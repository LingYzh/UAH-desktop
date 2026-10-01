import assert from 'node:assert/strict';
import test from 'node:test';
import { assessContext, TaskTreeBudget, BudgetExceededError } from '../../src/runtime/context-governor';

const exceeded = (code: BudgetExceededError['code']) => (error: unknown) => error instanceof BudgetExceededError && error.code === code;
test('context counts complete UTF-8 JSON including opaque native data without mutation', () => {
    const input = { instructions: '中文 instructions', history: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(100), signature: '签名' }, { type: 'tool_result', content: 'real result' }], tools: [{ name: 'read_file' }], capacity: 20000 };
    const before = structuredClone(input); const result = assessContext(input);
    assert.equal(result.bodyBytes, Buffer.byteLength(JSON.stringify({ instructions: input.instructions, history: input.history, tools: input.tools }), 'utf8'));
    assert.equal(result.inputEstimatedTokens, result.bodyBytes + 1024); assert.equal(result.outputReserve, 4000);
    assert.equal(result.toolReserve, 2000); assert.equal(result.errorReserve, 1000);
    assert.equal(result.requiredTokens, result.inputEstimatedTokens + 7000); assert.equal(result.admitted, true); assert.equal(result.capacityKnown, true);
    assert.deepEqual(input, before);
    const denied = assessContext({ ...input, capacity: 1100 }); assert.equal(denied.admitted, false); assert.equal(denied.reason, 'context_capacity_exceeded'); assert.deepEqual(input, before);
});
test('context reserves explicit output and capped defaults, enforcing exact boundaries', () => {
    const input = { instructions: '', history: [], tools: [], capacity: 1000000 };
    const result = assessContext(input); assert.equal(result.outputReserve, 8192); assert.equal(result.toolReserve, 8192); assert.equal(result.errorReserve, 50000);
    const explicit = assessContext({ ...input, maxOutputTokens: 128 }); assert.equal(explicit.outputReserve, 128);
    assert.equal(assessContext({ ...input, maxOutputTokens: null }).outputReserve, 8192);
    // Find a capacity where floor/ceil margins leave an exact admission boundary.
    const base = { instructions: '', history: [], tools: [], maxOutputTokens: 1 };
    const bytes = assessContext(base).bodyBytes;
    let capacity = 2000;
    while (capacity - (bytes + 1024 + 1 + Math.floor(capacity * .1) + Math.ceil(capacity * .05)) < 0) capacity++;
    const remaining = capacity - (bytes + 1024 + 1 + Math.floor(capacity * .1) + Math.ceil(capacity * .05));
    const exact = assessContext({ ...base, capacity, instructions: 'x'.repeat(remaining) }); assert.equal(exact.requiredTokens, capacity); assert.equal(exact.admitted, true);
    assert.equal(assessContext({ ...base, capacity, instructions: 'x'.repeat(remaining + 1) }).admitted, false);
});
test('unknown capacity uses a 16 MiB body ceiling without claiming provider fit', () => {
    const base = { instructions: '', history: [], tools: [] }; const overhead = assessContext(base).bodyBytes;
    const exact = assessContext({ ...base, instructions: 'x'.repeat(16 * 1024 * 1024 - overhead) });
    assert.equal(exact.bodyBytes, 16 * 1024 * 1024); assert.equal(exact.admitted, true); assert.equal(exact.capacityKnown, false); assert.equal(exact.capacity, null);
    assert.equal(exact.reason, 'capacity_unknown_body_within_limit'); assert.equal(exact.toolReserve, 0); assert.equal(exact.errorReserve, 0);
    const denied = assessContext({ ...base, instructions: 'x'.repeat(16 * 1024 * 1024 - overhead + 1) }); assert.equal(denied.admitted, false); assert.equal(denied.reason, 'body_bytes_exceeded');
});
test('context rejects ambiguous configuration and JSON that would lose native fields', () => {
    const base = { instructions: '', history: [], tools: [] };
    const cycle: unknown[] = []; cycle.push(cycle);
    const hidden = Object.defineProperty({}, 'native', { value: 'must be counted', enumerable: false });
    const accessor = Object.defineProperty({}, 'native', { get() { throw new Error('must not execute'); }, enumerable: true });
    for (const value of [{ ...base, capacity: 0 }, { ...base, capacity: NaN }, { ...base, capacity: null }, { ...base, maxOutputTokens: 1.5 }, { ...base, maxOutputTokens: 0 }, { ...base, unknown: true }, { ...base, history: [undefined] }, { ...base, history: [1n] }, { ...base, history: [Infinity] }, { ...base, history: Array(1) }, { ...base, history: cycle }, { ...base, history: [hidden] }, { ...base, history: [accessor] }, { ...base, history: [new Date()] }]) assert.throws(() => assessContext(value as never), TypeError);
});
test('shared reservations charge request/token/in-flight capacity immediately with no refunds', () => {
    let now = 10; const budget = new TaskTreeBudget({ monotonicNow: () => now, maxRequests: 3, maxConcurrentRequests: 2, maxEstimatedTokens: 100 });
    const first = budget.reserveRequest(30); const second = budget.reserveRequest(20); assert.notEqual(first, second);
    assert.equal(budget.snapshot().requestsUsed, 2); assert.equal(budget.snapshot().tokensCharged, 50); assert.equal(budget.snapshot().tokensReserved, 50); assert.equal(budget.snapshot().inFlight, 2);
    assert.throws(() => budget.reserveRequest(1), exceeded('concurrent_requests'));
    budget.settleRequest(first, 5); budget.settleRequest(second, null); assert.equal(budget.snapshot().tokensCharged, 50); assert.equal(budget.snapshot().tokensReserved, 0);
    const third = budget.reserveRequest(50); budget.settleRequest(third, 50); assert.equal(budget.snapshot().tokensCharged, 100);
    assert.throws(() => budget.reserveRequest(0), exceeded('requests')); assert.throws(() => budget.settleRequest(first, 30), TypeError);
    assert.throws(() => budget.settleRequest('unknown', null), TypeError); now = 15; assert.equal(budget.snapshot().elapsedMs, 5);
});
test('reported overrun settles truthfully and subsequent request/tool admission or check rejects', () => {
    const budget = new TaskTreeBudget({ maxEstimatedTokens: 10 }); const id = budget.reserveRequest(5);
    assert.doesNotThrow(() => budget.settleRequest(id, 12)); assert.equal(budget.snapshot().tokensCharged, 12); assert.equal(budget.snapshot().inFlight, 0); assert.equal(budget.snapshot().estimatedTokensExceeded, true);
    assert.throws(() => budget.check(), exceeded('estimated_tokens')); assert.throws(() => budget.reserveRequest(0), exceeded('estimated_tokens')); assert.throws(() => budget.reserveTools(1), exceeded('estimated_tokens'));
    assert.throws(() => budget.settleRequest(id, null), TypeError);
    const saturated = new TaskTreeBudget(); const first = saturated.reserveRequest(1); const second = saturated.reserveRequest(1);
    saturated.settleRequest(first, Number.MAX_SAFE_INTEGER); saturated.settleRequest(second, Number.MAX_SAFE_INTEGER);
    assert.equal(saturated.snapshot().tokensCharged, Number.MAX_SAFE_INTEGER); assert.equal(saturated.snapshot().estimatedTokensExceeded, true); assert.equal(saturated.snapshot().inFlight, 0);
});
test('tool reservations are atomic and elapsed admission uses only the monotonic clock', () => {
    let now = 0; const budget = new TaskTreeBudget({ maxTools: 3, maxElapsedMs: 10, monotonicNow: () => now });
    budget.reserveTools(2); assert.throws(() => budget.reserveTools(2), exceeded('tools')); assert.equal(budget.snapshot().toolsUsed, 2); budget.reserveTools(1);
    const request = budget.reserveRequest(5); now = 10;
    assert.throws(() => budget.reserveRequest(1), exceeded('elapsed_ms')); assert.throws(() => budget.reserveTools(0), exceeded('elapsed_ms')); assert.throws(() => budget.check(), exceeded('elapsed_ms'));
    assert.doesNotThrow(() => budget.settleRequest(request, null), 'late completion still settles evidence'); assert.equal(budget.snapshot().inFlight, 0);
    now = 9; assert.throws(() => budget.snapshot(), TypeError);
});
test('invalid budget configuration/reservation never consumes counters', () => {
    for (const options of [{ maxRequests: 0 }, { maxTools: -1 }, { maxElapsedMs: Infinity }, { maxConcurrentRequests: 1.5 }, { maxEstimatedTokens: null }, { monotonicNow: () => NaN }, { unknown: 1 }]) assert.throws(() => new TaskTreeBudget(options as never), TypeError);
    const budget = new TaskTreeBudget({ maxEstimatedTokens: 5 });
    for (const amount of [-1, NaN, 0.1, Infinity]) assert.throws(() => budget.reserveRequest(amount), TypeError);
    assert.throws(() => budget.reserveRequest(6), exceeded('estimated_tokens')); assert.equal(budget.snapshot().requestsUsed, 0);
    const id = budget.reserveRequest(5); assert.throws(() => budget.settleRequest(id, -1), TypeError); assert.equal(budget.snapshot().inFlight, 1); budget.settleRequest(id, null);
    for (const amount of [-1, NaN, 0.1]) assert.throws(() => budget.reserveTools(amount), TypeError); assert.equal(budget.snapshot().toolsUsed, 0);
    assert.deepEqual(new TaskTreeBudget().snapshot().limits, { maxRequests: 64, maxTools: 256, maxElapsedMs: 1800000, maxEstimatedTokens: 4000000, maxConcurrentRequests: 4 });
});

