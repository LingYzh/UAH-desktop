import { parseModelParameters, type ModelParameters } from './model-parameters';

export type ApiProtocol = 'openai-chat' | 'openai-responses' | 'anthropic';
export type ModelModality = 'text' | 'image' | 'audio' | 'video' | 'file' | 'pdf';

export interface ModelDetails {
    id: string;
    inputModalities?: ModelModality[];
    outputModalities?: ModelModality[];
    contextWindow?: number;
    maxOutputTokens?: number;
    tools?: boolean;
    vision?: boolean;
    reasoning?: boolean;
    streaming?: boolean;
    imageInput?: boolean;
    pdfInput?: boolean;
    audioInput?: boolean;
    videoInput?: boolean;
}

export interface ModelCatalog {
    models: string[];
    modelDetails: ModelDetails[];
}

export interface EndpointRecord {
    id: string;
    name: string;
    protocol: ApiProtocol;
    baseUrl: string;
    models: string[];
    modelDetails?: ModelDetails[];
    modelOverrides?: ModelDetails[];
    modelParameters?: Array<{ id: string; parameters: ModelParameters }>;
    enabled: boolean;
    revision: number;
    hasKey: boolean;
}

export interface ApiConnection extends Omit<EndpointRecord, 'hasKey'> {
    apiKey: string;
}

export interface ApiMessage {
    role: 'user' | 'assistant';
    content: string;
}

export interface EndpointDraft {
    id: string | null;
    name: string;
    protocol: ApiProtocol;
    baseUrl: string;
    models: string[];
    modelDetails?: ModelDetails[];
    modelOverrides?: ModelDetails[];
    modelParameters?: Array<{ id: string; parameters: ModelParameters }>;
    enabled: boolean;
    revision: number;
    // null preserves the stored key; empty string explicitly removes it.
    apiKey: string | null;
}

export type EndpointCommand =
    | { type: 'list' }
    | { type: 'save'; draft: EndpointDraft }
    | { type: 'delete'; id: string; revision: number }
    | { type: 'discover'; draft: EndpointDraft }
    | { type: 'test'; draft: EndpointDraft; modelId: string };

export interface EndpointReply {
    endpoints: EndpointRecord[];
    models?: string[];
    modelDetails?: ModelDetails[];
    tested?: boolean;
    testResult?: ApiTestResult;
}

export interface ApiTestResult {
    text: string;
    elapsedMs: number;
}

function record(value: unknown, keys: string[], optionalKeys: string[] = []): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || ![...keys, ...optionalKeys].includes(key))
        || keys.some((key) => !Object.hasOwn(value, key) || !('value' in Object.getOwnPropertyDescriptor(value, key)!))
        || optionalKeys.some((key) => Object.hasOwn(value, key) && !('value' in Object.getOwnPropertyDescriptor(value, key)!))) {
        throw new TypeError('端点请求格式无效。');
    }
}

function text(value: unknown, max: number): string {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError('端点字段为空、过长或含有控制字符。');
    }
    return value.trim();
}

export function normalizeBaseUrl(value: unknown): string {
    const source = text(value, 2048);
    let url: URL;
    try { url = new URL(source); } catch { throw new TypeError('请输入有效的 API 基础地址。'); }
    const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(url.hostname);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
        || url.username || url.password || url.search || url.hash) {
        throw new TypeError('API 地址须为 HTTPS 或本机回环 HTTP，且不能包含账号、查询参数或片段。');
    }
    return url.href.replace(/\/+$/, '');
}

function revision(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) throw new TypeError('端点版本无效。');
    return value as number;
}

function positiveInteger(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > 1_000_000_000) {
        throw new TypeError('模型能力数值无效。');
    }
    return value as number;
}

function modalities(value: unknown): ModelModality[] {
    if (!Array.isArray(value) || value.length > 6 || value.some((item) => !['text', 'image', 'audio', 'video', 'file', 'pdf'].includes(item as string))) {
        throw new TypeError('模型模态无效。');
    }
    const result = value as ModelModality[];
    if (new Set(result).size !== result.length) {
        throw new TypeError('模型模态不能重复。');
    }
    return [...result];
}

function modelDetails(value: unknown, models: string[]): ModelDetails[] | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value) || value.length > 500) {
        throw new TypeError('模型能力最多包含 500 项。');
    }
    const seen = new Set<string>();
    return value.map((item) => {
        record(item, ['id'], [
            'inputModalities', 'outputModalities', 'contextWindow', 'maxOutputTokens',
            'tools', 'vision', 'reasoning', 'streaming', 'imageInput', 'pdfInput', 'audioInput', 'videoInput',
        ]);
        const id = text(item.id, 200);
        if (!models.includes(id) || seen.has(id)) {
            throw new TypeError('模型能力必须对应唯一的模型 ID。');
        }
        seen.add(id);
        const result: ModelDetails = { id };
        if (Object.hasOwn(item, 'inputModalities')) result.inputModalities = modalities(item.inputModalities);
        if (Object.hasOwn(item, 'outputModalities')) result.outputModalities = modalities(item.outputModalities);
        if (Object.hasOwn(item, 'contextWindow')) result.contextWindow = positiveInteger(item.contextWindow);
        if (Object.hasOwn(item, 'maxOutputTokens')) result.maxOutputTokens = positiveInteger(item.maxOutputTokens);
        for (const name of ['tools', 'vision', 'reasoning', 'streaming', 'imageInput', 'pdfInput', 'audioInput', 'videoInput'] as const) {
            if (Object.hasOwn(item, name)) {
                if (typeof item[name] !== 'boolean') throw new TypeError('模型能力布尔值无效。');
                result[name] = item[name] as boolean;
            }
        }
        return result;
    });
}

