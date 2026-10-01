import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs, { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { prepareRuntimeUpgrade } from '../../src/runtime/store-backup';
import { RUNTIME_SCHEMA_VERSION, RuntimeStore } from '../../src/runtime/store';
import { conversationMessages } from '../../src/shared/conversation-history';
import type { ApprovalRecord, ArtifactSnapshot, RunRecord, SessionRecord } from '../../src/shared/contracts';

function directory(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-store-backup-'));
    t.after(() => {
        const target = resolve(root);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('uah-store-backup-'));
        rmSync(target, { recursive: true, force: true });
    });
    return root;
}
function seed(root: string, version: number) {
    const db = new DatabaseSync(join(root, 'runtime.sqlite'));
    db.exec(`PRAGMA journal_mode = DELETE; CREATE TABLE facts (id TEXT PRIMARY KEY, value TEXT); INSERT INTO facts(rowid,id,value) VALUES (7,'old','preserved'); PRAGMA user_version = ${version};`);
    db.close();
}
function inspect(path: string) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        return { version: db.prepare('PRAGMA user_version').get()!.user_version,
            integrity: db.prepare('PRAGMA quick_check').get()!.quick_check,
            facts: db.prepare('SELECT rowid,id,value FROM facts ORDER BY rowid').all() };
    } finally { db.close(); }
}

test('live uncheckpointed WAL facts and implicit rowids survive in a standalone completed backup', async t => {
    const root = directory(t); seed(root, 1);
    const filename = join(root, 'runtime.sqlite'); const live = new DatabaseSync(filename);
    try {
        live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE); INSERT INTO facts(rowid,id,value) VALUES (101,\'wal-only\',\'committed WAL fact\');');
        assert.ok(statSync(filename + '-wal').size > 0);
        const mainOnly = join(root, 'main-only.sqlite'); copyFileSync(filename, mainOnly);
        assert.equal(inspect(mainOnly).facts.length, 1, 'the new committed record really is absent from the main database file');
        const expected = inspect(filename); let progress = 0;
        const result = await prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION, () => { progress++; });
        assert.ok(result); assert.equal(result.schemaVersion, 1); assert.ok(progress >= 2);
        assert.match(basename(result.path), /^runtime-v1-[a-f0-9-]+\.sqlite$/);
        assert.equal(existsSync(result.path + '.pending'), false);
        assert.deepEqual(readdirSync(dirname(result.path)), [basename(result.path)], 'completed backup leaves no pending WAL or SHM files');
        assert.deepEqual(inspect(result.path), expected);
        const restored = join(root, 'restore'); mkdirSync(restored);
        const restoredFile = join(restored, 'runtime.sqlite'); copyFileSync(result.path, restoredFile);
        assert.equal(existsSync(restoredFile + '-wal'), false);
        assert.deepEqual(inspect(restoredFile), expected, 'restoring only the completed sqlite file needs no source or pending WAL sidecar');
        assert.deepEqual(inspect(filename), expected, 'the live source remains unchanged');
    } finally { live.close(); }
});

for (const version of [RUNTIME_SCHEMA_VERSION, 99]) {
    test(`schema ${version} ${version === RUNTIME_SCHEMA_VERSION ? 'skips' : 'rejects'} without backup or persistent source changes`, async t => {
        const root = directory(t); seed(root, version); const filename = join(root, 'runtime.sqlite');
        const before = readFileSync(filename);
        if (version === RUNTIME_SCHEMA_VERSION) assert.equal(await prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION), null);
        else await assert.rejects(prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION), /newer than supported/);
        assert.deepEqual(readFileSync(filename), before);
        assert.equal(existsSync(join(root, 'upgrade-backups')), false);
        assert.equal(existsSync(filename + '-wal'), false); assert.equal(existsSync(filename + '-shm'), false);
        const db = new DatabaseSync(filename, { readOnly: true });
        try { assert.equal(db.prepare('PRAGMA journal_mode').get()!.journal_mode, 'delete'); } finally { db.close(); }
    });
}

test('missing and empty unversioned databases skip while nonempty unversioned databases stop', async t => {
    const root = directory(t);
    assert.equal(await prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION), null);
    assert.deepEqual(readdirSync(root), []);
    const db = new DatabaseSync(join(root, 'runtime.sqlite')); db.close();
    assert.equal(await prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION), null);
    const nonempty = new DatabaseSync(join(root, 'runtime.sqlite')); nonempty.exec('CREATE TABLE unknown (value TEXT);'); nonempty.close();
    const before = readFileSync(join(root, 'runtime.sqlite'));
    await assert.rejects(prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION), /Unversioned nonempty/);
    assert.deepEqual(readFileSync(join(root, 'runtime.sqlite')), before);
    assert.equal(existsSync(join(root, 'upgrade-backups')), false);
});

test('repeated startup backups use distinct completed files and never overwrite an earlier backup', async t => {
    const root = directory(t); seed(root, 2);
    const first = await prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION); assert.ok(first);
    const firstBytes = readFileSync(first.path);
    const db = new DatabaseSync(join(root, 'runtime.sqlite')); db.exec("INSERT INTO facts(rowid,id,value) VALUES (200,'later','new fact');"); db.close();
    const second = await prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION); assert.ok(second);
    assert.notEqual(second.path, first.path); assert.deepEqual(readFileSync(first.path), firstBytes);
    assert.equal(inspect(first.path).facts.length, 1); assert.equal(inspect(second.path).facts.length, 2);
    assert.equal(readdirSync(join(root, 'upgrade-backups')).filter(name => name.endsWith('.sqlite')).length, 2);
});

