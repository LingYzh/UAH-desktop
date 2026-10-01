import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeStore, type StoreCommit } from '../../src/runtime/store';
import { RunJournal } from '../../src/runtime/run-journal';
import type { RunRecord } from '../../src/shared/contracts';

function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-run-journal-'));
    const store = new RuntimeStore(directory);
    const run: RunRecord = { id: randomUUID(), sessionId: randomUUID(), turnId: randomUUID(), state: 'running', input: 'task', output: '', sequence: 0,
        createdAt: new Date().toISOString(), effective: { runtimeId: 'api', modelId: 'model', agentId: 'default', policyVersion: 1 } };
    const session = { id: run.sessionId, title: 'Fixture', directory: null, requested: run.effective, createdAt: run.createdAt };
    store.commit({ sessions: [session], runs: [run] });
    const failures: RunRecord[][] = [];
    const journal = new RunJournal(store, directory, id => id === run.id ? run : undefined, failed => failures.push(failed));
    t.after(() => {
        journal.close(); store.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
        assert.ok(path.basename(directory).startsWith('uah-run-journal-'));
        rmSync(directory, { recursive: true, force: true });
    });
    const requestId = randomUUID(); const attemptId = randomUUID();
    const delta = (text: string, offset: number) => ({ requestId, attemptId, blockId: `${attemptId}:text`, offset, offsetUnit: 'utf16' as const, text });
    return { directory, store, journal, run, session, failures, requestId, attemptId, delta };
}

test('100000 characters in twenty-character deltas persist exact offsets with bounded commits and snapshots', t => {
    const f = fixture(t);
    const original = f.store.commit.bind(f.store);
    const commits: Array<{ deltaCount: number; snapshotCharacters: number }> = [];
    t.mock.method(f.store, 'commit', (changes: StoreCommit) => {
        commits.push({ deltaCount: changes.journal?.filter(event => event.type === 'response.delta').length ?? 0,
            snapshotCharacters: changes.runs?.reduce((sum, run) => sum + run.output.length, 0) ?? 0 });
        return original(changes);
    });
    const chunk = '0123456789abcdefghij';
    for (let offset = 0; offset < 100_000; offset += chunk.length) {
        f.run.output += chunk; f.journal.delta(f.run, f.delta(chunk, offset));
    }
    f.journal.event(f.run, 'response.terminal', { requestId: f.requestId, attemptId: f.attemptId, status: 'completed', partial: false });
    t.mock.restoreAll();
    assert.ok(commits.length <= 8, `Unexpected per-delta writes: ${commits.length}`);
    assert.ok(commits.filter(commit => commit.snapshotCharacters > 0).length <= 8);
    assert.ok(commits.reduce((sum, commit) => sum + commit.snapshotCharacters, 0) <= 800_000);
    const events = [];
    let after = 0;
    for (;;) { const page = f.store.readJournal(f.run.sessionId, after, 1000); if (!page.length) break; events.push(...page); after = page.at(-1)!.sessionSeq; }
    const deltas = events.filter(event => event.type === 'response.delta');
    assert.equal(deltas.length, 5000); assert.equal(deltas.map(event => event.payload.text).join(''), chunk.repeat(5000));
    for (const [index, event] of deltas.entries()) { assert.equal(event.payload.offset, index * 20); assert.equal(event.sessionSeq, index + 1); }
    assert.equal(f.store.readSnapshot().runs[0].output, f.run.output);
    assert.equal(events.at(-1)?.type, 'response.terminal');
    assert.equal(f.journal.recordingHealth(f.run.sessionId).status, 'healthy');
});

test('reasoning materialization batches snapshots without inventing text transcript deltas', async t => {
    const f = fixture(t);
    const original = f.store.commit.bind(f.store); let commits = 0;
    t.mock.method(f.store, 'commit', (changes: StoreCommit) => { commits++; return original(changes); });
    f.run.activities = [{ id: randomUUID(), kind: 'reasoning', title: 'Reasoning', content: '', status: 'running' }];
    for (let index = 0; index < 100; index++) { f.run.activities[0].content += 'think'; f.journal.materialize(f.run, 5); }
    assert.equal(commits, 0);
    await delay(75);
    assert.equal(commits, 1); assert.equal(f.store.readSnapshot().runs[0].activities?.[0].content, 'think'.repeat(100));
    assert.deepEqual(f.store.readJournal(f.run.sessionId), []);
});

