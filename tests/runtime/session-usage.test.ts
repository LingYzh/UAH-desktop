import assert from 'node:assert/strict';
import test from 'node:test';
import type { TranscriptEvent, UsageRecord } from '../../src/shared/harness-contracts.js';
import { aggregateSessionUsage } from '../../src/runtime/context/session-usage.js';

const SESSION = 'session-main';
const OTHER_SESSION = 'session-other';

function usageEvent(options: {
    requestId: string;
    attemptId: string;
    runId?: string;
    sessionId?: string;
    scopeSessionId?: string;
    scopeKind?: 'session' | 'application';
    purpose?: UsageRecord['purpose'];
    parentRunId?: string | null;
    revision?: number;
    counters?: Partial<UsageRecord['counters']>;
    diagnostics?: Array<{ code: string; paths: string[] }>;
    sequence: number;
}): TranscriptEvent {
    const sessionId = options.sessionId ?? SESSION;
    const usage: UsageRecord = {
        schemaVersion: 1,
        requestId: options.requestId,
        attemptId: options.attemptId,
        revision: options.revision ?? 0,
        purpose: options.purpose ?? 'agent',
        scope: options.scopeKind === 'application'
            ? { kind: 'application' }
            : { kind: 'session', sessionId: options.scopeSessionId ?? sessionId, runId: options.runId ?? 'run-root' },
        protocol: 'openai-responses',
        adapterVersion: 'fixture',
        source: 'provider',
        completeness: 'partial',
        rawUsage: {},
        counters: {
            inputTokens: null,
            outputTokens: null,
            cachedInputTokens: null,
            cacheCreationInputTokens: null,
            totalTokens: null,
            ...options.counters,
        },
        ...(options.diagnostics ? { normalization: { version: 1 as const, sourcePaths: [], diagnostics: options.diagnostics, inputUncachedTokens: null, reasoningTokens: null } } : {}),
        providerResponseId: null,
        accountNamespace: 'fixture',
        reportedCost: null,
        estimatedCost: null,
    };
    return {
        schemaVersion: 1,
        eventId: `event-${options.sequence}`,
        sessionSeq: options.sequence,
        timestamp: '2026-10-05T00:00:00.000Z',
        processEpochId: 'epoch-fixture',
        run: {
            sessionId,
            runId: options.runId ?? 'run-root',
            parentRunId: options.parentRunId ?? null,
            rootRunId: 'run-root',
            turnId: 'turn-fixture',
        },
        type: 'usage.snapshot',
        payload: { usage },
    };
}

function dispatchEvent(options: { requestId: string; attemptId: string; sequence: number; sessionId?: string; runId?: string; parentRunId?: string | null }): TranscriptEvent {
    return {
        schemaVersion: 1,
        eventId: `dispatch-${options.sequence}`,
        sessionSeq: options.sequence,
        timestamp: '2026-10-05T00:00:00.000Z',
        processEpochId: 'epoch-fixture',
        run: {
            sessionId: options.sessionId ?? SESSION,
            runId: options.runId ?? 'run-root',
            parentRunId: options.parentRunId ?? null,
            rootRunId: 'run-root',
            turnId: 'turn-fixture',
        },
        type: 'request.dispatch',
        payload: { requestId: options.requestId, attemptId: options.attemptId },
    };
}

const DS_ROWS = [
    [13718, 132, 0], [14744, 550, 13824], [15302, 122, 15104], [16423, 393, 15360],
    [17313, 895, 16768], [18233, 492, 18048], [19658, 2234, 18688], [22528, 1669, 21888],
    [25230, 817, 24192], [26908, 1227, 25984], [28883, 2003, 28032],
] as const;

test('partial cache rate uses matched input/cache pairs and exposes coverage', () => {
    const events = [
        usageEvent({requestId:'paired',attemptId:'a',sequence:1,counters:{inputTokens:100,cachedInputTokens:80}}),
        usageEvent({requestId:'input-only',attemptId:'b',sequence:2,counters:{inputTokens:900,cachedInputTokens:null}}),
        dispatchEvent({requestId:'missing',attemptId:'c',sequence:3}),
    ];
    const result = aggregateSessionUsage(events, SESSION);
    assert.equal(result.cacheHitRate, null);
    assert.equal(result.knownCacheHitRate, 0.8);
    assert.equal(result.cacheHitRateReportedAttempts, 1);
    assert.equal(result.attemptCount, 3);
});

