import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore, RUNTIME_SCHEMA_VERSION, type RuntimeStoreOptions, type RunPageOptions } from '../../src/runtime/store';
import type { SessionRecord, RunRecord, ArtifactSnapshot, RuntimeEvent, ApprovalRecord } from '../../src/shared/contracts';

const timestamp = '2026-10-01T00:00:00.000Z';
const effective = { runtimeId: 'runtime', modelId: 'model', agentId: 'agent', policyVersion: 1 };
function session(id = 'a'): SessionRecord {
    return { id, title: id, directory: null, requested: effective, createdAt: timestamp };
}
function run(id: string, sessionId = 'a', createdAt = timestamp): RunRecord {
    return { id, sessionId, turnId: id, state: 'completed', input: id, output: 'saved', effective, sequence: 1, createdAt };
}
function fixture(t: { after(fn: () => void): void }, options?: RuntimeStoreOptions) {
    const root = resolve(tmpdir());
    const directory = mkdtempSync(join(root, 'uah-history-'));
    const store = new RuntimeStore(directory, options);
    t.after(() => {
        store.close();
        const target = resolve(directory);
        assert.ok(target.startsWith(root + sep) && target !== root);
        rmSync(target, { recursive: true, force: true });
    });
    return { store, directory };
}

test('default quota admits 501 and 1000 runs and compound cursors preserve every tied timestamp', t => {
    const { store, directory } = fixture(t);
    store.commit({ sessions: [session('a'), session('b')] });
    for (let i = 0; i < 1000; i++) {
        store.assertCanCreateRun();
        store.commit({ runs: [run(`run-${String(i).padStart(4, '0')}`, i % 2 ? 'b' : 'a')] });
        if (i === 500) assert.equal(store.historyCapacity().count, 501);
    }
    assert.equal(store.historyCapacity().count, 1000);
    assert.equal(store.historyCapacity().maxRuns, 100_000);
    assert.equal(store.historyCapacity().maxDatabaseBytes, 2 * 1024 ** 3);
    assert.ok(store.historyCapacity().databaseBytes > 0);
    assert.equal(store.readSnapshot().runs.length, 1000);
    assert.equal(store.readRunPage().runs.length, 50);
    const ids: string[] = [];
    let before: RunPageOptions['before'];
    do {
        const page = store.readRunPage({ before, limit: 73 });
        ids.push(...page.runs.map(item => item.id));
        before = page.nextCursor ?? undefined;
    } while (before);
    assert.equal(ids.length, 1000);
    assert.equal(new Set(ids).size, 1000);
    assert.deepEqual(ids, Array.from({ length: 1000 }, (_, i) => `run-${String(999 - i).padStart(4, '0')}`));
    const isolated: string[] = [];
    do {
        const page = store.readRunPage({ sessionId: 'a', before, limit: 200 });
        assert.ok(page.runs.every(item => item.sessionId === 'a'));
        isolated.push(...page.runs.map(item => item.id));
        before = page.nextCursor ?? undefined;
    } while (before);
    assert.equal(new Set(isolated).size, 500);
    assert.deepEqual(store.readRunPage({ sessionId: 'absent' }), { runs: [], nextCursor: null });
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    try {
        const indexes = db.prepare('PRAGMA index_list(runs)').all() as Array<{ name: string }>;
        assert.ok(indexes.some(item => item.name === 'runs_session_created_at'));
        assert.ok(indexes.some(item => item.name === 'runs_created_at'));
    } finally { db.close(); }
});

test('keyset order uses both date and ID and returns null at exact final page size', t => {
    const { store } = fixture(t);
    store.commit({ sessions: [session()], runs: [run('c'), run('b'), run('a', 'a', '2026-09-30T00:00:00.000Z')] });
    const first = store.readRunPage({ limit: 2 });
    assert.deepEqual(first.runs.map(item => item.id), ['c', 'b']);
    assert.deepEqual(first.nextCursor, { createdAt: timestamp, id: 'b' });
    assert.deepEqual(store.readRunPage({ before: first.nextCursor!, limit: 1 }).runs.map(item => item.id), ['a']);
    assert.equal(store.readRunPage({ before: first.nextCursor!, limit: 1 }).nextCursor, null);
    assert.equal(store.readRunPage({ before: { createdAt: timestamp, id: 'c' }, limit: 2 }).nextCursor, null);
});

