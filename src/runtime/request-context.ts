import { randomUUID } from 'node:crypto';
import type { ApiMessage, ApiProtocol } from '../shared/endpoints';
import type { ToolDefinition } from '../shared/tool-protocol';
import type { RequestContextDetail, RequestContextSummary } from '../shared/request-context';

const MAX_DETAIL_CHARACTERS = 240_000;
const MAX_SECTION_CHARACTERS = 100_000;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Visible text heuristic, deliberately not a provider tokenizer or billing estimate. */
export function estimateVisibleTokens(text: string): number {
    let ascii = 0;
    let other = 0;
    for (const char of text) { if (char.codePointAt(0)! < 128) ascii++; else other++; }
    return Math.ceil(ascii / 4 + other);
}

/** Allowlist native public messages/calls/results. Never serialize opaque provider objects. */
function visibleHistory(history: unknown[]): { text: string; omitted: boolean } {
    let omitted = false;
    function blocks(content: unknown): unknown {
        if (typeof content === 'string') return content;
        if (!Array.isArray(content)) return '';
        return content.flatMap<unknown>(value => {
            const item = record(value);
            if (['text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string') return [{ type: item.type, text: item.text }];
            if (item.type === 'tool_use') return [{ type: 'tool_use', id: item.id, name: item.name, input: item.input }];
            if (item.type === 'tool_result') return [{ type: 'tool_result', tool_use_id: item.tool_use_id, is_error: item.is_error, content: blocks(item.content) }];
            omitted = true;
            return [];
        });
    }
    const projected = history.flatMap<unknown>(value => {
        const item = record(value);
        if (item.type === 'function_call') return [{ type: 'function_call', call_id: item.call_id, name: item.name, arguments: item.arguments }];
        if (item.type === 'function_call_output') return [{ type: 'function_call_output', call_id: item.call_id, output: blocks(item.output) }];
        if (['user', 'assistant', 'tool'].includes(String(item.role)) && (!item.type || item.type === 'message')) {
            if ('reasoning_content' in item || 'reasoning' in item || 'signature' in item) omitted = true;
            return [{ role: item.role, content: blocks(item.content), ...(item.role === 'tool' ? { tool_call_id: item.tool_call_id } : {}),
                ...(Array.isArray(item.tool_calls) ? { tool_calls: item.tool_calls.map(value => {
                    const call = record(value); const fn = record(call.function);
                    return { id: call.id, type: call.type, function: { name: fn.name, arguments: fn.arguments } };
                }) } : {}) }];
        }
        omitted = true;
        return [];
    });
    return { text: JSON.stringify(projected, null, 2), omitted };
}

export function captureRequestContext(input: {
    runId: string; round: number; modelId: string; protocol: ApiProtocol; capacity?: number; requestId?: string;
    sections: Array<{ id: string; content: string }>;
    messages: ApiMessage[]; continuation?: unknown[]; tools: ToolDefinition[];
    compiledBody?: Record<string, unknown>; contextDiagnostics?: string; pressure?: RequestContextSummary['pressure'];
}): RequestContextDetail {
    const body = input.compiledBody;
    const wireHistory = body ? (input.protocol === 'openai-responses' ? body.input : body.messages) as unknown[] : undefined;
    const visible = visibleHistory(wireHistory?.filter(item => record(item).role !== 'system') ?? input.continuation ?? input.messages);
    const instructions = body ? (input.protocol === 'openai-chat' ? wireHistory?.filter(item => record(item).role === 'system').map(item => record(item).content).join('\n\n') ?? ''
        : typeof (body.instructions ?? body.system) === 'string' ? String(body.instructions ?? body.system) : JSON.stringify(body.system ?? ''))
        : input.sections.filter(section => !section.id.startsWith('context.')).map(section => section.content).join('\n\n');
    const environment = body ? '' : input.sections.filter(section => section.id.startsWith('context.')).map(section => section.content).join('\n\n');
    let budget = MAX_DETAIL_CHARACTERS;
    const sections = [
        { id: 'instructions', label: '系统与角色指令', content: instructions },
        { id: 'environment', label: '环境与 Git', content: environment },
        { id: 'tools', label: '工具定义', content: JSON.stringify(body?.tools ?? input.tools, null, 2) },
        { id: 'history', label: '消息与工具结果', content: visible.text },
    ].filter(section => !body || section.id !== 'environment').map(section => {
        const length = Math.min(budget, MAX_SECTION_CHARACTERS);
        const content = section.content.slice(0, length);
        budget -= content.length;
        return { ...section, content, characters: section.content.length, estimatedTokens: estimateVisibleTokens(section.content), truncated: content.length < section.content.length };
    });
    return {
        requestId: input.requestId ?? randomUUID(), runId: input.runId, round: input.round, capturedAt: new Date().toISOString(),
        modelId: input.modelId, protocol: input.protocol,
        ...(Number.isSafeInteger(input.capacity) && input.capacity! > 0 ? { capacity: input.capacity } : {}),
        estimatedInputTokens: sections.reduce((sum, section) => sum + section.estimatedTokens, 0),
        omittedPrivateState: visible.omitted, sections, ...(input.pressure ? { pressure: input.pressure } : {}),
        ...(input.contextDiagnostics ? { contextDiagnostics: input.contextDiagnostics } : {}),
    };
}

export function contextSummary(detail: RequestContextDetail): RequestContextSummary {
    return { ...detail, sections: detail.sections.map(({ content: _content, ...section }) => section) };
}
