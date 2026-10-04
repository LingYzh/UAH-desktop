import { createHash } from 'node:crypto';
import type { ApiProtocol } from '../../shared/endpoints';

/**
 * A deliberately small, provider independent view of a model history.
 *
 * The provider ids in a native response identify provider objects, whereas
 * the id on a tool call identifies the call that a later tool result refers
 * to.  Only the latter is retained here.  Everything is parsed into this
 * representation before it is rendered for the next provider so that a
 * response id, a reasoning block, or an opaque provider extension cannot
 * accidentally become part of a portable prompt.
 */
interface JsonObject { [key: string]: JsonValue }
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

interface PortableCall {
    id: string;
    name: string;
    arguments: string;
    value: JsonObject;
    order: number;
}

interface PortableResult {
    id: string;
    output: string;
    error: boolean;
    order: number;
}

interface TextPart { kind: 'text'; text: string }
interface CallPart { kind: 'call'; call: PortableCall }
type AssistantPart = TextPart | CallPart;

interface PortableText {
    kind: 'text';
    role: 'user' | 'assistant';
    text: string;
}

interface PortableAssistant {
    kind: 'assistant';
    parts: AssistantPart[];
}

interface PortableResults {
    kind: 'results';
    results: PortableResult[];
}

type PortableItem = PortableText | PortableAssistant | PortableResults;

const protocols: ReadonlySet<ApiProtocol> = new Set(['openai-chat', 'openai-responses', 'anthropic']);
const privateBlockTypes = new Set([
    'encrypted', 'encrypted_content', 'encrypted_thinking', 'reasoning', 'reasoning_text',
    'redacted_thinking', 'signature', 'summary_text', 'thinking',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message: string): never {
    throw new Error(`Cannot portable history: ${message}`);
}

function protocol(value: ApiProtocol): asserts value is ApiProtocol {
    if (!protocols.has(value)) fail(`unsupported protocol ${String(value)}`);
}

function text(value: unknown, label: string): string {
    if (typeof value !== 'string') fail(`${label} must be text`);
    return value;
}

function nonEmptyText(value: unknown, label: string): string {
    const result = text(value, label);
    if (!result) fail(`${label} must not be empty`);
    return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

/** Convert a parsed tool argument to deterministic JSON while rejecting opaque values. */
function normalizeJson(value: unknown, label: string): JsonValue {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
        return value;
    }
    if (Array.isArray(value)) return value.map((item, index) => normalizeJson(item, `${label}[${index}]`));
    if (!isPlainObject(value)) fail(`${label} must contain JSON values`);
    const result: JsonObject = {};
    for (const key of Object.keys(value).sort()) {
        if (value[key] === undefined) fail(`${label}.${key} is not JSON`);
        result[key] = normalizeJson(value[key], `${label}.${key}`);
    }
    return result;
}

function normalizedArguments(value: unknown, label: string): JsonObject {
    const normalized = normalizeJson(value, label);
    if (!isPlainObject(normalized)) fail(`${label} must be a JSON object`);
    return normalized as JsonObject;
}

function parseArguments(value: unknown, label: string): { raw: string; value: JsonObject } {
    let raw: string;
    let parsed: unknown;
    if (typeof value === 'string') {
        raw = value;
        if (!raw) fail(`${label} must not be empty`);
        try { parsed = JSON.parse(raw); } catch { fail(`${label} is not valid JSON`); }
    } else {
        parsed = value;
        raw = JSON.stringify(value);
        if (raw === undefined) fail(`${label} is not JSON`);
    }
    return { raw, value: normalizedArguments(parsed, label) };
}

function stableJson(value: JsonValue): string {
    return JSON.stringify(value);
}

function mappedId(name: string, args: JsonObject, ordinal: number): string {
    // The ordinal makes equal calls in the same history distinct.  The
    // original provider id is intentionally absent so a provider roundtrip
    // produces the same id even when every provider changes its object ids.
    const digest = createHash('sha256')
        .update(JSON.stringify([ordinal, name, stableJson(args)]))
        .digest('hex');
    return `uah_${digest.slice(0, 56)}`;
}

function visibleTextBlock(block: Record<string, unknown>, label: string, types: ReadonlySet<string>): string {
    const type = text(block.type, `${label}.type`);
    if (!types.has(type)) fail(`unsupported ${label} block ${type}`);
    const field = type === 'refusal' ? 'refusal' : 'text';
    return text(block[field], `${label}.${field}`);
}

function collectTextContent(content: unknown, label: string, types: ReadonlySet<string>): string {
    if (typeof content === 'string') return content;
    if (content === null || content === undefined) return '';
    if (!Array.isArray(content)) fail(`${label} must be text or text blocks`);
    let result = '';
    for (const [index, value] of content.entries()) {
        if (!isRecord(value)) fail(`${label}[${index}] is not a block`);
        const type = text(value.type, `${label}[${index}].type`);
        if (privateBlockTypes.has(type)) continue;
        result += visibleTextBlock(value, `${label}[${index}]`, types);
    }
    return result;
}

function outputText(value: unknown, label: string): string {
    if (typeof value === 'string') return value;
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) {
        let result = '';
        for (const [index, block] of value.entries()) {
            if (!isRecord(block)) fail(`${label}[${index}] is not a text block`);
            const type = text(block.type, `${label}[${index}].type`);
            if (privateBlockTypes.has(type)) continue;
            if (!['text', 'input_text', 'output_text', 'refusal'].includes(type)) {
                fail(`unsupported ${label} block ${type}`);
            }
            result += text(block[type === 'refusal' ? 'refusal' : 'text'], `${label}[${index}]`);
        }
        return result;
    }
    // Tool implementations normally return a string.  Error objects are
    // still useful evidence, so retain their JSON text instead of dropping it.
    if (isPlainObject(value)) {
        const normalized = normalizeJson(value, label);
        return JSON.stringify(normalized);
    }
    fail(`${label} must be text`);
}

