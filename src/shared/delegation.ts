import type { AgentProfile, AgentSettings, PermissionMode } from './agents';
import { defaultModelParameters, parseModelParameters, type ModelParameters } from './model-parameters';
import type { ApiMessage } from './endpoints';
import type { Snapshot } from './contracts';
import { permissionModes, permissionIsSubset } from './permissions';
import { conversationMessages } from './conversation-history';
export { permissionDecision, permissionIsSubset } from './permissions';

export type DelegationContext = { mode: 'all' } | { mode: 'none' } | { mode: 'selected'; messages: ApiMessage[] };

export interface DelegationRequest {
    providerId?: string;
    modelId?: string;
    reasoningEffort?: ModelParameters['reasoningEffort'];
    agent: { type: 'inherit' } | { type: 'preset'; id: string } | { type: 'inline'; name: string; instructions: string };
    permissionMode?: PermissionMode;
    context?: DelegationContext;
}
export interface DelegationParent {
    agentId: string;
    agentName: string;
    agentInstructions: string;
    permissionMode: PermissionMode;
    allowDelegation: boolean;
    providerId: string;
    modelId: string;
    directory: string | null;
    depth: number;
}
export interface DelegationPlan extends DelegationParent {
    agentSource: DelegationRequest['agent']['type'];
    reasoningEffort: ModelParameters['reasoningEffort'];
    inheritHistory: boolean;
    contextMode: DelegationContext['mode'];
    contextMessages: ApiMessage[];
    timeoutSeconds: number;
    executionAvailable: false;
}
const modes = permissionModes;
function record(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).some(key => typeof key !== 'string' || ![...required, ...optional].includes(key))
        || required.some(key => !Object.hasOwn(value, key))
        || Reflect.ownKeys(value).some(key => !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error('子代理启动参数字段无效。');
}
function text(value: unknown, maximum: number, empty = false): string {
    if (typeof value !== 'string' || value.length > maximum || (!empty && !value.trim())) throw new Error('子代理启动参数文本无效。');
    return value;
}
export function parseDelegationRequest(value: unknown): DelegationRequest {
    record(value, ['agent'], ['providerId', 'modelId', 'reasoningEffort', 'permissionMode', 'context']);
    const source = value.agent;
    record(source, ['type'], ['id', 'name', 'instructions']);
    let agent: DelegationRequest['agent'];
    if (source.type === 'inherit') { record(source, ['type']); agent = { type: 'inherit' }; }
    else if (source.type === 'preset') { record(source, ['type', 'id']); agent = { type: 'preset', id: text(source.id, 200) }; }
    else if (source.type === 'inline') { record(source, ['type', 'name', 'instructions']); agent = { type: 'inline', name: text(source.name, 100), instructions: text(source.instructions, 32000, true) }; }
    else throw new Error('子代理 Agent 来源无效。');
    const result: DelegationRequest = { agent };
    for (const key of ['providerId', 'modelId'] as const) if (Object.hasOwn(value, key)) result[key] = text(value[key], 200);
    if (result.providerId !== undefined && result.modelId === undefined) throw new Error('指定 provider 时必须同时指定模型，不能跨 provider 猜测同名模型。');
    if (Object.hasOwn(value, 'reasoningEffort')) result.reasoningEffort = parseModelParameters({ ...defaultModelParameters(), reasoningEffort: value.reasoningEffort }).reasoningEffort;
    if (Object.hasOwn(value, 'permissionMode')) {
        if (!modes.includes(value.permissionMode as PermissionMode)) throw new Error('子代理权限模式无效。');
        result.permissionMode = value.permissionMode as PermissionMode;
    }
    if (Object.hasOwn(value, 'context')) {
        record(value.context, ['mode'], ['messages']);
        if (value.context.mode === 'selected') {
            record(value.context, ['mode', 'messages']);
            result.context = { mode: 'selected', messages: parseContextMessages(value.context.messages) };
        } else if (value.context.mode === 'all' || value.context.mode === 'none') {
            record(value.context, ['mode']);
            result.context = { mode: value.context.mode };
        } else throw new Error('子代理上下文模式无效。');
    }
    return result;
}
function parseContextMessages(value: unknown): ApiMessage[] {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > 1000
        || Reflect.ownKeys(value).length !== value.length + 1) throw new Error('子代理上下文最多包含 1000 条消息。');
    const messages: ApiMessage[] = [];
    let contentBytes = 0;
    const encoder = new TextEncoder();
    for (let index = 0; index < value.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new Error('子代理上下文格式无效。');
        const item = descriptor.value;
        record(item, ['role', 'content']);
        if (item.role !== 'user' && item.role !== 'assistant') throw new Error('子代理上下文仅接受 user / assistant 消息；Agent 指令需单独配置。');
        const content = text(item.content, 1_000_000, true);
        contentBytes += encoder.encode(content).byteLength;
        if (contentBytes > 1_000_000) throw new Error('子代理上下文超过 1 MB，请挑选部分内容或提供摘要。');
        messages.push({ role: item.role, content });
    }
    if (encoder.encode(JSON.stringify(messages)).byteLength > 1_000_000) throw new Error('子代理上下文超过 1 MB，请挑选部分内容或提供摘要。');
    return messages;
}
/** Reconstruct the parent model's conversation window, excluding later turns and other sessions. */
export function parentConversation(snapshot: Snapshot, parentRunId: string): ApiMessage[] {
    const index = snapshot.runs.findIndex(item => item.id === parentRunId);
    if (index < 0) throw new Error('父代理运行不存在。');
    const run = snapshot.runs[index];
    const limit = run.effective.modelParameters?.historyTurns ?? run.effective.agentParameters?.historyTurns;
    const messages: ApiMessage[] = run.contextMessages ? structuredClone(run.contextMessages) : conversationMessages(snapshot, run.sessionId, { beforeRunId: run.id, historyTurns: limit, includeFailed: true });
    messages.push({ role: 'user', content: run.input });
    if (run.history?.deleted) return messages;
    if (run.history?.editedOutput !== undefined) messages.push({ role: 'assistant', content: run.history.editedOutput });
    else if (run.activities?.length) {
        for (const activity of run.activities) {
            if (activity.kind === 'text' && activity.content) messages.push({ role: 'assistant', content: activity.content });
            else if (activity.kind === 'tool' || activity.kind === 'agent') messages.push({ role: 'assistant', content: `[工具 ${activity.title} · ${activity.status}]\n${activity.content}` });
        }
    } else if (run.output) messages.push({ role: 'assistant', content: run.output });
    return messages;
}
/** Produces a validated configuration only. It neither reserves a slot nor launches an agent. */
export function resolveDelegation(parent: DelegationParent, settings: AgentSettings, raw: unknown, parentContext: ApiMessage[] = []): DelegationPlan {
    const request = parseDelegationRequest(raw);
    if (!modes.includes(parent.permissionMode)) throw new Error('父代理权限快照无效。');
    if (!parent.allowDelegation || !settings.subagents.enabled) throw new Error('父代理或全局设置未允许委派。');
    if (!Number.isSafeInteger(parent.depth) || parent.depth < 0 || parent.depth >= settings.subagents.maxDepth) throw new Error('已达到最大委派深度。');
    let preset: Extract<AgentProfile, { kind: 'subagent' }> | undefined;
    if (request.agent.type === 'preset') {
        const id = request.agent.id;
        preset = settings.profiles.find((item): item is Extract<AgentProfile, { kind: 'subagent' }> => item.id === id && item.kind === 'subagent' && item.enabled);
        if (!preset) throw new Error('指定的预设子代理不存在或已停用。');
    }
    const permissionMode = request.permissionMode ?? parent.permissionMode;
    if (!permissionIsSubset(permissionMode, parent.permissionMode)) throw new Error('子代理权限不能超过父代理；请继承或降低权限。');
    const providerId = request.providerId ?? preset?.model?.endpointId ?? parent.providerId;
    const modelId = request.modelId ?? preset?.model?.modelId ?? parent.modelId;
    const context = request.context ?? { mode: settings.subagents.inheritHistory ? 'all' : 'none' };
    const contextMessages = parseContextMessages(context.mode === 'selected' ? context.messages : context.mode === 'all' ? parentContext : []);
    return {
        agentId: preset?.id ?? (request.agent.type === 'inherit' ? parent.agentId : 'inline'),
        agentName: preset?.name ?? (request.agent.type === 'inline' ? request.agent.name : parent.agentName),
        agentInstructions: preset?.instructions ?? (request.agent.type === 'inline' ? request.agent.instructions : parent.agentInstructions),
        permissionMode,
        allowDelegation: parent.allowDelegation && (preset?.allowDelegation ?? request.agent.type === 'inherit'),
        providerId, modelId,
        directory: parent.directory,
        depth: parent.depth + 1,
        agentSource: request.agent.type,
        reasoningEffort: request.reasoningEffort ?? 'default',
        inheritHistory: context.mode === 'all',
        contextMode: context.mode,
        contextMessages,
        timeoutSeconds: settings.subagents.timeoutSeconds,
        executionAvailable: false,
    };
}
export function parseDelegationPreview(value: unknown): { parentRunId: string; request: DelegationRequest } {
    record(value, ['parentRunId', 'request']);
    return { parentRunId: text(value.parentRunId, 200), request: parseDelegationRequest(value.request) };
}
