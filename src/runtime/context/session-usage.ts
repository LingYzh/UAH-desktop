import type { TranscriptEvent, UsageCounters, UsageRecord } from '../../shared/harness-contracts.js';

export interface SessionUsageFieldSummary {
    /** Sum of the attempts whose value is known, or null when that sum overflows. */
    knownSum: number | null;
    reportedAttempts: number;
    /** Present only when every counted attempt has a known value and the sum is safe. */
    total: number | null;
}

export interface SessionUsageSummary {
    requestCount: number;
    attemptCount: number;
    incompleteAttempts: number;
    inputTokens: SessionUsageFieldSummary;
    outputTokens: SessionUsageFieldSummary;
    cachedInputTokens: SessionUsageFieldSummary;
    cacheCreationInputTokens: SessionUsageFieldSummary;
    uncachedInputTokens: SessionUsageFieldSummary;
    /** Cached reads divided by input, only when both fields are complete and input is positive. */
    cacheHitRate: number | null;
    /** Same-attempt input/cache pairs only; never presented as full-session coverage. */
    knownCacheHitRate: number | null;
    cacheHitRateReportedAttempts: number;
}

type UsageCounterField = 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheCreationInputTokens';
type AttemptValues = Record<UsageCounterField | 'uncachedInputTokens', number | null>;

interface SessionAttempt {
    requestId: string;
    attemptId: string;
    highestRevision: number;
    snapshots: UsageRecord[];
    invalidRevision: boolean;
}

