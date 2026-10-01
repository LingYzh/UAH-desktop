import { createHash } from 'node:crypto';
import { types } from 'node:util';
import type { HistoryTurn } from './model-history';

const MAX_BYTES = 16 * 1024 * 1024;
const MAX_DEPTH = 128;

export interface PublicHistoryCandidate {
    continuation: unknown[];
    prefixLength: number;
    previousVersion: string;
    nextVersion: string;
    beforeBytes: number;
    afterBytes: number;
    reduced: boolean;
}

/** Reject values JSON.stringify would omit, coerce or execute through getters/toJSON. */
function checkedJson(value: unknown): string {
    type Visit = { value: unknown; depth: number; exit?: boolean };
    const visits: Visit[] = [{ value, depth: 0 }];
    const ancestors = new Set<object>();
    let bytes = 0;
    const add = (count: number) => {
        bytes += count;
        if (bytes > MAX_BYTES) throw new Error('Context projection exceeds 16 MiB.');
    };
    while (visits.length) {
        const visit = visits.pop()!;
        const item = visit.value;
        if (visit.exit) { ancestors.delete(item as object); continue; }
        if (visit.depth > MAX_DEPTH) throw new Error('Context projection exceeds JSON depth 128.');
        if (item === null || typeof item === 'boolean') { add(item === null ? 4 : item ? 4 : 5); continue; }
        if (typeof item === 'number') {
            if (!Number.isFinite(item)) throw new Error('Context projection must contain only JSON values.');
            add(JSON.stringify(item).length); continue;
        }
        if (typeof item === 'string') {
            if (item.length > MAX_BYTES) throw new Error('Context projection exceeds 16 MiB.');
            add(Buffer.byteLength(JSON.stringify(item), 'utf8')); continue;
        }
        if (!item || typeof item !== 'object') throw new Error('Context projection must contain only JSON values.');
        if (types.isProxy(item)) throw new Error('Context projection cannot contain executable JSON proxies.');
        if (ancestors.has(item)) throw new Error('Context projection cannot contain JSON cycles.');
        const array = Array.isArray(item);
        const prototype = Object.getPrototypeOf(item);
        if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
            throw new Error('Context projection must contain plain JSON objects and arrays.');
        }
        const descriptors = Object.getOwnPropertyDescriptors(item);
        const keys = Reflect.ownKeys(descriptors);
        if (keys.some(key => typeof key !== 'string')) throw new Error('Context projection cannot contain non-JSON properties.');
        const fields = array ? keys.filter(key => key !== 'length') as string[] : keys as string[];
        if (array && (fields.length !== item.length || fields.some((key, index) => key !== String(index)))) {
            throw new Error('Context projection cannot contain sparse arrays or non-JSON properties.');
        }
        add(2 + Math.max(0, fields.length - 1));
        ancestors.add(item); visits.push({ value: item, depth: visit.depth, exit: true });
        for (let index = fields.length - 1; index >= 0; index--) {
            const key = fields[index]; const descriptor = descriptors[key];
            if (!descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw new Error('Context projection cannot contain getters or hidden properties.');
            if (!array) add(Buffer.byteLength(JSON.stringify(key), 'utf8') + 1);
            visits.push({ value: descriptor.value, depth: visit.depth + 1 });
        }
    }
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, 'utf8') > MAX_BYTES) throw new Error('Context projection exceeds 16 MiB.');
    return json;
}

const version = (json: string) => createHash('sha256').update(json, 'utf8').digest('hex');

/** Called only after validation; copy each JSON occurrence without input/output aliases. */
function cloneJson<T>(value: T): T {
    if (Array.isArray(value)) return value.map(item => cloneJson(item)) as T;
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneJson(item)])) as T;
    return value;
}

/** Candidate only: replace prior native turns with complete existing public messages.
 * The current user turn and its entire native tail remain unchanged. No model call,
 * authorization interpretation, durable commit or fact deletion happens here. */
export function publicHistoryCandidate(turns: HistoryTurn[], continuation: unknown[], prefixLength: number): PublicHistoryCandidate {
    if (types.isProxy(turns) || types.isProxy(continuation)) throw new Error('Context projection cannot contain executable JSON proxies.');
    if (!Array.isArray(turns) || !Array.isArray(continuation)) throw new Error('Context history and continuation must be arrays.');
    if (!Number.isSafeInteger(prefixLength) || prefixLength < 0 || prefixLength >= continuation.length) throw new Error('Invalid context prefix boundary.');
    const beforeJson = checkedJson(continuation);
    checkedJson(turns);
    const oldItems = cloneJson(continuation);
    const boundary = oldItems[prefixLength];
    if (!boundary || typeof boundary !== 'object' || Array.isArray(boundary) || (boundary as { role?: unknown }).role !== 'user') {
        throw new Error('Context prefix boundary must identify the current user message.');
    }
    const publicTurns = cloneJson(turns);
    if (publicTurns.some(turn => !turn || typeof turn !== 'object' || !Array.isArray(turn.messages)
        || turn.messages.some(message => !message || typeof message !== 'object' || Array.isArray(message)
            || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string'))) {
        throw new Error('Invalid public history messages.');
    }
    const prefix = publicTurns.flatMap(turn => turn.messages);
    const candidate = [...prefix, ...oldItems.slice(prefixLength)];
    const afterJson = checkedJson(candidate);
    const beforeBytes = Buffer.byteLength(beforeJson, 'utf8');
    const afterBytes = Buffer.byteLength(afterJson, 'utf8');
    return { continuation: cloneJson(candidate), prefixLength: prefix.length,
        previousVersion: version(beforeJson), nextVersion: version(afterJson), beforeBytes, afterBytes, reduced: afterBytes < beforeBytes };
}