test('aggregates the audited 11-request DS session across child and compaction runs', () => {
    const events: TranscriptEvent[] = [];
    DS_ROWS.forEach(([inputTokens, outputTokens, cachedInputTokens], index) => {
        const requestId = `request-${index}`;
        const attemptId = `attempt-${index}`;
        const child = index >= 2 && index !== 6;
        const compaction = index === 6;
        const runId = compaction ? 'run-compaction' : child ? 'run-child' : 'run-root';
        const parentRunId = child || compaction ? 'run-root' : null;
        const purpose = compaction ? 'compaction' : 'agent';
        events.push(dispatchEvent({ requestId, attemptId, sequence: index * 3 + 1, runId, parentRunId }));
        events.push(usageEvent({ requestId, attemptId, revision: 0, sequence: index * 3 + 2, runId, parentRunId, purpose,
            counters: { inputTokens: null, outputTokens: null, cachedInputTokens: null } }));
        events.push(usageEvent({ requestId, attemptId, revision: 1, sequence: index * 3 + 3, runId, parentRunId, purpose,
            counters: { inputTokens, outputTokens, cachedInputTokens, totalTokens: inputTokens + outputTokens } }));
    });
    events.push(usageEvent({ requestId: 'foreign-scope', attemptId: 'foreign-attempt', scopeKind: 'application', sequence: 100 }));
    events.push(usageEvent({ requestId: 'foreign-session', attemptId: 'foreign-attempt', sessionId: OTHER_SESSION, sequence: 101,
        counters: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, cacheCreationInputTokens: 0 } }));
    events.push(usageEvent({ requestId: 'mismatched-scope', attemptId: 'bad-attempt', scopeSessionId: OTHER_SESSION, sequence: 102,
        counters: { inputTokens: 999, outputTokens: 999, cachedInputTokens: 0, cacheCreationInputTokens: 0 } }));

    const result = aggregateSessionUsage(events, SESSION);
    assert.equal(result.requestCount, 11);
    assert.equal(result.attemptCount, 11);
    assert.equal(result.incompleteAttempts, 11, 'the audited provider did not report cache creation tokens');
    assert.deepEqual(result.inputTokens, { knownSum: 218940, reportedAttempts: 11, total: 218940 });
    assert.deepEqual(result.outputTokens, { knownSum: 10534, reportedAttempts: 11, total: 10534 });
    assert.deepEqual(result.cachedInputTokens, { knownSum: 197888, reportedAttempts: 11, total: 197888 });
    assert.deepEqual(result.cacheCreationInputTokens, { knownSum: 0, reportedAttempts: 0, total: null });
    assert.deepEqual(result.uncachedInputTokens, { knownSum: 21052, reportedAttempts: 11, total: 21052 });
    assert.ok(Math.abs(result.cacheHitRate! - 0.9038458025029689) < 1e-12);
});

test('uses only the highest revision and counts retries as separate attempts', () => {
    const events: TranscriptEvent[] = [
        dispatchEvent({ requestId: 'r1', attemptId: 'a1', sequence: 1 }),
        usageEvent({ requestId: 'r1', attemptId: 'a1', revision: 1, sequence: 2,
            counters: { inputTokens: 10, outputTokens: 3, cachedInputTokens: 6, cacheCreationInputTokens: 1 } }),
        usageEvent({ requestId: 'r1', attemptId: 'a1', revision: 0, sequence: 3,
            counters: { inputTokens: 4, outputTokens: 2, cachedInputTokens: 2, cacheCreationInputTokens: 0 } }),
        dispatchEvent({ requestId: 'r1', attemptId: 'a2', sequence: 4 }),
        usageEvent({ requestId: 'r1', attemptId: 'a2', revision: 0, sequence: 5,
            counters: { inputTokens: 8, outputTokens: 2, cachedInputTokens: 3, cacheCreationInputTokens: 1 } }),
        dispatchEvent({ requestId: 'r2', attemptId: 'a3', sequence: 6 }),
    ];
    const result = aggregateSessionUsage(events, SESSION);
    assert.equal(result.requestCount, 2);
    assert.equal(result.attemptCount, 3);
    assert.equal(result.incompleteAttempts, 1);
    assert.deepEqual(result.inputTokens, { knownSum: 18, reportedAttempts: 2, total: null });
    assert.deepEqual(result.outputTokens, { knownSum: 5, reportedAttempts: 2, total: null });
    assert.deepEqual(result.cachedInputTokens, { knownSum: 9, reportedAttempts: 2, total: null });
    assert.deepEqual(result.uncachedInputTokens, { knownSum: 9, reportedAttempts: 2, total: null });
    assert.equal(result.cacheHitRate, null);
});

