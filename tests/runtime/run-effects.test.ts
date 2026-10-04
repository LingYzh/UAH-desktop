import test from 'node:test';
import assert from 'node:assert/strict';
import type { Snapshot } from '../../src/shared/contracts';
import { sessionHasFileChanges } from '../../src/shared/run-effects';

test('side effects retain reverted writes, empty creation and child/retry artifacts across a session', () => {
    const snapshot = { artifacts: [{ sessionId: 'other', oldContent: null, newContent: '' }], runs: [] } as unknown as Snapshot;
    assert.equal(sessionHasFileChanges(snapshot, 'session'), false);
    snapshot.artifacts.push({ sessionId: 'session', oldContent: null, newContent: '' } as any);
    assert.equal(sessionHasFileChanges(snapshot, 'session'), true);
    snapshot.artifacts = [{ sessionId: 'session', oldContent: 'a', newContent: 'b' }, { sessionId: 'session', oldContent: 'b', newContent: 'a' }] as any;
    assert.equal(sessionHasFileChanges(snapshot, 'session'), true);
});

test('actual command/write outcomes conservatively block retries while denied/start-failed operations do not', () => {
    for (const [name, status, result, expected] of [
        ['write_file', 'failed', 'File written, but snapshot persistence failed.', true],
        ['write_file', 'failed', 'Write failed after modification began.', true],
        ['write_file', 'failed', 'Permission mode denies this operation.', false],
        ['run_command', 'completed', 'Exit code: 0\noutput', true],
        ['run_command', 'failed', 'Exit code: 1\nerror', true],
        ['run_command', 'failed', 'Unsandboxed command: interrupted', true],
        ['run_command', 'failed', 'Command could not start.\nUnsandboxed command: missing', false],
        ['run_command', 'failed', 'Permission mode denies this operation.', false],
    ] as const) {
        const snapshot = { artifacts: [], runs: [{ sessionId: 'session', parentRunId: 'parent', retryOfRunId: 'old', activities: [{ title: name, status, content: `${JSON.stringify({ content: 'Exit code: 0\n\nFile written.' })}\n\n${result}` }] }] } as unknown as Snapshot;
        assert.equal(sessionHasFileChanges(snapshot, 'session'), expected, result);
        assert.equal(sessionHasFileChanges(snapshot, 'other'), false);
    }
});

test('memory writes and forgetting count as durable effects but declined memory approvals do not', () => {
    for (const name of ['save_memory', 'forget_memory']) {
        for (const effectState of ['not_started', 'possible', 'confirmed']) {
            const snapshot = { artifacts: [], runs: [{ sessionId: 'session', activities: [{ title: name,
                tool: { name, outcome: { effectState } } }] }] } as unknown as Snapshot;
            assert.equal(sessionHasFileChanges(snapshot, 'session'), effectState !== 'not_started');
        }
    }
});
