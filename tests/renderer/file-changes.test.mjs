import assert from 'node:assert/strict';
import test from 'node:test';
import { roundFileChanges, filePathKey } from '../../src/renderer/file-changes.js';

const run = { id: 'root', sessionId: 'session' };
const artifact = (id, oldContent, newContent, overrides = {}) => ({ id, sessionId: 'session', runId: 'root', turnId: 'turn', path: 'C:\\Project\\file.txt', oldContent, newContent, createdAt: '2026-09-27T00:00:00Z', hash: id, ...overrides });

test('round merges ordered repeated writes preserving complete snapshot fields and original path', () => {
    const first = artifact('first', 'old', 'middle', { createdAt: '2026-09-26T01:00:00Z' });
    const last = artifact('last', 'middle', 'new', { path: 'c:/PROJECT/file.txt', createdAt: '2026-09-27T00:00:00Z' });
    const snapshot = { runs: [run], artifacts: [last, first] };
    const before = structuredClone(snapshot);
    assert.deepEqual(roundFileChanges(run, snapshot), [{ ...first, newContent: 'new', createdAt: last.createdAt, hash: 'last', latestArtifactId: 'last', artifactIds: ['first', 'last'] }]);
    assert.deepEqual(snapshot, before);
});

test('recursive child artifacts stay inside the root session and descendant graph', () => {
    const snapshot = { runs: [run,
        { id: 'child', sessionId: 'session', parentRunId: 'root' },
        { id: 'grandchild', sessionId: 'session', parentRunId: 'child' },
        { id: 'foreign', sessionId: 'other', parentRunId: 'root' },
        { id: 'invalid-grandchild', sessionId: 'session', parentRunId: 'foreign' },
        { id: 'sibling', sessionId: 'session' }], artifacts: [
        artifact('root-edit', 'old', 'one'), artifact('child-edit', 'one', 'two', { runId: 'child' }),
        artifact('grandchild-edit', 'two', 'three', { runId: 'grandchild' }),
        artifact('foreign-edit', 'three', 'wrong', { runId: 'foreign', sessionId: 'other' }),
        artifact('bad-grandchild', 'three', 'wrong', { runId: 'invalid-grandchild' }),
        artifact('sibling-edit', 'three', 'wrong', { runId: 'sibling' }),
        artifact('wrong-artifact-session', 'three', 'wrong', { runId: 'child', sessionId: 'other' })] };
    const result = roundFileChanges(run, snapshot);
    assert.equal(result.length, 1); assert.equal(result[0].newContent, 'three'); assert.equal(result[0].runId, 'root');
    assert.deepEqual(result[0].artifactIds, ['root-edit', 'child-edit', 'grandchild-edit']);
});

test('equal dates preserve input order and POSIX paths remain case-sensitive', () => {
    const result = roundFileChanges(run, { runs: [run], artifacts: [
        artifact('second', 'one', 'two', { path: '/project/a.txt' }),
        artifact('third', 'two', 'three', { path: '/project/a.txt' }),
        artifact('distinct', null, 'upper', { path: '/project/A.txt' }),
        artifact('first', 'old', 'one', { path: '/project/a.txt', createdAt: '2026-09-26T00:00:00Z' })] });
    assert.deepEqual(result[0].artifactIds, ['first', 'second', 'third']);
    assert.equal(result[0].newContent, 'three'); assert.equal(result.length, 2);
    assert.equal(filePathKey('C:\\Project\\.\\sub\\..\\a.txt'), filePathKey('c:/project/a.txt'));
    assert.notEqual(filePathKey('/project/A.txt'), filePathKey('/project/a.txt'));
});

test('net reverted edits disappear but creation of an empty file remains', () => {
    const result = roundFileChanges(run, { runs: [run], artifacts: [
        artifact('edit', 'original', 'temporary'), artifact('revert', 'temporary', 'original'),
        artifact('empty-create', null, '', { path: '/project/empty.txt' })] });
    assert.equal(result.length, 1); assert.equal(result[0].id, 'empty-create');
    assert.equal(result[0].oldContent, null); assert.equal(result[0].newContent, '');
});

test('retry rounds retain actual changes from same-session retry ancestors and their children', () => {
    const retry = { id: 'retry', sessionId: 'session', retryOfRunId: 'root' };
    const older = { id: 'older', sessionId: 'session', retryOfRunId: 'foreign' };
    const result = roundFileChanges(retry, { runs: [retry, { ...run, retryOfRunId: 'older' }, older,
        { id: 'child', sessionId: 'session', parentRunId: 'root' }, { id: 'foreign', sessionId: 'other' }],
    artifacts: [artifact('initial', null, 'one', { runId: 'older' }), artifact('child-edit', 'one', 'two', { runId: 'child' }),
        artifact('retry-edit', 'two', 'three', { runId: 'retry' }), artifact('foreign', 'three', 'wrong', { runId: 'foreign', sessionId: 'other' })] });
    assert.equal(result[0].runId, 'retry'); assert.equal(result[0].newContent, 'three');
    assert.deepEqual(result[0].artifactIds, ['initial', 'child-edit', 'retry-edit']);
});
