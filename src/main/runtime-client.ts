import { utilityProcess, type UtilityProcess } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Command, RuntimeEvent, Snapshot } from '../shared/contracts';
import type { ApiConnection, ModelCatalog, ApiTestResult, ProviderCatalogEntry } from '../shared/endpoints';
import type { AgentCommand, AgentSettings } from '../shared/agents';
import type { JournalViewQuery, JournalExportResult } from '../shared/journal-view';

export interface RuntimeClientOptions {
    listProviders?: () => ProviderCatalogEntry[];
    executionHelperPath?: string;
    resolveExtensions?: () => import('../shared/extension-runtime').ExtensionRuntimeBundle;
    readSkill?: (id: string, relativePath?: string) => { name: string; content: string; source: string };
}

export class RuntimeClient {
    private child: UtilityProcess;
    private pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
    private ready: Promise<void>;
    private exited: Promise<void>;
    private dead = false;

    constructor(workerPath: string, dataDirectory: string, onEvent: (event: RuntimeEvent) => void, resolveConnection: (id: string) => ApiConnection, options: RuntimeClientOptions = {}) {
        const argumentsForWorker = options.executionHelperPath ? [dataDirectory, options.executionHelperPath] : [dataDirectory];
        this.child = utilityProcess.fork(workerPath, argumentsForWorker, { serviceName: 'UAH Runtime Supervisor', stdio: 'pipe' });
        // Never relay raw runtime stdout/stderr to the renderer.
        this.child.stdout?.resume();
        this.child.stderr?.resume();
        this.ready = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('运行进程启动超时。')), 15000);
            this.child.on('message', (message) => {
                // A live SQLite backup reports progress while preserving the
                // startup barrier; no command is accepted until migration ends.
                if (message?.kind === 'startup-progress') timer.refresh();
                if (message?.kind === 'ready') { clearTimeout(timer); resolve(); }
                if (message?.kind === 'fatal') { clearTimeout(timer); reject(new Error(message.error || '运行进程初始化失败。')); }
            });
            this.child.once('exit', () => { clearTimeout(timer); reject(new Error('运行进程已退出。')); });
        });
        // Attach immediately, including when startup fails before the first command.
        this.ready.catch(() => {});
        this.child.on('message', (message) => {
            if (message?.kind === 'resolve-extensions' || message?.kind === 'read-skill' || message?.kind === 'list-providers') {
                try {
                    const result = message.kind === 'list-providers' ? options.listProviders?.() : message.kind === 'resolve-extensions' ? options.resolveExtensions?.()
                        : options.readSkill?.(message.skillId, message.relativePath);
                    if (!result) throw new Error('扩展服务不可用。');
                    this.child.postMessage({ kind: 'extension-result', id: message.id, result });
                } catch {
                    this.child.postMessage({ kind: 'extension-result', id: message.id, error: message.kind === 'list-providers' ? 'Provider 目录读取失败，请检查模型与账号设置。' : '扩展配置或技能不可用，请检查安装与启用状态。' });
                }
                return;
            }
            if (message?.kind === 'resolve-connection') {
                try {
                    if (typeof message.endpointId !== 'string') throw new Error('端点 ID 无效。');
                    this.child.postMessage({ kind: 'connection', id: message.id, connection: resolveConnection(message.endpointId) });
                } catch {
                    this.child.postMessage({ kind: 'connection', id: message.id, error: '端点不可用、已停用或凭据无法解密，请检查模型与账号设置。' });
                }
                return;
            }
            if (message?.kind === 'event') onEvent(message.event);
            if (message?.kind !== 'reply') return;
            const request = this.pending.get(message.id);
            if (!request) return;
            clearTimeout(request.timer);
            this.pending.delete(message.id);
            if (message.error) request.reject(new Error(message.error));
            else request.resolve(message.snapshot ?? message.result);
        });
        this.exited = new Promise((resolve) => this.child.once('exit', () => {
            this.dead = true;
            for (const request of this.pending.values()) {
                clearTimeout(request.timer);
                request.reject(new Error('运行进程意外退出；重启后会将未完成任务标记为中止。'));
            }
            this.pending.clear();
            resolve();
        }));
    }

    async execute(command: Command, view?: import('../shared/snapshot-view').SnapshotView): Promise<Snapshot> {
        await this.ready;
        return this.request({ kind: 'command', command, view });
    }
    async testConnector(id: string): Promise<unknown> {
        await this.ready;
        return this.request({ kind: 'test-connector', connectorId: id }, 45_000);
    }
    async nativeProbe(settings: import('../shared/native-codex').NativeCodexSettings): Promise<NonNullable<import('../shared/extension-runtime').NativeStatus['probe']>> {
        await this.ready;
        return this.request({ kind: 'native-probe', settings }, 45_000);
    }
    async git(query: import('../shared/git').GitQuery): Promise<import('../shared/git').GitResult> {
        await this.ready;
        return this.request({ kind: 'git-query', query }, 30_000);
    }
    async requestContext(query: import('../shared/request-context').ContextQuery): Promise<import('../shared/request-context').RequestContextDetail | null> {
        await this.ready;
        return this.request({ kind: 'request-context', query });
    }
    async journal(query: JournalViewQuery): Promise<unknown> {
        await this.ready;
        return this.request({ kind: 'journal-view', query }, 30_000);
    }
    async beginSessionPurge(query: Extract<import('../shared/journal-view').JournalQuery, { action: 'purge-confirm' }>): Promise<void> {
        await this.ready;
        return this.request({ kind: 'session-purge-begin', query }, 120_000);
    }
    async finishSessionPurge(sessionId: string, browserCleared: boolean): Promise<import('../shared/session-purge').SessionPurgeResult> {
        await this.ready;
        return this.request({ kind: 'session-purge-finish', sessionId, browserCleared }, 120_000);
    }
    async journalPolicy(command: import('../shared/journal-policy').JournalPolicyCommand): Promise<import('../shared/journal-policy').JournalPolicy> {
        await this.ready;
        return this.request({ kind: 'journal-policy', command });
    }
    async journalSessionDirectory(query: { sessionId: string }): Promise<string> {
        await this.ready;
        return this.request<string>({ kind: 'journal-session-directory', query }, 30_000);
    }
    async journalExport(query: { sessionId: string; destination: string; mode: 'full' | 'share' }): Promise<JournalExportResult> {
        await this.ready;
        return this.request<JournalExportResult>({ kind: 'journal-export', query }, 60_000);
    }
    async delegationPreview(value: { parentRunId: string; request: import('../shared/delegation').DelegationRequest }): Promise<import('../shared/delegation').DelegationPlan> {
        await this.ready;
        return this.request({ kind: 'delegation-preview', value });
    }

    async agentOperation(command: AgentCommand): Promise<AgentSettings> {
        await this.ready;
        return this.request<AgentSettings>({ kind: 'agent-operation', command });
    }

    async apiOperation(connection: ApiConnection, operation: 'discover' | 'test', modelId?: string): Promise<ModelCatalog | ApiTestResult> {
        await this.ready;
        return this.request<ModelCatalog | ApiTestResult>({ kind: 'api-operation', connection, operation, modelId }, 45_000);
    }

    private request<T = Snapshot>(message: Record<string, unknown>, timeout = 15000): Promise<T> {
        if (this.dead) return Promise.reject(new Error('运行进程不可用。'));
        const id = randomUUID();
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error('运行进程未响应；请检查任务状态后再操作。'));
            }, timeout);
            this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
            this.child.postMessage({ ...message, id });
        });
    }

    async shutdown() {
        if (this.dead) return;
        await this.ready;
        await this.request({ kind: 'shutdown' });
        await Promise.race([
            this.exited,
            new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('运行进程尚未确认退出。')), 5000))
        ]);
    }
}
