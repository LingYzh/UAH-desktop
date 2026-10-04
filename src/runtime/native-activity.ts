import type { RunActivity } from '../shared/contracts.js';

export type NativeActivityPhase = 'started' | 'completed';
export type NativeActivityProjection = Omit<RunActivity, 'id' | 'kind'> & { id: string; kind: 'reasoning' | 'tool' };

const excludedItemTypes = new Set(['agentMessage', 'userMessage', 'plan']);
export const NATIVE_ACTIVITY_TEXT_LIMIT_BYTES = 128 * 1024;
export const NATIVE_ACTIVITY_TRUNCATION_NOTICE = '\n[原生输出已截断，超过 128 KiB。]';

export interface BoundedNativeText {
    text: string;
    truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function pretty(value: unknown): string {
    try { return JSON.stringify(value, null, 2); }
    catch { return 'Native activity details are unavailable.'; }
}

function readableFallback(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(readableFallback);
    if (!isRecord(value)) return value;
    return Object.fromEntries(Object.entries(value)
        .filter(([key]) => !['encrypted_content', 'internal_chat_message_metadata_passthrough'].includes(key))
        .map(([key, child]) => [key, readableFallback(child)]));
}

function argumentRecord(value: unknown): Record<string, unknown> {
    if (isRecord(value)) return value;
    if (value === undefined) return {};
    return { value };
}

function contentText(value: unknown): string {
    if (!Array.isArray(value)) return '';
    return value.map(item => {
        if (!isRecord(item)) return '';
        if ((item.type === 'text' || item.type === 'inputText') && typeof item.text === 'string') return item.text;
        return '';
    }).filter(Boolean).join('\n');
}

function itemStatus(item: Record<string, unknown>, phase: NativeActivityPhase): RunActivity['status'] {
    if (phase === 'started') return 'running';
    return item.status === 'failed' || item.status === 'declined' ? 'failed' : 'completed';
}

function resultForCommand(item: Record<string, unknown>): string {
    const output = stringValue(item.aggregatedOutput);
    const exitCode = typeof item.exitCode === 'number' ? `退出代码：${item.exitCode}` : '';
    return [output, exitCode].filter(Boolean).join('\n');
}

function resultForMcp(item: Record<string, unknown>): { text: string; isError: boolean } {
    const error = isRecord(item.error) ? stringValue(item.error.message) : '';
    const result = isRecord(item.result) ? item.result : null;
    const content = result ? contentText(result.content) : '';
    const structured = result?.structuredContent;
    return {
        text: error || content || (structured === undefined ? '' : pretty(structured)),
        isError: Boolean(error) || item.status === 'failed',
    };
}

function resultForDynamic(item: Record<string, unknown>): string {
    return contentText(item.contentItems);
}

function resultForFileChange(item: Record<string, unknown>): string {
    if (!Array.isArray(item.changes)) return '';
    return item.changes.filter(isRecord).map(change => {
        const path = stringValue(change.path);
        const kindValue = change.kind;
        const kind = typeof kindValue === 'string' ? kindValue : isRecord(kindValue) ? stringValue(kindValue.type) : '';
        const movePath = isRecord(kindValue) ? stringValue(kindValue.move_path) : '';
        const diff = stringValue(change.diff);
        return [kind && path ? `${kind} · ${path}${movePath ? ` → ${movePath}` : ''}` : path || kind, diff].filter(Boolean).join('\n');
    }).filter(Boolean).join('\n\n');
}

/** Appends at most 128 KiB of UTF-8 text, reserving room for an explicit truncation notice. */
export function appendBoundedNativeText(current: BoundedNativeText, delta: string): BoundedNativeText {
    if (current.truncated || delta.length === 0) return current;
    const contentLimit = NATIVE_ACTIVITY_TEXT_LIMIT_BYTES - Buffer.byteLength(NATIVE_ACTIVITY_TRUNCATION_NOTICE, 'utf8');
    let used = Buffer.byteLength(current.text, 'utf8');
    let addition = '';
    for (const character of delta) {
        const size = Buffer.byteLength(character, 'utf8');
        if (used + size > contentLimit) return { text: current.text + addition, truncated: true };
        addition += character;
        used += size;
    }
    return addition ? { text: current.text + addition, truncated: false } : current;
}

export function displayBoundedNativeText(value: string, truncated: boolean): string {
    return truncated ? `${value}${NATIVE_ACTIVITY_TRUNCATION_NOTICE}` : value;
}

/** Returns only the service-provided public summary; encrypted/private reasoning fields are ignored. */
export function nativeReasoningSummary(value: unknown): string {
    if (!isRecord(value) || !Array.isArray(value.summary)) return '';
    return value.summary.map(part => {
        if (typeof part === 'string') return part;
        if (isRecord(part) && (part.type === undefined || part.type === 'summary_text')) return stringValue(part.text);
        return '';
    }).filter(Boolean).join('\n\n');
}

/** Converts a visible Codex thread item into the existing activity shape without manufacturing file snapshots. */
export function projectNativeItem(value: unknown, phase: NativeActivityPhase): NativeActivityProjection | null {
    if (!isRecord(value) || typeof value.type !== 'string' || typeof value.id !== 'string' || value.id.length === 0) return null;
    const type = value.type;
    if (excludedItemTypes.has(type)) return null;

    if (type === 'reasoning') {
        const summary = nativeReasoningSummary(value);
        if (!summary) return null;
        return { id: `native:${value.id}`, kind: 'reasoning', title: '原生推理摘要', content: summary, status: itemStatus(value, phase) };
    }

    let name = `native:${type}`;
    let title = `原生操作 · ${type}`;
    let args: Record<string, unknown> = {};
    let result = '';
    let isError = false;
    if (type === 'commandExecution') {
        title = '原生命令';
        args = { command: stringValue(value.command), cwd: stringValue(value.cwd) };
        result = resultForCommand(value);
        isError = typeof value.exitCode === 'number' && value.exitCode !== 0;
    } else if (type === 'mcpToolCall') {
        title = 'MCP 工具';
        args = { server: stringValue(value.server), tool: stringValue(value.tool), arguments: argumentRecord(value.arguments) };
        const projection = resultForMcp(value);
        result = projection.text;
        isError = projection.isError;
    } else if (type === 'dynamicToolCall') {
        title = '原生动态工具';
        args = { tool: stringValue(value.tool), arguments: argumentRecord(value.arguments) };
        result = resultForDynamic(value);
        isError = value.success === false || value.status === 'failed';
    } else if (type === 'fileChange') {
        title = '原生文件变更';
        const changes = Array.isArray(value.changes) ? value.changes.filter(isRecord) : [];
        args = { changes: changes.map(change => {
            const kind = isRecord(change.kind) ? { type: stringValue(change.kind.type), ...(typeof change.kind.move_path === 'string' ? { move_path: change.kind.move_path } : {}) } : change.kind;
            return { path: stringValue(change.path), kind };
        }) };
        result = resultForFileChange(value);
        isError = value.status === 'failed';
    } else {
        const readable = readableFallback(value);
        args = { item: readable as Record<string, unknown> };
        result = pretty(readable);
        isError = value.status === 'failed';
    }

    const activityStatus = phase === 'completed' && isError ? 'failed' : itemStatus(value, phase);
    const tool: NonNullable<RunActivity['tool']> = {
        name,
        arguments: args,
        ...(result ? { result } : {}),
        ...(isError ? { isError: true } : {}),
    };
    return { id: `native:${value.id}`, kind: 'tool', title, content: result, status: activityStatus, tool };
}
