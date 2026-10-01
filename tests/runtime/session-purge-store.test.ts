import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore, RUNTIME_SCHEMA_VERSION } from '../../src/runtime/store';
import { eraseSessionRows } from '../../src/runtime/session-purge-data';

const target = "target'; DELETE FROM sessions; --";
const tables = ['sessions', 'runs', 'request_contexts', 'approvals', 'artifacts', 'events', 'canonical_events', 'journal_exports', 'session_purges'];
function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-session-purge-'));
    const store = new RuntimeStore(root); const filename = join(root, 'runtime.sqlite');
    t.after(() => {
        store.close(); const path = resolve(root);
        assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith('uah-session-purge-'));
        rmSync(path, { recursive: true, force: true });
    });
    const db = new DatabaseSync(filename); db.exec('PRAGMA foreign_keys = ON;');
    const effective = { runtimeId: 'api', modelId: 'legacy', agentId: 'agent', policyVersion: 1 };
    for (const sessionId of [target, 'other', 'branch']) {
        const session = { id: sessionId, title: sessionId, directory: null, requested: effective, createdAt: 'now' };
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sessionId, 'now', JSON.stringify(session));
        for (const suffix of ['root', 'child']) {
            const id = `${sessionId}-${suffix}`;
            const run = { id, sessionId, turnId: id + '-turn', createdAt: 'now', sequence: 1, state: 'completed', input: 'Original goal', output: 'Original reply', effective,
                ...(suffix === 'child' ? { parentRunId: `${sessionId}-root`, depth: 1 } : {}),
                ...(sessionId === 'branch' ? { retryOfRunId: `${target}-root` } : {}),
                ...(suffix === 'root' ? { plan: { id: id + '-plan', documentId: 'doc', version: 2, title: 'Plan', content: 'Final plan', hash: 'plan', filePath: 'plan.md', status: 'approved', createdAt: 'now', history: [{ id: 'prior', documentId: 'doc', version: 1, content: 'Earlier plan', filePath: 'prior.md', hash: 'prior', createdAt: 'now' }] } } : {}) };
            db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run(id, sessionId, 'now', 'completed', 1, JSON.stringify(run));
            db.prepare('INSERT INTO request_contexts VALUES (?, ?)').run(id, JSON.stringify({ runId: id, requestId: id + '-request', round: 1, sections: [{ content: 'Native continuation' }] }));
            db.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?)').run(id + '-approval', id, 'approved', JSON.stringify({ requestId: id + '-approval', runId: id, sessionId, status: 'approved' }));
            const artifact = { id: id + '-file', sessionId, runId: id, turnId: id + '-turn', path: 'saved.txt', oldContent: 'Before', newContent: 'After', hash: createHash('sha256').update('After').digest('hex'), createdAt: 'now' };
            db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?)').run(artifact.id, sessionId, id, artifact.hash, JSON.stringify(artifact));
            db.prepare('INSERT INTO events(runtime_id,session_id,run_id,turn_id,sequence,type,data) VALUES (?,?,?,?,?,?,?)').run('api', sessionId, id, id + '-turn', 1, 'artifact-created', JSON.stringify({ type: 'artifact-created', payload: { artifact } }));
            db.prepare('INSERT INTO canonical_events VALUES (?, ?, ?, ?)').run(id + '-event', sessionId, suffix === 'root' ? 1 : 2, JSON.stringify({ eventId: id + '-event', type: 'provider.frame', payload: { marker: sessionId, raw: 'Original raw frame' } }));
        }
        db.prepare('INSERT INTO journal_exports VALUES (?, ?)').run(sessionId, 2);
    }
    db.close();
    return { root, store, filename };
}
function state(db: DatabaseSync) {
    const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
    return Object.fromEntries(tables.filter(table => present.has(table)).map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
}
function inspect(filename: string) {
    const db = new DatabaseSync(filename, { readOnly: true }); try { return state(db); } finally { db.close(); }
}
function expectedAfter(before: ReturnType<typeof state>) {
    return Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, table === 'session_purges' ? rows : rows.filter(row => {
        if (table === 'sessions') return row.id !== target;
        if (table === 'approvals' || table === 'request_contexts') return !String(row.run_id).startsWith(target + '-');
        return row.session_id !== target;
    })]));
}

test('purge atomically erases every target fact and projection, retains independent branches and persists retry intent across restart', t => {
    const f = fixture(t); const before = inspect(f.filename); const intent = { phase: 'files', directory: 'controlled-session-dir', backups: ['controlled-backup.sqlite'] };
    f.store.beginSessionPurge(target, intent);
    const after = inspect(f.filename); const expected = expectedAfter(before);
    expected.session_purges = [{ session_id: target, data: JSON.stringify(intent) }];
    assert.deepEqual(after, expected);
    assert.deepEqual(f.store.readSessionPurges(), [{ sessionId: target, intent }]);
    assert.deepEqual(f.store.readSessionSnapshot(target).sessions, []);
    assert.equal(f.store.readSessionRuns('branch').length, 2);
    assert.throws(() => f.store.beginSessionPurge(target, { phase: 'retry' }), /already pending/);
    assert.deepEqual(inspect(f.filename), after);
    f.store.close(); const restarted = new RuntimeStore(f.root);
    try {
        assert.deepEqual(restarted.readSessionPurges(), [{ sessionId: target, intent }]);
        restarted.completeSessionPurge('other'); assert.deepEqual(restarted.readSessionPurges(), [{ sessionId: target, intent }]);
        restarted.completeSessionPurge(target); assert.deepEqual(restarted.readSessionPurges(), []);
        assert.equal(restarted.readSessionRuns('other').length, 2);
    } finally { restarted.close(); }
});