test('configured count and database quotas reject admission while preserving existing updates', t => {
    const { store, directory } = fixture(t, { maxRuns: 2 });
    store.commit({ sessions: [session()], runs: [run('a'), run('b')] });
    assert.throws(() => store.assertCanCreateRun(), /capacity quota.*2 runs.*preserved/);
    store.commit({ runs: [{ ...run('a'), output: 'updated', sequence: 2 }] });
    assert.equal(store.readRunPage().runs.find(item => item.id === 'a')!.output, 'updated');
    store.close();
    const bytesLimited = new RuntimeStore(directory, { maxDatabaseBytes: 1 });
    try {
        assert.throws(() => bytesLimited.assertCanCreateRun(), /Database capacity quota.*1 bytes.*preserved/);
        bytesLimited.commit({ runs: [{ ...run('b'), output: 'still durable', sequence: 2 }] });
        assert.equal(bytesLimited.historyCapacity().count, 2);
        assert.equal(bytesLimited.readSnapshot().runs.find(item => item.id === 'b')!.output, 'still durable');
    } finally { bytesLimited.close(); }
});

test('lightweight snapshot skips artifact verification and default still detects tampering', t => {
    const { store, directory } = fixture(t);
    const artifact: ArtifactSnapshot = { id: 'artifact', sessionId: 'a', runId: 'run', turnId: 'run', path: 'unused',
        oldContent: null, newContent: 'original', hash: createHash('sha256').update('original').digest('hex'), createdAt: timestamp };
    const event: RuntimeEvent = { runtimeId: 'runtime', sessionId: 'a', runId: 'run', turnId: 'run', sequence: 1,
        type: 'artifact-created', payload: { artifact } };
    store.commit({ sessions: [session()], runs: [run('run')], artifacts: [artifact], events: [event] });
    assert.equal(store.readSnapshot().artifacts.length, 1);
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    try { db.prepare('UPDATE artifacts SET data = ? WHERE id = ?').run(JSON.stringify({ ...artifact, newContent: 'tampered' }), artifact.id); }
    finally { db.close(); }
    assert.equal(store.readSnapshot({ verifyArtifacts: false }).artifacts[0].newContent, 'tampered');
    assert.throws(() => store.readSnapshot(), /manifest mismatch/);
    assert.throws(() => store.readSnapshot({ verifyArtifacts: true }), /manifest mismatch/);
});

test('strict store, page and snapshot options reject malformed values', t => {
    const { store, directory } = fixture(t);
    for (const value of [null, [], new Date(), { extra: 1 }, { maxRuns: 0 }, { maxRuns: 1.5 }, { maxRuns: NaN },
        { maxDatabaseBytes: -1 }, { maxDatabaseBytes: Infinity }, { maxDatabaseBytes: '5' }]) {
        assert.throws(() => new RuntimeStore(directory, value as RuntimeStoreOptions), /Invalid/);
    }
    for (const value of [null, [], { extra: 1 }, { limit: 0 }, { limit: 201 }, { limit: 1.5 }, { sessionId: '' },
        { sessionId: 2 }, { before: null }, { before: { id: 'x' } }, { before: { id: 'x', createdAt: '' } },
        { before: { id: 'x', createdAt: timestamp, extra: 1 } }]) {
        assert.throws(() => store.readRunPage(value as RunPageOptions), /Invalid/);
    }
    assert.throws(() => store.readSnapshot({ verifyArtifacts: 0 } as never), /Invalid/);
    assert.throws(() => store.readSnapshot({ extra: true } as never), /Invalid/);
    store.close();
    assert.throws(() => store.historyCapacity(), /closed/);
    assert.throws(() => store.readRunPage(), /closed/);
});

