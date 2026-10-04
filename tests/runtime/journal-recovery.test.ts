import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { RuntimeStore } from '../../src/runtime/store';
import { Supervisor } from '../../src/runtime/supervisor';
import { beginToolOutcome } from '../../src/runtime/tool-outcome';
import type { RunRecord, SessionRecord } from '../../src/shared/contracts';
import type { TranscriptEvent, InvocationIdentity } from '../../src/shared/harness-contracts';

test('recovery pairs invocation identities by session and run, preserves event order and rejects malformed identities', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uah-recovery-identities-'));
    const store = new RuntimeStore(directory);
    const event = (sessionId: string, runId: string, sessionSeq: number, type: 'tool.dispatch' | 'tool.result', invocationId = 'same-id'): TranscriptEvent => {
        const identity: InvocationIdentity = { sessionId, runId, rootRunId: runId, parentRunId: null, turnId: runId,
            requestId: 'request', attemptId: 'attempt', stepId: 'step', invocationId, toolCallId: 'call' };
        return { schemaVersion: 1, eventId: randomUUID(), sessionSeq, timestamp: new Date().toISOString(), processEpochId: 'epoch', run: identity, type,
            payload: type === 'tool.dispatch' ? { identity, executionId: null, approvalId: null, toolName: 'read_file' }
                : { invocationId, outcome: beginToolOutcome().outcome } } as TranscriptEvent;
    };
    try {
        store.commit({ journal: [event('a', 'a1', 1, 'tool.dispatch'), event('a', 'a2', 2, 'tool.result'),
            event('b', 'b1', 1, 'tool.dispatch'), event('b', 'b1', 2, 'tool.result')] });
        assert.deepEqual([...store.readUnresolvedDispatchRuns()], ['a1']);
        assert.deepEqual(store.readToolDispatchIdentities('a'), [{ invocationId: 'same-id', toolCallId: 'call' }]);
        store.commit({ journal: [event('a', 'a1', 3, 'tool.result'), event('a', 'a1', 4, 'tool.dispatch')] });
        assert.deepEqual([...store.readUnresolvedDispatchRuns()], ['a1']);
        store.commit({ journal: [event('a', 'a1', 5, 'tool.result')] });
        assert.deepEqual([...store.readUnresolvedDispatchRuns()], []);
        store.commit({ journal: [event('a', 'a1', 6, 'tool.dispatch', '')] });
        assert.throws(() => store.readUnresolvedDispatchRuns(), /Invalid recovery invocation identity/);
    } finally {
        store.close();
        const target = resolve(directory);
        assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-recovery-identities-'));
        rmSync(target, { recursive: true, force: true });
    }
});

for (const resultRecorded of [false, true]) test(`restart ${resultRecorded ? 'retains confirmed result' : 'gates unresolved dispatch'} without re-execution`, async t => {
    const directory = mkdtempSync(join(tmpdir(), 'uah-journal-recovery-'));
    const effective = { runtimeId: 'api', modelId: 'fixture', agentId: 'api-text', policyVersion: 1 };
    const session: SessionRecord = { id: randomUUID(), title: 'Recovery', directory: null, requested: effective, createdAt: new Date().toISOString() };
    const run: RunRecord = { id: randomUUID(), sessionId: session.id, turnId: randomUUID(), state: 'running', input: 'fixture', output: '', effective, sequence: 0, createdAt: session.createdAt };
    const identity: InvocationIdentity = { sessionId: session.id, runId: run.id, rootRunId: run.id, parentRunId: null, turnId: run.turnId, requestId: randomUUID(), attemptId: randomUUID(), stepId: randomUUID(), invocationId: randomUUID(), toolCallId: 'duplicate-provider-id' };
    const store = new RuntimeStore(directory);
    const dispatch: TranscriptEvent = { schemaVersion: 1, eventId: randomUUID(), sessionSeq: 1, timestamp: session.createdAt, processEpochId: randomUUID(), run: identity, type: 'tool.dispatch', payload: { identity, executionId: randomUUID(), approvalId: null, toolName: 'run_command' } };
    const outcome = beginToolOutcome().outcome; outcome.recordingState = 'durable'; outcome.effectState = 'possible';
    store.commit({ sessions: [session], runs: [run], journal: [dispatch, ...(resultRecorded ? [{ ...dispatch, eventId: randomUUID(), sessionSeq: 2, type: 'tool.result' as const, payload: { invocationId: identity.invocationId, outcome } }] : [])] });
    store.close();
    const fullSnapshot = t.mock.method(RuntimeStore.prototype, 'readSnapshot', () => { throw new Error('Startup must not materialize a full history snapshot'); });
    let supervisor: Supervisor;
    try { supervisor = new Supervisor({ dataDirectory: directory, onEvent: () => {} }); }
    finally { fullSnapshot.mock.restore(); }
    try {
        const snapshot = await supervisor.execute({ type: 'snapshot' });
        assert.equal(snapshot.runs[0].state, 'stopped');
        assert.equal(snapshot.runs[0].harnessState, resultRecorded ? undefined : 'needs_reconciliation');
        const view = supervisor.journalView({ action: 'summary', sessionId: session.id });
        assert.equal('sessionId' in view && view.sessionId, session.id);
        assert.throws(() => supervisor.journalSessionDirectory('unknown'), /不存在/);
    } finally { await supervisor.shutdown(); }
});
