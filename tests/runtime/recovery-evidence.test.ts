import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, mkdir, link, symlink, truncate, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectRecoveryResources } from '../../src/runtime/recovery-evidence.js';
import type { ResourceVersion } from '../../src/shared/harness-contracts.js';

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const uri = (filename: string) => pathToFileURL(filename).href;
function resource(filename: string, afterHash: string | null, hashKind?: ResourceVersion['hashKind']): ResourceVersion {
    return { uri: uri(filename), beforeHash: hash('old'), afterHash, ...(hashKind ? { hashKind } : {}) };
}
async function fixture(run: (root: string, outside: string) => Promise<void>): Promise<void> {
    const temp = await mkdtemp(path.join(os.tmpdir(), 'uah-recovery-evidence-'));
    const root = path.join(temp, 'approved');
    await mkdir(root);
    try { await run(root, path.join(temp, 'outside')); } finally { await rm(temp, { recursive: true, force: true }); }
}

test('latest current hashes match, change or disappear without touching file content', async () => fixture(async root => {
    const good = path.join(root, 'good.txt'), changed = path.join(root, 'changed.txt'), missing = path.join(root, 'missing.txt');
    await writeFile(good, 'current'); await writeFile(changed, 'new');
    const result = await inspectRecoveryResources(root, [resource(good, hash('current')), resource(changed, hash('old')), resource(missing, hash('lost'))]);
    assert.deepEqual(result.map(item => item.status), ['matched', 'changed', 'missing']);
    assert.equal(result[0].hashKind, 'utf8_text');
    assert.equal(result[0].actualHash, hash('current')); assert.equal(result[1].actualHash, hash('new'));
    assert.equal(result[2].actualHash, null);
    assert.equal((await inspectRecoveryResources(root, [] )).length, 0);
}));

test('duplicate URI uses its last afterHash and hash kind; beforeHash cannot supply current evidence', async () => fixture(async root => {
    const file = path.join(root, 'file.txt'); await writeFile(file, 'current');
    const first = resource(file, hash('old'), 'raw_bytes');
    const latest = resource(file, hash('current'), 'utf8_text');
    const result = await inspectRecoveryResources(root, [first, latest]);
    assert.equal(result.length, 1); assert.equal(result[0].status, 'matched'); assert.equal(result[0].hashKind, 'utf8_text');
    const unknown = await inspectRecoveryResources(root, [latest, { ...latest, beforeHash: hash('current'), afterHash: null }]);
    assert.equal(unknown[0].status, 'unverifiable'); assert.equal(unknown[0].expectedHash, null); assert.equal(unknown[0].actualHash, null);
}));

test('raw bytes include BOM and arbitrary binary; UTF-8 text strips exactly one leading BOM', async () => fixture(async root => {
    const file = path.join(root, 'bom.txt');
    const bom = Buffer.from([0xef, 0xbb, 0xbf]); const text = 'A😀\r\nB';
    const bytes = Buffer.concat([bom, Buffer.from(text)]); await writeFile(file, bytes);
    assert.equal((await inspectRecoveryResources(root, [resource(file, hash(bytes), 'raw_bytes')]))[0].status, 'matched');
    assert.equal((await inspectRecoveryResources(root, [resource(file, hash(text))]))[0].status, 'matched');
    assert.equal((await inspectRecoveryResources(root, [resource(file, hash(bytes))]))[0].status, 'changed');
    await writeFile(file, Buffer.concat([bom, bytes]));
    assert.equal((await inspectRecoveryResources(root, [resource(file, hash('\ufeff' + text))]))[0].status, 'matched');
    const binary = Buffer.from([0xff, 0x80, 0]); await writeFile(file, binary);
    assert.equal((await inspectRecoveryResources(root, [resource(file, hash(binary), 'raw_bytes')]))[0].status, 'matched');
    const invalid = (await inspectRecoveryResources(root, [resource(file, hash(binary), 'utf8_text')]))[0];
    assert.equal(invalid.status, 'unverifiable'); assert.equal(invalid.actualHash, null); assert.match(invalid.detail, /UTF-8/);
}));

