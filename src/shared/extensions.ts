export interface ConnectorRecord {
    id: string;
    name: string;
    transport: 'stdio' | 'http';
    command: string;
    args: string[];
    url: string;
    enabled: boolean;
    revision: number;
    hasSecrets: boolean;
    pluginId?: string;
}

export type ConnectorDraft = Omit<ConnectorRecord, 'id' | 'hasSecrets'> & {
    id: string | null;
    secrets: Record<string, string> | null;
    /** Advisory display state returned by list(); the store derives it from encrypted data. */
    hasSecrets?: boolean;
};

export interface ResolvedConnector extends ConnectorRecord {
    secrets: Record<string, string>;
}

export interface SkillRecord {
    id: string;
    name: string;
    description: string;
    enabled: boolean;
    pluginId?: string;
    source: string;
    builtin?: true;
}

export interface PluginRecord {
    id: string;
    name: string;
    description: string;
    version: string;
    enabled: boolean;
    source: string;
    unsupported: string[];
}

export interface MarketplacePluginRecord {
    name: string;
    description: string;
    source: string;
}

export interface MarketplaceRecord {
    id: string;
    name: string;
    source: string;
    plugins: MarketplacePluginRecord[];
}

export interface ExtensionSnapshot {
    connectors: ConnectorRecord[];
    skills: SkillRecord[];
    plugins: PluginRecord[];
    marketplaces: MarketplaceRecord[];
}

export type ExtensionCommand =
    | { type: 'list' }
    | { type: 'save-connector'; draft: ConnectorDraft }
    | { type: 'delete-connector'; id: string; revision: number }
    | { type: 'install-skill'; source: string }
    | { type: 'set-skill-enabled'; id: string; enabled: boolean }
    | { type: 'remove-skill'; id: string }
    | { type: 'install-plugin'; source: string }
    | { type: 'set-plugin-enabled'; id: string; enabled: boolean }
    | { type: 'remove-plugin'; id: string }
    | { type: 'add-marketplace'; source: string }
    | { type: 'remove-marketplace'; id: string }
    | { type: 'install-marketplace-plugin'; marketplaceId: string; name: string }
    | { type: 'update-plugin'; id: string };

const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_CONNECTOR_ARGS = 128;
const MAX_SECRET_ENTRIES = 128;
const MAX_MARKETPLACE_PLUGINS = 256;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

function fail(message: string): never {
    throw new TypeError(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
    for (const key of Object.keys(value)) {
        if (!required.includes(key) && !optional.includes(key)) fail('扩展命令包含不支持的字段。');
    }
    for (const key of required) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) fail('扩展命令缺少必需字段。');
    }
}

function text(value: unknown, label: string, maxLength: number, allowEmpty = false): string {
    if (typeof value !== 'string' || value.length > maxLength || CONTROL_CHARACTERS.test(value)) {
        fail(`${label}无效。`);
    }
    const normalized = value.trim();
    if (!allowEmpty && normalized.length === 0) fail(`${label}不能为空。`);
    return normalized;
}

function id(value: unknown): string {
    return text(value, '扩展标识', 200);
}

function revision(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) fail('连接器版本无效。');
    return value as number;
}

function bool(value: unknown, label: string): boolean {
    if (typeof value !== 'boolean') fail(`${label}无效。`);
    return value;
}

function stringArray(value: unknown, label: string, maxCount: number, maxLength: number): string[] {
    if (!Array.isArray(value) || value.length > maxCount) fail(`${label}无效。`);
    return value.map((entry) => {
        if (typeof entry !== 'string' || entry.length > maxLength || CONTROL_CHARACTERS.test(entry)) fail(`${label}无效。`);
        return entry;
    });
}