test('restore retains charges and execution time but abandons in-flight reservations', () => {
    let now = 100;
    const original = new TaskTreeBudget({ maxRequests: 3, maxTools: 5, maxEstimatedTokens: 100, maxElapsedMs: 50, monotonicNow: () => now });
    const abandoned = original.reserveRequest(30);
    original.reserveTools(2);
    now = 110.5;
    const saved = original.snapshot();
    const before = structuredClone(saved);
    now = 1_000_000;
    const restored = TaskTreeBudget.restore(saved, { monotonicNow: () => now });
    assert.deepEqual(restored.snapshot(), { ...saved, inFlight: 0, tokensReserved: 0 });
    assert.deepEqual(saved, before);
    assert.throws(() => restored.settleRequest(abandoned, null), TypeError);
    const next = restored.reserveRequest(20);
    restored.settleRequest(next, 10);
    assert.equal(restored.snapshot().requestsUsed, 2);
    assert.equal(restored.snapshot().tokensCharged, 50);
    now += 39.5;
    assert.equal(restored.snapshot().elapsedMs, 50);
    assert.throws(() => restored.check(), exceeded('elapsed_ms'));
    now -= 1;
    assert.throws(() => restored.snapshot(), TypeError);
});

test('restore overrides cumulative limits without resetting request or tool consumption', () => {
    const budget = new TaskTreeBudget({ maxRequests: 2, maxTools: 2, monotonicNow: () => 0 });
    budget.settleRequest(budget.reserveRequest(10), null);
    budget.settleRequest(budget.reserveRequest(10), null);
    budget.reserveTools(2);
    const saved = budget.snapshot();
    const unchanged = TaskTreeBudget.restore(saved, { monotonicNow: () => 100 });
    assert.throws(() => unchanged.reserveRequest(0), exceeded('requests'));
    assert.throws(() => unchanged.reserveTools(1), exceeded('tools'));
    const lowered = TaskTreeBudget.restore(saved, { maxRequests: 1, maxTools: 1, monotonicNow: () => 0 });
    const again = TaskTreeBudget.restore(lowered.snapshot(), { monotonicNow: () => 0 });
    assert.equal(again.snapshot().requestsUsed, 2);
    assert.equal(again.snapshot().toolsUsed, 2);
    assert.throws(() => again.reserveRequest(0), exceeded('requests'));
    assert.throws(() => again.reserveTools(0), exceeded('tools'));
    const increased = TaskTreeBudget.restore(saved, { maxRequests: 3, maxTools: 3, maxEstimatedTokens: undefined, monotonicNow: () => 0 });
    increased.reserveRequest(1); increased.reserveTools(1);
    assert.equal(increased.snapshot().requestsUsed, 3);
    assert.equal(increased.snapshot().toolsUsed, 3);
    assert.equal(increased.snapshot().limits.maxEstimatedTokens, saved.limits.maxEstimatedTokens);
});

