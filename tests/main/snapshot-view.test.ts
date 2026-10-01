import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSnapshotView } from '../../src/shared/snapshot-view';

test('snapshot view accepts only an optional explicit session identity or overview', () => {
    assert.equal(parseSnapshotView(undefined), undefined);
    assert.deepEqual(parseSnapshotView({ sessionId: null }), { sessionId: null });
    assert.deepEqual(parseSnapshotView({ sessionId: 'session-1' }), { sessionId: 'session-1' });
    assert.deepEqual(parseSnapshotView({ sessionId: 'session-1', turnLimit: 50 }), { sessionId: 'session-1', turnLimit: 50 });
    for (const turnLimit of [undefined, null, 0, -1, 1.5, Infinity, 100001, '50']) assert.throws(() => parseSnapshotView({ sessionId: 'a', turnLimit }), TypeError);
    assert.throws(() => parseSnapshotView({ sessionId: null, turnLimit: 50 }), TypeError);
    assert.throws(() => parseSnapshotView({ sessionId: 'a', get turnLimit() { throw new Error('must not access'); } }), TypeError);
    for (const value of [null, [], {}, { sessionId: '' }, { sessionId: '../secret' }, { sessionId: undefined }, { sessionId: 'a', path: 'elsewhere' }, Object.create({ sessionId: 'a' })]) {
        assert.throws(() => parseSnapshotView(value), TypeError);
    }
    let accessed = false;
    assert.throws(() => parseSnapshotView({ get sessionId() { accessed = true; return 'a'; } }), TypeError);
    assert.equal(accessed, false);
    assert.throws(() => parseSnapshotView({ sessionId: 'a', [Symbol()]: 1 }), TypeError);
});
