import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { types } from 'node:util';

const MAX_UNKNOWN_BODY_BYTES = 16 * 1024 * 1024;
const WRAPPER_TOKENS = 1024;
export interface ContextInput {
    instructions: string;
    history: unknown[];
    tools: unknown[];
    capacity?: number;
    maxOutputTokens?: number | null;
}
export interface ContextAssessment {
    admitted: boolean;
    reason: 'within_capacity' | 'context_capacity_exceeded' | 'capacity_unknown_body_within_limit' | 'body_bytes_exceeded';
    capacityKnown: boolean;
    capacity: number | null;
    bodyBytes: number;
    wrapperTokens: number;
    inputEstimatedTokens: number;
    outputReserve: number;
    toolReserve: number;
    errorReserve: number;
    requiredTokens: number;
    bodyByteLimit: number | null;
}
function plain(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key)
            || !Object.getOwnPropertyDescriptor(value, key)!.enumerable
            || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) throw new TypeError('Invalid budget configuration.');
}
function integer(value: unknown, field: string, min = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min) throw new TypeError(`Invalid ${field}.`);
    return value;
}
function add(...values: number[]): number { return integer(values.reduce((sum, value) => sum + value, 0), 'budget total'); }
const LIMIT_KEYS = ['maxRequests', 'maxTools', 'maxElapsedMs', 'maxEstimatedTokens', 'maxConcurrentRequests'];
const OPTION_KEYS = [...LIMIT_KEYS, 'monotonicNow'];
function complete(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
    plain(value, keys);
    if (Reflect.ownKeys(value).length !== keys.length) throw new TypeError('Incomplete budget snapshot.');
}
/** Reject values JSON would omit, coerce or execute so the estimate covers every native field. */
function json(value: unknown, ancestors = new Set<object>(), depth = 0): void {
    if (depth > 128) throw new TypeError('Context JSON is too deeply nested.');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number' && Number.isFinite(value)) return;
    if (!value || typeof value !== 'object' || ancestors.has(value)) throw new TypeError('Context must contain complete JSON values.');
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Context must contain plain JSON values.');
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new TypeError('Context arrays must be dense.');
    ancestors.add(value);
    try {
        for (const key of keys) {
            if (array && key === 'length') continue;
            if (typeof key !== 'string' || array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new TypeError('Invalid context JSON key.');
            const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
            if (!('value' in descriptor) || !descriptor.enumerable) throw new TypeError('Context JSON accessors and hidden fields are unsupported.');
            json(descriptor.value, ancestors, depth + 1);
        }
    } finally { ancestors.delete(value); }
}
/** A conservative admission estimate, never provider billing or a history transform. */
export function assessContext(input: ContextInput): ContextAssessment {
    plain(input, ['instructions', 'history', 'tools', 'capacity', 'maxOutputTokens']);
    if (typeof input.instructions !== 'string' || !Array.isArray(input.history) || !Array.isArray(input.tools)) throw new TypeError('Invalid context fields.');
    const capacity = input.capacity === undefined ? null : integer(input.capacity, 'capacity', 1);
    const output = input.maxOutputTokens == null ? null : integer(input.maxOutputTokens, 'maxOutputTokens', 1);
    const body = { instructions: input.instructions, history: input.history, tools: input.tools };
    json(body);
    const bodyBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    const inputEstimatedTokens = add(bodyBytes, WRAPPER_TOKENS);
    const outputReserve = output ?? (capacity === null ? 0 : Math.min(8192, Math.floor(capacity * 0.2)));
    const toolReserve = capacity === null ? 0 : Math.min(8192, Math.floor(capacity * 0.1));
    const errorReserve = capacity === null ? 0 : Math.ceil(capacity * 0.05);
    const requiredTokens = add(inputEstimatedTokens, outputReserve, toolReserve, errorReserve);
    const admitted = capacity === null ? bodyBytes <= MAX_UNKNOWN_BODY_BYTES : requiredTokens <= capacity;
    return { admitted, reason: capacity === null ? admitted ? 'capacity_unknown_body_within_limit' : 'body_bytes_exceeded'
        : admitted ? 'within_capacity' : 'context_capacity_exceeded', capacityKnown: capacity !== null, capacity,
        bodyBytes, wrapperTokens: WRAPPER_TOKENS, inputEstimatedTokens, outputReserve, toolReserve, errorReserve, requiredTokens,
        bodyByteLimit: capacity === null ? MAX_UNKNOWN_BODY_BYTES : null };
}

export type BudgetExceededCode = 'requests' | 'tools' | 'elapsed_ms' | 'estimated_tokens' | 'concurrent_requests' | 'context_capacity' | 'no_progress' | 'model_corrections';
export class BudgetExceededError extends Error {
    constructor(readonly code: BudgetExceededCode) { super(`Task tree budget exceeded: ${code}.`); this.name = 'BudgetExceededError'; }
}
export interface TaskTreeBudgetOptions {
    maxRequests?: number;
    maxTools?: number;
    maxElapsedMs?: number;
    maxEstimatedTokens?: number;
    maxConcurrentRequests?: number;
    monotonicNow?: () => number;
}
export interface TaskTreeBudgetSnapshot {
    requestsUsed: number;
    toolsUsed: number;
    tokensCharged: number;
    tokensReserved: number;
    estimatedTokensExceeded: boolean;
    inFlight: number;
    elapsedMs: number;
    limits: { maxRequests: number; maxTools: number; maxElapsedMs: number; maxEstimatedTokens: number; maxConcurrentRequests: number };
}
/** Shared by a root and its descendants. Admission reservations are never refunded. */
export class TaskTreeBudget {
    private readonly limits: TaskTreeBudgetSnapshot['limits'];
    private readonly now: () => number;
    private readonly started: number;
    private lastClock: number;
    private requestsUsed = 0;
    private toolsUsed = 0;
    private tokensCharged = 0;
    private tokensExceeded = false;
    private elapsedBefore = 0;
    private readonly reservations = new Map<string, number>();
    constructor(options: TaskTreeBudgetOptions = {}) {
        plain(options, OPTION_KEYS);
        this.limits = {
            maxRequests: integer(options.maxRequests === undefined ? 64 : options.maxRequests, 'maxRequests', 1),
            maxTools: integer(options.maxTools === undefined ? 256 : options.maxTools, 'maxTools'),
            maxElapsedMs: integer(options.maxElapsedMs === undefined ? 30 * 60 * 1000 : options.maxElapsedMs, 'maxElapsedMs', 1),
            maxEstimatedTokens: integer(options.maxEstimatedTokens === undefined ? 4_000_000 : options.maxEstimatedTokens, 'maxEstimatedTokens'),
            maxConcurrentRequests: integer(options.maxConcurrentRequests === undefined ? 4 : options.maxConcurrentRequests, 'maxConcurrentRequests', 1),
        };
        if (options.monotonicNow !== undefined && typeof options.monotonicNow !== 'function') throw new TypeError('Invalid monotonicNow.');
        this.now = options.monotonicNow as (() => number) | undefined ?? (() => performance.now());
        this.started = this.lastClock = this.now();
        if (!Number.isFinite(this.started) || this.started < 0) throw new TypeError('Invalid monotonic clock.');
    }
    /** Restore charged totals, not external requests; downtime is not execution time. */
    static restore(snapshot: unknown, options: TaskTreeBudgetOptions = {}): TaskTreeBudget {
        complete(snapshot, ['requestsUsed', 'toolsUsed', 'tokensCharged', 'tokensReserved', 'estimatedTokensExceeded', 'inFlight', 'elapsedMs', 'limits']);
        complete(snapshot.limits, LIMIT_KEYS);
        plain(options, OPTION_KEYS);
        const requests = integer(snapshot.requestsUsed, 'requestsUsed');
        const tools = integer(snapshot.toolsUsed, 'toolsUsed');
        const charged = integer(snapshot.tokensCharged, 'tokensCharged');
        const reserved = integer(snapshot.tokensReserved, 'tokensReserved');
        const inFlight = integer(snapshot.inFlight, 'inFlight');
        const limits = snapshot.limits;
        for (const key of LIMIT_KEYS) integer(limits[key], key, ['maxRequests', 'maxElapsedMs', 'maxConcurrentRequests'].includes(key) ? 1 : 0);
        if (typeof snapshot.estimatedTokensExceeded !== 'boolean'
            || typeof snapshot.elapsedMs !== 'number' || !Number.isFinite(snapshot.elapsedMs)
            || snapshot.elapsedMs < 0 || snapshot.elapsedMs > Number.MAX_SAFE_INTEGER
            || inFlight > requests || inFlight > (limits.maxConcurrentRequests as number)
            || reserved > charged || inFlight === 0 && reserved !== 0 || requests === 0 && charged !== 0
            || charged > (limits.maxEstimatedTokens as number) && !snapshot.estimatedTokensExceeded
            || snapshot.estimatedTokensExceeded && charged <= (limits.maxEstimatedTokens as number) && charged < Number.MAX_SAFE_INTEGER) {
            throw new TypeError('Inconsistent budget snapshot.');
        }
        const restoredOptions: TaskTreeBudgetOptions = { ...limits };
        for (const key of OPTION_KEYS) if (options[key] !== undefined) Object.defineProperty(restoredOptions, key, { value: options[key], enumerable: true, configurable: true, writable: true });
        const restored = new TaskTreeBudget(restoredOptions);
        restored.requestsUsed = requests;
        restored.toolsUsed = tools;
        restored.tokensCharged = charged;
        restored.elapsedBefore = snapshot.elapsedMs;
        // MAX_SAFE may be a saturated aggregate: an explicit increase cannot prove headroom.
        restored.tokensExceeded = charged === Number.MAX_SAFE_INTEGER || charged > restored.limits.maxEstimatedTokens;
        return restored;
    }
    private elapsed(): number {
        const time = this.now();
        if (!Number.isFinite(time) || time < this.lastClock) throw new TypeError('Monotonic clock moved backwards or became invalid.');
        const elapsed = this.elapsedBefore + (time - this.started);
        if (!Number.isFinite(elapsed) || elapsed > Number.MAX_SAFE_INTEGER) throw new TypeError('Elapsed budget overflow.');
        this.lastClock = time; return elapsed;
    }
    private admitTime(): void { if (this.elapsed() >= this.limits.maxElapsedMs) throw new BudgetExceededError('elapsed_ms'); }
    /** Settlement is evidence only; callers check before authorizing more effects. */
    check(): void {
        this.admitTime();
        if (this.tokensExceeded || this.tokensCharged > this.limits.maxEstimatedTokens) throw new BudgetExceededError('estimated_tokens');
    }
    reserveRequest(estimatedTokens: number): string {
        integer(estimatedTokens, 'estimatedTokens'); this.check();
        if (this.requestsUsed >= this.limits.maxRequests) throw new BudgetExceededError('requests');
        if (this.reservations.size >= this.limits.maxConcurrentRequests) throw new BudgetExceededError('concurrent_requests');
        if (estimatedTokens > this.limits.maxEstimatedTokens - this.tokensCharged) throw new BudgetExceededError('estimated_tokens');
        const id = randomUUID(); this.reservations.set(id, estimatedTokens);
        this.requestsUsed++; this.tokensCharged += estimatedTokens; return id;
    }
    settleRequest(id: string, reportedTokens: number | null): void {
        if (typeof id !== 'string' || !this.reservations.has(id)) throw new TypeError('Unknown or already settled request reservation.');
        if (reportedTokens !== null) integer(reportedTokens, 'reportedTokens');
        const reserved = this.reservations.get(id)!;
        const increment = Math.max(reserved, reportedTokens ?? reserved) - reserved;
        const charged = this.tokensCharged + increment;
        this.reservations.delete(id);
        this.tokensExceeded ||= !Number.isSafeInteger(charged) || charged > this.limits.maxEstimatedTokens;
        // Saturate only an unrepresentable aggregate; never wrap or admit it.
        this.tokensCharged = Math.min(Number.MAX_SAFE_INTEGER, charged);
    }
    reserveTools(count: number): void {
        integer(count, 'tool count'); this.check();
        if (count > this.limits.maxTools - this.toolsUsed) throw new BudgetExceededError('tools');
        this.toolsUsed += count;
    }
    snapshot(): TaskTreeBudgetSnapshot {
        return { requestsUsed: this.requestsUsed, toolsUsed: this.toolsUsed, tokensCharged: this.tokensCharged,
            estimatedTokensExceeded: this.tokensExceeded,
            tokensReserved: [...this.reservations.values()].reduce((sum, value) => sum + value, 0),
            inFlight: this.reservations.size, elapsedMs: this.elapsed(), limits: { ...this.limits } };
    }
}