function secrets(value: unknown): Record<string, string> | null {
    if (value === null) return null;
    if (!isRecord(value)) fail('连接器密钥无效。');
    const entries = Object.entries(value);
    if (entries.length > MAX_SECRET_ENTRIES) fail('连接器密钥数量过多。');
    const result: Record<string, string> = Object.create(null) as Record<string, string>;
    let totalLength = 0;
    for (const [key, entry] of entries) {
        const normalizedKey = text(key, '密钥名称', 256);
        if (typeof entry !== 'string' || entry.length > 64 * 1024 || entry.includes('\u0000')) fail('密钥内容无效。');
        const normalizedValue = entry;
        totalLength += new TextEncoder().encode(normalizedKey).length + new TextEncoder().encode(normalizedValue).length;
        if (totalLength > 256 * 1024) fail('连接器密钥数据过大。');
        result[normalizedKey] = normalizedValue;
    }
    return result;
}

function connectorDraft(value: unknown): ConnectorDraft {
    if (!isRecord(value)) fail('连接器配置无效。');
    exactKeys(value, ['id', 'name', 'transport', 'command', 'args', 'url', 'enabled', 'revision', 'secrets'], ['hasSecrets', 'pluginId']);
    const transport = value.transport;
    if (transport !== 'stdio' && transport !== 'http') fail('连接器传输类型无效。');
    const parsed: ConnectorDraft = {
        id: value.id === null ? null : id(value.id),
        name: text(value.name, '连接器名称', 200),
        transport,
        command: text(value.command, '连接器命令', 8192, true),
        args: stringArray(value.args, '连接器参数', MAX_CONNECTOR_ARGS, 8192),
        url: text(value.url, '连接器地址', 8192, true),
        enabled: bool(value.enabled, '连接器启用状态'),
        revision: revision(value.revision),
        secrets: secrets(value.secrets),
    };
    if (value.hasSecrets !== undefined) parsed.hasSecrets = bool(value.hasSecrets, '连接器密钥状态');
    if (value.pluginId !== undefined) parsed.pluginId = id(value.pluginId);
    return parsed;
}

function commandId(value: unknown): string {
    return id(value);
}

export function parseExtensionCommand(value: unknown): ExtensionCommand {
    if (!isRecord(value)) fail('扩展命令格式无效。');
    const type = value.type;
    switch (type) {
        case 'list':
            exactKeys(value, ['type']);
            return { type };
        case 'save-connector':
            exactKeys(value, ['type', 'draft']);
            return { type, draft: connectorDraft(value.draft) };
        case 'delete-connector':
            exactKeys(value, ['type', 'id', 'revision']);
            return { type, id: commandId(value.id), revision: revision(value.revision) };
        case 'install-skill':
        case 'install-plugin':
        case 'add-marketplace':
            exactKeys(value, ['type', 'source']);
            return { type, source: text(value.source, '扩展来源', 4096) };
        case 'set-skill-enabled':
        case 'set-plugin-enabled':
            exactKeys(value, ['type', 'id', 'enabled']);
            return { type, id: commandId(value.id), enabled: bool(value.enabled, '扩展开启状态') };
        case 'remove-skill':
        case 'remove-plugin':
        case 'remove-marketplace':
        case 'update-plugin':
            exactKeys(value, ['type', 'id']);
            return { type, id: commandId(value.id) };
        case 'install-marketplace-plugin':
            exactKeys(value, ['type', 'marketplaceId', 'name']);
            return {
                type,
                marketplaceId: commandId(value.marketplaceId),
                name: text(value.name, '插件名称', 200),
            };
        default:
            fail('扩展命令类型无效。');
    }
}

export function validateExtensionCommandSize(value: unknown): void {
    let size: number;
    try {
        const serialized = JSON.stringify(value);
        if (typeof serialized !== 'string') fail('扩展命令大小无效。');
        size = new TextEncoder().encode(serialized).length;
    } catch {
        fail('扩展命令大小无效。');
    }
    if (size > MAX_COMMAND_BYTES) fail('扩展命令过大。');
}

export const extensionLimits = {
    commandBytes: MAX_COMMAND_BYTES,
    connectorArgs: MAX_CONNECTOR_ARGS,
    secretEntries: MAX_SECRET_ENTRIES,
    marketplacePlugins: MAX_MARKETPLACE_PLUGINS,
} as const;