function modelParameters(value: unknown, models: string[]): Array<{ id: string; parameters: ModelParameters }> | undefined {
    if (value === undefined) {
        return undefined;
    }
    if (!Array.isArray(value)
        || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > 500) {
        throw new TypeError('模型参数最多包含 500 项。');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1
        || keys.some((key) => key !== 'length'
            && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new TypeError('模型参数列表格式无效。');
    }
    const seen = new Set<string>();
    const result: Array<{ id: string; parameters: ModelParameters }> = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) {
            throw new TypeError('模型参数列表格式无效。');
        }
        const item = descriptor.value;
        record(item, ['id', 'parameters']);
        const id = text(item.id, 200);
        if (!models.includes(id) || seen.has(id)) {
            throw new TypeError('模型参数必须对应唯一的模型 ID。');
        }
        seen.add(id);
        result.push({ id, parameters: parseModelParameters(item.parameters) });
    }
    return result;
}

export function parseEndpointDraft(value: unknown): EndpointDraft {
    record(value, ['id', 'name', 'protocol', 'baseUrl', 'models', 'enabled', 'revision', 'apiKey'], ['modelDetails', 'modelOverrides', 'modelParameters']);
    if (!['openai-chat', 'openai-responses', 'anthropic'].includes(value.protocol as string)) throw new TypeError('API 协议无效。');
    if (typeof value.enabled !== 'boolean') throw new TypeError('启用状态无效。');
    if (!Array.isArray(value.models) || value.models.length > 500) throw new TypeError('模型目录最多包含 500 项。');
    const models = [...new Set(value.models.map((item) => text(item, 200)))];
    if (value.apiKey !== null && (typeof value.apiKey !== 'string' || value.apiKey.length > 8192 || /[^\x20-\x7e]/.test(value.apiKey))) {
        throw new TypeError('API Key 格式无效。');
    }
    const parsedDetails = modelDetails(value.modelDetails, models);
    const parsedOverrides = modelDetails(value.modelOverrides, models);
    const parsedParameters = modelParameters(value.modelParameters, models);
    return {
        id: value.id === null ? null : text(value.id, 200),
        name: text(value.name, 100),
        protocol: value.protocol as ApiProtocol,
        baseUrl: normalizeBaseUrl(value.baseUrl),
        models,
        enabled: value.enabled,
        revision: revision(value.revision),
        apiKey: value.apiKey === null ? null : (value.apiKey as string).trim(),
        ...(parsedDetails === undefined ? {} : { modelDetails: parsedDetails }),
        ...(parsedOverrides === undefined ? {} : { modelOverrides: parsedOverrides }),
        ...(parsedParameters === undefined ? {} : { modelParameters: parsedParameters }),
    };
}

/** Combines provider-reported model details with manual, field-level capability overrides. */
export function effectiveModelDetails(
    endpoint: Pick<EndpointRecord, 'modelDetails' | 'modelOverrides'>,
    id: string,
): ModelDetails {
    const reported = endpoint.modelDetails?.find((item) => item.id === id);
    const overridden = endpoint.modelOverrides?.find((item) => item.id === id);
    const details = { ...reported, ...overridden, id };
    // Copy the only nested values explicitly; callers can be Vue reactive proxies.
    if (details.inputModalities) details.inputModalities = [...details.inputModalities];
    if (details.outputModalities) details.outputModalities = [...details.outputModalities];
    return details;
}

export function parseEndpointCommand(value: unknown): EndpointCommand {
    if (!value || typeof value !== 'object') throw new TypeError('端点请求格式无效。');
    const type = (value as Record<string, unknown>).type;
    switch (type) {
        case 'list':
            record(value, ['type']);
            return { type: 'list' };
        case 'save':
        case 'discover':
            record(value, ['type', 'draft']);
            return { type, draft: parseEndpointDraft(value.draft) };
        case 'delete':
            record(value, ['type', 'id', 'revision']);
            return { type: 'delete', id: text(value.id, 200), revision: revision(value.revision) };
        case 'test':
            record(value, ['type', 'draft', 'modelId']);
            return { type: 'test', draft: parseEndpointDraft(value.draft), modelId: text(value.modelId, 200) };
        default:
            throw new TypeError('未知端点操作。');
    }
}