test('explicit token increase clears an old overrun but never admits saturated totals', () => {
    const budget = new TaskTreeBudget({ maxEstimatedTokens: 10, monotonicNow: () => 0 });
    budget.settleRequest(budget.reserveRequest(5), 12);
    const saved = budget.snapshot();
    assert.throws(() => TaskTreeBudget.restore(saved).check(), exceeded('estimated_tokens'));
    assert.throws(() => TaskTreeBudget.restore(saved, { maxEstimatedTokens: 11 }).check(), exceeded('estimated_tokens'));
    const increased = TaskTreeBudget.restore(saved, { maxEstimatedTokens: 13, monotonicNow: () => 0 });
    assert.equal(increased.snapshot().estimatedTokensExceeded, false);
    increased.reserveRequest(1);
    assert.equal(increased.snapshot().tokensCharged, 13);
    const saturated = { ...saved, tokensCharged: Number.MAX_SAFE_INTEGER };
    const blocked = TaskTreeBudget.restore(saturated, { maxEstimatedTokens: Number.MAX_SAFE_INTEGER });
    assert.throws(() => blocked.reserveRequest(0), exceeded('estimated_tokens'));
    assert.equal(blocked.snapshot().estimatedTokensExceeded, true);
    const lowered = TaskTreeBudget.restore({ ...saved, estimatedTokensExceeded: false, tokensCharged: 10 }, { maxEstimatedTokens: 9 });
    assert.throws(() => TaskTreeBudget.restore(lowered.snapshot()).check(), exceeded('estimated_tokens'));
});

