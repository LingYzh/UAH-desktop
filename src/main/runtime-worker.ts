import { configureDiagnostics } from '../runtime/diagnostics';
import { Supervisor } from '../runtime/supervisor';
import { parseCommand } from '../shared/contracts';
import { randomUUID } from 'node:crypto';
import type { ApiConnection } from '../shared/endpoints';
import { discoverApiModels } from '../runtime/api-transport';
import { ApplicationJournal } from '../runtime/application-journal';
import { AgentStore } from './agent-store';
import { parseAgentCommand } from '../shared/agents';
import { parentConversation, parseDelegationPreview, resolveDelegation } from '../shared/delegation';
import { permissionIsSubset } from '../shared/permissions';
import { parseGitQuery } from '../shared/git';
import { readGit } from '../runtime/git';
import { parseContextQuery } from '../shared/request-context';
import path from 'node:path';
import { parseJournalQuery, parseJournalSessionQuery } from '../shared/journal-view';
import { parseSnapshotView } from '../shared/snapshot-view';
import { JournalPolicyStore } from '../runtime/journal-policy';
import { parseJournalPolicyCommand } from '../shared/journal-policy';
import { prepareRuntimeUpgrade } from '../runtime/store-backup';
import { RUNTIME_SCHEMA_VERSION } from '../runtime/store';