function errorFlag(item: Record<string, unknown>): boolean {
    if (item.is_error === true || item.isError === true || item.error === true) return true;
    if (typeof item.status === 'string' && ['failed', 'error', 'incomplete'].includes(item.status)) return true;
    return item.error !== undefined && item.error !== false && item.error !== null;
}

function resultOutput(item: Record<string, unknown>, field: 'content' | 'output'): { output: string; error: boolean } {
    const hasOutput = Object.prototype.hasOwnProperty.call(item, field);
    const error = errorFlag(item);
    const errorValue = item.error;
    if (hasOutput) return { output: outputText(item[field], `${field}`), error };
    if (errorValue !== undefined && errorValue !== true && errorValue !== false && errorValue !== null) {
        return { output: outputText(errorValue, 'error'), error: true };
    }
    if (error) return { output: '', error: true };
    fail(`tool result is missing ${field}`);
}

function addText(items: PortableItem[], role: 'user' | 'assistant', value: string): void {
    if (!value) return;
    const previous = items.at(-1);
    if (previous?.kind === 'text' && previous.role === role) previous.text += value;
    else items.push({ kind: 'text', role, text: value });
}

function addAssistant(items: PortableItem[], textValue: string, calls: PortableCall[]): void {
    if (!textValue && !calls.length) return;
    const previous = items.at(-1);
    if (previous?.kind === 'assistant' && !calls.length) {
        if (textValue) previous.parts.push({ kind: 'text', text: textValue });
        return;
    }
    const parts: AssistantPart[] = [];
    if (textValue) parts.push({ kind: 'text', text: textValue });
    parts.push(...calls.map(call => ({ kind: 'call' as const, call })));
    items.push({ kind: 'assistant', parts });
}