test('same-revision conflicts, invalid counters, and missing fields stay unknown', () => {
    const events: TranscriptEvent[] = [
        dispatchEvent({ requestId: 'r1', attemptId: 'a1', sequence: 1 }),
        usageEvent({ requestId: 'r1', attemptId: 'a1', revision: 3, sequence: 2,
            counters: { inputTokens: 10, outputTokens: 1, cachedInputTokens: 4, cacheCreationInputTokens: 0 } }),
        usageEvent({ requestId: 'r1', attemptId: 'a1', revision: 3, sequence: 3,
            counters: { inputTokens: 12, outputTokens: 1, cachedInputTokens: 4, cacheCreationInputTokens: 0 } }),
        dispatchEvent({ requestId: 'r2', attemptId: 'a2', sequence: 4 }),
        usageEvent({ requestId: 'r2', attemptId: 'a2', revision: 0, sequence: 5,
            counters: { inputTokens: -1, outputTokens: Number.MAX_SAFE_INTEGER + 1, cachedInputTokens: 0, cacheCreationInputTokens: 0 } }),
    ];
    const result = aggregateSessionUsage(events, SESSION);
    assert.deepEqual(result.inputTokens, { knownSum: 0, reportedAttempts: 0, total: null });
    assert.deepEqual(result.outputTokens, { knownSum: 1, reportedAttempts: 1, total: null });
    assert.deepEqual(result.cachedInputTokens, { knownSum: 4, reportedAttempts: 2, total: 4 });
    assert.deepEqual(result.uncachedInputTokens, { knownSum: 0, reportedAttempts: 0, total: null });
    assert.equal(result.incompleteAttempts, 2);
    assert.equal(result.cacheHitRate, null);
});

test('invalid cache breakdown diagnostics invalidate the affected cache fields', () => {
    const events: TranscriptEvent[] = [
        dispatchEvent({ requestId: 'r1', attemptId: 'a1', sequence: 1 }),
        usageEvent({ requestId: 'r1', attemptId: 'a1', revision: 0, sequence: 2,
            counters: { inputTokens: 100, outputTokens: 4, cachedInputTokens: 70, cacheCreationInputTokens: 40 },
            diagnostics: [{ code: 'usage.cache_breakdown_mismatch', paths: ['input_tokens', 'cache'] }] }),
    ];
    const result = aggregateSessionUsage(events, SESSION);
    assert.deepEqual(result.inputTokens, { knownSum: 100, reportedAttempts: 1, total: 100 });
    assert.deepEqual(result.cachedInputTokens, { knownSum: 0, reportedAttempts: 0, total: null });
    assert.deepEqual(result.cacheCreationInputTokens, { knownSum: 0, reportedAttempts: 0, total: null });
    assert.deepEqual(result.uncachedInputTokens, { knownSum: 0, reportedAttempts: 0, total: null });
    assert.equal(result.incompleteAttempts, 1);
});

test('accepts valid zeroes, derives uncached input from input minus cached reads, and leaves zero-input hit rate null', () => {
    const events: TranscriptEvent[] = [
        dispatchEvent({ requestId: 'r1', attemptId: 'a1', sequence: 1 }),
        usageEvent({ requestId: 'r1', attemptId: 'a1', revision: 0, sequence: 2,
            counters: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 } }),
        dispatchEvent({ requestId: 'r2', attemptId: 'a2', sequence: 3 }),
        usageEvent({ requestId: 'r2', attemptId: 'a2', revision: 0, sequence: 4,
            counters: { inputTokens: 100, outputTokens: 1, cachedInputTokens: 60, cacheCreationInputTokens: 20 } }),
    ];
    const result = aggregateSessionUsage(events, SESSION);
    assert.deepEqual(result.uncachedInputTokens, { knownSum: 40, reportedAttempts: 2, total: 40 });
    assert.deepEqual(result.cacheCreationInputTokens, { knownSum: 20, reportedAttempts: 2, total: 20 });
    assert.equal(result.cacheHitRate, 0.6);
    assert.equal(result.incompleteAttempts, 0);
});

test('reports unsafe aggregate sums as null without losing the per-attempt count', () => {
    const events: TranscriptEvent[] = [];
    for (let index = 0; index < 2; index++) {
        const requestId = `overflow-${index}`;
        const attemptId = `overflow-attempt-${index}`;
        events.push(dispatchEvent({ requestId, attemptId, sequence: index * 2 + 1 }));
        events.push(usageEvent({ requestId, attemptId, revision: 0, sequence: index * 2 + 2,
            counters: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0 } }));
    }
    const result = aggregateSessionUsage(events, SESSION);
    assert.deepEqual(result.inputTokens, { knownSum: null, reportedAttempts: 2, total: null });
    assert.deepEqual(result.outputTokens, { knownSum: 0, reportedAttempts: 2, total: 0 });
    assert.equal(result.incompleteAttempts, 0);
    assert.equal(result.cacheHitRate, null);
});
