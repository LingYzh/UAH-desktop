import type { AgentModel } from './agents.js';

/** The closed schema stored by agents.sqlite schema version 2. Keep migration-only. */
export type LegacyAgentV2Permission = 'readonly' | 'accept-edits' | 'auto' | 'bypass' | 'inherit';

export interface LegacyAgentV2ProfileBase {
    id: string;
    name: string;
    description: string;
    instructions: string;
    enabled: boolean;
    allowDelegation: boolean;
}

export type LegacyAgentV2Profile = (LegacyAgentV2ProfileBase & {
    kind: 'primary';
    permissionMode: Exclude<LegacyAgentV2Permission, 'inherit'>;
}) | (LegacyAgentV2ProfileBase & {
    kind: 'subagent';
    permissionMode: LegacyAgentV2Permission;
    model?: AgentModel | null;
});

export interface LegacyAgentV2SubagentSettings {
    enabled: boolean;
    maxConcurrentThreads: number;
    maxDepth: number;
    inheritHistory: boolean;
    timeoutSeconds: number;
}

export interface LegacyAgentV2Settings {
    revision: number;
    profiles: LegacyAgentV2Profile[];
    subagents: LegacyAgentV2SubagentSettings;
}

const MAX_SERIALIZED_BYTES = 1_048_576;
const PERMISSION_MODES: readonly LegacyAgentV2Permission[] = ['readonly', 'accept-edits', 'auto', 'bypass', 'inherit'];

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return value !== null
        && typeof value === 'object'
        && !Array.isArray(value)
        && [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function record(value: unknown, keys: readonly string[], requiredKeys: readonly string[] = keys): asserts value is Record<string, unknown> {
    if (!isPlainRecord(value)
        || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
        || requiredKeys.some((key) => {
            if (!Object.hasOwn(value, key)) return true;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return !descriptor || !('value' in descriptor);
        })
        || keys.some((key) => {
            if (!Object.hasOwn(value, key)) return false;
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

function parseModel(value: unknown): AgentModel | null {
    if (value === null) return null;
    record(value, ['endpointId', 'modelId']);
    return {
        endpointId: string(value.endpointId, 200, '端点标识', { trim: true, identifier: true }),
        modelId: string(value.modelId, 200, '模型标识', { trim: true, identifier: true }),
    };
}

function parsePermissionMode(value: unknown, allowInherit: boolean): LegacyAgentV2Permission {
    if (typeof value !== 'string'
        || !PERMISSION_MODES.includes(value as LegacyAgentV2Permission)
        || (!allowInherit && value === 'inherit')) {
        throw new TypeError('旧版智能体权限模式无效。');
    }
    return value as LegacyAgentV2Permission;
}

function parseProfile(value: unknown): LegacyAgentV2Profile {
    if (!isPlainRecord(value) || (value.kind !== 'primary' && value.kind !== 'subagent')) {
        throw new TypeError('旧版智能体类型无效。');
    }
    const commonKeys = ['id', 'name', 'description', 'instructions', 'enabled', 'kind', 'permissionMode', 'allowDelegation'] as const;
    const hasModelKey = value.kind === 'subagent' && Object.hasOwn(value, 'model');
    record(value, value.kind === 'primary' ? commonKeys : [...commonKeys, 'model'], commonKeys);
    const base: LegacyAgentV2ProfileBase = {
        id: string(value.id, 200, '标识', { trim: true, identifier: true }),
        name: string(value.name, 100, '名称', { trim: true }),
        description: string(value.description, 2000, '描述', { empty: true }),
        instructions: string(value.instructions, 32_000, '指令', { empty: true }),
        enabled: boolean(value.enabled, '启用状态'),
        allowDelegation: boolean(value.allowDelegation, '委派权限'),
    };
    if (value.kind === 'primary') {
        return {
            ...base,
            kind: 'primary',
            permissionMode: parsePermissionMode(value.permissionMode, false) as Exclude<LegacyAgentV2Permission, 'inherit'>,
        };
    }
    return {
        ...base,
        kind: 'subagent',
        permissionMode: parsePermissionMode(value.permissionMode, true),
        ...(hasModelKey ? { model: parseModel(value.model) } : {}),
    };
}

function parseSubagents(value: unknown): LegacyAgentV2SubagentSettings {
    record(value, ['enabled', 'maxConcurrentThreads', 'maxDepth', 'inheritHistory', 'timeoutSeconds']);
    return {
        enabled: boolean(value.enabled, '子代理启用状态'),
        maxConcurrentThreads: number(value.maxConcurrentThreads, 1, 32, 'maxConcurrentThreads', true),
        maxDepth: number(value.maxDepth, 1, 8, 'maxDepth', true),
        inheritHistory: boolean(value.inheritHistory, '历史继承设置'),
        timeoutSeconds: number(value.timeoutSeconds, 5, 3600, '子代理超时', true),
    };
}

export function parseAgentSettingsV2(value: unknown): LegacyAgentV2Settings {
    record(value, ['revision', 'profiles', 'subagents']);
    const revision = number(value.revision, 0, Number.MAX_SAFE_INTEGER, '版本', true);
    const profiles = arrayItems(value.profiles, 100, '配置').map(parseProfile);
    const ids = new Set(profiles.map((profile) => profile.id));
    if (ids.size !== profiles.length) throw new TypeError('旧版智能体标识不能重复。');
    if (!profiles.some((profile) => profile.kind === 'primary' && profile.enabled)) {
        throw new TypeError('旧版配置至少需要一个已启用的主智能体。');
    }
    const settings: LegacyAgentV2Settings = { revision, profiles, subagents: parseSubagents(value.subagents) };
    if (new TextEncoder().encode(JSON.stringify(settings)).byteLength > MAX_SERIALIZED_BYTES) {
        throw new TypeError('旧版智能体配置序列化后不能超过 1 MB。');
    }
    return settings;
}
