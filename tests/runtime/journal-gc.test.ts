import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync, linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RuntimeStore } from '../../src/runtime/store';
import { TranscriptWriter } from '../../src/runtime/transcript-writer';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { reviewJournalCleanup, collectJournalOrphans } from '../../src/runtime/journal-gc';
import { parseJournalQuery } from '../../src/shared/journal-view';
import { Supervisor } from '../../src/runtime/supervisor';
import type { TranscriptEvent } from '../../src/shared/harness-contracts';

function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-journal-gc-')); const store = new RuntimeStore(join(root, 'data'));
    const writer = new TranscriptWriter(store, join(root, 'data'), { deriveCoverage: true });
    const directory = writer.sessionDirectory('gc'); const artifacts = new JournalArtifacts(directory); let seq = 0;
    const commit = (type: string, payload: unknown) => store.commit({ journal: [{ schemaVersion: 1, eventId: `event-${++seq}`, sessionSeq: seq,
        timestamp: new Date().toISOString(), processEpochId: 'epoch', run: { sessionId: 'gc', runId: 'root', parentRunId: null, rootRunId: 'root', turnId: 'turn' }, type, payload } as TranscriptEvent] });
    const child = artifacts.save({ text: 'nested public evidence' }).ref;
    const parent = artifacts.save({ nested: child }).ref;
    const native = artifacts.save({ opaque: 'native signature', schemaVersion: 1 }, [], true).ref;
    const branch = artifacts.save({ text: 'independent branch copy' }).ref;
    commit('message.accepted', { messageId: 'user', revision: 1, role: 'user', content: parent });
    commit('artifact.created', { snapshot: child });
    commit('history.branch', { sourceRunId: 'source', content: branch, frames: [native] });
    commit('run.state', { state: 'completed', reason: null });
    const flush = () => assert.equal(writer.flush('gc').status, 'healthy'); flush();
    const editManifest = (fn: (value: any) => void) => { const file = join(directory, 'manifest.json'); const value = JSON.parse(readFileSync(file, 'utf8')); fn(value); writeFileSync(file, JSON.stringify(value)); };
    t.after(() => { store.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('uah-journal-gc-')); rmSync(root, { recursive: true, force: true }); });
    return { directory, artifacts, commit, flush, editManifest, refs: [child, parent, native, branch], now: Date.now() + 25 * 3600000 };
}

test('canonical transitive public/native/branch closure survives while old unreferenced content is collected', t => {
    const f = fixture(t); const orphan = f.artifacts.save({ text: 'unreferenced old content' }).ref;
    const binary = f.artifacts.saveBytes(Buffer.from([0, 255, 10]));
    const young = f.artifacts.save({ text: 'new protected content' }).ref;
    const youngPath = join(f.directory, young.relativePath!);
    utimesSync(youngPath, new Date(f.now), new Date(f.now));
    writeFileSync(join(f.directory, 'artifacts', 'unknown.txt'), 'unknown');
    const before = readFileSync(join(f.directory, 'transcript.jsonl'));
    assert.equal(reviewJournalCleanup(f.directory, 'gc', {}, Date.now()).files.length, 0, 'new content has a 24h grace');
    const review = reviewJournalCleanup(f.directory, 'gc', { native: f.refs[2] }, f.now);
    assert.equal(review.files.length, 2); assert.equal(review.minimumAgeHours, 24);
    const result = collectJournalOrphans(f.directory, 'gc', {}, review.fingerprint, f.now);
    assert.deepEqual(result, { removedFiles: 2, removedBytes: review.bytes, remainingFiles: 0 });
    for (const ref of f.refs) assert.ok(existsSync(join(f.directory, ref.relativePath!)));
    assert.ok(!existsSync(join(f.directory, orphan.relativePath!))); assert.ok(!existsSync(join(f.directory, binary.relativePath!)));
    assert.ok(existsSync(join(f.directory, 'artifacts', 'unknown.txt'))); assert.deepEqual(readFileSync(join(f.directory, 'transcript.jsonl')), before);
    assert.ok(existsSync(youngPath), 'new hash content remains protected even alongside old orphans');
});

