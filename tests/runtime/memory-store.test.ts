import assert from 'node:assert/strict';
import test from 'node:test';
import {
    existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { MemoryIndexUpdateError, MemoryStore, MemoryStoreError, type MemoryReadResult } from '../../src/runtime/memory-store';
import type { MemoryEntry, MemoryWrite } from '../../src/shared/memory';

function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-memory-store-'));
    const home = join(root, 'home'); const project = join(root, 'project');
    mkdirSync(home); mkdirSync(project);
    t.after(() => {
        assert.ok(root.startsWith(tmpdir()));
        rmSync(root, { recursive: true, force: true });
    });
    const store = new MemoryStore({ homeDirectory: home });
    const write = (overrides: Partial<MemoryWrite> = {}): MemoryWrite => ({
        scope: 'project', title: 'A useful fact', body: 'Keep this condition in mind.', kind: 'lesson',
        status: 'candidate', pinned: false,
        source: { sessionId: 'session-1', runId: 'run-1', origin: 'agent', evidenceIds: ['activity-1'] },
        ...overrides,
    });
    return { root, home, project, store, write };
}

function errorCode(code: string) { return (error: unknown) => error instanceof MemoryStoreError && error.code === code; }
function assertEntry(value: MemoryReadResult): asserts value is MemoryEntry { assert.ok('body' in value); }
function localDate(value: string): string {
    const date = new Date(value); const pad = (item: number) => String(item).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

test('concurrent store instances serialize writes and refuse the losing stale version', async t => {
    const f = fixture(t);
    const second = new MemoryStore({ homeDirectory: f.home });
    const entry = await f.store.save(f.project, f.write());
    const results = await Promise.allSettled([
        f.store.save(f.project, f.write({ id: entry.id, expectedHash: entry.hash, body: 'First edit' })),
        second.save(f.project, f.write({ id: entry.id, expectedHash: entry.hash, body: 'Second edit' })),
    ]);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.ok(rejected?.status === 'rejected'); assert.ok(errorCode('WRITE_CONFLICT')(rejected.reason));
    const current = await f.store.read(f.project, 'project', entry.id); assertEntry(current);
    const successful = results.find(result => result.status === 'fulfilled'); assert.ok(successful?.status === 'fulfilled');
    assert.equal(current.hash, successful.value.hash);
    const created = await Promise.all([
        f.store.save(f.project, f.write({ title: 'One' })), second.save(f.project, f.write({ title: 'Two' })),
    ]);
    const index = readFileSync(join(f.store.directoryFor(f.project, 'project'), 'MEMORY.md'), 'utf8');
    for (const item of created) assert.ok(index.includes(encodeURIComponent(basename(item.path))));
});

test('reads and construction do not create directories; records persist and compare exact content hashes', async t => {
    const f = fixture(t); const memoryRoot = f.store.directoryFor(null, 'user'); const projectRoot = f.store.directoryFor(f.project, 'project');
    assert.deepEqual(await f.store.list(f.project), { entries: [], documents: [], warnings: [] });
    assert.equal(existsSync(memoryRoot), false); assert.equal(existsSync(projectRoot), false);
    const entry = await f.store.save(null, f.write({ scope: 'user', kind: 'preference', status: 'active', pinned: true,
        source: { sessionId: 'session-1', runId: 'run-1', origin: 'user', evidenceIds: [] } }));
    assert.ok(entry.path.startsWith(memoryRoot));
    const restarted = new MemoryStore({ homeDirectory: f.home });
    const read = await restarted.read(null, 'user', entry.id);
    assertEntry(read);
    assert.equal(read.body, entry.body); assert.equal(read.hash, entry.hash); assert.equal(read.source?.origin, 'user');
    const edited = readFileSync(entry.path, 'utf8').replace(entry.body, 'A human edited this paragraph.');
    writeFileSync(entry.path, edited, 'utf8');
    const current = await restarted.read(null, 'user', entry.id);
    assertEntry(current);
    assert.notEqual(current.hash, entry.hash); assert.equal(current.body, 'A human edited this paragraph.');
    await assert.rejects(restarted.save(null, { ...f.write({ scope: 'user', kind: 'preference', status: 'active', pinned: true,
        source: { sessionId: 'session-1', runId: 'run-1', origin: 'user', evidenceIds: [] } }), id: entry.id, expectedHash: entry.hash }), errorCode('WRITE_CONFLICT'));
    const updated = await restarted.save(null, { ...f.write({ scope: 'user', kind: 'preference', status: 'active', pinned: true,
        body: 'Updated after rereading.', source: { sessionId: 'session-1', runId: 'run-2', origin: 'user', evidenceIds: [] } }), id: entry.id, expectedHash: current.hash });
    assert.equal(updated.id, entry.id); assert.equal(updated.body, 'Updated after rereading.');
});

test('new records use local-date readable slugs, safe Unicode fallbacks, and collision suffixes', async t => {
    const f = fixture(t);
    const explicit = await f.store.save(f.project, f.write({ title: 'PC prototype Windows scopes', slug: 'pc-prototype-windows-scopes' }));
    assert.equal(basename(explicit.path), `${localDate(explicit.createdAt)}-pc-prototype-windows-scopes.md`);
    assert.ok(explicit.path.startsWith(f.store.directoryFor(f.project, 'project')));

    const sameSlug = await f.store.save(f.project, f.write({ title: 'Same slug, another record', slug: 'pc-prototype-windows-scopes', body: 'Different body.' }));
    assert.equal(basename(sameSlug.path), `${localDate(sameSlug.createdAt)}-pc-prototype-windows-scopes-2.md`);
    assert.notEqual(sameSlug.id, explicit.id);

    const reserved = join(f.store.directoryFor(f.project, 'project'), `${localDate(explicit.createdAt)}-pc-prototype-windows-scopes-3.md`);
    writeFileSync(reserved, '# Human-authored collision\n', 'utf8');
    const afterReservedName = await f.store.save(f.project, f.write({ title: 'A third record', slug: 'pc-prototype-windows-scopes', body: 'Third body.' }));
    assert.equal(basename(afterReservedName.path), `${localDate(afterReservedName.createdAt)}-pc-prototype-windows-scopes-4.md`);
    assert.equal(readFileSync(reserved, 'utf8'), '# Human-authored collision\n');

    const unicode = await f.store.save(f.project, f.write({ title: '中文 标题：PC 原型' }));
    assert.equal(basename(unicode.path), `${localDate(unicode.createdAt)}-中文-标题-pc-原型.md`);

    const longTitle = '中'.repeat(80);
    const longOne = await f.store.save(f.project, f.write({ title: longTitle, body: 'Long title one.' }));
    const longTwo = await f.store.save(f.project, f.write({ title: longTitle, body: 'Long title two.' }));
    assert.ok(Buffer.byteLength(basename(longOne.path), 'utf8') <= 180);
    assert.ok(Buffer.byteLength(basename(longTwo.path), 'utf8') <= 180);
    assert.match(basename(longTwo.path), /-2\.md$/);
});

test('updating keeps the current filename while applying exact-hash compare and swap', async t => {
    const f = fixture(t); const entry = await f.store.save(f.project, f.write({ slug: 'original-subject' }));
    const updated = await f.store.save(f.project, f.write({ id: entry.id, expectedHash: entry.hash, title: 'A revised title', body: 'Revised text.' }));
    assert.equal(updated.path, entry.path);
    assert.equal(basename(updated.path), `${localDate(entry.createdAt)}-original-subject.md`);
    await assert.rejects(f.store.save(f.project, f.write({ id: entry.id, expectedHash: entry.hash, slug: 'new-subject' })), errorCode('INVALID_SLUG'));
});

test('friendly filename renames preserve ID lookup, list, update, forget, and actual index links', async t => {
    const f = fixture(t); const entry = await f.store.save(f.project, f.write({ slug: 'pc-prototype-windows-scopes' }));
    const renamed = join(f.store.directoryFor(f.project, 'project'), '2026-09-25-pc-prototype-windows-scopes.md');
    renameSync(entry.path, renamed);
    const readById = await f.store.read(f.project, 'project', entry.id); assertEntry(readById);
    assert.equal(readById.path, renamed);
    const readByPath = await f.store.read(f.project, 'project', basename(renamed)); assertEntry(readByPath);
    assert.equal(readByPath.id, entry.id);
    assert.equal((await f.store.list(f.project, 'project')).entries.find(item => item.id === entry.id)?.path, renamed);

    const updated = await f.store.save(f.project, f.write({ id: entry.id, expectedHash: readById.hash, title: 'Revised but not renamed', body: 'Updated friendly entry.' }));
    assert.equal(updated.path, renamed);
    const index = readFileSync(join(f.store.directoryFor(f.project, 'project'), 'MEMORY.md'), 'utf8');
    assert.ok(index.includes('2026-09-25-pc-prototype-windows-scopes.md'));
    assert.ok(!index.includes(basename(entry.path)));

    await f.store.forget(f.project, 'project', entry.id, updated.hash);
    const tombstone = await f.store.read(f.project, 'project', entry.id); assertEntry(tombstone);
    assert.equal(tombstone.status, 'deleted'); assert.equal(tombstone.body, '');
});

test('legacy UUID filenames remain readable, updatable, indexed, and forgettable without migration', async t => {
    const f = fixture(t); const entry = await f.store.save(f.project, f.write());
    const legacy = join(f.store.directoryFor(f.project, 'project'), `${entry.id}.md`);
    renameSync(entry.path, legacy);
    const read = await f.store.read(f.project, 'project', entry.id); assertEntry(read);
    assert.equal(read.path, legacy);
    const updated = await f.store.save(f.project, f.write({ id: entry.id, expectedHash: read.hash, body: 'Legacy file updated.' }));
    assert.equal(updated.path, legacy);
    assert.ok(readFileSync(join(f.store.directoryFor(f.project, 'project'), 'MEMORY.md'), 'utf8').includes(`${entry.id}.md`));
    await f.store.forget(f.project, 'project', entry.id, updated.hash);
    const forgotten = await f.store.read(f.project, 'project', entry.id); assertEntry(forgotten);
    assert.equal(forgotten.status, 'deleted');
    assert.notEqual(forgotten.path, legacy);
});

test('duplicate IDs are reported as ambiguous and UUID filename/header mismatches are excluded', async t => {
    const f = fixture(t); const entry = await f.store.save(f.project, f.write());
    const duplicate = join(f.store.directoryFor(f.project, 'project'), '2026-09-25-duplicate-copy.md');
    writeFileSync(duplicate, readFileSync(entry.path));
    await assert.rejects(f.store.read(f.project, 'project', entry.id), errorCode('AMBIGUOUS_ID'));
    await assert.rejects(f.store.save(f.project, f.write({ id: entry.id, expectedHash: entry.hash })), errorCode('AMBIGUOUS_ID'));
    await assert.rejects(f.store.forget(f.project, 'project', entry.id, entry.hash), errorCode('AMBIGUOUS_ID'));
    const pathRead = await f.store.read(f.project, 'project', basename(duplicate)); assertEntry(pathRead);

    const mismatch = fixture(t); const valid = await mismatch.store.save(mismatch.project, mismatch.write());
    const mismatchedName = join(mismatch.store.directoryFor(mismatch.project, 'project'), '11111111-1111-4111-8111-111111111111.md');
    assert.notEqual(basename(mismatchedName), `${valid.id}.md`);
    renameSync(valid.path, mismatchedName);
    await assert.rejects(mismatch.store.read(mismatch.project, 'project', valid.id), errorCode('UUID_FILENAME_MISMATCH'));
    await assert.rejects(mismatch.store.read(mismatch.project, 'project', basename(mismatchedName)), errorCode('UUID_FILENAME_MISMATCH'));
    const listed = await mismatch.store.list(mismatch.project, 'project');
    assert.equal(listed.entries.some(item => item.id === valid.id), false);
    assert.ok(listed.warnings.some(warning => warning.includes('UUID') && warning.includes('ID')));
});

test('user, project, and private-project scopes stay separate across worktrees', async t => {
    const f = fixture(t); const second = join(f.root, 'worktree-2'); mkdirSync(second);
    const projectOne = await f.store.save(f.project, f.write({ scope: 'project' }));
    const projectTwo = await f.store.save(second, f.write({ scope: 'project', title: 'Other worktree' }));
    const privateOne = await f.store.save(f.project, f.write({ scope: 'private-project' }));
    const privateTwo = await f.store.save(second, f.write({ scope: 'private-project', title: 'Other private worktree' }));
    assert.notEqual(f.store.directoryFor(f.project, 'private-project'), f.store.directoryFor(second, 'private-project'));
    assert.notEqual(projectOne.path, projectTwo.path); assert.notEqual(privateOne.path, privateTwo.path);
    assert.equal((await f.store.list(f.project, 'project')).entries.length, 1);
    assert.equal((await f.store.list(second, 'project')).entries.length, 1);
    assert.equal((await f.store.list(f.project, 'private-project')).entries.length, 1);
    const userRoot = f.store.directoryFor(null, 'user');
    await assert.rejects(f.store.read(null, 'user', `${userRoot}/projects/${privateOne.id}.md`), errorCode('INVALID_PATH'));
});

test('managed index updates preserve all user-authored text outside its block', async t => {
    const f = fixture(t); const root = f.store.directoryFor(f.project, 'project'); mkdirSync(root);
    const indexPath = join(root, 'MEMORY.md'); const manualPrefix = '# Human notes\nPlease keep this paragraph.';
    writeFileSync(indexPath, manualPrefix, 'utf8');
    const first = await f.store.save(f.project, f.write());
    let index = readFileSync(indexPath, 'utf8');
    assert.ok(index.startsWith(manualPrefix)); assert.ok(index.includes('UAH_MEMORY_INDEX:START'));
    assert.ok(index.includes(encodeURIComponent(basename(first.path))));
    const outsideEdit = `${index.replace(manualPrefix, `${manualPrefix}\nEdited outside the managed block.`)}\n\nManual footer.`;
    writeFileSync(indexPath, outsideEdit, 'utf8');
    const second = await f.store.save(f.project, f.write({ title: 'Second fact', body: 'Another fact.' }));
    index = readFileSync(indexPath, 'utf8');
    assert.ok(index.startsWith(`${manualPrefix}\nEdited outside the managed block.`));
    assert.ok(index.endsWith('Manual footer.')); assert.ok(index.includes(encodeURIComponent(basename(first.path))));
    assert.ok(index.includes(encodeURIComponent(basename(second.path))));
    assert.equal(index.split('UAH_MEMORY_INDEX:START').length - 1, 1);
    assert.equal(index.split('UAH_MEMORY_INDEX:END').length - 1, 1);
});

test('forget stores a readable body-free tombstone and blocks automatic duplicate content', async t => {
    const f = fixture(t); const entry = await f.store.save(f.project, f.write());
    const root = f.store.directoryFor(f.project, 'project');
    for (const offset of [0, 1]) {
        const reservedDate = new Date(Date.now() + offset * 24 * 60 * 60 * 1000).toISOString();
        writeFileSync(join(root, `${localDate(reservedDate)}-forgotten-memory.md`), 'reserved human note', 'utf8');
    }
    const manualEdit = readFileSync(entry.path, 'utf8').replace(entry.body, 'Human edited latest text.');
    writeFileSync(entry.path, manualEdit, 'utf8');
    const current = await f.store.read(f.project, 'project', entry.id); assertEntry(current);
    await f.store.forget(f.project, 'project', entry.id, current.hash);
    const tombstone = await f.store.read(f.project, 'project', entry.id);
    assertEntry(tombstone);
    assert.equal(tombstone.status, 'deleted'); assert.equal(tombstone.body, ''); assert.equal(tombstone.title, '已遗忘记忆');
    assert.match(basename(tombstone.path), /^\d{4}-\d{2}-\d{2}-forgotten-memory-2\.md$/);
    assert.notEqual(tombstone.path, entry.path);
    const forgottenText = readFileSync(tombstone.path, 'utf8');
    assert.ok(!forgottenText.includes(entry.title)); assert.ok(!forgottenText.includes('Human edited latest text.'));
    assert.notEqual(tombstone.hash, current.hash);
    await assert.rejects(f.store.save(f.project, f.write({ title: 'Retitled duplicate', body: current.body })), errorCode('TOMBSTONED_CONTENT'));
    const explicit = await f.store.save(f.project, f.write({ title: 'User chose to save it again', body: current.body, source: {
        sessionId: 'session-2', runId: 'run-2', origin: 'user', evidenceIds: [],
    } }));
    assert.notEqual(explicit.id, entry.id);
    const retained = await f.store.read(f.project, 'project', entry.id); assertEntry(retained); assert.equal(retained.status, 'deleted');
    assert.equal((await f.store.list(f.project, 'project')).entries.some(item => item.id === entry.id), false);
});

test('malformed metadata is reported, raw Markdown stays readable, and UUID files are never blindly overwritten', async t => {
    const f = fixture(t); const root = f.store.directoryFor(f.project, 'project'); mkdirSync(root);
    const malformedId = '11111111-1111-4111-8111-111111111111'; const malformedPath = join(root, `${malformedId}.md`);
    const malformed = '<!-- UAH_MEMORY:{not-json} -->\n\nBroken record'; writeFileSync(malformedPath, malformed, 'utf8');
    writeFileSync(join(root, 'notes.md'), '# Imported note\n\nReadable source.\n', 'utf8');
    const listed = await f.store.list(f.project, 'project');
    assert.ok(listed.warnings.some(warning => warning.includes('metadata') || warning.includes('元数据')));
    assert.ok(listed.documents.some(document => document.path.endsWith('notes.md')));
    const raw = await f.store.read(f.project, 'project', 'notes.md'); assert.ok('content' in raw); assert.equal(raw.content, '# Imported note\n\nReadable source.\n');
    await assert.rejects(f.store.read(f.project, 'project', malformedId), errorCode('INVALID_METADATA'));
    await assert.rejects(f.store.save(f.project, f.write({ id: malformedId, expectedHash: 'a'.repeat(64) })), errorCode('INVALID_METADATA'));
    assert.equal(readFileSync(malformedPath, 'utf8'), malformed);
    await assert.rejects(f.store.read(f.project, 'project', '../outside.md'), errorCode('INVALID_PATH'));
});

test('index failure reports the committed record and can be repaired by rebuilding', async t => {
    const f = fixture(t); const root = f.store.directoryFor(f.project, 'project'); mkdirSync(root);
    const indexPath = join(root, 'MEMORY.md'); writeFileSync(indexPath, '<!-- UAH_MEMORY_INDEX:START -->\nmissing end marker\n', 'utf8');
    let partial: MemoryIndexUpdateError | undefined;
    try { await f.store.save(f.project, f.write()); } catch (error) { if (error instanceof MemoryIndexUpdateError) partial = error; else throw error; }
    assert.ok(partial); assert.equal(partial.indexPath, indexPath);
    const committed = await f.store.read(f.project, 'project', partial.committedEntry.id); assertEntry(committed); assert.equal(committed.body, f.write().body);
    writeFileSync(indexPath, 'Manual index text remains.\n', 'utf8');
    await f.store.rebuildIndex(f.project, 'project');
    assert.ok(readFileSync(indexPath, 'utf8').startsWith('Manual index text remains.'));
});

test('snapshot reads bounded indexes and pinned preferences without creating missing storage', async t => {
    const f = fixture(t); const snapshot = await f.store.snapshot(f.project);
    assert.equal(snapshot.indexes.find(item => item.scope === 'project')?.exists, false);
    assert.equal(existsSync(f.store.directoryFor(f.project, 'project')), false);
    assert.equal(existsSync(f.store.directoryFor(null, 'user')), false);
    const preference = await f.store.save(null, f.write({ scope: 'user', kind: 'preference', status: 'active', pinned: true,
        body: 'A persistent user preference.', source: { sessionId: 's', runId: 'r', origin: 'user', evidenceIds: [] } }));
    const next = await f.store.snapshot(f.project);
    assert.equal(next.pinned[0]?.id, preference.id); assert.equal(next.indexes.find(item => item.scope === 'user')?.content, '');
    const extraWrite = f.write({ scope: 'user', kind: 'preference', status: 'active', pinned: true,
        body: 'x'.repeat(3000), source: { sessionId: 's', runId: 'r2', origin: 'user', evidenceIds: [] } });
    await f.store.save(null, extraWrite);
    await f.store.save(null, { ...extraWrite, body: 'y'.repeat(3000), source: { ...extraWrite.source, runId: 'r3' } });
    const projectRoot = f.store.directoryFor(f.project, 'project'); mkdirSync(projectRoot);
    writeFileSync(join(projectRoot, 'MEMORY.md'), 'project index '.repeat(500), 'utf8');
    const bounded = await f.store.snapshot(f.project);
    assert.ok(bounded.indexes.find(item => item.scope === 'project')!.content.length <= 4000);
    assert.ok(bounded.pinned.reduce((total, item) => total + item.title.length + item.body.length + 2, 0) <= 4000);
    assert.ok(bounded.warnings.some(warning => warning.includes('4000')));
});

test('list is globally bounded across managed records and imported Markdown documents', async t => {
    const f = fixture(t); const root = f.store.directoryFor(f.project, 'project'); mkdirSync(root);
    for (let index = 0; index < 205; index++) writeFileSync(join(root, `document-${String(index).padStart(3, '0')}.md`), `# Document ${index}\n`, 'utf8');
    const listed = await f.store.list(f.project, 'project');
    assert.equal(listed.entries.length + listed.documents.length, 200);
    assert.ok(listed.documents.every(document => Buffer.byteLength(document.content, 'utf8') <= 64 * 1024));
    assert.ok(listed.warnings.some(warning => warning.includes('200')));
});

test('symbolic links, hard links, reparse paths, and aborted writes are refused', async t => {
    const f = fixture(t); const root = f.store.directoryFor(f.project, 'project'); mkdirSync(root);
    const external = join(f.root, 'outside.md'); writeFileSync(external, 'outside data', 'utf8');
    const linkPath = join(root, 'linked.md');
    let fileSymlinkCreated = false;
    try { symlinkSync(external, linkPath, 'file'); fileSymlinkCreated = true; }
    catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (fileSymlinkCreated) await assert.rejects(f.store.read(f.project, 'project', 'linked.md'), error => error instanceof MemoryStoreError && ['UNSAFE_PATH', 'UNSAFE_FILE'].includes(error.code));
    const entry = await f.store.save(f.project, f.write());
    const hardlink = join(root, 'other-name.md'); linkSync(entry.path, hardlink);
    await assert.rejects(f.store.read(f.project, 'project', 'other-name.md'), errorCode('UNSAFE_FILE'));
    await assert.rejects(f.store.forget(f.project, 'project', entry.id, entry.hash), errorCode('UNSAFE_FILE'));

    const linkedDirectory = join(f.root, 'project-link');
    try { symlinkSync(f.project, linkedDirectory, 'junction'); }
    catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
    if (existsSync(linkedDirectory)) assert.throws(() => f.store.directoryFor(linkedDirectory, 'project'), errorCode('UNSAFE_PATH'));

    const cancelled = new AbortController(); cancelled.abort();
    const absentHome = join(f.root, 'not-yet-created-home'); const absent = new MemoryStore({ homeDirectory: absentHome });
    await assert.rejects(absent.save(null, f.write({ scope: 'user' }), cancelled.signal), errorCode('CANCELLED'));
    assert.equal(existsSync(absentHome), false);
});
