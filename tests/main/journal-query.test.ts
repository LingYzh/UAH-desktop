import test from 'node:test';
import assert from 'node:assert/strict';
import { parseJournalQuery, parseJournalSessionQuery } from '../../src/shared/journal-view';

test('journal IPC accepts only fixed actions and typed identities', () => {
    for (const query of [
        { action: 'summary', sessionId: 'session-1' },
        { action: 'request', sessionId: 'session-1', requestId: 'request_2' },
        { action: 'request', sessionId: 'session-1', requestId: 'request_2', attemptId: 'attempt_3' },
        { action: 'open', sessionId: 'session-1' },
        { action: 'export', sessionId: 'session-1', mode: 'full' },
        { action: 'export', sessionId: 'session-1', mode: 'share' },
    ]) assert.deepEqual(parseJournalQuery(query), query);
    assert.deepEqual(parseJournalSessionQuery({ sessionId: 'session-1' }), { sessionId: 'session-1' });
    const emptyPrototype = Object.assign(Object.create(null), { action: 'summary', sessionId: 'session-1' });
    assert.deepEqual(parseJournalQuery(emptyPrototype), { action: 'summary', sessionId: 'session-1' });
});

test('journal IPC rejects path injection, extra fields, invalid modes and identities', () => {
    for (const query of [
        null, [], new Date(), { action: 'delete', sessionId: 'session-1' },
        { action: 'summary', sessionId: '../other' }, { action: 'open', sessionId: 'C:/secret' },
        { action: 'summary', sessionId: '' }, { action: 'summary', sessionId: 'a'.repeat(201) },
        { action: 'summary', sessionId: 'session\n1' }, { action: 'summary', sessionId: ' session' },
        { action: 'summary', sessionId: 'session-1', after: 1 },
        { action: 'summary', sessionId: 'session-1', path: 'C:/secret' },
        { action: 'request', sessionId: 'session-1' }, { action: 'request', sessionId: 'session-1', requestId: '../secret' },
        { action: 'request', sessionId: 'session-1', requestId: 'request_2', attemptId: '../secret' },
        { action: 'request', sessionId: 'session-1', requestId: 'request_2', attemptId: undefined },
        { action: 'export', sessionId: 'session-1', mode: 'full', destination: 'C:/secret' },
        { action: 'export', sessionId: 'session-1', mode: 'raw' }, { action: 'export', sessionId: 'session-1', mode: true },
    ]) assert.throws(() => parseJournalQuery(query), TypeError);
    assert.throws(() => parseJournalSessionQuery({ sessionId: 'session-1', path: 'elsewhere' }), TypeError);
});

test('journal IPC rejects accessors, inherited authority and symbol fields without invoking getters', () => {
    let called = false;
    const accessor = { sessionId: 'session-1', get action() { called = true; return 'summary'; } };
    assert.throws(() => parseJournalQuery(accessor), TypeError); assert.equal(called, false);
    assert.throws(() => parseJournalQuery(Object.create({ action: 'summary', sessionId: 'session-1' })), TypeError);
    assert.throws(() => parseJournalQuery({ action: 'summary', sessionId: 'session-1', [Symbol('path')]: 'secret' }), TypeError);
});
