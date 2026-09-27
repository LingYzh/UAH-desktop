import { parsePermissionMode, type PermissionMode } from './permissions';
import { defaultModelParameters, parseModelParameters, type ModelReasoningEffort, type ModelParameters } from './model-parameters';

export interface SessionControls {
    permissionMode: PermissionMode;
    reasoningEffort: ModelReasoningEffort;
}
export function defaultSessionControls(): SessionControls {
    return { permissionMode: 'manual', reasoningEffort: 'default' };
}
export function parseSessionControls(value: unknown): SessionControls {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== 2
        || !Object.hasOwn(value, 'permissionMode') || !Object.hasOwn(value, 'reasoningEffort')
        || Reflect.ownKeys(value).some(key => !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new Error('会话控制设置字段无效。');
    const source = value as Record<string, unknown>;
    return {
        permissionMode: parsePermissionMode(source.permissionMode),
        reasoningEffort: parseModelParameters({ ...defaultModelParameters(), reasoningEffort: source.reasoningEffort }).reasoningEffort,
    };
}
export function applySessionReasoning(parameters: ModelParameters, controls: SessionControls): ModelParameters {
    const applied = structuredClone(parameters);
    applied.reasoningEffort = controls.reasoningEffort;
    // Conversation controls own reasoning. Never carry a model-level budget into a session request.
    applied.thinkingBudget = null;
    return applied;
}