function addAssistantParts(items: PortableItem[], parts: AssistantPart[]): void {
    if (!parts.length) return;
    const previous = items.at(-1);
    if (previous?.kind === 'assistant') previous.parts.push(...parts);
    else items.push({ kind: 'assistant', parts: [...parts] });
}

function addResults(items: PortableItem[], result: PortableResult): void {
    const previous = items.at(-1);
    if (previous?.kind === 'results') previous.results.push(result);
    else items.push({ kind: 'results', results: [result] });
}

function makeCall(
    originalId: unknown,
    name: unknown,
    args: unknown,
    callsBySourceId: Map<string, PortableCall>,
    ordinal: number,
    label: string,
): PortableCall {
    const sourceId = nonEmptyText(originalId, `${label}.id`);
    if (callsBySourceId.has(sourceId)) fail(`duplicate tool call id ${sourceId}`);
    const callName = nonEmptyText(name, `${label}.name`);
    if (/[ -]/.test(callName)) fail(`${label}.name contains control characters`);
    const parsed = parseArguments(args, `${label}.arguments`);
    const id = mappedId(callName, parsed.value, ordinal);
    if ([...callsBySourceId.values()].some(existing => existing.id === id)) fail(`tool call id mapping collision for ${id}`);
    const call: PortableCall = { id, name: callName, arguments: parsed.raw, value: parsed.value, order: ordinal };
    callsBySourceId.set(sourceId, call);
    return call;
}

function makeResult(
    sourceId: unknown,
    item: Record<string, unknown>,
    field: 'content' | 'output',
    callsBySourceId: Map<string, PortableCall>,
    completed: Set<string>,
): PortableResult {
    const id = nonEmptyText(sourceId, `tool result.${field === 'content' ? 'tool_use_id' : 'call_id'}`);
    const call = callsBySourceId.get(id);
    if (!call) fail(`tool result references unknown call ${id}`);
    if (completed.has(id)) fail(`duplicate tool result for call ${id}`);
    const result = resultOutput(item, field);
    completed.add(id);
    return { id: call.id, ...result, order: call.order };
}

function parseChat(history: readonly unknown[]): { items: PortableItem[]; calls: Map<string, PortableCall>; completed: Set<string> } {
    const items: PortableItem[] = [];
    const calls = new Map<string, PortableCall>();
    const completed = new Set<string>();
    let ordinal = 0;
    const textTypes = new Set(['text', 'input_text', 'output_text', 'refusal']);
    for (const [index, value] of history.entries()) {
        if (!isRecord(value)) fail(`history[${index}] is not a message`);
        const role = value.role;
        if (role === 'user') {
            addText(items, 'user', collectTextContent(value.content, `history[${index}].content`, textTypes));
        } else if (role === 'assistant') {
            const content = collectTextContent(value.content, `history[${index}].content`, textTypes);
            const rawCalls = value.tool_calls;
            const parsedCalls: PortableCall[] = [];
            if (rawCalls !== undefined) {
                if (!Array.isArray(rawCalls)) fail(`history[${index}].tool_calls must be an array`);
                for (const [callIndex, rawCall] of rawCalls.entries()) {
                    if (!isRecord(rawCall) || (rawCall.type !== undefined && rawCall.type !== 'function')) {
                        fail(`history[${index}].tool_calls[${callIndex}] is not a function call`);
                    }
                    if (!isRecord(rawCall.function)) fail(`history[${index}].tool_calls[${callIndex}].function is missing`);
                    parsedCalls.push(makeCall(rawCall.id, rawCall.function.name, rawCall.function.arguments,
                        calls, ordinal++, `history[${index}].tool_calls[${callIndex}]`));
                }
            }
            addAssistant(items, content, parsedCalls);
        } else if (role === 'tool') {
            addResults(items, makeResult(value.tool_call_id, value, 'content', calls, completed));
        } else {
            fail(`unsupported message role ${String(role)}`);
        }
    }
    return { items, calls, completed };
}