const parent = process.parentPort;
if (!parent || !process.argv[2]) throw new Error('Runtime must be launched by the desktop host.');
async function initialize() {
    try {
        const executionHelperPath = process.argv[3];
        if (executionHelperPath && !path.isAbsolute(executionHelperPath)) throw new Error('Execution helper path must be absolute.');
        configureDiagnostics(process.argv[2]);
        const progress = () => parent!.postMessage({ kind: 'startup-progress' });
        await prepareRuntimeUpgrade(process.argv[2], RUNTIME_SCHEMA_VERSION, progress);
        await prepareRuntimeUpgrade(path.join(process.argv[2], 'application-journal'), RUNTIME_SCHEMA_VERSION, progress);
        const agents = new AgentStore(process.argv[2]);
        const journalPolicy = new JournalPolicyStore(process.argv[2]);
        const applicationJournal = new ApplicationJournal(process.argv[2], () => journalPolicy.get().captureRaw);
        const connections = new Map<string, { resolve: (value: ApiConnection) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
        const probes = new Set<AbortController>();
        const probeTasks = new Set<Promise<void>>();
        const resolveConnection = (endpointId: string): Promise<ApiConnection> => new Promise((resolve, reject) => {
                const id = randomUUID();
                const timer = setTimeout(() => { connections.delete(id); reject(new Error('端点读取超时。')); }, 5000);
                connections.set(id, { resolve, reject, timer });
                parent.postMessage({ kind: 'resolve-connection', id, endpointId });
            });
        const supervisor = new Supervisor({
            executionHelperPath,
            dataDirectory: process.argv[2],
            getCaptureRaw: () => journalPolicy.get().captureRaw,
            resolveAgent: (id) => agents.resolve(id),
            getAgentSettings: () => agents.get(),
            onEvent: (event) => parent.postMessage({ kind: 'event', event }),
            resolveConnection,
        });
        let queue = Promise.resolve();
        let closing = false;
        parent.on('message', ({ data }) => {
            if (data.kind === 'connection') {
                const request = connections.get(data.id);
                if (request) {
                    clearTimeout(request.timer);
                    connections.delete(data.id);
                    if (data.error) request.reject(new Error(data.error));
                    else request.resolve(data.connection);
                }
                return;
            }
            if (data.kind === 'api-operation') {
                if (closing || probes.size > 0) {
                    parent.postMessage({ kind: 'reply', id: data.id, error: '端点测试正在进行或运行进程正在退出。' });
                    return;
                }
                const controller = new AbortController();
                probes.add(controller);
                const timer = setTimeout(() => controller.abort(), 30_000);
                const operation = data.operation === 'discover'
                    ? discoverApiModels(data.connection, controller.signal)
                    : applicationJournal.testConnection(data.connection, data.modelId, controller.signal);
                const task = operation.then((result) => parent.postMessage({ kind: 'reply', id: data.id, result }))
                    .catch((error) => parent.postMessage({ kind: 'reply', id: data.id, error: error instanceof Error ? error.message : '端点测试失败。' }))
                    .finally(() => { clearTimeout(timer); probes.delete(controller); probeTasks.delete(task); });
                probeTasks.add(task);
                return;
            }
            // Bounded read-only subprocesses must not block the stop/approval command queue.
            if (data.kind === 'git-query') {
                if (closing || probes.size >= 4) {
                    parent.postMessage({ kind: 'reply', id: data.id, error: '读取正在进行或应用正在退出，请稍后刷新。' });
                    return;
                }
                const controller = new AbortController();
                probes.add(controller);
                const task = Promise.resolve().then(() => readGit(parseGitQuery(data.query), controller.signal))
                    .then(result => parent.postMessage({ kind: 'reply', id: data.id, result }))
                    .catch(error => parent.postMessage({ kind: 'reply', id: data.id, error: error instanceof Error ? error.message : 'Git 读取失败。' }))
                    .finally(() => { probes.delete(controller); probeTasks.delete(task); });
                probeTasks.add(task);
                return;
            }
            queue = queue.then(async () => {
                try {
                    if (closing) throw new Error('运行进程正在退出。');
                    if (data.kind === 'shutdown') {
                        closing = true;
                        for (const probe of probes) probe.abort();
                        await Promise.allSettled(probeTasks);
                        applicationJournal.close();
                        await supervisor.shutdown();
                        agents.close();
                        parent.postMessage({ kind: 'reply', id: data.id });
                        setTimeout(() => process.exit(0), 50);
                    } else if (data.kind === 'delegation-preview') {
                        const { parentRunId, request } = parseDelegationPreview(data.value);
                        const snapshot = await supervisor.execute({ type: 'snapshot' });
                        const run = snapshot.runs.find(item => item.id === parentRunId);
                        const session = run && snapshot.sessions.find(item => item.id === run.sessionId);
                        if (!run || !session || run.effective.runtimeId !== 'api' || !run.effective.endpointId || !run.effective.permissionMode) throw new Error('父代理运行不存在或缺少有效权限快照。');
                        const currentMode = session.controls?.permissionMode ?? run.effective.permissionMode;
                        // A historical run cannot lend authority revoked by the current session controls.
                        const permissionMode = permissionIsSubset(currentMode, run.effective.permissionMode) ? currentMode : run.effective.permissionMode;
                        const result = resolveDelegation({
                            agentId: run.effective.agentId,
                            agentName: run.effective.agentName || '会话 Agent',
                            agentInstructions: run.effective.agentInstructions || '',
                            permissionMode,
                            allowDelegation: run.effective.allowDelegation === true,
                            providerId: run.effective.endpointId,
                            modelId: run.effective.modelId,
                            directory: session.directory,
                            depth: run.depth ?? 0,
                        }, agents.get(), request, parentConversation(snapshot, parentRunId));
                        const connection = await resolveConnection(result.providerId);
                        if (!connection.models.includes(result.modelId)) throw new Error('子代理指定的模型不在该 provider 中。');
                        if (request.reasoningEffort === undefined) result.reasoningEffort = run.effective.modelParameters?.reasoningEffort ?? 'default';
                        parent.postMessage({ kind: 'reply', id: data.id, result });
                    } else if (data.kind === 'request-context') {
                        const { runId } = parseContextQuery(data.query);
                        parent.postMessage({ kind: 'reply', id: data.id, result: supervisor.requestContext(runId) });
                    } else if (data.kind === 'journal-policy') {
                        parent.postMessage({ kind: 'reply', id: data.id, result: journalPolicy.execute(parseJournalPolicyCommand(data.command)) });
                    } else if (data.kind === 'session-purge-begin') {
                        const query = parseJournalQuery(data.query);
                        if (query.action !== 'purge-confirm') throw new Error('无效的删除确认。');
                        supervisor.beginSessionPurge(query.sessionId, query.fingerprint);
                        parent.postMessage({ kind: 'reply', id: data.id, result: null });
                    } else if (data.kind === 'session-purge-finish') {
                        const { sessionId } = parseJournalSessionQuery({ sessionId: data.sessionId });
                        if (typeof data.browserCleared !== 'boolean') throw new Error('无效的浏览器清理状态。');
                        if (!data.browserCleared) supervisor.releaseSessionPurge(sessionId);
                        const result = data.browserCleared ? supervisor.finishSessionPurge(sessionId) : { sessionId, completed: false, error: '浏览器数据尚未清理，删除保留为待完成。' };
                        parent.postMessage({ kind: 'reply', id: data.id, result });
                    } else if (data.kind === 'journal-view') {
                        const query = parseJournalQuery(data.query);
                        if (query.action !== 'summary' && query.action !== 'request' && query.action !== 'recovery' && query.action !== 'verification' && query.action !== 'cleanup-review' && query.action !== 'cleanup-confirm' && query.action !== 'purge-review') throw new TypeError('无效的日志操作。');
                        parent.postMessage({ kind: 'reply', id: data.id, result: query.action === 'purge-review' ? supervisor.sessionPurgeReview(query.sessionId) : query.action === 'cleanup-review' || query.action === 'cleanup-confirm'
                            ? supervisor.journalCleanup(query.sessionId, query.action === 'cleanup-confirm' ? query.fingerprint : undefined) : query.action === 'recovery'
                            ? await supervisor.recoveryReview(query.sessionId, query.runId) : query.action === 'verification'
                                ? await supervisor.verificationReview(query.sessionId, query.runId) : supervisor.journalView(query) });
                    } else if (data.kind === 'journal-session-directory') {
                        const { sessionId } = parseJournalSessionQuery(data.query);
                        parent.postMessage({ kind: 'reply', id: data.id, result: await supervisor.journalSessionDirectory(sessionId) });
                    } else if (data.kind === 'journal-export') {
                        const query = data.query;
                        if (!query || typeof query !== 'object' || Array.isArray(query) || Object.keys(query).some(key => !['sessionId', 'destination', 'mode'].includes(key)) || typeof query.destination !== 'string' || query.destination.length > 1024 || query.destination.includes('\0') || !path.isAbsolute(query.destination)) throw new TypeError('无效的日志导出位置。');
                        const parsed = parseJournalQuery({ action: 'export', sessionId: query.sessionId, mode: query.mode });
                        if (parsed.action !== 'export') throw new TypeError('无效的日志导出请求。');
                        parent.postMessage({ kind: 'reply', id: data.id, result: await supervisor.journalExport(parsed.sessionId, query.destination, parsed.mode) });
                    } else if (data.kind === 'agent-operation') {
                        const command = parseAgentCommand(data.command);
                        const result = command.type === 'get' ? agents.get() : agents.save(command.settings);
                        parent.postMessage({ kind: 'reply', id: data.id, result });
                    } else if (data.kind === 'command') {
                        const snapshot = await supervisor.execute(parseCommand(data.command), parseSnapshotView(data.view));
                        parent.postMessage({ kind: 'reply', id: data.id, snapshot });
                    }
                } catch (error) {
                    parent.postMessage({ kind: 'reply', id: data.id, error: error instanceof Error ? error.message : '运行请求失败。' });
                }
            });
        });
        parent.postMessage({ kind: 'ready' });
    } catch (error) {
        parent.postMessage({ kind: 'fatal', error: error instanceof Error ? error.message : '运行进程初始化失败。' });
        process.exitCode = 1;
    }
}
void initialize();
