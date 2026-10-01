import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import fs, { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { finishSessionPurgeFiles, prepareSessionPurgeFiles, purgeFilesFingerprint, type SessionPurgeIntent } from '../../src/runtime/session-purge-files';
import { RuntimeStore } from '../../src/runtime/store';

const session = 'target-session';
const execution = 'd1301d0c-798b-4814-b694-66d532497960';
const sessionDirectory = (id: string) => `sessions/${createHash('sha256').update(JSON.stringify(id)).digest('hex')}`;
function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-purge-files-'));
    t.after(() => { const path = resolve(root); assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith('uah-purge-files-')); rmSync(path, { recursive: true, force: true }); });
    const put = (path: string, value = path) => { const file = join(root, path); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, value); return file; };
    const files = [`${sessionDirectory(session)}/events.jsonl`, `${sessionDirectory(session)}/artifacts/request.json`, `plans/${session}/plan.md`, `executions/${execution}/stdout.txt`];
    const retained = [`${sessionDirectory('other-session')}/events.jsonl`, 'plans/other-session/plan.md', `${sessionDirectory('independent-branch')}/events.jsonl`, 'workspace/user-owned.txt'];
    files.concat(retained).forEach(path => put(path));
    return { root, files, retained, put, prepare: () => prepareSessionPurgeFiles(root, session, [execution]) };
}
function restored(intent: SessionPurgeIntent): SessionPurgeIntent { return JSON.parse(JSON.stringify(intent)); }
function backup(root: string, version: 1 | 2) {
    const runtime = join(root, 'seed'); const store = new RuntimeStore(runtime); store.close();
    const source = join(runtime, 'runtime.sqlite');
    const db = new DatabaseSync(source);
    for (const id of [session, 'other-session']) {
        db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(id, 'now', JSON.stringify({ id }));
        const run = `${id}-run`;
        db.prepare('INSERT INTO runs VALUES (?, ?, ?, ?, ?, ?)').run(run, id, 'now', 'completed', 1, JSON.stringify({ id: run, sessionId: id }));
        db.prepare('INSERT INTO approvals VALUES (?, ?, ?, ?)').run(run + '-approval', run, 'approved', JSON.stringify({ sessionId: id }));
        db.prepare('INSERT INTO artifacts VALUES (?, ?, ?, ?, ?)').run(run + '-artifact', id, run, 'hash', JSON.stringify({ sessionId: id }));
        db.prepare('INSERT INTO events(runtime_id,session_id,run_id,turn_id,sequence,type,data) VALUES(?,?,?,?,?,?,?)').run('api', id, run, 'turn', 1, 'text-delta', JSON.stringify({ sessionId: id }));
        db.prepare('INSERT INTO request_contexts VALUES (?, ?)').run(run, JSON.stringify({ runId: run }));
    }
    db.exec('DROP TABLE canonical_events; DROP TABLE journal_exports;');
    if (version === 1) db.exec('DROP TABLE request_contexts;');
    db.exec(`PRAGMA user_version=${version}; PRAGMA journal_mode=DELETE;`); db.close();
    const destination = join(root, 'upgrade-backups', `runtime-v${version}-${randomUUID()}.sqlite`);
    mkdirSync(dirname(destination), { recursive: true }); writeFileSync(destination, readFileSync(source));
    return destination;
}
function backupState(path: string) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
        const tables = ['sessions', 'runs', 'approvals', 'artifacts', 'events', 'request_contexts'];
        const present = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
        return Object.fromEntries(tables.filter(table => present.includes(table)).map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all().map(row => ({ ...row }))]));
    } finally { db.close(); }
}

test('owned session, Plan and selected UUID execution files disappear while workspace and other sessions remain; restart finishing is idempotent', t => {
    const f = fixture(t); const intent = f.prepare(); const saved = restored(intent);
    assert.equal(purgeFilesFingerprint(saved), purgeFilesFingerprint(intent));
    assert.equal(intent.files.length, f.files.length);
    finishSessionPurgeFiles(f.root, intent); finishSessionPurgeFiles(f.root, saved); finishSessionPurgeFiles(f.root, saved);
    for (const path of f.files) assert.equal(existsSync(join(f.root, path)), false);
    for (const path of f.retained) assert.equal(readFileSync(join(f.root, path), 'utf8'), path);
});

test('post-review content drift is rejected and the changed file survives', t => {
    const f = fixture(t); const intent = f.prepare(); const item = intent.files[0]; f.put(item.path, 'Changed since review');
    assert.throws(() => finishSessionPurgeFiles(f.root, intent), /changed/);
    assert.equal(readFileSync(join(f.root, item.path), 'utf8'), 'Changed since review');
});

test('hardlinks are rejected during inspection and after review without unlinking either name', t => {
    const f = fixture(t); const intent = f.prepare(); const file = join(f.root, intent.files[0].path); const external = join(f.root, 'workspace', 'hardlink.txt'); linkSync(file, external);
    assert.throws(f.prepare, /link/); assert.throws(() => finishSessionPurgeFiles(f.root, intent), /link/);
    assert.equal(existsSync(file), true); assert.equal(readFileSync(external, 'utf8'), intent.files[0].path);
});