test('canonical commit failure permanently stops admission and accepts only an explicit failure projection', t => {
    const f = fixture(t); const original = f.store.commit.bind(f.store); let shouldFail = true;
    t.mock.method(f.store, 'commit', (changes: StoreCommit) => {
        if (shouldFail) throw new Error('fixture canonical failure');
        return original(changes);
    });
    f.run.output = 'observed'; f.journal.delta(f.run, f.delta('observed', 0));
    assert.throws(() => f.journal.flush(), /canonical failure/);
    assert.equal(f.failures.length, 1); assert.equal(f.failures[0][0].id, f.run.id);
    shouldFail = false;
    assert.throws(() => f.journal.admit(f.run.sessionId), /suspended/);
    assert.throws(() => f.journal.materialize(f.run, 1), /suspended/);
    assert.throws(() => f.journal.event(f.run, 'request.dispatch', { requestId: f.requestId, attemptId: f.attemptId }), /suspended/);
    const failed: RunRecord = { ...f.run, state: 'failed', harnessState: 'recording_failed', error: 'Recording failed' };
    assert.throws(() => f.journal.commit({ runs: [failed], sessions: [{ ...f.session, id: randomUUID() }] }), /suspended|failure projection/);
    assert.throws(() => f.journal.event(failed, 'request.dispatch', { requestId: f.requestId, attemptId: f.attemptId }, { runs: [failed] }), /suspended|failure projection/);
    f.journal.commit({ runs: [failed], events: [{ type: 'run-state', runtimeId: failed.effective.runtimeId, sessionId: failed.sessionId, runId: failed.id, turnId: failed.turnId, sequence: 1, payload: { run: failed } }] });
    t.mock.restoreAll();
    assert.equal(f.store.readSnapshot().runs[0].state, 'failed');
    assert.equal(f.store.readSnapshot().runs[0].harnessState, 'recording_failed');
    assert.equal(f.store.readJournal(f.run.sessionId).some(event => event.type === 'request.dispatch'), false);
    assert.throws(() => f.journal.admit(f.run.sessionId), /suspended/);
});

test('projection failure leaves canonical watermark authoritative and repairs a degraded export', t => {
    const f = fixture(t);
    const sessions = path.join(f.directory, 'sessions'); writeFileSync(sessions, 'fixture-blocker');
    f.journal.event(f.run, 'response.started', { requestId: f.requestId, attemptId: f.attemptId });
    const degraded = f.journal.recordingHealth(f.run.sessionId);
    assert.equal(degraded.status, 'degraded'); assert.equal(degraded.durableSeq, 1); assert.equal(degraded.exportedSeq, 0);
    assert.equal(f.store.readJournal(f.run.sessionId).length, 1);
    assert.doesNotThrow(() => f.journal.admit(f.run.sessionId));
    unlinkSync(sessions); mkdirSync(sessions);
    const directory = f.journal.project(f.run.sessionId);
    assert.equal(path.dirname(directory), sessions);
    const healthy = f.journal.recordingHealth(f.run.sessionId);
    assert.equal(healthy.status, 'healthy'); assert.equal(healthy.durableSeq, 1); assert.equal(healthy.exportedSeq, 1);
    assert.deepEqual(readFileSync(path.join(directory, 'transcript.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)), f.store.readJournal(f.run.sessionId));
    writeFileSync(path.join(directory, 'transcript.jsonl'), 'tampered projection\n');
    f.journal.project(f.run.sessionId);
    assert.equal(readFileSync(path.join(directory, 'transcript.jsonl'), 'utf8'), f.store.readJournal(f.run.sessionId).map(event => JSON.stringify(event) + '\n').join(''));
    assert.equal(path.basename(directory), createHash('sha256').update(JSON.stringify(f.run.sessionId)).digest('hex'));
});