test('existing schema v3 receives indexes without deleting or rewriting history', t => {
    const { store, directory } = fixture(t);
    store.commit({ sessions: [session()], runs: [run('preserved')] });
    store.close();
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    db.exec('DROP INDEX runs_session_created_at;');
    db.close();
    const reopened = new RuntimeStore(directory);
    try {
        assert.deepEqual(reopened.readRunPage().runs, [run('preserved')]);
        const inspect = new DatabaseSync(join(directory, 'runtime.sqlite'));
        try {
            assert.equal((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, RUNTIME_SCHEMA_VERSION);
            assert.ok(inspect.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='runs_session_created_at'").get());
        } finally { inspect.close(); }
    } finally { reopened.close(); }
});

test('session snapshot isolates root/child runs, approvals and artifacts in original insertion order', t => {
    const { store, directory } = fixture(t);
    const runs = [run('z-root', 'b'), run('z-root-a'), { ...run('a-child', 'a'), parentRunId: 'z-root-a' },
        { ...run('a-child-b', 'b'), parentRunId: 'z-root' }];
    const approvals: ApprovalRecord[] = runs.map(item => ({ runtimeId: 'runtime', sessionId: item.sessionId,
        runId: item.id, turnId: item.turnId, requestId: `approval-${item.id}`, policyVersion: 1,
        status: 'pending', summary: 'review', path: 'file', createdAt: timestamp }));
    const artifacts: ArtifactSnapshot[] = runs.map(item => ({ id: `artifact-${item.id}`, sessionId: item.sessionId,
        runId: item.id, turnId: item.turnId, path: 'file', oldContent: null, newContent: 'content',
        hash: createHash('sha256').update('content').digest('hex'), createdAt: timestamp }));
    store.commit({ sessions: [session('b'), session('a')], runs, approvals, artifacts });
    // Upserts must retain rowid order, rather than using the history page's date/ID order.
    store.commit({ runs: [{ ...runs[1], output: 'updated' }], approvals: [{ ...approvals[1], status: 'approved' }] });
    const full = store.readSnapshot({ verifyArtifacts: false });
    for (const id of ['a', 'b']) {
        assert.deepEqual(store.readSessionSnapshot(id), {
            sessions: full.sessions.filter(item => item.id === id), runs: full.runs.filter(item => item.sessionId === id),
            approvals: full.approvals.filter(item => item.sessionId === id), artifacts: full.artifacts.filter(item => item.sessionId === id),
        });
    }
    assert.deepEqual(store.readSessionSnapshot('a').runs.map(item => item.id), ['z-root-a', 'a-child']);
    assert.deepEqual(store.readSessionSnapshot('unknown'), { sessions: [], runs: [], approvals: [], artifacts: [] });
    assert.deepEqual(store.readSessionSnapshot("a' OR 1=1 --"), { sessions: [], runs: [], approvals: [], artifacts: [] });
    assert.throws(() => store.readSnapshot(), /no event manifest/);
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    try {
        db.prepare('UPDATE runs SET data = ? WHERE id = ?').run('{broken', 'z-root');
        // Corrupt unrelated history and manifests are not loaded by a scoped projection.
        assert.equal(store.readSessionSnapshot('a').runs.length, 2);
        assert.throws(() => store.readSessionSnapshot('b'), /Cannot read persisted runs record/);
    } finally { db.close(); }
});

test('session snapshot validates identifiers and preserves persisted JSON read errors for each table', t => {
    const { store, directory } = fixture(t);
    for (const id of [null, undefined, 1, {}, '', 'x'.repeat(201), 'a\u0000', 'a\n', 'a\u007f', 'a\u0085']) {
        assert.throws(() => store.readSessionSnapshot(id as string), /Invalid session snapshot sessionId/);
    }
    assert.deepEqual(store.readSessionSnapshot('x'.repeat(200)), { sessions: [], runs: [], approvals: [], artifacts: [] });
    const approval: ApprovalRecord = { runtimeId: 'runtime', sessionId: 'a', runId: 'r', turnId: 'r',
        requestId: 'approval', policyVersion: 1, status: 'pending', summary: 'review', path: 'file', createdAt: timestamp };
    const artifact: ArtifactSnapshot = { id: 'artifact', sessionId: 'a', runId: 'r', turnId: 'r', path: 'file',
        oldContent: null, newContent: 'content', hash: 'not-verified', createdAt: timestamp };
    store.commit({ sessions: [session()], runs: [run('r')], approvals: [approval], artifacts: [artifact] });
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    try {
        for (const table of ['sessions', 'runs', 'approvals', 'artifacts']) {
            const original = (db.prepare(`SELECT data FROM ${table}`).get() as { data: string }).data;
            db.prepare(`UPDATE ${table} SET data = ?`).run('{broken');
            assert.throws(() => store.readSessionSnapshot('a'), new RegExp(`Cannot read persisted ${table} record`));
            db.prepare(`UPDATE ${table} SET data = ?`).run(original);
        }
        assert.equal(store.readSessionSnapshot('a').artifacts[0].hash, 'not-verified');
    } finally { db.close(); }
    store.close();
    assert.throws(() => store.readSessionSnapshot('a'), /closed/);
});