function parseResponses(history: readonly unknown[]): { items: PortableItem[]; calls: Map<string, PortableCall>; completed: Set<string> } {
    const items: PortableItem[] = [];
    const calls = new Map<string, PortableCall>();
    const completed = new Set<string>();
    const textTypes = new Set(['text', 'input_text', 'output_text', 'refusal']);
    let ordinal = 0;
    for (const [index, value] of history.entries()) {
        if (!isRecord(value)) fail(`history[${index}] is not an item`);
        const type = value.type;
        if (type === 'function_call') {
            const call = makeCall(value.call_id, value.name, value.arguments, calls, ordinal++, `history[${index}]`);
            addAssistantParts(items, [{ kind: 'call', call }]);
        } else if (type === 'function_call_output') {
            addResults(items, makeResult(value.call_id, value, 'output', calls, completed));
        } else if (type === 'reasoning' || type === 'response.reasoning' || privateBlockTypes.has(String(type))) {
            // Reasoning and encrypted response items are intentionally not
            // portable.  Their presence is valid; their content is private.
            continue;
        } else if (type === 'message' || type === undefined) {
            const role = value.role;
            if (role !== 'user' && role !== 'assistant') fail(`history[${index}] message role is unsupported`);
            const content = collectTextContent(value.content, `history[${index}].content`, textTypes);
            if (role === 'user') addText(items, 'user', content);
            else addAssistant(items, content, []);
        } else {
            fail(`unsupported response item ${String(type)}`);
        }
    }
    return { items, calls, completed };
}

function parseAnthropic(history: readonly unknown[]): { items: PortableItem[]; calls: Map<string, PortableCall>; completed: Set<string> } {
    const items: PortableItem[] = [];
    const calls = new Map<string, PortableCall>();
    const completed = new Set<string>();
    let ordinal = 0;
    for (const [index, value] of history.entries()) {
        if (!isRecord(value)) fail(`history[${index}] is not a message`);
        const role = value.role;
        if (role !== 'user' && role !== 'assistant') fail(`unsupported message role ${String(role)}`);
        const content = value.content;
        if (typeof content === 'string' || content === null || content === undefined) {
            if (role === 'user') addText(items, 'user', content ?? '');
            else addAssistant(items, content ?? '', []);
            continue;
        }
        if (!Array.isArray(content)) fail(`history[${index}].content must be text or blocks`);
        const assistantParts: AssistantPart[] = [];
        let textBuffer = '';
        const flushAssistantText = () => {
            if (textBuffer) { assistantParts.push({ kind: 'text', text: textBuffer }); textBuffer = ''; }
        };
        for (const [blockIndex, valueBlock] of content.entries()) {
            if (!isRecord(valueBlock)) fail(`history[${index}].content[${blockIndex}] is not a block`);
            const type = text(valueBlock.type, `history[${index}].content[${blockIndex}].type`);
            if (privateBlockTypes.has(type)) continue;
            if (type === 'text') {
                const blockText = text(valueBlock.text, `history[${index}].content[${blockIndex}].text`);
                if (role === 'assistant') textBuffer += blockText;
                else addText(items, 'user', blockText);
            } else if (type === 'tool_use') {
                if (role !== 'assistant') fail('tool_use block must be in an assistant message');
                flushAssistantText();
                const call = makeCall(valueBlock.id, valueBlock.name, valueBlock.input, calls, ordinal++,
                    `history[${index}].content[${blockIndex}]`);
                assistantParts.push({ kind: 'call', call });
            } else if (type === 'tool_result') {
                if (role !== 'user') fail('tool_result block must be in a user message');
                addResults(items, makeResult(valueBlock.tool_use_id, valueBlock, 'content', calls, completed));
            } else {
                fail(`unsupported Anthropic block ${type}`);
            }
        }
        if (role === 'assistant') {
            flushAssistantText();
            addAssistantParts(items, assistantParts);
        }
    }
    return { items, calls, completed };
}