test('URI authority, non-file resources, query, fragments and outside paths fail closed', async () => fixture(async (root, outside) => {
    await writeFile(outside, 'secret'); const valid = resource(path.join(root, 'plain.txt'), hash('secret'));
    await writeFile(path.join(root, 'plain.txt'), 'secret');
    const forbidden = [uri(outside), 'https://example.com/private', 'file://remote/share/file', 'file://user:password@host/file', valid.uri + '?', valid.uri + '#', valid.uri + '?secret=token', valid.uri + '#token', 'not-a-uri', ' ' + valid.uri];
    const result = await inspectRecoveryResources(root, forbidden.map(value => ({ ...valid, uri: value })));
    assert.equal(result.length, forbidden.length);
    for (const item of result) { assert.equal(item.status, 'unverifiable'); assert.equal(item.actualHash, null); assert.equal(item.detail.includes('secret'), false); assert.equal(item.detail.includes('password'), false); }
    assert.equal((await inspectRecoveryResources(root, [resource(root, hash('secret'))]))[0].status, 'unverifiable');
}));

test('null, relative, missing and non-directory approved roots cannot authorize reads', async () => fixture(async root => {
    const file = path.join(root, 'file.txt'); await writeFile(file, 'current');
    for (const directory of [null, '.', path.join(root, 'missing-root'), file]) {
        const [result] = await inspectRecoveryResources(directory, [resource(file, hash('current'))]);
        assert.equal(result.status, 'unverifiable'); assert.equal(result.actualHash, null);
    }
    for (const expected of [null, '', 'not-a-hash', 'a'.repeat(63)]) {
        const [result] = await inspectRecoveryResources(root, [resource(file, expected)]);
        assert.equal(result.status, 'unverifiable'); assert.equal(result.actualHash, null);
    }
    assert.equal((await inspectRecoveryResources(root, [resource(file, hash('current').toUpperCase())]))[0].status, 'matched');
    assert.equal((await inspectRecoveryResources(root, [{ ...resource(file, hash('current')), hashKind: 'unsupported' as ResourceVersion['hashKind'] }]))[0].status, 'unverifiable');
}));

test('hard links, ordinary directories and oversized files are unverifiable', async () => fixture(async root => {
    const file = path.join(root, 'file.txt'), hard = path.join(root, 'hard.txt'), big = path.join(root, 'big.bin'), folder = path.join(root, 'folder');
    await writeFile(file, 'current'); await link(file, hard); await mkdir(folder); await writeFile(big, ''); await truncate(big, 16 * 1024 * 1024 + 1);
    for (const filename of [file, hard, folder, big]) {
        const [result] = await inspectRecoveryResources(root, [resource(filename, hash('current'), 'raw_bytes')]);
        assert.equal(result.status, 'unverifiable'); assert.equal(result.actualHash, null);
    }
    await truncate(big, 16 * 1024 * 1024);
    const [boundary] = await inspectRecoveryResources(root, [resource(big, hash(Buffer.alloc(16 * 1024 * 1024)), 'raw_bytes')]);
    assert.equal(boundary.status, 'matched');
}));

test('directory junctions, symbolic files and approved roots through links are refused', async t => fixture(async root => {
    const dir = path.join(root, 'real'); await mkdir(dir); const file = path.join(dir, 'file.txt'); await writeFile(file, 'current');
    const junction = path.join(root, 'junction'); await symlink(dir, junction, process.platform === 'win32' ? 'junction' : 'dir');
    const [through] = await inspectRecoveryResources(root, [resource(path.join(junction, 'file.txt'), hash('current'))]);
    assert.equal(through.status, 'unverifiable');
    const [linkedRoot] = await inspectRecoveryResources(junction, [resource(path.join(junction, 'file.txt'), hash('current'))]);
    assert.equal(linkedRoot.status, 'unverifiable');
    const symbolic = path.join(root, 'symbolic.txt');
    try { await symlink(file, symbolic, 'file'); } catch (error) {
        if (process.platform !== 'win32' || (error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
        t.diagnostic('File symlink creation requires Windows privilege; directory junction rejection was verified.'); return;
    }
    assert.equal((await inspectRecoveryResources(root, [resource(symbolic, hash('current'))]))[0].status, 'unverifiable');
}));

test('Windows drive URI casing follows host path rules and alternate streams are rejected', { skip: process.platform !== 'win32' }, async () => fixture(async root => {
    const file = path.join(root, 'Case File.txt'); await writeFile(file, 'current');
    const value = resource(file, hash('current')); value.uri = value.uri.replace('Case%20File.txt', 'case%20file.TXT');
    assert.equal((await inspectRecoveryResources(root.toUpperCase(), [value]))[0].status, 'matched');
    value.uri = uri(file) + ':stream';
    assert.equal((await inspectRecoveryResources(root, [value]))[0].status, 'unverifiable');
}));