function safeCounter(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function attemptKey(requestId: string, attemptId: string): string {
    return JSON.stringify([requestId, attemptId]);
}

function ensureAttempt(attempts: Map<string, SessionAttempt>, requestId: unknown, attemptId: unknown): SessionAttempt | null {
    if (typeof requestId !== 'string' || requestId.length === 0
        || typeof attemptId !== 'string' || attemptId.length === 0) return null;
    const key = attemptKey(requestId, attemptId);
    let attempt = attempts.get(key);
    if (!attempt) {
        attempt = { requestId, attemptId, highestRevision: -1, snapshots: [], invalidRevision: false };
        attempts.set(key, attempt);
    }
    return attempt;
}

type CounterState = { kind: 'missing' } | { kind: 'value'; value: number } | { kind: 'invalid' };

function counterState(value: unknown): CounterState {
    if (value === null || value === undefined) return { kind: 'missing' };
    return safeCounter(value) ? { kind: 'value', value } : { kind: 'invalid' };
}

function resolveCounter(snapshots: readonly UsageRecord[], field: UsageCounterField): number | null {
    if (snapshots.length === 0) return null;
    const states = snapshots.map(snapshot => counterState((snapshot.counters as UsageCounters | undefined)?.[field]));
    if (states.some(state => state.kind === 'invalid')) return null;
    const first = states[0]!;
    if (states.some(state => state.kind !== first.kind
        || (state.kind === 'value' && first.kind === 'value' && state.value !== first.value))) return null;
    return first.kind === 'value' ? first.value : null;
}

function hasCacheBreakdownConflict(snapshots: readonly UsageRecord[]): boolean {
    return snapshots.some(snapshot => snapshot.normalization?.diagnostics.some(diagnostic =>
        diagnostic.code === 'usage.cache_breakdown_mismatch'
        || diagnostic.code === 'usage.deepseek_cache_conflict'
        || diagnostic.code === 'usage.deepseek_cache_total_mismatch') === true);
}

function attemptValues(attempt: SessionAttempt): AttemptValues {
    const result: AttemptValues = {
        inputTokens: null,
        outputTokens: null,
        cachedInputTokens: null,
        cacheCreationInputTokens: null,
        uncachedInputTokens: null,
    };
    if (attempt.invalidRevision) return result;

    const input = resolveCounter(attempt.snapshots, 'inputTokens');
    const output = resolveCounter(attempt.snapshots, 'outputTokens');
    let cached = resolveCounter(attempt.snapshots, 'cachedInputTokens');
    let cacheCreation = resolveCounter(attempt.snapshots, 'cacheCreationInputTokens');

    const cacheConflict = hasCacheBreakdownConflict(attempt.snapshots)
        || (input !== null && ((cached !== null && cached > input)
            || (cacheCreation !== null && cacheCreation > input)
            || (cached !== null && cacheCreation !== null && cached > input - cacheCreation)));
    if (cacheConflict) {
        cached = null;
        cacheCreation = null;
    }

    result.inputTokens = input;
    result.outputTokens = output;
    result.cachedInputTokens = cached;
    result.cacheCreationInputTokens = cacheCreation;
    if (input !== null && cached !== null) result.uncachedInputTokens = input - cached;
    return result;
}

function safeSum(values: readonly number[]): number | null {
    let sum = 0;
    for (const value of values) {
        if (!safeCounter(value) || sum > Number.MAX_SAFE_INTEGER - value) return null;
        sum += value;
    }
    return sum;
}

function summarizeField(values: readonly AttemptValues[], field: keyof AttemptValues): SessionUsageFieldSummary {
    const known = values.flatMap(value => value[field] === null ? [] : [value[field]!]);
    const knownSum = safeSum(known);
    const complete = values.length > 0 && known.length === values.length;
    return {
        knownSum,
        reportedAttempts: known.length,
        total: complete ? knownSum : null,
    };
}

/**
 * Aggregate each dispatched provider attempt once, using only the newest usage
 * revision for that request/attempt pair. Session scoped child and compaction
 * requests are included through their shared session id.
 */
export function aggregateSessionUsage(events: readonly TranscriptEvent[], sessionId: string): SessionUsageSummary {
    const attempts = new Map<string, SessionAttempt>();
    const excludedScopeAttempts = new Set<string>();

    for (const event of events) {
        if (event.type !== 'usage.snapshot') continue;
        const usage = event.payload.usage;
        if (typeof usage.requestId !== 'string' || usage.requestId.length === 0
            || typeof usage.attemptId !== 'string' || usage.attemptId.length === 0) continue;
        if (event.run.sessionId !== sessionId || usage.scope.kind !== 'session' || usage.scope.sessionId !== sessionId) {
            excludedScopeAttempts.add(attemptKey(usage.requestId, usage.attemptId));
        }
    }

    for (const event of events) {
        if (event.run.sessionId !== sessionId) continue;

        if (event.type === 'request.dispatch') {
            if (excludedScopeAttempts.has(attemptKey(event.payload.requestId, event.payload.attemptId))) continue;
            ensureAttempt(attempts, event.payload.requestId, event.payload.attemptId);
            continue;
        }

        if (event.type !== 'usage.snapshot') continue;
        const usage = event.payload.usage;
        if (usage.scope.kind !== 'session' || usage.scope.sessionId !== sessionId) continue;
        if (excludedScopeAttempts.has(attemptKey(usage.requestId, usage.attemptId))) continue;
        const attempt = ensureAttempt(attempts, usage.requestId, usage.attemptId);
        if (!attempt) continue;
        if (!safeCounter(usage.revision)) {
            attempt.invalidRevision = true;
            continue;
        }
        if (usage.revision > attempt.highestRevision) {
            attempt.highestRevision = usage.revision;
            attempt.snapshots = [usage];
        } else if (usage.revision === attempt.highestRevision) {
            attempt.snapshots.push(usage);
        }
    }

    const values = [...attempts.values()].map(attemptValues);
    const requestCount = new Set([...attempts.values()].map(attempt => attempt.requestId)).size;
    const fieldNames: (keyof AttemptValues)[] = [
        'inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'uncachedInputTokens',
    ];
    const incompleteAttempts = values.filter(value => fieldNames.some(field => value[field] === null)).length;
    const inputTokens = summarizeField(values, 'inputTokens');
    const outputTokens = summarizeField(values, 'outputTokens');
    const cachedInputTokens = summarizeField(values, 'cachedInputTokens');
    const cacheCreationInputTokens = summarizeField(values, 'cacheCreationInputTokens');
    const uncachedInputTokens = summarizeField(values, 'uncachedInputTokens');
    const cacheHitRate = values.length > 0
        && inputTokens.reportedAttempts === values.length
        && cachedInputTokens.reportedAttempts === values.length
        && inputTokens.knownSum !== null && inputTokens.knownSum > 0
        && cachedInputTokens.knownSum !== null
        ? cachedInputTokens.knownSum / inputTokens.knownSum
        : null;

    const paired = values.filter(value => value.inputTokens !== null && value.cachedInputTokens !== null);
    const pairedInput = safeSum(paired.map(value => value.inputTokens!));
    const pairedCached = safeSum(paired.map(value => value.cachedInputTokens!));
    const knownCacheHitRate = pairedInput !== null && pairedInput > 0 && pairedCached !== null ? pairedCached / pairedInput : null;
    return {
        requestCount,
        attemptCount: attempts.size,
        incompleteAttempts,
        inputTokens,
        outputTokens,
        cachedInputTokens,
        cacheCreationInputTokens,
        uncachedInputTokens,
        cacheHitRate,
        knownCacheHitRate,
        cacheHitRateReportedAttempts: paired.length,
    };
}