function parse(from: ApiProtocol, history: readonly unknown[]): { items: PortableItem[]; calls: Map<string, PortableCall>; completed: Set<string> } {
    if (!Array.isArray(history)) fail('history must be an array');
    if (from === 'openai-chat') return parseChat(history);
    if (from === 'openai-responses') return parseResponses(history);
    return parseAnthropic(history);
}

function validatePairs(calls: Map<string, PortableCall>, completed: Set<string>): void {
    for (const id of calls.keys()) if (!completed.has(id)) fail(`tool call ${id} has no result`);
}

function assistantText(parts: readonly AssistantPart[]): string {
    return parts.filter((part): part is TextPart => part.kind === 'text').map(part => part.text).join('');
}

function callsIn(parts: readonly AssistantPart[]): PortableCall[] {
    return parts.filter((part): part is CallPart => part.kind === 'call').map(part => part.call);
}

function renderChat(items: readonly PortableItem[]): unknown[] {
    const output: unknown[] = [];
    for (const item of items) {
        if (item.kind === 'text') output.push({ role: item.role, content: item.text });
        else if (item.kind === 'assistant') {
            const textValue = assistantText(item.parts);
            const calls = callsIn(item.parts);
            if (!textValue && !calls.length) continue;
            output.push({ role: 'assistant', content: textValue || null,
                ...(calls.length ? { tool_calls: calls.map(call => ({ id: call.id, type: 'function',
                    function: { name: call.name, arguments: call.arguments } })) } : {}) });
        } else {
            for (const result of [...item.results].sort((left, right) => left.order - right.order)) output.push({ role: 'tool', tool_call_id: result.id, content: result.output,
                ...(result.error ? { is_error: true } : {}) });
        }
    }
    return output;
}

function renderResponses(items: readonly PortableItem[]): unknown[] {
    const output: unknown[] = [];
    for (const item of items) {
        if (item.kind === 'text') {
            if (item.role === 'assistant') output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: item.text }] });
            else output.push({ role: 'user', content: item.text });
        } else if (item.kind === 'assistant') {
            const textValue = assistantText(item.parts);
            const calls = callsIn(item.parts);
            if (textValue) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: textValue }] });
            for (const call of calls) output.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
        } else {
            for (const result of [...item.results].sort((left, right) => left.order - right.order)) output.push({ type: 'function_call_output', call_id: result.id, output: result.output,
                ...(result.error ? { status: 'failed' } : {}) });
        }
    }
    return output;
}

function renderAnthropic(items: readonly PortableItem[]): unknown[] {
    const output: unknown[] = [];
    for (const item of items) {
        if (item.kind === 'text') output.push({ role: item.role, content: item.text });
        else if (item.kind === 'assistant') {
            const content: unknown[] = [];
            for (const part of item.parts) {
                if (part.kind === 'text') content.push({ type: 'text', text: part.text });
                else content.push({ type: 'tool_use', id: part.call.id, name: part.call.name, input: structuredClone(part.call.value) });
            }
            if (content.length) output.push({ role: 'assistant', content });
        } else {
            output.push({ role: 'user', content: [...item.results].sort((left, right) => left.order - right.order).map(result => ({ type: 'tool_result', tool_use_id: result.id,
                content: result.output, ...(result.error ? { is_error: true } : {}) })) });
        }
    }
    return output;
}

/**
 * Project native wire history from one supported API protocol to another.
 *
 * The input is treated as untrusted provider data.  A malformed or incomplete
 * call/result sequence throws so callers can fall back to the public legacy
 * history instead of sending a silently damaged conversation.
 */
export function portableHistory(from: ApiProtocol, to: ApiProtocol, history: readonly unknown[]): unknown[] {
    protocol(from);
    protocol(to);
    const parsed = parse(from, history);
    validatePairs(parsed.calls, parsed.completed);
    if (to === 'openai-chat') return renderChat(parsed.items);
    if (to === 'openai-responses') return renderResponses(parsed.items);
    return renderAnthropic(parsed.items);
}
