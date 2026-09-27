import { parseModelParameters, type ModelParameters, type ModelReasoningEffort } from './model-parameters.js';

/** The closed schema stored by agents.sqlite schema version 1. Keep migration-only. */
export interface LegacyAgentProfile {
    id: string;
    name: string;
    description: string;
    instructions: string;
    enabled: boolean;
    kind: 'primary' | 'subagent';
    model: { endpointId: string; modelId: string } | null;
    parameters: ModelParameters;
    sandboxMode: 'inherit' | 'read-only' | 'workspace-write';
    allowDelegation: boolean;
}

export interface LegacyAgentSubagentSettings {
    enabled: boolean;
    maxConcurrentThreads: number;
    maxDepth: number;
    defaultModel: { endpointId: string; modelId: string } | null;
    defaultReasoningEffort: ModelReasoningEffort;
    inheritHistory: boolean;
    allowModelOverride: boolean;
    allowReasoningOverride: boolean;
    timeoutSeconds: number;
}

export interface LegacyAgentSettings {
    revision: number;
    profiles: LegacyAgentProfile[];
    subagents: LegacyAgentSubagentSettings;
}

const MAX_SERIALIZED_BYTES = 1_048_576;
const REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
    'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
    if (!isPlainRecord(value)
        || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
        || keys.some((key) => {
            if (!Object.hasOwn(value, key)) return true;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return !descriptor || !('value' in descriptor);
        })) {
        throw new TypeError('旧版智能体配置字段无效。');
    }
}

function string(value: unknown, maxLength: number, field: string, options: { empty?: boolean; trim?: boolean; identifier?: boolean } = {}): string {
    if (typeof value !== 'string'
        || value.length > maxLength
        || (options.empty !== true && !value.trim())
        || (options.identifier === true && /[\u0000-\u001f\u007f]/.test(value))) {
        throw new TypeError(`旧版智能体${field}无效。`);
    }
    return options.trim === true ? value.trim() : value;
}

function boolean(value: unknown, field: string): boolean {
    if (typeof value !== 'boolean') throw new TypeError(`旧版智能体${field}无效。`);
    return value;
}

function number(value: unknown, min: number, max: number, field: string, integer = false): number {
    if (typeof value !== 'number'
        || !Number.isFinite(value)
        || value < min
        || value > max
        || (integer && !Number.isSafeInteger(value))) {
        throw new TypeError(`旧版智能体${field}无效。`);
    }
    return value;
}

function arrayItems(value: unknown, maxLength: number, field: string): unknown[] {
    if (!Array.isArray(value)
        || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > maxLength) {
        throw new TypeError(`旧版智能体${field}无效。`);
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1
        || keys.some((key) => key !== 'length'
            && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new TypeError(`旧版智能体${field}无效。`);
    }
    const items: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new TypeError(`旧版智能体${field}无效。`);
        items.push(descriptor.value);
    }
    return items;
}

function parseModel(value: unknown): LegacyAgentProfile['model'] {
    if (value === null) return null;
    record(value, ['endpointId', 'modelId']);
    return {
        endpointId: string(value.endpointId, 200, '端点标识', { trim: true, identifier: true }),
        modelId: string(value.modelId, 200, '模型标识', { trim: true, identifier: true }),
    };
}

function parseReasoningEffort(value: unknown, field: string): ModelReasoningEffort {
    if (typeof value !== 'string' || !REASONING_EFFORTS.includes(value as ModelReasoningEffort)) {
        throw new TypeError(`旧版智能体${field}无效。`);
    }
    return value as ModelReasoningEffort;
}

function parseProfile(value: unknown): LegacyAgentProfile {
    record(value, ['id', 'name', 'description', 'instructions', 'enabled', 'kind', 'model', 'parameters', 'sandboxMode', 'allowDelegation']);
    if (value.kind !== 'primary' && value.kind !== 'subagent') throw new TypeError('旧版智能体类型无效。');
    if (value.sandboxMode !== 'inherit' && value.sandboxMode !== 'read-only' && value.sandboxMode !== 'workspace-write') {
        throw new TypeError('旧版智能体沙箱模式无效。');
    }
    return {
        id: string(value.id, 200, '标识', { trim: true, identifier: true }),
        name: string(value.name, 100, '名称', { trim: true }),
        description: string(value.description, 2000, '描述', { empty: true }),
        instructions: string(value.instructions, 32_000, '指令', { empty: true }),
        enabled: boolean(value.enabled, '启用状态'),
        kind: value.kind,
        model: parseModel(value.model),
        parameters: parseModelParameters(value.parameters),
        sandboxMode: value.sandboxMode,
        allowDelegation: boolean(value.allowDelegation, '委派权限'),
    };
}

function parseSubagents(value: unknown): LegacyAgentSubagentSettings {
    record(value, [
        'enabled', 'maxConcurrentThreads', 'maxDepth', 'defaultModel', 'defaultReasoningEffort',
        'inheritHistory', 'allowModelOverride', 'allowReasoningOverride', 'timeoutSeconds',
    ]);
    return {
        enabled: boolean(value.enabled, '子代理启用状态'),
        maxConcurrentThreads: number(value.maxConcurrentThreads, 1, 32, 'maxConcurrentThreads', true),
        maxDepth: number(value.maxDepth, 1, 8, 'maxDepth', true),
        defaultModel: parseModel(value.defaultModel),
        defaultReasoningEffort: parseReasoningEffort(value.defaultReasoningEffort, '默认推理强度'),
        inheritHistory: boolean(value.inheritHistory, '历史继承设置'),
        allowModelOverride: boolean(value.allowModelOverride, '模型覆盖设置'),
        allowReasoningOverride: boolean(value.allowReasoningOverride, '推理强度覆盖设置'),
        timeoutSeconds: number(value.timeoutSeconds, 5, 3600, '子代理超时', true),
    };
}

export function parseLegacyAgentSettings(value: unknown): LegacyAgentSettings {
    record(value, ['revision', 'profiles', 'subagents']);
    const revision = number(value.revision, 0, Number.MAX_SAFE_INTEGER, '版本', true);
    const profiles = arrayItems(value.profiles, 100, '配置').map(parseProfile);
    const ids = new Set(profiles.map((profile) => profile.id));
    if (ids.size !== profiles.length) throw new TypeError('旧版智能体标识不能重复。');
    if (!profiles.some((profile) => profile.kind === 'primary' && profile.enabled)) {
        throw new TypeError('旧版配置至少需要一个已启用的主智能体。');
    }
    const settings: LegacyAgentSettings = { revision, profiles, subagents: parseSubagents(value.subagents) };
    if (new TextEncoder().encode(JSON.stringify(settings)).byteLength > MAX_SERIALIZED_BYTES) {
        throw new TypeError('旧版智能体配置序列化后不能超过 1 MB。');
    }
    return settings;
}
