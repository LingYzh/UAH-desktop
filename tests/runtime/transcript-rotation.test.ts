import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import fs, { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RuntimeStore } from '../../src/runtime/store';
import { TranscriptWriter } from '../../src/runtime/transcript-writer';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import type { TranscriptEvent, TranscriptManifest } from '../../src/shared/harness-contracts';

function event(seq: number, text = `Event ${seq}`): TranscriptEvent {
    return { schemaVersion: 1, eventId: `stable-event-${seq}`, sessionSeq: seq, timestamp: '2026-10-01T00:00:00.000Z', processEpochId: 'epoch',
        run: { sessionId: 'session', runId: seq % 2 ? 'parent' : 'child', parentRunId: seq % 2 ? null : 'parent', rootRunId: 'parent', turnId: `turn-${Math.ceil(seq / 2)}` },
        type: 'response.delta', payload: { requestId: `request-${Math.ceil(seq / 2)}`, attemptId: 'attempt', blockId: 'text', offset: 0, offsetUnit: 'utf16', text } };
}
function fixture(t: { after(fn: () => void): void }, segmentBytes = 900) {
    const root = mkdtempSync(join(tmpdir(), 'uah-transcript-rotation-')); const store = new RuntimeStore(root);
    let writer = new TranscriptWriter(store, root, { segmentBytes, batchSize: 2 });
    const directory = writer.sessionDirectory('session'); const tail = join(directory, 'transcript.jsonl');
    t.after(() => { writer.close(); store.close(); const path = resolve(root); assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith('uah-transcript-rotation-')); rmSync(path, { recursive: true, force: true }); });
    const commit = (first: number, last: number) => store.commit({ journal: Array.from({ length: last - first + 1 }, (_, index) => event(first + index)) });
    const manifest = (): TranscriptManifest => JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
    const verify = () => {
        const value = manifest(); let expected = 1; const chunks: Buffer[] = [];
        for (const segment of value.segments) {
            assert.equal(segment.firstSeq, expected); assert.ok(segment.lastSeq >= segment.firstSeq);
            assert.equal(segment.relativePath, `segments/${segment.firstSeq}-${segment.lastSeq}-${segment.sha256}.jsonl`);
            const bytes = readFileSync(join(directory, segment.relativePath)); assert.equal(bytes.at(-1), 10);
            assert.equal(createHash('sha256').update(bytes).digest('hex'), segment.sha256);
            const rows = bytes.toString('utf8').trimEnd().split('\n').map(line => JSON.parse(line));
            assert.deepEqual(rows.map(row => row.sessionSeq), Array.from({ length: segment.lastSeq - segment.firstSeq + 1 }, (_, index) => segment.firstSeq + index));
            const maxLine = Math.max(...rows.map(row => Buffer.byteLength(JSON.stringify(row) + '\n')));
            assert.ok(bytes.length < segmentBytes + maxLine, 'closed chunk never exceeds threshold plus one complete line');
            chunks.push(bytes); expected = segment.lastSeq + 1;
        }
        const active = readFileSync(tail); assert.ok(active.length < segmentBytes); chunks.push(active);
        const canonical = Buffer.from(store.readJournal('session', 0, 10000).map(row => JSON.stringify(row) + '\n').join(''));
        assert.deepEqual(Buffer.concat(chunks), canonical); assert.deepEqual(value.retainedRanges, value.durableSeq ? [{ firstSeq: 1, lastSeq: value.durableSeq }] : []);
        assert.equal(value.exportedSeq, value.durableSeq); return value;
    };
    return { root, store, directory, tail, commit, manifest, verify, get writer() { return writer; }, restart: () => { writer.close(); writer = new TranscriptWriter(store, root, { segmentBytes, batchSize: 2 }); } };
}

test('multiple flushes rotate contiguous parent/child rounds while preserving exact identities, payloads and canonical facts', t => {
    const f = fixture(t); f.commit(1, 5); assert.equal(f.writer.flush('session').status, 'healthy'); const first = f.verify(); assert.ok(first.segments.length);
    f.commit(6, 13); assert.equal(f.writer.flush('session').status, 'healthy'); const second = f.verify(); assert.ok(second.segments.length > first.segments.length);
    assert.deepEqual(second.segments.slice(0, first.segments.length), first.segments);
    assert.equal(f.store.readJournal('session').length, 13);
    f.restart(); assert.equal(f.writer.flush('session').status, 'healthy'); const rebuilt = f.verify();
    assert.deepEqual(rebuilt.segments, second.segments, 'restart resets its rotation index and never duplicates old segments');
});

test('empty tails and one oversized UTF-8 event remain complete unsplit lines', t => {
    const f = fixture(t, 1); f.store.commit({ journal: [event(1, '\u4e2d\u6587\n'.repeat(10000))] });
    assert.equal(f.writer.flush('session').status, 'healthy'); const manifest = f.verify(); assert.equal(manifest.segments.length, 1);
    assert.equal(readFileSync(f.tail).length, 0); assert.equal(manifest.segments[0].firstSeq, 1); assert.equal(manifest.segments[0].lastSeq, 1);
    assert.equal(f.store.readJournal('session')[0].eventId, 'stable-event-1');
});

test('half a tail line is rebuilt from SQLite rather than trusted as a rotated prefix', t => {
    const f = fixture(t); f.commit(1, 7); f.writer.flush('session'); appendFileSync(f.tail, '{"half":');
    assert.equal(f.writer.flush('session').status, 'healthy'); f.verify();
    f.restart(); appendFileSync(f.tail, 'bad UTF8\xff'); assert.equal(f.writer.flush('session').status, 'healthy'); f.verify();
});