test('intent insertion failure rolls back deletion of every table and does not persist an intent', t => {
    const f = fixture(t); const db = new DatabaseSync(f.filename);
    db.exec("CREATE TRIGGER fail_purge BEFORE INSERT ON session_purges BEGIN SELECT RAISE(ABORT, 'injected purge intent failure'); END;"); db.close();
    const before = inspect(f.filename);
    assert.throws(() => f.store.beginSessionPurge(target, { phase: 'files' }), /injected purge intent failure/);
    assert.deepEqual(inspect(f.filename), before); assert.deepEqual(f.store.readSessionPurges(), []);
    const inspectDb = new DatabaseSync(f.filename);
    try { assert.deepEqual(inspectDb.prepare('PRAGMA foreign_key_check').all(), []); } finally { inspectDb.close(); }
});

test('unknown session and invalid intent cannot create success or cleanup intent', t => {
    const f = fixture(t); const before = inspect(f.filename);
    assert.throws(() => f.store.beginSessionPurge('absent', {}), /does not exist/);
    assert.throws(() => f.store.beginSessionPurge(target, [] as unknown as Record<string, unknown>), /Invalid session purge intent/);
    const circular: Record<string, unknown> = {}; circular.self = circular;
    assert.throws(() => f.store.beginSessionPurge(target, circular), /circular/i);
    assert.deepEqual(inspect(f.filename), before);
});

for (const version of [1, 2]) for (const foreignKeys of [false, true]) {
    test(`helper cleans schema v${version} with foreign_keys=${foreignKeys} only inside caller transaction`, t => {
        const f = fixture(t); f.store.close(); const db = new DatabaseSync(f.filename);
        try {
            db.exec('DROP TABLE canonical_events; DROP TABLE journal_exports;');
            if (version === 1) db.exec('DROP TABLE request_contexts;');
            db.exec(`PRAGMA user_version = ${version}; PRAGMA foreign_keys = ${foreignKeys ? 'ON' : 'OFF'};`);
            db.prepare('INSERT INTO session_purges VALUES (?, ?)').run('existing-intent', JSON.stringify({ unchanged: true }));
            const before = state(db);
            db.exec('BEGIN IMMEDIATE;'); eraseSessionRows(db, target);
            assert.equal(db.isTransaction, true, 'helper neither commits nor rolls back the caller transaction');
            assert.deepEqual(state(db), expectedAfter(before)); db.exec('ROLLBACK;'); assert.deepEqual(state(db), before);
            db.exec('BEGIN IMMEDIATE;'); eraseSessionRows(db, target); db.exec('COMMIT;');
            assert.deepEqual(state(db), expectedAfter(before)); assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
            assert.equal(db.prepare('PRAGMA user_version').get()!.user_version, version);
        } finally { db.close(); }
    });
}

test('checkpoint reports a real active reader as busy, preserves pending intent, then truncates WAL after release', t => {
    const f = fixture(t); const reader = new DatabaseSync(f.filename, { readOnly: true });
    try {
        reader.exec('BEGIN;'); reader.prepare('SELECT * FROM runs').all();
        f.store.beginSessionPurge(target, { phase: 'checkpoint' });
        assert.throws(() => f.store.checkpointAfterPurge(), /checkpoint is busy/);
        assert.deepEqual(f.store.readSessionPurges(), [{ sessionId: target, intent: { phase: 'checkpoint' } }]);
        reader.exec('ROLLBACK;'); f.store.checkpointAfterPurge();
        assert.equal(existsSync(f.filename + '-wal') ? statSync(f.filename + '-wal').size : 0, 0);
    } finally { reader.close(); }
});

test('schema3 existing database gains purge intents transactionally without changing schema version or history', t => {
    const f = fixture(t); f.store.close(); const db = new DatabaseSync(f.filename);
    db.exec('DROP TABLE session_purges;'); const before = state(db); db.close();
    const reopened = new RuntimeStore(f.root);
    try {
        const after = inspect(f.filename); delete after.session_purges;
        assert.deepEqual(after, before); assert.deepEqual(reopened.readSessionPurges(), []);
        const inspectDb = new DatabaseSync(f.filename, { readOnly: true });
        try { assert.equal(inspectDb.prepare('PRAGMA user_version').get()!.user_version, RUNTIME_SCHEMA_VERSION); } finally { inspectDb.close(); }
    } finally { reopened.close(); }
});

test('schema3 late index failure also rolls back incremental purge table creation', t => {
    const f = fixture(t); f.store.close(); const db = new DatabaseSync(f.filename);
    db.exec('DROP TABLE session_purges; DROP INDEX runs_session_created_at; CREATE TABLE runs_session_created_at (preserve TEXT);');
    const before = state(db); db.close();
    assert.throws(() => new RuntimeStore(f.root), /runs_session_created_at|already exists/);
    assert.deepEqual(inspect(f.filename), before);
    const inspectDb = new DatabaseSync(f.filename, { readOnly: true });
    try { assert.equal(inspectDb.prepare("SELECT 1 FROM sqlite_master WHERE name='session_purges'").get(), undefined); } finally { inspectDb.close(); }
});