test('backup synchronization failure leaves only a pending file and preserves source data and schema', async t => {
    const root = directory(t); seed(root, 2); const filename = join(root, 'runtime.sqlite');
    const before = readFileSync(filename); const state = inspect(filename);
    const mock = t.mock.method(fs, 'fsyncSync', () => { throw new Error('Injected backup synchronization failure'); });
    syncBuiltinESMExports();
    try { await assert.rejects(prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION), /Injected backup synchronization failure/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(readFileSync(filename), before); assert.deepEqual(inspect(filename), state);
    const names = readdirSync(join(root, 'upgrade-backups'));
    assert.equal(names.length, 1); assert.match(names[0], /^runtime-v2-[a-f0-9-]+\.sqlite\.pending$/);
});

test('SQLite backup cannot complete after the reserved destination is replaced by a directory', async t => {
    const root = directory(t); seed(root, 1); const filename = join(root, 'runtime.sqlite'); const before = readFileSync(filename);
    let injected = false;
    await assert.rejects(prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION, () => {
        if (injected) return;
        injected = true;
        const backupDirectory = join(root, 'upgrade-backups');
        const names = readdirSync(backupDirectory); assert.equal(names.length, 1);
        assert.ok(names[0].endsWith('.pending'));
        const pending = join(backupDirectory, names[0]); unlinkSync(pending); mkdirSync(pending);
    }), /open|directory|database|backup/i);
    assert.equal(injected, true); assert.deepEqual(readFileSync(filename), before);
    assert.equal(readdirSync(join(root, 'upgrade-backups')).some(name => name.endsWith('.sqlite')), false);
    assert.equal(inspect(filename).version, 1);
});

for (const version of [1, 2]) {
    test(`v${version} completed backup restores and migrates legacy conversation, Plan, approvals and file snapshots in isolation`, async t => {
        const root = directory(t); const createdAt = '2026-10-01T00:00:00.000Z';
        const effective = { runtimeId: 'api', modelId: 'old-model', agentId: 'old-agent', policyVersion: 1 };
        const session: SessionRecord = { id: 'session', title: 'Legacy', directory: null, requested: effective, createdAt, activePlanRunId: 'plan' };
        const run = (id: string): RunRecord => ({ id, sessionId: session.id, turnId: `${id}-turn`, createdAt, sequence: 1, state: 'completed', input: id, output: `Reply ${id}`, effective });
        const plan = run('plan'); plan.plan = { id: 'plan-v2', documentId: 'plan-doc', version: 2, title: 'Plan', content: 'Approved plan', hash: 'plan-hash', filePath: 'plan.md', status: 'approved', createdAt,
            history: [{ id: 'plan-v1', documentId: 'plan-doc', version: 1, content: 'Earlier plan', hash: 'old-hash', filePath: 'old.md', createdAt }] };
        const write = run('write'); const child = { ...run('child'), parentRunId: write.id, depth: 1 };
        const edited = { ...run('edited'), history: { editedOutput: 'Visible user revision' } };
        const deleted = { ...run('deleted'), history: { deleted: true } };
        const artifact: ArtifactSnapshot = { id: 'file', sessionId: session.id, runId: write.id, turnId: write.turnId, path: 'saved.txt', oldContent: 'Before', newContent: 'After', hash: createHash('sha256').update('After').digest('hex'), createdAt };
        const approval: ApprovalRecord = { ...effective, sessionId: session.id, runId: write.id, turnId: write.turnId, requestId: 'approval', status: 'approved', summary: 'Write approval', path: artifact.path, createdAt };
        const store = new RuntimeStore(root);
        store.commit({ sessions: [session], runs: [plan, write, child, edited, deleted], artifacts: [artifact], approvals: [approval],
            events: [{ type: 'artifact-created', runtimeId: 'api', sessionId: session.id, runId: write.id, turnId: write.turnId, sequence: 1, payload: { artifact } }] });
        const expected = store.readSnapshot(); const messages = conversationMessages(expected, session.id); store.close();
        const db = new DatabaseSync(join(root, 'runtime.sqlite'));
        db.exec(`DROP TABLE canonical_events; DROP TABLE journal_exports; ${version === 1 ? 'DROP TABLE request_contexts;' : ''} PRAGMA user_version = ${version};`); db.close();
        const result = await prepareRuntimeUpgrade(root, RUNTIME_SCHEMA_VERSION); assert.ok(result); assert.equal(result.schemaVersion, version);
        const source = new DatabaseSync(join(root, 'runtime.sqlite'), { readOnly: true });
        try { assert.equal(source.prepare('PRAGMA user_version').get()!.user_version, version); } finally { source.close(); }
        const restore = join(root, 'isolated-restore'); mkdirSync(restore); copyFileSync(result.path, join(restore, 'runtime.sqlite'));
        const restored = new RuntimeStore(restore);
        try {
            assert.deepEqual(restored.readSnapshot(), expected);
            assert.deepEqual(conversationMessages(restored.readSnapshot(), session.id), messages);
            assert.ok(messages.some(message => message.content === 'Visible user revision'));
            assert.equal(messages.some(message => message.content === 'Reply deleted'), false);
            assert.deepEqual([...restored.readLegacyJournalSessionIds()], [session.id]);
            assert.deepEqual(restored.readJournal(session.id), []);
        } finally { restored.close(); }
    });
}
