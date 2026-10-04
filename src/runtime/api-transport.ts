import { extractModelDetails } from './model-details';
import { CONTEXT_LIMITS } from './context/meter';
import { contextRoute } from './context/replay-domain';
import { freezeJson } from './context/projection';
import { planCache, type CacheFrontier, type CachePlan } from './context/cache-planner';
import type { AgentStreamEvent, ApiUsage, ToolCall, ToolDefinition, ToolResult } from '../shared/tool-protocol.js';
import type { ModelParameters } from '../shared/model-parameters.js';
import type { ModelDetails, ModelCatalog, ApiTestResult } from '../shared/endpoints';
import { createDiagnosticTrace } from './diagnostics';
import { normalizeBaseUrl, type ApiConnection, type ApiMessage } from '../shared/endpoints.js';
import { mergeUsageSnapshot, normalizeProviderUsage } from './context/usage-normalizer.js';

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_REQUEST_BYTES = CONTEXT_LIMITS.requestBytes;
const MAX_RESPONSE_BYTES = 16_000_000;
const MAX_JSON_RESPONSE_BYTES = 2_000_000;
const MAX_SSE_FRAME_BYTES = 1_000_000;
const MAX_OUTPUT_CHARACTERS = 500_000;
const MAX_MODELS = 500;
const MAX_MODEL_PAGES = 10;

type ApiProtocol = ApiConnection['protocol'];
type TransportFailure = 'cancelled' | 'timeout' | 'network' | 'invalid' | 'truncated' | 'incomplete' | 'tool' | 'server';

export interface RequestIdentity { requestId: string; attemptId: string; }
export interface RequestObserver {
    prepared(body: Record<string, unknown>, protocol: ApiProtocol): void;
    dispatch(): void;
    responseStarted(): void;
    providerEvent(event: { event?: string; data: string }): void;
    terminal(status: 'completed' | 'failed' | 'cancelled'): void;
}
/** Recording acknowledgement failed; never reinterpret this as a provider/network failure. */
export class RequestRecordingError extends Error {
    constructor(readonly partial = false) {
        super('Request recording failed; request execution has been stopped.');
        this.name = 'RequestRecordingError';
    }
}

export class ApiTransportError extends Error {
    constructor(message: string, readonly reason = 'invalid') {
        super(message);
        this.name = 'ApiTransportError';
    }
}

const FAILURE_MESSAGES: Record<TransportFailure, string> = {
    cancelled: '请求已取消。',
    timeout: '模型服务请求超时。',
    network: '无法连接到模型服务。',
    invalid: '模型服务返回的数据无效。',
    truncated: '模型服务提前结束了响应。',
    incomplete: '模型服务未能完成文本响应。',
    tool: '模型请求了当前不支持的工具。',
    server: '模型服务返回了错误。',
};

const DIAGNOSTIC_MESSAGES: Record<string, string> = {
    'json.decode': '响应无法解析为 UTF-8 JSON。请检查基础地址及版本前缀；服务可能返回了 HTML 页面或非 JSON 正文。',
    'json.object_expected': 'JSON 顶层必须是对象，实际返回了数组、空值或其他类型。',
    'models.data_array_expected': '模型目录缺少 data 数组，或 data 的类型不是数组。当前协议要求 {"data":[{"id":"模型 ID"}]}。',
    'models.count_limit': '模型目录超过当前允许的 500 项上限。',
    'models.id_invalid': '模型条目的 id 必须是非空字符串，长度不超过 200，且不能含控制字符或首尾空格。',
    'models.pagination_invalid': '模型目录分页信息无效：has_more / last_id 缺失、游标重复，或超过 10 页上限。',
    'body.byte_limit': '响应正文超过 2000000 字节上限，已停止读取。',
    'body.missing': '服务返回了空响应体，无法读取模型数据。',
    'sse.json_decode': '流式事件的 data 无法解析为 JSON。请检查所选协议是否与服务一致。',
    'sse.object_expected': '流式事件 JSON 必须是对象，实际类型不符。',
    'sse.text_expected': '流式事件中的文本字段不是字符串。',
    'sse.delta_expected': '流式事件中的 delta 字段不是对象。',
    'chat.choices_expected': 'Chat Completions 流式响应缺少 choices 数组；请检查是否选错协议。',
    'chat.choice_expected': 'Chat Completions 的 choices[0] 不是对象。',
    'sse.frame_limit': '单个流式事件或未分行数据超过 1000000 字符上限。',
    'sse.byte_limit': '流式响应总量超过 16000000 字节上限。',
    'sse.read_or_encoding': '读取流式响应失败，或响应包含无效 UTF-8 编码。',
    'stream.output_limit': '累计文本输出超过 500000 字符上限。',
};

function fail(kind: TransportFailure, reason: string = kind, detail?: string): never {
    throw new ApiTransportError(detail ?? DIAGNOSTIC_MESSAGES[reason] ?? FAILURE_MESSAGES[kind], reason);
}

