import assert from 'node:assert/strict';
import test from 'node:test';
import { parseNativeContextUsageUpdated } from '../../src/shared/native-context';

const expectedThreadId = 'thread-fixture';
const expectedTurnId = 'turn-fixture';
const capturedAt = '2026-10-03T10:15:30.000Z';

test('native cache-write counters preserve reported zero independently of unknown fields', () => {
    const result = parseNativeContextUsageUpdated({ threadId: expectedThreadId, turnId: expectedTurnId,
        tokenUsage: { last: { totalTokens: 19907, inputTokens: 19900, outputTokens: 7, cacheWriteInputTokens: 0 },
            total: { totalTokens: 50000, cacheWriteInputTokens: 12 }, modelContextWindow: 258400 } }, expectedThreadId, expectedTurnId, capturedAt);
    assert.equal(result?.totalTokens, 19907);
    assert.equal(result?.cacheWriteInputTokens, 0);
    assert.equal(result?.cumulative?.cacheWriteInputTokens, 12);
    assert.equal(result?.reasoningOutputTokens, undefined);
});

function notification(overrides: Record<string, unknown> = {}): unknown {
    return {
        threadId: expectedThreadId,
        turnId: expectedTurnId,
        tokenUsage: {
            last: {
                inputTokens: 120,
                outputTokens: 12,
                cachedInputTokens: 20,
                reasoningOutputTokens: 3,
                totalTokens: 132,
            },
            total: {
                inputTokens: 900,
                outputTokens: 90,
                cachedInputTokens: 100,
                reasoningOutputTokens: 22,
                totalTokens: 990,
            },
            modelContextWindow: 128_000,
        },
        ...overrides,
    };
}

test('native token update maps latest request, capacity, and cumulative usage separately', () => {
    const result = parseNativeContextUsageUpdated(notification(), expectedThreadId, expectedTurnId, capturedAt);

    assert.deepEqual(result, {
        capturedAt,
        threadId: expectedThreadId,
        turnId: expectedTurnId,
        inputTokens: 120,
        outputTokens: 12,
        cachedInputTokens: 20,
        reasoningOutputTokens: 3,
        totalTokens: 132,
        capacity: 128_000,
        cumulative: {
            inputTokens: 900,
            outputTokens: 90,
            cachedInputTokens: 100,
            reasoningOutputTokens: 22,
            totalTokens: 990,
        },
    });
});

test('missing latest counters remain unknown instead of becoming zero', () => {
    const value = notification({
        tokenUsage: {
            last: {},
            total: {},
            modelContextWindow: 64_000,
        },
    });
    const result = parseNativeContextUsageUpdated(value, expectedThreadId, expectedTurnId, capturedAt);

    assert.deepEqual(result, {
        capturedAt,
        threadId: expectedThreadId,
        turnId: expectedTurnId,
        capacity: 64_000,
    });
});

test('zero token counts are valid while zero capacity is invalid', () => {
    const value = notification({
        tokenUsage: {
            last: { inputTokens: 0, totalTokens: 0 },
            total: { inputTokens: 0, totalTokens: 0 },
            modelContextWindow: 1,
        },
    });
    const result = parseNativeContextUsageUpdated(value, expectedThreadId, expectedTurnId, capturedAt);
    assert.equal(result?.inputTokens, 0);
    assert.equal(result?.totalTokens, 0);
    assert.equal(result?.capacity, 1);
    assert.deepEqual(result?.cumulative, { inputTokens: 0, totalTokens: 0 });

    const invalidCapacity = notification({ tokenUsage: { last: {}, total: {}, modelContextWindow: 0 } });
    assert.equal(parseNativeContextUsageUpdated(invalidCapacity, expectedThreadId, expectedTurnId, capturedAt), null);
});

test('wrong thread or turn and malformed notification envelopes are rejected', () => {
    assert.equal(parseNativeContextUsageUpdated(notification(), 'other-thread', expectedTurnId, capturedAt), null);
    assert.equal(parseNativeContextUsageUpdated(notification(), expectedThreadId, 'other-turn', capturedAt), null);
    assert.equal(parseNativeContextUsageUpdated(null, expectedThreadId, expectedTurnId, capturedAt), null);
    assert.equal(parseNativeContextUsageUpdated({}, expectedThreadId, expectedTurnId, capturedAt), null);
    assert.equal(parseNativeContextUsageUpdated(notification({ tokenUsage: { last: {} } }), expectedThreadId, expectedTurnId, capturedAt), null);
    assert.equal(parseNativeContextUsageUpdated(notification({ turnId: '' }), expectedThreadId, expectedTurnId, capturedAt), null);
});

test('invalid, fractional, negative, and unsafe token counts are rejected', () => {
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12', null]) {
        const value = notification({ tokenUsage: { last: { inputTokens: invalid }, total: {} } });
        assert.equal(parseNativeContextUsageUpdated(value, expectedThreadId, expectedTurnId, capturedAt), null);
    }
    for (const invalid of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '128000']) {
        const value = notification({ tokenUsage: { last: {}, total: {}, modelContextWindow: invalid } });
        assert.equal(parseNativeContextUsageUpdated(value, expectedThreadId, expectedTurnId, capturedAt), null);
    }
});

test('nullable or omitted context window leaves capacity unknown', () => {
    for (const capacity of [null, undefined]) {
        const tokenUsage: Record<string, unknown> = { last: {}, total: {} };
        if (capacity !== undefined) tokenUsage.modelContextWindow = capacity;
        const value = notification({ tokenUsage });
        const result = parseNativeContextUsageUpdated(value, expectedThreadId, expectedTurnId, capturedAt);
        assert.equal(result?.capacity, undefined);
    }
});