test('restore rejects incomplete or contradictory persistent evidence', () => {
    const saved = new TaskTreeBudget({ monotonicNow: () => 0 }).snapshot();
    for (const key of Object.keys(saved)) {
        const missing: Record<string, unknown> = { ...saved }; delete missing[key];
        assert.throws(() => TaskTreeBudget.restore(missing), TypeError, key);
    }
    for (const key of Object.keys(saved.limits)) {
        const limits: Record<string, unknown> = { ...saved.limits }; delete limits[key];
        assert.throws(() => TaskTreeBudget.restore({ ...saved, limits }), TypeError, key);
    }
    const invalid = [null, [], { ...saved, extra: 1 }, { ...saved, requestsUsed: .5 }, { ...saved, toolsUsed: -1 },
        { ...saved, tokensCharged: Number.MAX_SAFE_INTEGER + 1 }, { ...saved, tokensReserved: 1 },
        { ...saved, inFlight: 1 }, { ...saved, estimatedTokensExceeded: 0 }, { ...saved, estimatedTokensExceeded: true },
        { ...saved, elapsedMs: NaN }, { ...saved, elapsedMs: Infinity }, { ...saved, elapsedMs: -1 },
        { ...saved, elapsedMs: Number.MAX_SAFE_INTEGER + 1 }, { ...saved, limits: { ...saved.limits, maxRequests: 0 } },
        { ...saved, limits: { ...saved.limits, maxConcurrentRequests: Infinity } },
        { ...saved, limits: { ...saved.limits, extra: 1 } }, { ...saved, requestsUsed: 1, tokensCharged: 5, tokensReserved: 1 },
        { ...saved, requestsUsed: 5, inFlight: 5 }, { ...saved, requestsUsed: 1, tokensCharged: 5_000_000 },
        { ...saved, requestsUsed: 1, tokensCharged: 5, tokensReserved: 6, inFlight: 1 }];
    for (const value of invalid) assert.throws(() => TaskTreeBudget.restore(value), TypeError);
});

test('restore never invokes snapshot/configuration accessors or proxy traps', () => {
    const saved = new TaskTreeBudget({ monotonicNow: () => 0 }).snapshot();
    let calls = 0;
    const accessor = (object: object, key: string) => Object.defineProperty({ ...object }, key, { enumerable: true, get() { calls++; throw new Error('private'); } });
    const proxy = (object: object) => new Proxy(object, { getPrototypeOf() { calls++; throw new Error('private'); } });
    for (const value of [accessor(saved, 'requestsUsed'), { ...saved, limits: accessor(saved.limits, 'maxRequests') }, proxy(saved), { ...saved, limits: proxy(saved.limits) }]) assert.throws(() => TaskTreeBudget.restore(value), TypeError);
    for (const options of [accessor({}, 'maxRequests'), proxy({}), { maxEstimatedTokens: -1 }, { monotonicNow: 'invalid' }, { unknown: true }]) assert.throws(() => TaskTreeBudget.restore(saved, options as never), TypeError);
    assert.equal(calls, 0);
    const hidden = Object.defineProperty({ ...saved }, 'requestsUsed', { value: 0, enumerable: false });
    assert.throws(() => TaskTreeBudget.restore(hidden), TypeError);
    assert.throws(() => TaskTreeBudget.restore({ ...saved, [Symbol('hidden')]: 0 }), TypeError);
    assert.doesNotThrow(() => TaskTreeBudget.restore(Object.assign(Object.create(null), saved), { monotonicNow: () => 0 }));
});

test('restore validates fresh monotonic clocks and cumulative elapsed overflow', () => {
    const saved = new TaskTreeBudget({ monotonicNow: () => 0 }).snapshot();
    for (const time of [-1, NaN, Infinity]) assert.throws(() => TaskTreeBudget.restore(saved, { monotonicNow: () => time }), TypeError);
    let time = 0;
    const restored = TaskTreeBudget.restore({ ...saved, elapsedMs: Number.MAX_SAFE_INTEGER }, { monotonicNow: () => time });
    assert.equal(restored.snapshot().elapsedMs, Number.MAX_SAFE_INTEGER);
    time = 1; assert.throws(() => restored.snapshot(), TypeError);
    time = 10;
    const clock = TaskTreeBudget.restore(saved, { monotonicNow: () => time });
    time = Infinity; assert.throws(() => clock.check(), TypeError);
});