function failHttp(status: number): never {
    const safeStatus = Number.isInteger(status) && status >= 100 && status <= 599 ? status : 500;
    throw new ApiTransportError(`模型服务返回 HTTP ${safeStatus}。${safeStatus === 401 ? '认证失败，请检查 API Key。' : safeStatus === 403 ? '服务拒绝访问，请检查密钥权限。' : safeStatus === 404 ? '接口不存在，请检查基础地址、版本前缀和协议。' : safeStatus === 429 ? '请求受到限流或额度限制，请检查服务配额。' : ''}`, `http.${safeStatus}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateConnection(connection: ApiConnection): { protocol: ApiProtocol; baseUrl: string; apiKey: string } {
    try {
        if (!isRecord(connection)) {
            fail('invalid');
        }
        const protocol = connection.protocol;
        if (protocol !== 'openai-chat' && protocol !== 'openai-responses' && protocol !== 'anthropic') {
            fail('invalid');
        }
        if (typeof connection.baseUrl !== 'string' || connection.baseUrl.length > 2_048) {
            fail('invalid');
        }
        if (typeof connection.apiKey !== 'string' || connection.apiKey.length > 8_192
            || /[^\x20-\x7e]/.test(connection.apiKey)) {
            fail('invalid');
        }
        return {
            protocol,
            baseUrl: normalizeBaseUrl(connection.baseUrl),
            apiKey: connection.apiKey.trim(),
        };
    } catch (error) {
        if (error instanceof ApiTransportError) {
            throw error;
        }
        fail('invalid');
    }
}

function validateModelId(modelId: string): string {
    if (typeof modelId !== 'string' || modelId.length === 0 || modelId.length > 200
        || modelId.trim() !== modelId || /[\u0000-\u001f\u007f]/.test(modelId)) {
        fail('invalid');
    }
    return modelId;
}

function validateMessages(messages: ApiMessage[]): ApiMessage[] {
    if (!Array.isArray(messages) || messages.length > 1_000) {
        fail('invalid');
    }
    const validated: ApiMessage[] = [];
    let contentBytes = 0;
    const encoder = new TextEncoder();
    for (const message of messages) {
        if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant')
            || typeof message.content !== 'string') {
            fail('invalid');
        }
        contentBytes += encoder.encode(message.content).byteLength;
        if (contentBytes > MAX_REQUEST_BYTES) {
            fail('invalid');
        }
        validated.push({ role: message.role, content: message.content });
    }
    return validated;
}

function endpointUrl(baseUrl: string, path: string): string {
    return `${baseUrl}/${path}`;
}

function headersFor(
    connection: { protocol: ApiProtocol; apiKey: string },
    acceptsStream: boolean,
): HeadersInit {
    const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: acceptsStream ? 'text/event-stream' : 'application/json',
    };
    if (connection.protocol === 'anthropic') {
        headers['anthropic-version'] = '2023-06-01';
        if (connection.apiKey) {
            headers['x-api-key'] = connection.apiKey;
        }
    } else if (connection.apiKey) {
        headers.authorization = `Bearer ${connection.apiKey}`;
    }
    return headers;
}

export interface ApiStreamOptions {
    instructions?: string;
    parameters?: ModelParameters;
}

function requestBody(
    protocol: ApiProtocol,
    modelId: string,
    messages: ApiMessage[],
    maxOutputTokens?: number,
    options: ApiStreamOptions = {},
): string {
    const parameters = options.parameters;
    const instructions = options.instructions;
    maxOutputTokens ??= parameters?.maxOutputTokens ?? undefined;
    if (instructions !== undefined && (typeof instructions !== 'string' || instructions.length > 64_000)) {
        fail('invalid', 'agent.instructions', '智能体指令无效。');
    }
    if (parameters?.thinkingBudget != null && protocol !== 'anthropic') {
        fail('invalid', 'agent.thinking_protocol', '当前 OpenAI 协议不支持显式思考预算。');
    }
    if (protocol === 'openai-responses' && parameters?.stop.length) {
        fail('invalid', 'agent.stop_protocol', 'Responses 协议不支持停止序列。');
    }
    if (protocol === 'anthropic' && parameters) {
        if (!['default', 'none', 'low', 'medium', 'high', 'xhigh', 'max'].includes(parameters.reasoningEffort)) {
            fail('invalid', 'agent.effort_protocol', 'Anthropic 不支持该思考强度；请选择默认、关闭、low、medium、high、xhigh 或 max。');
        }
        if (parameters.reasoningEffort !== 'default' && parameters.thinkingBudget !== null) {
            fail('invalid', 'agent.thinking_conflict', '思考强度与固定思考预算不能同时设置；请选择其中一种。');
        }
        if (parameters.thinkingBudget !== null) {
            if (parameters.thinkingBudget >= (maxOutputTokens ?? 4_096)) {
                fail('invalid', 'agent.thinking_limit', '思考预算必须小于最大输出 token 数。');
            }
            if (parameters.temperature !== null || (parameters.topP !== null && parameters.topP < 0.95)) {
                fail('invalid', 'agent.thinking_sampling', 'Anthropic 思考预算不能与 temperature 或小于 0.95 的 topP 同时配置。');
            }
        }
        if (parameters.temperature !== null && parameters.temperature > 1) {
            fail('invalid', 'agent.temperature', 'Anthropic temperature 必须在 0 到 1 之间。');
        }
    }
    let body: Record<string, unknown>;
    if (protocol === 'openai-chat') {
        body = {
            model: modelId,
            messages: instructions ? [{ role: 'system', content: instructions }, ...messages] : messages,
            stream: true,
            store: false,
            ...(maxOutputTokens === undefined ? {} : { max_completion_tokens: maxOutputTokens }),
        };
    } else if (protocol === 'openai-responses') {
        body = {
            model: modelId,
            input: messages.map(({ role, content }) => ({ role, content })),
            stream: true,
            store: false,
            ...(maxOutputTokens === undefined ? {} : { max_output_tokens: maxOutputTokens }),
            ...(instructions ? { instructions } : {}),
        };
    } else {
        body = {
            model: modelId,
            max_tokens: maxOutputTokens ?? 4_096,
            messages,
            stream: true,
            ...(instructions ? { system: instructions } : {}),
        };
    }
    if (parameters) {
        if (parameters.temperature !== null) body.temperature = parameters.temperature;
        if (parameters.topP !== null) body.top_p = parameters.topP;
        if (parameters.stop.length) body[protocol === 'anthropic' ? 'stop_sequences' : 'stop'] = [...parameters.stop];
        if (parameters.reasoningEffort !== 'default') {
            if (protocol === 'openai-chat') body.reasoning_effort = parameters.reasoningEffort;
            else if (protocol === 'openai-responses') body.reasoning = { effort: parameters.reasoningEffort };
            else if (parameters.reasoningEffort === 'none') body.thinking = { type: 'disabled' };
            else {
                body.thinking = { type: 'adaptive' };
                body.output_config = { effort: parameters.reasoningEffort };
            }
        }
        if (parameters.thinkingBudget !== null) body.thinking = { type: 'enabled', budget_tokens: parameters.thinkingBudget };
    }
    const serialized = JSON.stringify(body);
    if (new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) {
        fail('invalid');
    }
    return serialized;
}

interface RequestScope {
    trace: ReturnType<typeof createDiagnosticTrace>;
    response(status: number, contentType: string): void;
    success(count?: number): void;
    failure(error: unknown): ApiTransportError;
    signal: AbortSignal;
    abortError(): ApiTransportError | null;
    dispose(): void;
    throwIfAborted(): void;
}

function createRequestScope(signal?: AbortSignal, operation: 'models' | 'stream' | 'test' = 'stream', protocol = 'unknown', timeoutMs = REQUEST_TIMEOUT_MS, identity?: RequestIdentity): RequestScope {
    const trace = createDiagnosticTrace(operation, protocol, identity);
    const started = Date.now();
    let finished = false;
    let responseSummary = '尚未收到 HTTP 响应';
    trace.event('request.start');
    const controller = new AbortController();
    let abortKind: 'cancelled' | 'timeout' | undefined;
    const onAbort = () => {
        abortKind = 'cancelled';
        controller.abort();
    };
    if (signal?.aborted) {
        abortKind = 'cancelled';
        controller.abort();
    } else {
        signal?.addEventListener('abort', onAbort, { once: true });
    }
    const timer = setTimeout(() => {
        if (!controller.signal.aborted) {
            abortKind = 'timeout';
            controller.abort();
        }
    }, timeoutMs);

    const abortError = () => (abortKind ? new ApiTransportError(FAILURE_MESSAGES[abortKind], abortKind) : null);
    return {
        trace,
        response(status, contentType) {
            responseSummary = `HTTP ${status}，响应类型：${contentType}`;
            trace.event('http.response', { status, contentType });
        },
        success(count) {
            finished = true;
            trace.event('request.complete', { elapsedMs: Date.now() - started, ...(count === undefined ? {} : { count }) });
        },
        failure(error) {
            const cause = abortError() ?? (error instanceof ApiTransportError ? error : new ApiTransportError(FAILURE_MESSAGES.network, 'network'));
            finished = true;
            trace.event('request.failed', { reason: cause.reason, elapsedMs: Date.now() - started });
            return new ApiTransportError(cause.message + '（' + responseSummary + '；原因：' + cause.reason + '；诊断编号：' + trace.id + '）', cause.reason);
        },
        signal: controller.signal,
        abortError,
        dispose() {
            if (!finished) trace.event('request.closed', { outcome: 'consumer_stopped', elapsedMs: Date.now() - started });
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
            if (!controller.signal.aborted) {
                controller.abort();
            }
        },
        throwIfAborted() {
            if (controller.signal.aborted) {
                throw abortError() ?? new ApiTransportError(FAILURE_MESSAGES.cancelled);
            }
        },
    };
}

async function fetchScoped(
    url: string,
    init: RequestInit,
    scope: RequestScope,
    observer?: RequestObserver,
): Promise<Response> {
    scope.throwIfAborted();
    try {
        const path = new URL(url).pathname;
        const route = ['chat/completions', 'responses', 'messages', 'models'].find((value) => path.endsWith('/' + value)) ?? 'custom';
        scope.trace.event('http.send', { method: init.method === 'GET' ? 'GET' : 'POST', route });
        observer?.dispatch();
        const response = await fetch(url, { ...init, redirect: 'error', signal: scope.signal });
        observer?.responseStarted();
        const type = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
        const contentType = ['application/json', 'text/html', 'text/event-stream', 'text/plain'].includes(type ?? '') ? type! : type ? 'other' : 'missing';
        scope.response(response.status, contentType);
        return response;
    } catch (error) {
        if (error instanceof RequestRecordingError) throw error;
        const abortError = scope.abortError();
        if (abortError) {
            throw abortError;
        }
        const cause = error instanceof Error && isRecord(error.cause) ? error.cause : undefined;
        const code = typeof cause?.code === 'string' ? cause.code : '';
        const messages: Record<string, string> = {
            ECONNREFUSED: '连接被拒绝，请确认模型服务已启动且端口正确。',
            ENOTFOUND: '无法解析服务主机名，请检查地址和 DNS。',
            ECONNRESET: '连接被服务或代理重置。',
            ETIMEDOUT: '网络连接超时。',
            UND_ERR_CONNECT_TIMEOUT: '建立连接超时。',
            CERT_HAS_EXPIRED: '服务 TLS 证书已过期。',
            DEPTH_ZERO_SELF_SIGNED_CERT: '服务使用了不受信任的自签名证书。',
            UNABLE_TO_VERIFY_LEAF_SIGNATURE: '无法验证服务 TLS 证书链。',
        };
        if (messages[code]) fail('network', 'network.' + code, '无法连接到模型服务：' + messages[code]);
        if (cause?.message === 'bad port') fail('network', 'network.blocked_port', '无法连接到模型服务：当前端口被网络库的安全规则禁止访问。');
        if (cause?.message === 'unexpected redirect') fail('network', 'network.redirect', '无法连接到模型服务：接口返回重定向，当前不自动跟随，请填写最终 API 基础地址。');
        fail('network');
    }
}

function assertOk(response: Response): void {
    if (!response.ok) {
        failHttp(response.status);
    }
}

async function readBoundedBytes(
    response: Response,
    maximumBytes: number,
    scope: RequestScope,
): Promise<Uint8Array> {
    if (!response.body) {
        fail('invalid', 'body.missing');
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    try {
        while (true) {
            scope.throwIfAborted();
            const result = await reader.read();
            scope.throwIfAborted();
            if (result.done) {
                break;
            }
            totalBytes += result.value.byteLength;
            if (totalBytes > maximumBytes) {
                scope.trace.event('body.limit', { bytes: totalBytes, limit: maximumBytes });
                fail('invalid', 'body.byte_limit');
            }
            chunks.push(result.value);
        }
    } catch (error) {
        if (error instanceof ApiTransportError) {
            throw error;
        }
        const abortError = scope.abortError();
        if (abortError) {
            throw abortError;
        }
        fail('network');
    } finally {
        try {
            await reader.cancel();
        } catch {
            // The response stream may already be closed or aborted.
        }
        reader.releaseLock();
    }

    scope.trace.event('body.read', { bytes: totalBytes });
    const result = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return result;
}

async function readJson(response: Response, scope: RequestScope): Promise<Record<string, unknown>> {
    const bytes = await readBoundedBytes(response, MAX_JSON_RESPONSE_BYTES, scope);
    let parsed: unknown;
    try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
        fail('invalid', 'json.decode');
    }
    if (Array.isArray(parsed)) return { data: parsed };
    if (!isRecord(parsed)) {
        fail('invalid', 'json.object_expected');
    }
    return parsed;
}

interface SseEvent {
    event: string;
    data: string;
}

async function* readSseEvents(
    reader: ReadableStreamDefaultReader<Uint8Array>,
    scope: RequestScope,
): AsyncGenerator<SseEvent> {
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let buffer = '';
    let eventName = '';
    const dataLines: string[] = [];
    let eventBytes = 0;
    let totalBytes = 0;

    const dispatch = (): SseEvent | undefined => {
        if (dataLines.length === 0) {
            eventName = '';
            eventBytes = 0;
            return undefined;
        }
        const result = { event: eventName || 'message', data: dataLines.join('\n') };
        eventName = '';
        dataLines.length = 0;
        eventBytes = 0;
        return result;
    };

    const acceptLine = (line: string): SseEvent | undefined => {
        if (line.length === 0) {
            return dispatch();
        }
        if (line.startsWith(':')) {
            return undefined;
        }
        const separator = line.indexOf(':');
        const field = separator < 0 ? line : line.slice(0, separator);
        let value = separator < 0 ? '' : line.slice(separator + 1);
        if (value.startsWith(' ')) {
            value = value.slice(1);
        }
        if (field === 'event') {
            eventName = value;
            eventBytes += value.length;
        } else if (field === 'data') {
            dataLines.push(value);
            eventBytes += value.length + 1;
        }
        if (eventBytes > MAX_SSE_FRAME_BYTES) {
            fail('invalid', 'sse.frame_limit');
        }
        return undefined;
    };

    try {
        while (true) {
            scope.throwIfAborted();
            const result = await reader.read();
            scope.throwIfAborted();
            if (result.done) {
                break;
            }
            totalBytes += result.value.byteLength;
            if (totalBytes > MAX_RESPONSE_BYTES) {
                fail('invalid', 'sse.byte_limit');
            }
            buffer += decoder.decode(result.value, { stream: true });
            if (buffer.length > MAX_SSE_FRAME_BYTES && !/[\r\n]/.test(buffer)) {
                fail('invalid', 'sse.frame_limit');
            }

            let lineEnd = -1;
            while ((lineEnd = buffer.search(/[\r\n]/)) >= 0) {
                const newline = buffer[lineEnd];
                if (newline === '\r' && lineEnd === buffer.length - 1) {
                    break;
                }
                const line = buffer.slice(0, lineEnd);
                const consumed = newline === '\r' && buffer[lineEnd + 1] === '\n' ? lineEnd + 2 : lineEnd + 1;
                buffer = buffer.slice(consumed);
                const event = acceptLine(line);
                if (event) {
                    yield event;
                }
            }
            if (buffer.length > MAX_SSE_FRAME_BYTES) {
                fail('invalid', 'sse.frame_limit');
            }
        }
        buffer += decoder.decode();
        if (buffer.length > 0) {
            const event = acceptLine(buffer);
            if (event) {
                yield event;
            }
        }
        const finalEvent = dispatch();
        if (finalEvent) {
            yield finalEvent;
        }
    } catch (error) {
        if (error instanceof ApiTransportError) {
            throw error;
        }
        const abortError = scope.abortError();
        if (abortError) {
            throw abortError;
        }
        fail('invalid', 'sse.read_or_encoding');
    }
}

function parseEventData(event: SseEvent): Record<string, unknown> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(event.data);
    } catch {
        fail('invalid', 'sse.json_decode');
    }
    if (!isRecord(parsed)) {
        fail('invalid', 'sse.object_expected');
    }
    if (Object.hasOwn(parsed, 'error')) {
        fail('server');
    }
    return parsed;
}

interface ParsedStreamEvent {
    deltas: string[];
    terminal: boolean;
}

function textValue(value: unknown): string {
    if (typeof value !== 'string') {
        fail('invalid', 'sse.text_expected');
    }
    return value;
}

function checkToolItem(item: unknown): void {
    if (!isRecord(item)) {
        return;
    }
    const type = item.type;
    if (typeof type === 'string' && (type === 'function_call' || type === 'computer_call'
        || type === 'web_search_call' || type === 'file_search_call' || type.endsWith('_call'))) {
        fail('tool');
    }
}

function parseOpenAiChatEvent(event: SseEvent): ParsedStreamEvent {
    if (event.event === 'error') {
        fail('server');
    }
    if (event.data.trim() === '[DONE]') {
        return { deltas: [], terminal: true };
    }
    const payload = parseEventData(event);
    if (payload.type === 'error') {
        fail('server');
    }
    if (!Array.isArray(payload.choices)) {
        fail('invalid', 'chat.choices_expected');
    }
    const first = payload.choices[0];
    if (first === undefined) {
        return { deltas: [], terminal: false };
    }
    if (!isRecord(first)) {
        fail('invalid', 'chat.choice_expected');
    }
    const delta = first.delta;
    const deltas: string[] = [];
    if (delta !== undefined && delta !== null) {
        if (!isRecord(delta)) {
            fail('invalid', 'sse.delta_expected');
        }
        if (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0) {
            fail('tool');
        }
        if (delta.function_call !== undefined && delta.function_call !== null) {
            fail('tool');
        }
        if (delta.content !== undefined && delta.content !== null) {
            deltas.push(textValue(delta.content));
        }
        if (delta.refusal !== undefined && delta.refusal !== null) {
            deltas.push(textValue(delta.refusal));
        }
    }
    if (first.finish_reason === 'tool_calls' || first.finish_reason === 'function_call') {
        fail('tool');
    }
    if (first.finish_reason === 'length' || first.finish_reason === 'content_filter') {
        fail('incomplete');
    }
    if (first.finish_reason !== undefined && first.finish_reason !== null && first.finish_reason !== 'stop') {
        fail('incomplete');
    }
    return { deltas, terminal: false };
}

const RESPONSES_RELEVANT_EVENTS = new Set([
    'error',
    'response.failed',
    'response.incomplete',
    'response.completed',
    'response.output_text.delta',
    'response.refusal.delta',
    'response.output_item.added',
    'response.output_item.done',
    'response.function_call_arguments.delta',
    'response.function_call_arguments.done',
]);

function parseOpenAiResponsesEvent(event: SseEvent): ParsedStreamEvent {
    if (!RESPONSES_RELEVANT_EVENTS.has(event.event)) {
        return { deltas: [], terminal: false };
    }
    if (event.event === 'error' || event.event === 'response.failed' || event.event === 'response.incomplete'
        || event.event === 'response.function_call_arguments.delta'
        || event.event === 'response.function_call_arguments.done') {
        fail(event.event.startsWith('response.function_call') ? 'tool' : 'server');
    }
    const payload = parseEventData(event);
    const type = typeof payload.type === 'string' ? payload.type : event.event;
    if (type === 'error' || type === 'response.failed' || type === 'response.incomplete') {
        fail('server');
    }
    if (type === 'response.completed') {
        const response = payload.response;
        if (isRecord(response)) {
            if (response.status !== undefined && response.status !== 'completed') {
                fail('incomplete');
            }
            if (Array.isArray(response.output)) {
                for (const item of response.output) {
                    checkToolItem(item);
                }
            }
        }
        return { deltas: [], terminal: true };
    }
    if (type === 'response.output_item.added' || type === 'response.output_item.done') {
        checkToolItem(payload.item);
        return { deltas: [], terminal: false };
    }
    if (type === 'response.output_text.delta' || type === 'response.refusal.delta') {
        return { deltas: [textValue(payload.delta)], terminal: false };
    }
    return { deltas: [], terminal: false };
}

const ANTHROPIC_RELEVANT_EVENTS = new Set([
    'error',
    'message_start',
    'content_block_start',
    'content_block_delta',
    'message_delta',
    'message_stop',
]);

function parseAnthropicEvent(event: SseEvent): ParsedStreamEvent {
    if (!ANTHROPIC_RELEVANT_EVENTS.has(event.event)) {
        return { deltas: [], terminal: false };
    }
    if (event.event === 'error') {
        fail('server');
    }
    const payload = parseEventData(event);
    const type = typeof payload.type === 'string' ? payload.type : event.event;
    if (type === 'error') {
        fail('server');
    }
    if (type === 'content_block_start') {
        const block = payload.content_block;
        if (isRecord(block) && (block.type === 'tool_use' || block.type === 'server_tool_use')) {
            fail('tool');
        }
        if (isRecord(block) && block.type === 'text' && block.text !== undefined && block.text !== null) {
            return { deltas: [textValue(block.text)], terminal: false };
        }
        return { deltas: [], terminal: false };
    }
    if (type === 'content_block_delta') {
        const delta = payload.delta;
        if (!isRecord(delta)) {
            fail('invalid', 'sse.delta_expected');
        }
        if (delta.type === 'input_json_delta' || delta.type === 'thinking_delta' || delta.type === 'signature_delta') {
            if (delta.type === 'input_json_delta') {
                fail('tool');
            }
            return { deltas: [], terminal: false };
        }
        if (delta.type === 'text_delta') {
            return { deltas: [textValue(delta.text)], terminal: false };
        }
        return { deltas: [], terminal: false };
    }
    if (type === 'message_delta') {
        const delta = payload.delta;
        if (isRecord(delta) && delta.stop_reason === 'tool_use') {
            fail('tool');
        }
        if (isRecord(delta) && delta.stop_reason === 'max_tokens') {
            fail('incomplete');
        }
        return { deltas: [], terminal: false };
    }
    return { deltas: [], terminal: type === 'message_stop' };
}

function parseProtocolEvent(protocol: ApiProtocol, event: SseEvent): ParsedStreamEvent {
    if (protocol === 'openai-chat') {
        return parseOpenAiChatEvent(event);
    }
    if (protocol === 'openai-responses') {
        return parseOpenAiResponsesEvent(event);
    }
    return parseAnthropicEvent(event);
}

function requestPath(protocol: ApiProtocol): string {
    if (protocol === 'openai-chat') {
        return 'chat/completions';
    }
    if (protocol === 'openai-responses') {
        return 'responses';
    }
    return 'messages';
}

async function* streamApiInternal(
    connectionInput: ApiConnection,
    modelInput: string,
    messagesInput: ApiMessage[],
    signal?: AbortSignal,
    maxOutputTokens?: number,
    options?: ApiStreamOptions,
): AsyncGenerator<string> {
    const connection = validateConnection(connectionInput);
    const modelId = validateModelId(modelInput);
    const messages = validateMessages(messagesInput);
    const body = requestBody(connection.protocol, modelId, messages, maxOutputTokens, options);
    const scope = createRequestScope(signal, maxOutputTokens === undefined ? 'stream' : 'test', connection.protocol,
        options?.parameters ? options.parameters.timeoutSeconds * 1_000 : REQUEST_TIMEOUT_MS);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        const response = await fetchScoped(
            endpointUrl(connection.baseUrl, requestPath(connection.protocol)),
            {
                method: 'POST',
                headers: headersFor(connection, true),
                body,
            },
            scope,
        );
        assertOk(response);
        if (!response.body) {
            fail('invalid', 'body.missing');
        }
        reader = response.body.getReader();
        let terminal = false;
        let outputCharacters = 0;
        for await (const event of readSseEvents(reader, scope)) {
            const result = parseProtocolEvent(connection.protocol, event);
            for (const delta of result.deltas) {
                outputCharacters += delta.length;
                if (outputCharacters > MAX_OUTPUT_CHARACTERS) {
                    fail('invalid', 'stream.output_limit');
                }
                if (delta.length > 0) {
                    yield delta;
                }
            }
            if (result.terminal) {
                if (outputCharacters === 0) {
                    fail('incomplete');
                }
                terminal = true;
                scope.success(outputCharacters);
                return;
            }
        }
        if (!terminal) {
            fail('truncated');
        }
    } catch (error) {
        throw scope.failure(error);
    } finally {
        if (reader) {
            try {
                await reader.cancel();
            } catch {
                // The consumer may have stopped while the body was being read.
            }
            reader.releaseLock();
        }
        scope.dispose();
    }
}

/** Streams text from one of the supported text-only API protocols. */
export function streamApi(
    connection: ApiConnection,
    modelId: string,
    messages: ApiMessage[],
    signal?: AbortSignal,
    options?: ApiStreamOptions,
): AsyncGenerator<string> {
    return streamApiInternal(connection, modelId, messages, signal, undefined, options);
}

export interface AgentApiStreamOptions extends ApiStreamOptions {
    tools: ToolDefinition[];
    requestIdentity?: RequestIdentity;
    observer?: RequestObserver;
    /** Full native history returned by the previous completed round, plus correlated tool results. */
    continuation?: unknown[];
    /** Internal frozen compilation, shared by admission, journal and transport. */
    preparedRequest?: PreparedAgentRequest;
    cachePlanning?: { previous?: CacheFrontier };
    /** Compiler inspection only; transport always enforces the byte limit. */
    inspectOversized?: boolean;
}

export interface PreparedAgentRequest {
    routeKey: string;
    protocol: ApiProtocol;
    modelId: string;
    body: Record<string, unknown>;
    serialized: string;
    history: unknown[];
    tools: ToolDefinition[];
    cachePlan?: CachePlan;
}

const MAX_TOOL_CALLS = 64;
const MAX_TOOL_ARGUMENT_BYTES = 1_000_000;

function boundedNativeHistory(value: unknown, inspectOversized = false): unknown[] {
    if (!Array.isArray(value) || value.length > 4_000) fail('invalid');
    let serialized: string;
    try { serialized = JSON.stringify(value); } catch { fail('invalid'); }
    if (new TextEncoder().encode(serialized).byteLength > (inspectOversized ? 16_000_000 : MAX_REQUEST_BYTES)) fail('invalid', 'context.request_body_bytes_exceeded');
    return JSON.parse(serialized) as unknown[];
}

function validateTools(tools: ToolDefinition[]): ToolDefinition[] {
    if (!Array.isArray(tools) || tools.length > MAX_TOOL_CALLS) fail('invalid');
    const names = new Set<string>();
    return tools.map(tool => {
        if (!isRecord(tool) || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.name)
            || names.has(tool.name) || typeof tool.description !== 'string' || tool.description.length > 16_000
            || !isRecord(tool.parameters)) fail('invalid');
        names.add(tool.name);
        return { name: tool.name, description: tool.description, parameters: structuredClone(tool.parameters) };
    });
}

function finalizedCalls(calls: ToolCall[], tools?: ToolDefinition[]): ToolCall[] {
    if (calls.length > MAX_TOOL_CALLS) fail('invalid', 'tools.count', '模型请求的工具数量超过上限。');
    const ids = new Set<string>();
    let bytes = 0;
    for (const call of calls) {
        if (typeof call.id !== 'string' || !call.id || call.id.length > 200 || /[\u0000-\u001f\u007f]/.test(call.id)
            || ids.has(call.id) || typeof call.name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(call.name)
            || typeof call.arguments !== 'string') fail('invalid', 'tools.identity', '模型返回的工具调用标识无效。');
        ids.add(call.id);
        bytes += new TextEncoder().encode(call.arguments).byteLength;
        if (bytes > MAX_TOOL_ARGUMENT_BYTES) fail('invalid', 'tools.arguments_limit', '工具参数超过大小上限。');
        let parsed: unknown;
        try { parsed = JSON.parse(call.arguments); } catch { fail('invalid', 'tools.arguments_json', '模型返回的工具参数不是完整 JSON。'); }
        if (!isRecord(parsed)) fail('invalid', 'tools.arguments_object', '工具参数必须是 JSON 对象。');
        if (tools && !tools.some(tool => tool.name === call.name)) fail('tool');
    }
    return calls;
}

/** Appends exactly one result for every pending call in the latest completed round. */
export function appendToolResults(protocol: ApiConnection['protocol'], continuation: unknown[], results: ToolResult[]): unknown[] {
    const history = boundedNativeHistory(continuation);
    let calls: ToolCall[];
    const last = history.at(-1);
    if (protocol === 'openai-chat') {
        if (!isRecord(last) || last.role !== 'assistant' || !Array.isArray(last.tool_calls)) fail('invalid');
        calls = last.tool_calls.map(item => {
            if (!isRecord(item) || item.type !== 'function' || !isRecord(item.function)) fail('invalid');
            return { id: textValue(item.id), name: textValue(item.function.name), arguments: textValue(item.function.arguments) };
        });
    } else if (protocol === 'anthropic') {
        if (!isRecord(last) || last.role !== 'assistant' || !Array.isArray(last.content)) fail('invalid');
        calls = last.content.filter(item => isRecord(item) && item.type === 'tool_use').map(item => ({
            id: textValue(item.id), name: textValue(item.name), arguments: JSON.stringify(item.input),
        }));
    } else if (protocol === 'openai-responses') {
        const round: unknown[] = [];
        for (let index = history.length - 1; index >= 0; index -= 1) {
            const item = history[index];
            if (!isRecord(item)) fail('invalid');
            if (item.type === 'function_call_output' || item.role === 'user' || (item.role === 'assistant' && item.type !== 'message')) break;
            round.unshift(item);
        }
        calls = round.filter((item): item is Record<string, unknown> => isRecord(item) && item.type === 'function_call').map(item => ({
            id: textValue(item.call_id), name: textValue(item.name), arguments: textValue(item.arguments),
        }));
    } else fail('invalid');
    finalizedCalls(calls);
    if (!Array.isArray(results) || calls.length === 0 || results.length !== calls.length) fail('invalid');
    const resultIds = new Set<string>();
    for (const result of results) {
        if (!isRecord(result) || typeof result.id !== 'string' || !calls.some(call => call.id === result.id)
            || resultIds.has(result.id) || typeof result.content !== 'string'
            || (result.isError !== undefined && typeof result.isError !== 'boolean')) fail('invalid');
        resultIds.add(result.id);
    }
    const ordered = calls.map(call => results.find(result => result.id === call.id)!);
    if (protocol === 'anthropic') history.push({ role: 'user', content: ordered.map(result => ({
        type: 'tool_result', tool_use_id: result.id, content: result.content, ...(result.isError ? { is_error: true } : {}),
    })) });
    else if (protocol === 'openai-chat') history.push(...ordered.map(result => ({ role: 'tool', tool_call_id: result.id, content: result.content })));
    else history.push(...ordered.map(result => ({ type: 'function_call_output', call_id: result.id, output: result.content })));
    return boundedNativeHistory(history);
}

interface AgentRound {
    events: Array<Exclude<AgentStreamEvent, { type: 'complete' }>>;
    complete?: { toolCalls: ToolCall[]; output: unknown[] };
}

class AgentStreamAccumulator {
    private usage: ApiUsage = {};
    private usageRaw: Record<string, unknown> = {};
    private textCount = 0;
    private reasoningCount = 0;
    private argumentBytes = 0;
    private chatText = '';
    private chatReasoning: Record<string, string> = {};
    private chatFinish: string | undefined;
    private readonly chatCalls = new Map<number, ToolCall>();
    private readonly responseItems = new Map<number, Record<string, unknown>>();
    private readonly responseArgumentDeltas = new Map<number, string>();
    private readonly responseFinished = new Set<number>();
    private readonly responseDisplayed = new Map<string, string>();
    private readonly anthropicBlocks = new Map<number, Record<string, unknown>>();
    private readonly anthropicArguments = new Map<number, string>();
    private readonly anthropicClosed = new Set<number>();
    private anthropicStop: string | undefined;

    constructor(private readonly protocol: ApiProtocol, private readonly tools: ToolDefinition[]) {}

    private usageEvents(value: unknown): AgentRound['events'] {
        if (!isRecord(value)) return [];
        this.usageRaw = mergeUsageSnapshot(this.usageRaw, value);
        const next = normalizeProviderUsage(this.protocol, this.usageRaw, this.usage).usage;
        if (JSON.stringify(next) === JSON.stringify(this.usage)) return [];
        this.usage = next;
        return [{ type: 'usage', usage: { ...next } }];
    }

    private emit(type: 'text' | 'reasoning', value: unknown): AgentRound['events'] {
        const text = textValue(value);
        if (type === 'text') this.textCount += text.length;
        else this.reasoningCount += text.length;
        if (this.textCount > MAX_OUTPUT_CHARACTERS || this.reasoningCount > MAX_OUTPUT_CHARACTERS) fail('invalid', 'stream.output_limit');
        return text ? [{ type, text }] : [];
    }

    private index(value: unknown): number {
        if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 1_000) fail('invalid');
        return value as number;
    }

    private argumentDelta(value: unknown): string {
        const delta = textValue(value);
        this.argumentBytes += new TextEncoder().encode(delta).byteLength;
        if (this.argumentBytes > MAX_TOOL_ARGUMENT_BYTES) fail('invalid', 'tools.arguments_limit', '工具参数超过大小上限。');
        return delta;
    }

    accept(event: SseEvent): AgentRound {
        if (event.event === 'error') fail('server');
        if (this.protocol === 'openai-chat') return this.chat(event);
        const payload = parseEventData(event);
        const type = typeof payload.type === 'string' ? payload.type : event.event;
        if (type === 'error' || type === 'response.failed') fail('server');
        if (type === 'response.incomplete') fail('incomplete');
        return this.protocol === 'openai-responses' ? this.responses(type, payload) : this.anthropic(type, payload);
    }

    private chat(event: SseEvent): AgentRound {
        if (event.data.trim() === '[DONE]') {
            const calls = [...this.chatCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
            if (calls.length && this.chatFinish !== 'tool_calls') fail('incomplete');
            if (!calls.length && this.chatFinish === 'tool_calls') fail('invalid');
            if (!calls.length && this.chatFinish !== 'stop') fail('incomplete');
            if (!calls.length && !this.textCount && !this.reasoningCount) fail('incomplete');
            finalizedCalls(calls, this.tools);
            return { events: [], complete: { toolCalls: calls, output: [{ role: 'assistant', content: this.chatText || null,
                ...this.chatReasoning, ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function',
                    function: { name: call.name, arguments: call.arguments } })) } : {}) }] } };
        }
        const payload = parseEventData(event);
        if (payload.type === 'error') fail('server');
        if (!Array.isArray(payload.choices)) fail('invalid', 'chat.choices_expected');
        if (!payload.choices.length) return { events: this.usageEvents(payload.usage) };
        if (payload.choices.length !== 1 || !isRecord(payload.choices[0])) fail('invalid');
        const choice = payload.choices[0];
        const events: AgentRound['events'] = this.usageEvents(payload.usage);
        if (choice.finish_reason != null) {
            if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') fail('incomplete');
            this.chatFinish = choice.finish_reason;
        }
        const delta = choice.delta;
        if (delta != null) {
            if (!isRecord(delta) || delta.function_call != null) fail('invalid');
            for (const field of ['content', 'refusal'] as const) if (delta[field] != null) {
                events.push(...this.emit('text', delta[field]));
                this.chatText += textValue(delta[field]);
            }
            for (const field of ['reasoning_content', 'reasoning'] as const) if (delta[field] != null) {
                events.push(...this.emit('reasoning', delta[field]));
                this.chatReasoning[field] = (this.chatReasoning[field] ?? '') + textValue(delta[field]);
            }
            if (delta.tool_calls != null) {
                if (!Array.isArray(delta.tool_calls)) fail('invalid');
                for (const item of delta.tool_calls) {
                    if (!isRecord(item) || (item.type != null && item.type !== 'function')) fail('invalid');
                    const index = this.index(item.index);
                    let call = this.chatCalls.get(index);
                    if (!call) {
                        if (this.chatCalls.size >= MAX_TOOL_CALLS) fail('invalid');
                        call = { id: '', name: '', arguments: '' };
                        this.chatCalls.set(index, call);
                    }
                    if (item.id != null) {
                        const id = textValue(item.id);
                        if (call.id && call.id !== id) fail('invalid');
                        call.id = id;
                    }
                    if (item.function != null) {
                        if (!isRecord(item.function)) fail('invalid');
                        if (item.function.name != null) call.name += textValue(item.function.name);
                        if (item.function.arguments != null) call.arguments += this.argumentDelta(item.function.arguments);
                    }
                }
            }
        }
        return { events };
    }

    private responses(type: string, payload: Record<string, unknown>): AgentRound {
        if (['response.output_text.delta', 'response.refusal.delta', 'response.reasoning_summary_text.delta', 'response.reasoning_text.delta'].includes(type)) {
            const category = type.includes('reasoning') ? 'reasoning' : 'text';
            const key = `${category}:${payload.output_index ?? 0}:${payload.content_index ?? payload.summary_index ?? 0}`;
            const events = this.emit(category, payload.delta);
            this.responseDisplayed.set(key, (this.responseDisplayed.get(key) ?? '') + textValue(payload.delta));
            return { events };
        }
        if (type === 'response.output_item.added' || type === 'response.output_item.done') {
            const index = this.index(payload.output_index);
            if (!isRecord(payload.item)) fail('invalid');
            if (this.responseFinished.has(index)) fail('invalid');
            const previous = this.responseItems.get(index);
            if (previous && (previous.id !== payload.item.id || previous.type !== payload.item.type)) fail('invalid');
            const accumulatedArguments = this.responseArgumentDeltas.get(index);
            if (type.endsWith('.done') && accumulatedArguments !== undefined && payload.item.arguments !== accumulatedArguments) fail('invalid');
            this.responseItems.set(index, structuredClone(payload.item));
            if (type.endsWith('.done')) this.responseFinished.add(index);
        } else if (type === 'response.function_call_arguments.delta' || type === 'response.function_call_arguments.done') {
            const index = this.index(payload.output_index);
            const item = this.responseItems.get(index);
            if (!item || item.type !== 'function_call' || this.responseFinished.has(index)) fail('invalid');
            if (payload.item_id !== undefined && item.id !== payload.item_id) fail('invalid');
            if (type.endsWith('.delta')) this.responseArgumentDeltas.set(index,
                (this.responseArgumentDeltas.get(index) ?? '') + this.argumentDelta(payload.delta));
            else {
                const argumentsValue = textValue(payload.arguments);
                const deltas = this.responseArgumentDeltas.get(index);
                if (deltas !== undefined && deltas !== argumentsValue) fail('invalid');
                item.arguments = argumentsValue;
            }
        } else if (type === 'response.completed') {
            if (!isRecord(payload.response) || payload.response.status !== 'completed') fail('incomplete');
            let output: unknown[];
            if (Array.isArray(payload.response.output)) output = structuredClone(payload.response.output);
            else {
                if ([...this.responseItems.keys()].some(index => !this.responseFinished.has(index))) fail('incomplete');
                output = [...this.responseItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => structuredClone(item));
            }
            const calls: ToolCall[] = [];
            const events: AgentRound['events'] = this.usageEvents(payload.response.usage);
            const expectedCalls = [...this.responseItems.values()].filter(item => item.type === 'function_call');
            if (expectedCalls.some(expected => !output.some(item => isRecord(item) && item.type === 'function_call'
                && item.id === expected.id && item.call_id === expected.call_id))) fail('incomplete');
            if (!output.length && (this.textCount || this.reasoningCount)) fail('incomplete');
            for (const [index, item] of output.entries()) {
                if (!isRecord(item)) fail('invalid');
                if (item.type === 'function_call') calls.push({ id: textValue(item.call_id), name: textValue(item.name), arguments: textValue(item.arguments) });
                else if (typeof item.type === 'string' && item.type.endsWith('_call')) fail('tool');
                const parts = item.type === 'message' && Array.isArray(item.content) ? item.content
                    : item.type === 'reasoning' && Array.isArray(item.summary) ? item.summary : [];
                for (const [partIndex, part] of parts.entries()) {
                    if (!isRecord(part)) fail('invalid');
                    if (!['output_text', 'refusal', 'summary_text', 'reasoning_text'].includes(String(part.type))) continue;
                    const category = item.type === 'reasoning' ? 'reasoning' : 'text';
                    const key = `${category}:${index}:${partIndex}`;
                    const text = textValue(part.type === 'refusal' ? part.refusal : part.text);
                    const displayed = this.responseDisplayed.get(key) ?? '';
                    if (!text.startsWith(displayed)) fail('invalid');
                    events.push(...this.emit(category, text.slice(displayed.length)));
                }
            }
            finalizedCalls(calls, this.tools);
            if (!calls.length && !this.textCount && !this.reasoningCount) fail('incomplete');
            return { events, complete: { toolCalls: calls, output } };
        }
        if ([...this.responseItems.values()].filter(item => item.type === 'function_call').length > MAX_TOOL_CALLS) fail('invalid');
        return { events: [] };
    }

    private anthropic(type: string, payload: Record<string, unknown>): AgentRound {
        if (type === 'message_start') {
            return { events: isRecord(payload.message) ? this.usageEvents(payload.message.usage) : [] };
        } else if (type === 'content_block_start') {
            const index = this.index(payload.index);
            if (this.anthropicBlocks.has(index) || !isRecord(payload.content_block)) fail('invalid');
            const block = structuredClone(payload.content_block);
            if (!['text', 'thinking', 'redacted_thinking', 'tool_use'].includes(textValue(block.type))) fail('tool');
            this.anthropicBlocks.set(index, block);
            if (block.type === 'text') return { events: this.emit('text', block.text ?? '') };
            if (block.type === 'thinking') return { events: this.emit('reasoning', block.thinking ?? '') };
            if ([...this.anthropicBlocks.values()].filter(item => item.type === 'tool_use').length > MAX_TOOL_CALLS) fail('invalid');
        } else if (type === 'content_block_delta') {
            const index = this.index(payload.index);
            const block = this.anthropicBlocks.get(index);
            if (!block || this.anthropicClosed.has(index) || !isRecord(payload.delta)) fail('invalid');
            const delta = payload.delta;
            if (delta.type === 'text_delta' && block.type === 'text') {
                const events = this.emit('text', delta.text);
                block.text = textValue(block.text ?? '') + textValue(delta.text);
                return { events };
            } else if (delta.type === 'thinking_delta' && block.type === 'thinking') {
                const events = this.emit('reasoning', delta.thinking);
                block.thinking = textValue(block.thinking ?? '') + textValue(delta.thinking);
                return { events };
            } else if (delta.type === 'signature_delta' && block.type === 'thinking') {
                block.signature = textValue(block.signature ?? '') + textValue(delta.signature);
            } else if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
                this.anthropicArguments.set(index, (this.anthropicArguments.get(index) ?? '') + this.argumentDelta(delta.partial_json));
            } else fail('invalid');
        } else if (type === 'content_block_stop') {
            const index = this.index(payload.index);
            const block = this.anthropicBlocks.get(index);
            if (!block || this.anthropicClosed.has(index)) fail('invalid');
            if (block.type === 'tool_use' && this.anthropicArguments.has(index)) {
                try { block.input = JSON.parse(this.anthropicArguments.get(index)!); } catch { fail('invalid', 'tools.arguments_json'); }
            }
            this.anthropicClosed.add(index);
        } else if (type === 'message_delta') {
            if (!isRecord(payload.delta)) fail('invalid');
            if (payload.delta.stop_reason != null) this.anthropicStop = textValue(payload.delta.stop_reason);
            return { events: this.usageEvents(payload.usage) };
        } else if (type === 'message_stop') {
            if (!['end_turn', 'stop_sequence', 'tool_use'].includes(this.anthropicStop ?? '')
                || [...this.anthropicBlocks.keys()].some(index => !this.anthropicClosed.has(index))) fail('incomplete');
            const content = [...this.anthropicBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => structuredClone(block));
            const calls = content.filter(block => block.type === 'tool_use').map(block => ({
                id: textValue(block.id), name: textValue(block.name), arguments: JSON.stringify(block.input),
            }));
            finalizedCalls(calls, this.tools);
            if ((calls.length > 0) !== (this.anthropicStop === 'tool_use')) fail('invalid');
            if (!calls.length && !this.textCount && !this.reasoningCount) fail('incomplete');
            return { events: [], complete: { toolCalls: calls, output: [{ role: 'assistant', content }] } };
        }
        return { events: [] };
    }
}

/** Streams actual provider text/reasoning and releases tools only after a valid terminal response. */
export async function* streamAgentApi(connectionInput: ApiConnection, modelInput: string, messagesInput: ApiMessage[],
    signal?: AbortSignal, options: AgentApiStreamOptions = { tools: [] }): AsyncGenerator<AgentStreamEvent> {
    if (!options.observer) {
        yield* streamAgentApiInternal(connectionInput, modelInput, messagesInput, signal, options);
        return;
    }
    const supplied = options.observer;
    let terminalAttempted = false;
    let partial = false;
    const invoke = (callback: () => void) => {
        try { callback(); } catch { throw new RequestRecordingError(partial); }
    };
    const observer: RequestObserver = {
        prepared: (body, protocol) => invoke(() => supplied.prepared(body, protocol)),
        dispatch: () => invoke(() => supplied.dispatch()),
        responseStarted: () => invoke(() => supplied.responseStarted()),
        providerEvent: event => { partial = true; invoke(() => supplied.providerEvent(event)); },
        terminal: status => {
            if (terminalAttempted) return;
            terminalAttempted = true;
            invoke(() => supplied.terminal(status));
        },
    };
    try {
        yield* streamAgentApiInternal(connectionInput, modelInput, messagesInput, signal, { ...options, observer });
    } catch (error) {
        observer.terminal(signal?.aborted || (error instanceof ApiTransportError && error.reason === 'cancelled') ? 'cancelled' : 'failed');
        throw error;
    } finally {
        if (!terminalAttempted) observer.terminal('cancelled');
    }
}

export function prepareAgentRequest(connectionInput: ApiConnection, modelInput: string, messagesInput: ApiMessage[],
    options: AgentApiStreamOptions): PreparedAgentRequest {
    const connection = validateConnection(connectionInput);
    const modelId = validateModelId(modelInput);
    const messages = validateMessages(messagesInput);
    const tools = validateTools(options.tools);
    const history = boundedNativeHistory(options.continuation ?? messages, options.inspectOversized);
    const body = JSON.parse(requestBody(connection.protocol, modelId, messages, undefined, options)) as Record<string, unknown>;
    if (connection.protocol === 'openai-chat') {
        body.messages = options.instructions ? [{ role: 'system', content: options.instructions }, ...history] : history;
        if (tools.length) body.tools = tools.map(tool => ({ type: 'function', function: tool }));
    } else if (connection.protocol === 'openai-responses') {
        body.input = history;
        if (tools.length) body.tools = tools.map(tool => ({ type: 'function', ...tool, strict: false }));
        body.include = ['reasoning.encrypted_content'];
        const effort = options.parameters?.reasoningEffort ?? 'default';
        const reasoningCapability = connectionInput.modelOverrides?.find(item => item.id === modelId)?.reasoning
            ?? connectionInput.modelDetails?.find(item => item.id === modelId)?.reasoning;
        if (effort !== 'none' && (effort !== 'default' || reasoningCapability === true)) {
            body.reasoning = { ...(isRecord(body.reasoning) ? body.reasoning : {}), summary: 'auto' };
        }
    } else {
        body.messages = history;
        if (tools.length) body.tools = tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));
    }
    const cached = options.cachePlanning ? planCache(connectionInput, modelId, body, options.cachePlanning.previous) : undefined;
    const serialized = JSON.stringify(cached?.body ?? body);
    if (!options.inspectOversized && new TextEncoder().encode(serialized).byteLength > MAX_REQUEST_BYTES) fail('invalid', 'context.request_body_bytes_exceeded');
    return freezeJson({ routeKey: contextRoute(connectionInput, modelId), protocol: connection.protocol, modelId, body: cached?.body ?? body, serialized, history, tools,
        ...(cached ? { cachePlan: cached.plan } : {}) });
}

async function* streamAgentApiInternal(connectionInput: ApiConnection, modelInput: string, messagesInput: ApiMessage[],
    signal?: AbortSignal, options: AgentApiStreamOptions = { tools: [] }): AsyncGenerator<AgentStreamEvent> {
    const connection = validateConnection(connectionInput);
    const prepared = options.preparedRequest ?? prepareAgentRequest(connectionInput, modelInput, messagesInput, options);
    if (prepared.protocol !== connection.protocol || prepared.modelId !== modelInput || prepared.routeKey !== contextRoute(connectionInput, modelInput)) fail('invalid', 'context.route_mismatch');
    const { serialized, history, tools } = prepared;
    if (Buffer.byteLength(serialized) > MAX_REQUEST_BYTES) fail('invalid', 'context.request_body_bytes_exceeded');
    const scope = createRequestScope(signal, 'stream', connection.protocol,
        options.parameters ? options.parameters.timeoutSeconds * 1_000 : REQUEST_TIMEOUT_MS, options.requestIdentity);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
        options.observer?.prepared(JSON.parse(serialized) as Record<string, unknown>, connection.protocol);
        const response = await fetchScoped(endpointUrl(connection.baseUrl, requestPath(connection.protocol)), {
            method: 'POST', headers: headersFor(connection, true), body: serialized,
        }, scope, options.observer);
        if ([400, 413, 422].includes(response.status)) {
            const bytes = await readBoundedBytes(response, 65536, scope);
            try {
                const payload = JSON.parse(new TextDecoder().decode(bytes));
                const error = payload?.error ?? payload;
                const code = error?.code ?? error?.type;
                if (['context_length_exceeded', 'context_window_exceeded', 'prompt_too_long'].includes(code)
                    || code === 'invalid_request_error' && typeof error?.message === 'string' && /prompt is too long|maximum context length|context window exceeded/i.test(error.message)) {
                    throw new ApiTransportError('服务端报告上下文超出容量。', 'context_overflow');
                }
            } catch (error) { if (error instanceof ApiTransportError) throw error; }
        }
        assertOk(response);
        if (!response.body) fail('invalid', 'body.missing');
        reader = response.body.getReader();
        const accumulator = new AgentStreamAccumulator(connection.protocol, tools);
        for await (const event of readSseEvents(reader, scope)) {
            options.observer?.providerEvent({ ...event });
            const result = accumulator.accept(event);
            for (const delta of result.events) yield delta;
            if (result.complete) {
                scope.throwIfAborted();
                const continuation = boundedNativeHistory([...history, ...result.complete.output]);
                options.observer?.terminal('completed');
                scope.success();
                yield { type: 'complete', toolCalls: result.complete.toolCalls, continuation };
                return;
            }
        }
        fail('truncated');
    } catch (error) {
        if (error instanceof RequestRecordingError) {
            scope.trace.event('request.recording_failed', { reason: 'recording_failed' });
            throw error;
        }
        throw scope.failure(error);
    }
    finally {
        if (reader) {
            try { await reader.cancel(); } catch { /* The provider may already have closed its stream. */ }
            reader.releaseLock();
        }
        scope.dispose();
    }
}

function parseModelEntries(payload: Record<string, unknown>, scope: RequestScope): ModelDetails[] {
    const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models
        : isRecord(payload.data) && Array.isArray(payload.data.models) ? payload.data.models : undefined;
    scope.trace.event('models.schema', { shape: entries ? 'model_array' : 'array_missing', ...(entries ? { count: entries.length } : {}) });
    if (!entries) fail('invalid', 'models.data_array_expected', '未找到模型数组。支持顶层数组、data 数组、models 数组或 data.models 数组。');
    const entriesById = new Map<string, ModelDetails>();
    for (const [index, item] of entries.entries()) {
        const value = typeof item === 'string' ? item : isRecord(item) ? item.id ?? item.model ?? item.name : undefined;
        if (typeof value !== 'string' || value.trim().length === 0 || value.trim().length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
            scope.trace.event('models.item_invalid', { index });
            fail('invalid', 'models.id_invalid', '模型目录第 ' + (index + 1) + ' 项没有有效的模型标识。支持字符串条目或 id/model/name 字符串字段；长度须为 1–200 且不含控制字符。');
        }
        const id = value.trim();
        entriesById.set(id, { ...entriesById.get(id), ...extractModelDetails(id, item) });
    }
    return [...entriesById.values()];
}

async function fetchModelsPage(
    connection: { protocol: ApiProtocol; baseUrl: string; apiKey: string },
    scope: RequestScope,
    cursor?: { parameter: string; value: string },
): Promise<Record<string, unknown>> {
    const url = new URL(endpointUrl(connection.baseUrl, 'models'));
    if (cursor) url.searchParams.set(cursor.parameter, cursor.value);
    const response = await fetchScoped(url.toString(), { method: 'GET', headers: headersFor(connection, false) }, scope);
    assertOk(response);
    return readJson(response, scope);
}

/** Discovery recognises response shapes independently of the selected generation protocol. */
export async function discoverApiModels(connectionInput: ApiConnection, signal?: AbortSignal): Promise<ModelCatalog> {
    const connection = validateConnection(connectionInput);
    const scope = createRequestScope(signal, 'models', connection.protocol);
    try {
        const result: string[] = [];
        const seen = new Set<string>();
        const details = new Map<string, ModelDetails>();
        const cursors = new Set<string>();
        let cursor: { parameter: string; value: string } | undefined;
        for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
            const payload = await fetchModelsPage(connection, scope, cursor);
            for (const entry of parseModelEntries(payload, scope)) {
                if (!seen.has(entry.id)) { seen.add(entry.id); result.push(entry.id); }
                details.set(entry.id, { ...details.get(entry.id), ...entry });
            }
            if (result.length > MAX_MODELS) {
                scope.trace.event('models.limit', { count: result.length, limit: MAX_MODELS });
                fail('invalid', 'models.count_limit', '模型目录返回 ' + result.length + ' 项不同模型，当前上限为 ' + MAX_MODELS + ' 项。请缩小服务暴露的模型目录，或手动添加需要的模型 ID。');
            }
            const more = payload.has_more;
            const explicitlyDone = more === false || more === 'false' || more === 0;
            const explicitlyMore = more === true || more === 'true' || more === 1;
            const nextCursor = payload.next_cursor;
            const hasNextCursor = typeof nextCursor === 'string' && nextCursor.length > 0;
            if (more !== undefined && !explicitlyDone && !explicitlyMore) {
                fail('invalid', 'models.pagination.has_more', '模型目录第 ' + (page + 1) + ' 页 has_more 的值无效，无法确定是否有下一页。');
            }
            if (explicitlyDone || (!explicitlyMore && !hasNextCursor)) {
                scope.trace.event('models.pagination_end', { page, reason: explicitlyDone ? 'explicit_end' : 'unpaged' });
                scope.success(result.length);
                return { models: result, modelDetails: [...details.values()].filter(entry => Object.keys(entry).length > 1) };
            }
            const value = hasNextCursor ? nextCursor : payload.last_id;
            const parameter = hasNextCursor ? 'cursor' : 'after_id';
            if (typeof value !== 'string' || value.length === 0 || value.length > 200 || value.trim() !== value || /[\u0000-\u001f\u007f]/.test(value)) {
                fail('invalid', 'models.pagination.cursor_invalid', '模型目录第 ' + (page + 1) + ' 页声明还有下一页，但缺少有效的 last_id 或 next_cursor。');
            }
            const cursorKey = parameter + ':' + value;
            if (cursors.has(cursorKey)) fail('invalid', 'models.pagination.cursor_repeated', '模型目录第 ' + (page + 1) + ' 页返回了重复游标，已停止循环翻页。');
            if (page === MAX_MODEL_PAGES - 1) fail('invalid', 'models.pagination.page_limit', '已读取 ' + MAX_MODEL_PAGES + ' 页模型目录，服务仍声明有下一页，超过当前上限。');
            cursors.add(cursorKey);
            cursor = { parameter, value };
        }
        fail('invalid', 'models.pagination.page_limit');
    } catch (error) {
        throw scope.failure(error);
    } finally {
        scope.dispose();
    }
}

/** Backwards-compatible ID-only helper. */
export async function listApiModels(connection: ApiConnection, signal?: AbortSignal): Promise<string[]> {
    return (await discoverApiModels(connection, signal)).models;
}

/** Uses a 256-token cap and makes no retry if the endpoint or output is incomplete. */
export async function testApiConnection(
    connection: ApiConnection,
    modelId: string,
    signal?: AbortSignal,
): Promise<ApiTestResult> {
    const started = Date.now();
    let text = '';
    for await (const delta of streamApiInternal(
        connection,
        modelId,
        [{ role: 'user', content: 'Reply with the single word OK.' }],
        signal,
        256,
    )) {
        if (text.length < 8193) text += delta.slice(0, 8193 - text.length);
    }
    return { text: text.length > 8192 ? text.slice(0, 8192) + '\n（仅展示前 8192 个字符）' : text, elapsedMs: Date.now() - started };
}
