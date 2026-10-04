import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore, RUNTIME_SCHEMA_VERSION } from '../../src/runtime/store';
import type { RunRecord, SessionRecord, ArtifactSnapshot, ApprovalRecord, RuntimeEvent } from '../../src/shared/contracts';
import { conversationMessages } from '../../src/shared/conversation-history';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const timestamp = '2026-10-01T00:00:00.000Z';
const effective = { runtimeId: 'api', modelId: 'legacy-model', agentId: 'legacy-agent', policyVersion: 1 };
function directory(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-store-migration-'));
    t.after(() => { const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-store-migration-')); rmSync(target, { recursive: true, force: true }); });
    return root;
}
function legacyRecords() {
    const session: SessionRecord = { id: 'legacy-session', title: 'Original conversation', directory: null, requested: effective, createdAt: timestamp, activePlanRunId: 'plan' };
    const root = (id: string): RunRecord => ({ id, sessionId: session.id, turnId: `${id}-turn`, createdAt: timestamp, sequence: 1, state: 'completed', input: `Goal ${id}`, output: `Original ${id}`, effective });
    const plan = root('plan'); plan.plan = { id: 'plan-v2', documentId: 'plan-document', version: 2, title: 'Approved plan', content: 'Version two plan', hash: hash('Version two plan'),
        filePath: 'plan-v2.md', status: 'approved', createdAt: timestamp, resolvedAt: timestamp, executionRunId: 'write',
        history: [{ id: 'plan-v1', documentId: 'plan-document', version: 1, content: 'Version one plan', filePath: 'plan-v1.md', hash: hash('Version one plan'), createdAt: timestamp }] };
    const write = root('write'); const edited = { ...root('edited'), history: { editedOutput: 'User revised the visible reply' } };
    const deleted = { ...root('deleted'), history: { deleted: true } };
    const child: RunRecord = { ...root('child'), parentRunId: write.id, depth: 1 };
    const artifact: ArtifactSnapshot = { id: 'legacy-file-snapshot', sessionId: session.id, runId: write.id, turnId: write.turnId, path: 'saved.txt',
        oldContent: 'Before', newContent: 'After original write', hash: hash('After original write'), createdAt: timestamp };
    write.activities = [{ id: 'legacy-write', kind: 'tool', title: 'write_file', content: 'saved file', status: 'completed',
        tool: { name: 'write_file', arguments: { path: artifact.path }, result: 'Saved', artifactId: artifact.id } }];
    const approvals: ApprovalRecord[] = ['approved', 'rejected', 'expired'].map((status, index) => ({ runtimeId: 'api', sessionId: session.id, runId: write.id,
        turnId: write.turnId, requestId: `approval-${index}`, policyVersion: 1, status: status as ApprovalRecord['status'], summary: `Historical ${status}`, path: artifact.path, createdAt: timestamp }));
    const event: RuntimeEvent = { type: 'artifact-created', runtimeId: 'api', sessionId: session.id, runId: write.id, turnId: write.turnId, sequence: 1, payload: { artifact } };
    return { session, runs: [plan, write, child, edited, deleted], approvals, artifact, event };
}
function oldDatabase(t: { after(fn: () => void): void }, version: 1 | 2 | 3) {
    const root = directory(t); const records = legacyRecords(); const store = new RuntimeStore(root);
    store.commit({ sessions: [records.session], runs: records.runs, approvals: records.approvals, artifacts: [records.artifact], events: [records.event] });
    const before = store.readSnapshot(); const messages = conversationMessages(before, records.session.id); store.close();
    const database = new DatabaseSync(join(root, 'runtime.sqlite'));
    database.exec('DROP INDEX runs_created_at; DROP INDEX runs_session_created_at;');
    if (version < 3) database.exec('DROP TABLE canonical_events; DROP TABLE journal_exports;');
    if (version < 2) database.exec('DROP TABLE request_contexts;');
    database.exec(`PRAGMA user_version = ${version};`); database.close();
    return { root, records, before, messages };
}
function sqliteState(filename: string) {
    const database = new DatabaseSync(filename, { readOnly: true });
    try {
        const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
        const schema = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name").all();
        const rows = ['sessions', 'runs', 'approvals', 'artifacts', 'events'].map(table => [table, database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]);
        return { version, schema, rows };
    } finally { database.close(); }
}

test('future schemas are rejected before PRAGMA changes and the rejected connection is closed', t => {
    const root = directory(t); const filename = join(root, 'runtime.sqlite'); const seed = new DatabaseSync(filename);
    seed.exec('PRAGMA journal_mode = DELETE; CREATE TABLE future_data (value TEXT); INSERT INTO future_data VALUES (\'untouched future fact\'); PRAGMA user_version = 99;'); seed.close();
    const before = readFileSync(filename); const executed: string[] = []; let closes = 0;
    const originalExec = DatabaseSync.prototype.exec, originalClose = DatabaseSync.prototype.close;
    const exec = t.mock.method(DatabaseSync.prototype, 'exec', function(this: DatabaseSync, sql: string) { executed.push(sql); return originalExec.call(this, sql); });
    const close = t.mock.method(DatabaseSync.prototype, 'close', function(this: DatabaseSync) { closes++; return originalClose.call(this); });
    assert.throws(() => new RuntimeStore(root), /newer than supported/); assert.equal(closes, 1); assert.deepEqual(executed, []);
    exec.mock.restore(); close.mock.restore();
    assert.deepEqual(readFileSync(filename), before); assert.equal(existsSync(filename + '-wal'), false); assert.equal(existsSync(filename + '-shm'), false);
    const inspect = new DatabaseSync(filename, { readOnly: true });
    try { assert.equal((inspect.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode, 'delete'); assert.equal((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 99); }
    finally { inspect.close(); }
});

for (const version of [1, 2] as const) {
    test(`v${version} upgrade preserves actual legacy Plan versions, approvals, file snapshots and visible messages`, t => {
        const f = oldDatabase(t, version); const migrated = new RuntimeStore(f.root);
        try {
            assert.deepEqual(migrated.readSnapshot(), f.before);
            assert.deepEqual(conversationMessages(migrated.readSnapshot(), f.records.session.id), f.messages);
            assert.ok(f.messages.some(message => message.content === 'User revised the visible reply'));
            assert.equal(f.messages.some(message => message.content === 'Original deleted'), false);
            assert.equal(migrated.readRun('plan')?.plan?.history?.[0].content, 'Version one plan');
            assert.deepEqual([...migrated.readLegacyJournalSessionIds()], [f.records.session.id]);
            assert.deepEqual(migrated.readJournal(f.records.session.id), []);
            const state = sqliteState(join(f.root, 'runtime.sqlite')); assert.equal(state.version, RUNTIME_SCHEMA_VERSION);
            assert.ok(state.schema.some(row => row.name === 'runs_created_at')); assert.ok(state.schema.some(row => row.name === 'runs_session_created_at'));
        } finally { migrated.close(); }
    });
}

for (const version of [1, 2, 3] as const) {
    test(`v${version} late index DDL collision rolls back the entire migration or index repair`, t => {
        const f = oldDatabase(t, version); const filename = join(f.root, 'runtime.sqlite'); const database = new DatabaseSync(filename);
        database.exec('CREATE TABLE runs_session_created_at (preserve TEXT); INSERT INTO runs_session_created_at VALUES (\'original collision fact\');'); database.close();
        const before = sqliteState(filename);
        assert.throws(() => new RuntimeStore(f.root), /runs_session_created_at|already exists/);
        assert.deepEqual(sqliteState(filename), before, 'late index failure preserves old schema version, all tables and every original record');
        const inspect = new DatabaseSync(filename, { readOnly: true });
        try {
            assert.equal(inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_created_at'").get(), undefined);
            assert.equal((inspect.prepare('SELECT preserve FROM runs_session_created_at').get() as { preserve: string }).preserve, 'original collision fact');
        } finally { inspect.close(); }
    });
}

test('new database late index DDL collision does not leave partially created runtime tables', t => {
    const root = directory(t); const filename = join(root, 'runtime.sqlite'); const seed = new DatabaseSync(filename);
    seed.exec('CREATE TABLE runs_session_created_at (preserve TEXT); INSERT INTO runs_session_created_at VALUES (\'preexisting user object\');'); seed.close();
    assert.throws(() => new RuntimeStore(root), /runs_session_created_at|already exists/);
    const inspect = new DatabaseSync(filename, { readOnly: true });
    try {
        assert.equal((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 0);
        assert.deepEqual(inspect.prepare("SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name), ['runs_session_created_at']);
        assert.equal((inspect.prepare('SELECT preserve FROM runs_session_created_at').get() as { preserve: string }).preserve, 'preexisting user object');
    } finally { inspect.close(); }
});