test('a missing closed segment cannot be hidden by a cached tail signature and is rebuilt on explicit projection verification', t => {
    const f = fixture(t); f.commit(1, 8); f.writer.flush('session'); const manifest = f.verify(); const missing = join(f.directory, manifest.segments[0].relativePath); unlinkSync(missing);
    assert.equal(f.writer.flush('session', { verifyArtifacts: true }).status, 'healthy'); assert.equal(existsSync(missing), true); f.verify();
});

test('a tampered closed segment is rebuilt and an unrelated stale projection segment is retained', t => {
    const f = fixture(t); f.commit(1, 8); f.writer.flush('session'); const manifest = f.verify();
    writeFileSync(join(f.directory, manifest.segments[0].relativePath), 'Tampered projection'); const stale = join(f.directory, 'segments', 'old-unreferenced.jsonl'); writeFileSync(stale, 'Stale disposable projection');
    assert.equal(f.writer.flush('session', { verifyArtifacts: true }).status, 'healthy'); f.verify(); assert.equal(readFileSync(stale, 'utf8'), 'Stale disposable projection');
});

test('segment fsync failure is degraded, discards candidate rotation state and recovers from canonical rows', t => {
    const f = fixture(t); f.commit(1, 8); let calls = 0; const original = fs.fsyncSync;
    const mock = t.mock.method(fs, 'fsyncSync', (fd: number) => { if (++calls === 2) throw new Error('Injected segment fsync failure'); return original(fd); }); syncBuiltinESMExports();
    try { const result = f.writer.flush('session'); assert.equal(result.status, 'degraded'); assert.match(result.error!, /Injected segment fsync failure/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.equal(f.store.readJournal('session').length, 8); assert.equal(f.writer.flush('session').status, 'healthy'); f.verify();
});

test('manifest atomic commit failure after tail replacement never accepts candidate index or claims healthy', t => {
    const f = fixture(t); f.commit(1, 3); f.writer.flush('session'); const before = readFileSync(join(f.directory, 'manifest.json')); f.commit(4, 11);
    const original = fs.renameSync; const mock = t.mock.method(fs, 'renameSync', (from: Parameters<typeof fs.renameSync>[0], to: Parameters<typeof fs.renameSync>[1]) => { if (String(to) === join(f.directory, 'manifest.json')) throw new Error('Injected manifest rename failure'); return original(from, to); }); syncBuiltinESMExports();
    try { const result = f.writer.flush('session'); assert.equal(result.status, 'degraded'); assert.match(result.error!, /Injected manifest rename failure/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    assert.deepEqual(readFileSync(join(f.directory, 'manifest.json')), before); assert.equal(f.store.readJournal('session').length, 11);
    f.commit(12, 14); assert.equal(f.writer.flush('session').status, 'healthy'); f.verify();
    f.restart(); assert.equal(f.writer.flush('session').status, 'healthy'); f.verify();
});

test('segments directory junction and hardlinked segment are refused without following or rewriting external evidence', t => {
    const f = fixture(t); f.commit(1, 7); f.writer.flush('session'); const manifest = f.verify(); const first = join(f.directory, manifest.segments[0].relativePath);
    const linked = join(f.root, 'external-linked.jsonl'); linkSync(first, linked);
    assert.equal(f.writer.flush('session', { verifyArtifacts: true }).status, 'degraded'); assert.deepEqual(readFileSync(linked), readFileSync(first)); unlinkSync(linked);
    assert.equal(f.writer.flush('session').status, 'healthy'); f.verify();
    const segments = join(f.directory, 'segments'); rmSync(segments, { recursive: true }); const outside = join(f.root, 'external-directory'); mkdirSync(outside); writeFileSync(join(outside, 'preserved.txt'), 'Preserved'); symlinkSync(outside, segments, 'junction');
    assert.equal(f.writer.flush('session').status, 'degraded'); assert.equal(readFileSync(join(outside, 'preserved.txt'), 'utf8'), 'Preserved');
});

test('rotation preserves referenced artifacts and forgetSession clears cached rotation without recreating purged files', t => {
    const f = fixture(t); const artifacts = new JournalArtifacts(f.writer.sessionDirectory('session')); const saved = artifacts.save({ original: 'Native continuation and evidence' });
    const row = event(1); const refEvent = { ...row, type: 'artifact.created', payload: { artifactId: 'artifact', content: saved.ref } } as TranscriptEvent;
    f.store.commit({ journal: [refEvent, event(2), event(3), event(4)] }); assert.equal(f.writer.flush('session').status, 'healthy');
    assert.deepEqual(f.verify().artifacts, [saved.ref]); assert.deepEqual(JSON.parse(artifacts.read(saved.ref).toString('utf8')), { original: 'Native continuation and evidence' });
    f.writer.forgetSession('session'); rmSync(f.directory, { recursive: true }); assert.deepEqual(f.writer.drain(), []); assert.equal(existsSync(f.directory), false);
});

test('invalid segment thresholds are rejected and default small fixtures remain a single active transcript', t => {
    const f = fixture(t); for (const segmentBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => new TranscriptWriter(f.store, f.root, { segmentBytes }), /segment size/);
    const writer = new TranscriptWriter(f.store, f.root); f.commit(1, 3); assert.equal(writer.flush('session').status, 'healthy'); assert.deepEqual(f.manifest().segments, []); writer.close();
});