test('directory junctions are rejected during inspection and after review without traversing the target', t => {
    const f = fixture(t); const intent = f.prepare(); const plans = join(f.root, 'plans', session);
    rmSync(plans, { recursive: true }); symlinkSync(join(f.root, 'workspace'), plans, 'junction');
    assert.throws(f.prepare, /link/); assert.throws(() => finishSessionPurgeFiles(f.root, intent), /link/);
    assert.equal(readFileSync(join(f.root, 'workspace', 'user-owned.txt'), 'utf8'), 'workspace/user-owned.txt');
});

test('forged persisted intent paths cannot delete outside the allowed namespaces', t => {
    const f = fixture(t); const intent = f.prepare();
    for (const path of ['../outside.txt', 'workspace/user-owned.txt', `${sessionDirectory('other-session')}/events.jsonl`, 'plans/other-session/plan.md', 'C:/outside.txt']) {
        const forged = restored(intent); forged.files[0].path = path;
        assert.throws(() => finishSessionPurgeFiles(f.root, forged), /ownership|path/);
    }
    const forged = restored(intent); forged.backups.push({ path: 'workspace/user-owned.txt', dev: 0, ino: 0, bytes: 1, modified: 0 });
    assert.throws(() => finishSessionPurgeFiles(f.root, forged), /backup ownership/);
    for (const path of f.files.concat(f.retained)) assert.equal(readFileSync(join(f.root, path), 'utf8'), path);
});

test('a new unlisted file blocks rmdir and remains available for an explicitly renewed cleanup review', t => {
    const f = fixture(t); const intent = f.prepare(); const newPath = `${sessionDirectory(session)}/new-after-review.txt`; f.put(newPath, 'New unlisted evidence');
    assert.throws(() => finishSessionPurgeFiles(f.root, intent), /not empty|ENOTEMPTY/);
    assert.equal(readFileSync(join(f.root, newPath), 'utf8'), 'New unlisted evidence');
    finishSessionPurgeFiles(f.root, f.prepare()); assert.equal(existsSync(join(f.root, newPath)), false);
});

for (const version of [1, 2] as const) {
    test(`v${version} completed upgrade backup loses only the target facts and pending backup files are removed by exact manifest`, t => {
        const f = fixture(t); const path = backup(f.root, version); const before = backupState(path);
        const pending = `upgrade-backups/runtime-v${version}-${randomUUID()}.sqlite.pending`;
        for (const suffix of ['', '-wal', '-shm']) f.put(pending + suffix, 'Incomplete backup raw bytes');
        f.put('upgrade-backups/unrecognized-do-not-delete.txt', 'Retained unknown backup file');
        const intent = f.prepare(); assert.equal(intent.backups.length, 1);
        finishSessionPurgeFiles(f.root, intent); finishSessionPurgeFiles(f.root, restored(intent));
        const expected = Object.fromEntries(Object.entries(before).map(([table, rows]) => [table, rows.filter(row => table === 'sessions' ? row.id !== session : ['approvals', 'request_contexts'].includes(table) ? row.run_id !== session + '-run' : row.session_id !== session)]));
        assert.deepEqual(backupState(path), expected);
        for (const suffix of ['', '-wal', '-shm']) assert.equal(existsSync(join(f.root, pending + suffix)), false);
        assert.equal(readFileSync(join(f.root, 'upgrade-backups/unrecognized-do-not-delete.txt'), 'utf8'), 'Retained unknown backup file');
    });
}

test('a busy backup stops cleanup before any target files are removed and preserves backup rows', t => {
    const f = fixture(t); const path = backup(f.root, 2); const before = backupState(path); const intent = f.prepare(); const lock = new DatabaseSync(path);
    try {
        lock.exec('BEGIN IMMEDIATE;');
        assert.throws(() => finishSessionPurgeFiles(f.root, intent), /locked|busy/);
        lock.exec('ROLLBACK;'); assert.deepEqual(backupState(path), before);
        for (const name of f.files) assert.equal(existsSync(join(f.root, name)), true);
        finishSessionPurgeFiles(f.root, restored(intent));
    } finally { lock.close(); }
});

test('a damaged backup stops cleanup and retains the backup and target files', t => {
    const f = fixture(t); const name = `upgrade-backups/runtime-v1-${randomUUID()}.sqlite`; const path = f.put(name, 'Not an SQLite database'); const bytes = readFileSync(path); const intent = f.prepare();
    assert.throws(() => finishSessionPurgeFiles(f.root, intent), /database|damaged/i);
    assert.deepEqual(readFileSync(path), bytes); for (const file of f.files) assert.equal(existsSync(join(f.root, file)), true);
});

test('inspection depth bound refuses excessive nested owned directories using a small fixture', t => {
    const f = fixture(t); f.put(`${sessionDirectory(session)}/${Array.from({ length: 18 }, () => 'nested').join('/')}/leaf`, 'small');
    assert.throws(f.prepare, /inspection limit/); assert.equal(existsSync(join(f.root, f.retained[0])), true);
});

test('inspection byte cap rejects an oversized stat before reading any large body', t => {
    const f = fixture(t); const file = join(f.root, f.files[0]); const original = fs.lstatSync;
    const mock = t.mock.method(fs, 'lstatSync', ((path: Parameters<typeof fs.lstatSync>[0], options?: Parameters<typeof fs.lstatSync>[1]) => {
        const stat = original(path, options);
        if (String(path) === file) Object.defineProperty(stat, 'size', { value: 2 * 1024 ** 3 + 1 });
        return stat;
    }) as typeof fs.lstatSync);
    syncBuiltinESMExports();
    try { assert.throws(f.prepare, /files exceed inspection limit/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(readFileSync(file, 'utf8'), f.files[0]);
});
