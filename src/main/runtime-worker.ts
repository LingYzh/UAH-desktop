import { configureDiagnostics } from '../runtime/diagnostics';
import { Supervisor } from '../runtime/supervisor';
import { parseCommand } from '../shared/contracts';
import { randomUUID } from 'node:crypto';
import type { ApiConnection } from '../shared/endpoints';
import { discoverApiModels, testApiConnection } from '../runtime/api-transport';
import { AgentStore } from './agent-store';
import { parseAgentCommand } from '../shared/agents';
import { parentConversation, parseDelegationPreview, resolveDelegation } from '../shared/delegation';
import { permissionIsSubset } from '../shared/permissions';
import { parseGitQuery } from '../shared/git';
import { readGit } from '../runtime/git';
import { parseContextQuery } from '../shared/request-context';

const parent = process.parentPort;
if (!parent || !process.argv[2]) throw new Error('Runtime must be launched by the desktop host.');
try {
    configureDiagnostics(process.argv[2]);
    const agents = new AgentStore(process.argv[2]);
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
        dataDirectory: process.argv[2],
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
                : testApiConnection(data.connection, data.modelId, controller.signal);
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
                    await supervisor.shutdown();
                    await Promise.allSettled(probeTasks);
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
                } else if (data.kind === 'agent-operation') {
                    const command = parseAgentCommand(data.command);
                    const result = command.type === 'get' ? agents.get() : agents.save(command.settings);
                    parent.postMessage({ kind: 'reply', id: data.id, result });
                } else if (data.kind === 'command') {
                    const snapshot = await supervisor.execute(parseCommand(data.command));
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
