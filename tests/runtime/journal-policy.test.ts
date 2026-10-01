import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync, linkSync, symlinkSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';
import { JournalPolicyStore } from '../../src/runtime/journal-policy';
import { parseJournalPolicyCommand } from '../../src/shared/journal-policy';

function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync(join(tmpdir(), 'uah-journal-policy-'));
    const file = join(directory, 'journal-policy.json');
    t.after(() => { const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-journal-policy-')); rmSync(target, { recursive: true, force: true }); });
    return { directory, file };
}
test('default raw capture is enabled and atomic toggles survive restart without exposing mutable state', t => {
    const { directory, file } = fixture(t); const store = new JournalPolicyStore(directory);
    const first = store.get(); assert.deepEqual(first, { revision: 0, captureRaw: true }); first.captureRaw = false;
    assert.deepEqual(store.execute({ action: 'get' }), { revision: 0, captureRaw: true });
    assert.deepEqual(store.execute({ action: 'set', revision: 0, captureRaw: false }), { revision: 1, captureRaw: false });
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { schemaVersion: 1, revision: 1, captureRaw: false });
    const restarted = new JournalPolicyStore(directory); assert.deepEqual(restarted.get(), { revision: 1, captureRaw: false });
    assert.deepEqual(restarted.execute({ action: 'set', revision: 1, captureRaw: true }), { revision: 2, captureRaw: true });
    assert.ok(readdirSync(directory).includes('journal-policy.json'));
    assert.ok(readdirSync(directory).every(name => !name.endsWith('.tmp')), 'atomic saves leave no temporary files');
});
test('strict commands reject missing/extra fields, unsafe versions, accessors and hidden fields before mutation', t => {
    const { directory } = fixture(t); const store = new JournalPolicyStore(directory); let reads = 0;
    const accessor = Object.defineProperty({ action: 'set', captureRaw: false }, 'revision', { enumerable: true, get() { reads++; throw new Error('must not read'); } });
    const hidden = Object.defineProperty({ action: 'set', captureRaw: false }, 'revision', { value: 0, enumerable: false });
    for (const value of [null, [], new Date(), {}, { action: 'get', captureRaw: true }, { action: 'set', revision: 0 }, { action: 'set', captureRaw: false },
        { action: 'set', revision: 0, captureRaw: 0 }, { action: 'set', revision: -1, captureRaw: false }, { action: 'set', revision: .5, captureRaw: false },
        { action: 'set', revision: Infinity, captureRaw: false }, { action: 'set', revision: Number.MAX_SAFE_INTEGER + 1, captureRaw: false },
        { action: 'set', revision: 0, captureRaw: false, extra: true }, accessor, hidden, { action: 'get', [Symbol('extra')]: true }]) {
        assert.throws(() => parseJournalPolicyCommand(value)); assert.throws(() => store.execute(value as never));
    }
    assert.equal(reads, 0); assert.deepEqual(store.get(), { revision: 0, captureRaw: true });
});
test('stale revision or external content change cannot overwrite the current policy', t => {
    const { directory, file } = fixture(t); const store = new JournalPolicyStore(directory);
    store.execute({ action: 'set', revision: 0, captureRaw: false });
    assert.throws(() => store.execute({ action: 'set', revision: 0, captureRaw: true }), /变化/);
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 2, captureRaw: true }));
    assert.throws(() => store.execute({ action: 'set', revision: 1, captureRaw: false }), /变化/);
    assert.deepEqual(store.get(), { revision: 2, captureRaw: true }, 'get rereads an external edit');
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 2, captureRaw: false }));
    assert.throws(() => store.execute({ action: 'set', revision: 2, captureRaw: true }), /变化/);
    assert.deepEqual(store.get(), { revision: 2, captureRaw: false });
});
test('a missing previously persisted file fails closed for reads and writes', t => {
    const { directory, file } = fixture(t); const store = new JournalPolicyStore(directory);
    store.execute({ action: 'set', revision: 0, captureRaw: false }); const restarted = new JournalPolicyStore(directory);
    unlinkSync(file);
    for (const instance of [store, restarted]) {
        assert.throws(() => instance.get(), /ENOENT/); assert.throws(() => instance.execute({ action: 'set', revision: 1, captureRaw: true }), /ENOENT/);
    }
});
test('disabled policy removed while the process is stopped cannot silently re-enable capture at restart', t => {
    const { directory, file } = fixture(t);
    new JournalPolicyStore(directory).execute({ action: 'set', revision: 0, captureRaw: false });
    unlinkSync(file);
    assert.throws(() => new JournalPolicyStore(directory), /ENOENT|缺失|丢失|missing/);
});
test('corrupt schema, encoding and shape never silently return enabled defaults', t => {
    const { directory, file } = fixture(t);
    const malformed = ['{broken', 'null', '[]', '{"schemaVersion":2,"revision":1,"captureRaw":false}',
        '{"schemaVersion":1,"revision":1,"captureRaw":false,"extra":1}', '{"schemaVersion":1,"revision":1}',
        '{"schemaVersion":1,"revision":1.5,"captureRaw":false}', '{"schemaVersion":1,"revision":-1,"captureRaw":false}',
        '{"schemaVersion":1,"revision":1,"captureRaw":"false"}', Buffer.from([0xff, 0xfe]), 'x'.repeat(4097)];
    for (const content of malformed) { writeFileSync(file, content); assert.throws(() => new JournalPolicyStore(directory)); }
    writeFileSync(file, JSON.stringify({ schemaVersion: 1, revision: 1, captureRaw: false })); const store = new JournalPolicyStore(directory);
    writeFileSync(file, '{corrupted-after-load'); assert.throws(() => store.get()); assert.throws(() => store.execute({ action: 'set', revision: 1, captureRaw: true }));
});
test('hardlinked and non-file policy paths are rejected', t => {
    const { directory, file } = fixture(t); const other = join(directory, 'other.json'); writeFileSync(other, JSON.stringify({ schemaVersion: 1, revision: 1, captureRaw: false }));
    linkSync(other, file); assert.throws(() => new JournalPolicyStore(directory), /不安全/);
    unlinkSync(file); mkdirSync(file); assert.throws(() => new JournalPolicyStore(directory), /不安全/);
});
test('symlink policy paths are rejected without reading their target', t => {
    const { directory, file } = fixture(t); const other = join(directory, 'other.json'); writeFileSync(other, JSON.stringify({ schemaVersion: 1, revision: 1, captureRaw: false }));
    try { symlinkSync(other, file, 'file'); } catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) { t.skip('Host lacks file symlink permission; hardlink safety is tested separately'); return; } throw error; }
    assert.throws(() => new JournalPolicyStore(directory), /不安全/);
});
test('revision exhaustion refuses writes and preserves the disabled policy', t => {
    const { directory, file } = fixture(t); const content = JSON.stringify({ schemaVersion: 1, revision: Number.MAX_SAFE_INTEGER, captureRaw: false }); writeFileSync(file, content);
    const store = new JournalPolicyStore(directory); assert.throws(() => store.execute({ action: 'set', revision: Number.MAX_SAFE_INTEGER, captureRaw: true }), /上限/);
    assert.equal(readFileSync(file, 'utf8'), content); assert.deepEqual(store.get(), { revision: Number.MAX_SAFE_INTEGER, captureRaw: false });
});
test('initialization witness is required evidence rather than an unchecked sidecar', t => {
    const { directory, file } = fixture(t); new JournalPolicyStore(directory).execute({ action: 'set', revision: 0, captureRaw: false });
    const marker = join(directory, 'journal-policy.initialized'); assert.equal(readFileSync(marker, 'utf8'), '1');
    writeFileSync(marker, 'invalid'); assert.throws(() => new JournalPolicyStore(directory));
    unlinkSync(marker); linkSync(file, marker); assert.throws(() => new JournalPolicyStore(directory));
    unlinkSync(marker); mkdirSync(marker); assert.throws(() => new JournalPolicyStore(directory));
});