test('stale confirmation and drift fail before deleting any candidate', t => {
    const f = fixture(t); const orphan = f.artifacts.save({ text: 'orphan' }).ref; const path = join(f.directory, orphan.relativePath!);
    const review = reviewJournalCleanup(f.directory, 'gc', {}, f.now);
    f.commit('run.state', { state: 'completed', reason: 'changed canonical facts' }); f.flush();
    assert.throws(() => collectJournalOrphans(f.directory, 'gc', {}, review.fingerprint, f.now), /变化/); assert.ok(existsSync(path));
    writeFileSync(path, 'different bytes'); assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now), /内容或身份/); assert.ok(existsSync(path));
});

test('hardlinked candidates and projection-only references are refused', t => {
    const f = fixture(t); const orphan = f.artifacts.save({ text: 'orphan' }).ref; const path = join(f.directory, orphan.relativePath!);
    assert.throws(() => reviewJournalCleanup(f.directory, 'gc', { ref: orphan }, f.now), /显示投影/);
    linkSync(path, join(f.directory, 'duplicate-link')); assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now), /独占/); assert.ok(existsSync(path));
});

test('legacy and unknown canonical events are refused without pretending empty records are native', t => {
    const f = fixture(t); f.editManifest(value => { value.captureCoverage = 'legacy_partial'; });
    assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now), /旧记录/);
    f.editManifest(value => { value.captureCoverage = 'partial'; }); f.commit('future.unknown', {}); f.flush();
    assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now), /未知事件/);
});

test('missing nested closure and retained artifact corruption block cleanup', t => {
    const f = fixture(t); const path = join(f.directory, f.refs[0].relativePath!); const bytes = readFileSync(path);
    unlinkSync(path); assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now));
    writeFileSync(path, bytes); writeFileSync(path, 'corrupt'); assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now));
});

test('omitting a nested reference from manifest refuses collection even when its file exists', t => {
    const f = fixture(t);
    f.editManifest(value => { value.artifacts = value.artifacts.filter((ref: { relativePath: string }) => ref.relativePath !== f.refs[0].relativePath); });
    assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now), /manifest/);
    assert.ok(existsSync(join(f.directory, f.refs[0].relativePath!)));
});

test('symbolic link candidates are rejected when Windows supports file symlinks', t => {
    const f = fixture(t); const orphan = f.artifacts.save({ text: 'symlink target' }).ref;
    const target = join(f.directory, 'original-target'); const candidate = join(f.directory, orphan.relativePath!);
    writeFileSync(target, readFileSync(candidate)); unlinkSync(candidate);
    try { symlinkSync(target, candidate, 'file'); }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Windows file symlink privilege unavailable'); return; } throw error; }
    assert.throws(() => reviewJournalCleanup(f.directory, 'gc', {}, f.now), /独占/); assert.ok(existsSync(target));
});

test('cleanup query parser rejects incomplete/extra/accessor and invalid confirmation hashes', () => {
    assert.deepEqual(parseJournalQuery({ action: 'cleanup-review', sessionId: 'gc' }), { action: 'cleanup-review', sessionId: 'gc' });
    assert.equal(parseJournalQuery({ action: 'cleanup-confirm', sessionId: 'gc', fingerprint: 'a'.repeat(64) }).action, 'cleanup-confirm');
    let called = false;
    for (const input of [{ action: 'cleanup-review' }, { action: 'cleanup-review', sessionId: 'gc', now: 0 }, { action: 'cleanup-confirm', sessionId: 'gc', fingerprint: 'A'.repeat(64) },
        { action: 'cleanup-confirm', sessionId: 'gc', fingerprint: 'a'.repeat(63) }, { get action() { called = true; return 'cleanup-review'; }, sessionId: 'gc' }]) assert.throws(() => parseJournalQuery(input));
    assert.equal(called, false);
});

test('Supervisor rejects active and recording-failed sessions before closure inspection', async t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-journal-gc-supervisor-')); const supervisor = new Supervisor({ dataDirectory: root, onEvent: () => {} });
    t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('uah-journal-gc-')); rmSync(root, { recursive: true, force: true }); });
    try {
        const snapshot = await supervisor.execute({ type: 'create-session', title: 'GC gate', directory: null }); const id = snapshot.sessions[0].id;
        const state = supervisor as unknown as { recordingFailures: Set<string>; runs: { set(id: string, run: unknown): void } };
        state.recordingFailures.add(id); assert.throws(() => supervisor.journalCleanup(id), /记录失败/); state.recordingFailures.delete(id);
        state.runs.set('active', { id: 'active', sessionId: id, state: 'running' }); assert.throws(() => supervisor.journalCleanup(id), /等待会话任务/);
    } finally { await supervisor.shutdown(); }
});
