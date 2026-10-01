import assert from 'node:assert/strict';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { retryDelayMs, abortableRetryDelay } from '../../src/runtime/request-retry';

test('only exact structured whitelist reasons receive the two fixed run-wide delays', () => {
    for (const reason of ['http.408', 'http.429', 'http.500', 'http.502', 'http.503', 'http.504',
        'network.ECONNRESET', 'network.ETIMEDOUT', 'network.UND_ERR_CONNECT_TIMEOUT']) {
        assert.equal(retryDelayMs(reason, 0), 250);
        assert.equal(retryDelayMs(reason, 1), 1000);
        assert.equal(retryDelayMs(reason, 2), null);
        assert.equal(retryDelayMs(reason, 100), null);
    }
    for (const reason of ['', 'http.400', 'http.401', 'http.403', 'http.404', 'http.501', 'network.ECONNREFUSED',
        'network.ENOTFOUND', 'recording_error', 'ECONNRESET', 'HTTP 429', 'http.429 ', 'Http.429',
        'request failed: http.503', 'Network timed out (ETIMEDOUT)', 'tool batch accepted']) {
        assert.equal(retryDelayMs(reason, 0), null);
    }
});

test('invalid retry counters reject even when the reason is not retryable', () => {
    for (const count of [-1, .5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '0', null]) {
        assert.throws(() => retryDelayMs('http.429', count as number), /nonnegative safe integer/);
        assert.throws(() => retryDelayMs('unknown', count as number), /nonnegative safe integer/);
    }
    assert.equal(retryDelayMs('http.429', Number.MAX_SAFE_INTEGER), null);
});

test('pre-cancelled delay rejects the exact signal reason without scheduling or adding listeners', async t => {
    const controller = new AbortController(); const reason = { exact: 'caller reason' }; controller.abort(reason);
    let scheduled = 0;
    t.mock.method(globalThis, 'setTimeout', () => { scheduled++; throw new Error('must not schedule'); });
    await assert.rejects(abortableRetryDelay(1000, controller.signal), error => error === reason);
    assert.equal(scheduled, 0); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('waiting cancellation rejects immediately with the exact reason and removes timer/listener', async t => {
    const controller = new AbortController(); const reason = new Error('stop while waiting');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const originalClear = globalThis.clearTimeout; let cleared = 0;
    t.mock.method(globalThis, 'clearTimeout', (...args: Parameters<typeof clearTimeout>) => { cleared++; return originalClear(...args); });
    const delay = abortableRetryDelay(10000, controller.signal);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
    const rejected = assert.rejects(delay, error => error === reason);
    controller.abort(reason); await rejected;
    assert.equal(cleared, 1); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    t.mock.timers.tick(10000);
    assert.equal(cleared, 1, 'cancelled timer cannot execute normal completion cleanup');
});

test('normal completion resolves once and removes listener, including a zero delay', async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    for (const ms of [0, 250, 1000, 10000]) {
        const controller = new AbortController(); let resolved = false;
        const delay = abortableRetryDelay(ms, controller.signal).then(() => { resolved = true; });
        assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
        if (ms) { t.mock.timers.tick(ms - 1); await Promise.resolve(); assert.equal(resolved, false); t.mock.timers.tick(1); }
        else t.mock.timers.tick(0);
        await delay; assert.equal(resolved, true); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
        controller.abort(new Error('after completion')); assert.equal(resolved, true);
    }
});

test('delay rejects invalid bounds before creating resources', async () => {
    const controller = new AbortController();
    for (const ms of [-1, 10001, .5, NaN, Infinity, '1', null]) {
        await assert.rejects(abortableRetryDelay(ms as number, controller.signal), /integer from 0 through 10000/);
    }
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});
