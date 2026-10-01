import test from 'node:test';
import assert from 'node:assert/strict';
import { requestEvents } from '../../src/runtime/request-events';

test('request trace follows tool batches and dispatches to results and approvals across attempts', () => {
    const identity = (attemptId: string, invocationId: string) => ({ requestId: 'request', attemptId, invocationId });
    const event = (type: string, payload: unknown, runId = 'root') => ({ type, payload, run: { runId } });
    const events = [event('request.intent', { identity: identity('a', 'unused') }),
        event('tool.batch', { requestId: 'request', attemptId: 'a', invocations: [identity('a', 'one')] }),
        event('approval.requested', { invocationId: 'one' }), event('approval.decided', { invocationId: 'one' }),
        event('tool.result', { invocationId: 'one', outcome: { status: 'denied' } }),
        event('tool.dispatch', { identity: identity('b', 'two') }), event('tool.result', { invocationId: 'two' }),
        event('tool.result', { invocationId: 'one' }, 'foreign'),
        event('message.accepted', { content: { requestId: 'request', attemptId: 'a' } }),
        event('tool.result', { invocationId: 'unknown', outcome: { nested: identity('a', 'one') } })];
    assert.deepEqual(requestEvents(events, 'request', 'a'), events.slice(0, 5));
    assert.deepEqual(requestEvents(events, 'request', 'b'), events.slice(5, 7));
    assert.deepEqual(requestEvents(events, 'request'), events.slice(0, 7));
    assert.deepEqual(requestEvents(events, 'absent'), []);
});
