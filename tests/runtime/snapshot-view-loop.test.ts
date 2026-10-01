import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../../src/runtime/store';
import { Supervisor } from '../../src/runtime/supervisor';
import type { RunRecord, SessionRecord, ArtifactSnapshot, RuntimeEvent } from '../../src/shared/contracts';

const timestamp = '2026-10-01T00:00:00Z';
const effective = { runtimeId: 'local-verification', modelId: 'local', agentId: 'local', policyVersion: 1 };
test('tail IPC excludes unrelated resident cache entries and keeps legacy complete access explicit', async t => {
    const f = fixture(t, store => store.commit({ sessions: [session('a')],
        runs: Array.from({ length: 1000 }, (_, index) => run(`a-${index}`, 'a')) }));
    for (let index = 400; index < 528; index++) f.supervisor.requestContext(`a-${index}`);
    const page = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'a', turnLimit: 50 });
    assert.equal(page.historyWindow!.total, 1000);
    assert.deepEqual(page.historyWindow!.rootIds, Array.from({ length: 50 }, (_, index) => `a-${950 + index}`));
    assert.equal(page.runs.length, 51); assert.equal(page.runs[0].id, 'a-0');
    assert.equal(page.runs.some(item => item.id === 'a-500'), false);
    const expanded = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'a', turnLimit: 100 });
    assert.equal(expanded.historyWindow!.rootIds.length, 100); assert.equal(expanded.runs.length, 101);
    const full = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'a' });
    assert.equal(full.historyWindow, undefined); assert.equal(full.runs.length, 1000);
});
function session(id: string): SessionRecord { return { id, title: id, directory: null, requested: effective, createdAt: timestamp }; }
function run(id: string, sessionId: string, parentRunId?: string): RunRecord { return { id, sessionId, ...(parentRunId ? { parentRunId } : {}), turnId: id, state: 'completed', input: id, output: 'BODY'.repeat(1000), sequence: 1, createdAt: timestamp, effective }; }
function fixture(t: { after(fn: () => Promise<void>): void }, prepare: (store: RuntimeStore) => void) {
    const directory = mkdtempSync(join(tmpdir(), 'uah-snapshot-view-'));
    const store = new RuntimeStore(directory); prepare(store); store.close();
    const supervisor = new Supervisor({ dataDirectory: directory, onEvent: () => {} });
    t.after(async () => { await supervisor.shutdown(); const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-snapshot-view-')); rmSync(target, { recursive: true, force: true }); });
    return { supervisor, directory };
}

test('session IPC projection retains local history and global state without transmitting foreign bodies', async t => {
    const f = fixture(t, store => {
        store.commit({ sessions: [session('a'), session('b')] });
        store.commit({ runs: [...Array.from({ length: 1000 }, (_, index) => run(`b-${index}`, 'b')), run('a-root', 'a'), { ...run('a-child', 'a', 'a-root'), state: 'failed' }] });
    });
    const overview = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: null });
    assert.equal(overview.sessions.length, 2); assert.deepEqual(overview.runs, []); assert.deepEqual(overview.artifacts, []);
    assert.equal(overview.overview!.rootStates.a.id, 'a-root'); assert.equal(overview.overview!.latestStates.a.id, 'a-child');
    assert.equal(overview.overview!.latestStates.a.state, 'failed'); assert.equal(overview.overview!.rootStates.b.id, 'b-999');
    assert.deepEqual(overview.overview!.activeRunIds, []); assert.equal(JSON.stringify(overview).includes('BODY'), false);
    const selected = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'a' });
    assert.deepEqual(selected.runs.map(item => item.id), ['a-root', 'a-child']); assert.equal(selected.viewSessionId, 'a');
    const legacy = await f.supervisor.execute({ type: 'snapshot' }); assert.equal(legacy.runs.length, 1002);
    assert.equal(legacy.overview, undefined); assert.ok(JSON.stringify(selected).length * 100 < JSON.stringify(legacy).length);
    await assert.rejects(f.supervisor.execute({ type: 'create-session', title: 'must not create', directory: null }, { sessionId: 'missing' }), /不存在/);
    assert.equal((await f.supervisor.execute({ type: 'snapshot' }, { sessionId: null })).sessions.length, 2);
});

test('selected session verifies its own immutable file evidence without scanning foreign artifact bodies', async t => {
    const newContent = 'verified file';
    const artifact: ArtifactSnapshot = { id: 'artifact-b', sessionId: 'b', runId: 'b-root', turnId: 'b-root', path: 'file.txt', oldContent: null, newContent,
        hash: createHash('sha256').update(newContent).digest('hex'), createdAt: timestamp };
    const event: RuntimeEvent = { type: 'artifact-created', runtimeId: effective.runtimeId, sessionId: 'b', runId: 'b-root', turnId: 'b-root', sequence: 1, payload: { artifact } };
    const f = fixture(t, store => store.commit({ sessions: [session('a'), session('b')], runs: [run('a-root', 'a'), run('b-root', 'b')], artifacts: [artifact], events: [event] }));
    const db = new DatabaseSync(join(f.directory, 'runtime.sqlite'));
    db.prepare('UPDATE artifacts SET data = ? WHERE id = ?').run(JSON.stringify({ ...artifact, newContent: 'tampered' }), artifact.id); db.close();
    const a = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'a' }); assert.equal(a.runs.length, 1); assert.equal(a.artifacts.length, 0);
    await assert.rejects(f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'b' }), /manifest mismatch/);
    await assert.rejects(f.supervisor.execute({ type: 'snapshot' }), /manifest mismatch/);
});

test('sidebar summaries omit copied branch histories while selected branch configuration remains available', async t => {
    const branchAgent = { ...effective, agentInstructions: 'LOCKED BRANCH AGENT' };
    const f = fixture(t, store => store.commit({ sessions: [{ ...session('a'), branchAgent, branchMessages: [{ role: 'user', content: 'COPIED BRANCH BODY' }] }, session('b')] }));
    const overview = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: null });
    assert.equal(JSON.stringify(overview).includes('COPIED BRANCH BODY'), false); assert.equal(overview.sessions[0].branchAgent, undefined);
    const selected = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'a' }); assert.deepEqual(selected.sessions[0].branchAgent, branchAgent);
    assert.equal(selected.sessions[0].branchMessages![0].content, 'COPIED BRANCH BODY');
    const other = await f.supervisor.execute({ type: 'snapshot' }, { sessionId: 'b' });
    assert.equal(other.sessions[0].branchMessages, undefined);
    assert.equal(JSON.stringify(other).includes('COPIED BRANCH BODY'), false);
    const legacy = await f.supervisor.execute({ type: 'snapshot' }); assert.equal(legacy.sessions[0].branchMessages![0].content, 'COPIED BRANCH BODY');
});
