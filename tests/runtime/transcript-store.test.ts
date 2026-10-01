import assert from 'node:assert/strict';
import test from 'node:test';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { RuntimeStore } from '../../src/runtime/store';
import { TranscriptWriter } from '../../src/runtime/transcript-writer';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import type { ArtifactReference, TranscriptEvent } from '../../src/shared/harness-contracts';
import type { SessionRecord } from '../../src/shared/contracts';

function event(seq: number, sessionId = 'session', child = false): TranscriptEvent {
    return {
        schemaVersion: 1, eventId: `${sessionId}-event-${seq}`, sessionSeq: seq,
        timestamp: '2026-10-01T00:00:00.000Z', processEpochId: 'epoch',
        run: { sessionId, runId: child ? 'child' : 'parent', parentRunId: child ? 'parent' : null, rootRunId: 'parent', turnId: 'turn' },
        type: 'run.state', payload: { state: 'waiting_model', reason: 'UTF-8: \u4e2d\u6587\nLF' },
    };
}
function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync(join(tmpdir(), 'uah-journal-'));
    const store = new RuntimeStore(directory);
    t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
    return { directory, store };
}

test('canonical transaction rolls back state and all journal rows on duplicate ID or sequence gap', t => {
    const { store } = fixture(t);
    const session = { id: 'session', title: 'original', createdAt: 'now' } as SessionRecord;
    store.commit({ sessions: [session], journal: [event(1)] });
    assert.throws(() => store.commit({ sessions: [{ ...session, title: 'lost' }], journal: [event(2), event(4)] }), /sequence gap/);
    assert.equal(store.readSnapshot().sessions[0].title, 'original');
    assert.deepEqual(store.readJournal('session').map(e => e.sessionSeq), [1]);
    assert.throws(() => store.commit({ sessions: [{ ...session, title: 'lost' }], journal: [{ ...event(2), eventId: event(1).eventId }] }));
    assert.equal(store.readSnapshot().sessions[0].title, 'original');
    assert.equal(store.nextSessionSeq('session'), 2);
    assert.throws(() => store.commit({ journal: [event(1)] }), /sequence gap/);
});

test('parent/child share contiguous session sequence; separate sessions have independent durable/exported watermarks', t => {
    const { store } = fixture(t);
    store.commit({ journal: [event(1), event(2, 'session', true), event(1, 'other')] });
    assert.deepEqual(store.readJournal('session').map(e => e.run.runId), ['parent', 'child']);
    assert.deepEqual(store.readJournal('session', 1, 1), [event(2, 'session', true)]);
    assert.equal(store.nextSessionSeq('other'), 2);
    assert.deepEqual(store.journalWatermark('session'), { durableSeq: 2, exportedSeq: 0 });
    store.markExported('session', 1);
    assert.throws(() => store.markExported('session', 0), /watermark/);
    assert.throws(() => store.markExported('session', 3), /watermark/);
    assert.throws(() => store.readJournal('session', -1), /range/);
    assert.throws(() => store.commit({ journal: [{ ...event(3), schemaVersion: 2 } as unknown as TranscriptEvent] }), /envelope/);
    assert.equal(store.readJournal('session').length, 2);
});

test('writer exports canonical UTF-8 LF rows, appends batches and drains without claiming complete capture', t => {
    const { store, directory } = fixture(t);
    const writer = new TranscriptWriter(store, directory, { batchSize: 1 });
    store.commit({ journal: [event(1), event(2, 'session', true)] });
    assert.deepEqual(writer.flush('session'), { sessionId: 'session', status: 'healthy', durableSeq: 2, exportedSeq: 2,
        captureCoverage: 'partial', continuationCoverage: 'unavailable', recovery: 'stopped', redactionPolicyVersion: 'unverified' });
    const file = join(writer.sessionDirectory('session'), 'transcript.jsonl');
    const bytes = readFileSync(file);
    assert.equal(bytes.toString('utf8'), [event(1), event(2, 'session', true)].map(e => JSON.stringify(e) + '\n').join(''));
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'efbbbf');
    assert.equal(bytes.includes(13), false);
    const inode = statSync(file).ino;
    store.commit({ journal: [event(3)] });
    assert.equal(writer.close()[0].exportedSeq, 3);
    assert.equal(statSync(file).ino, inode);
    const manifest = JSON.parse(readFileSync(join(writer.sessionDirectory('session'), 'manifest.json'), 'utf8'));
    assert.equal(manifest.captureCoverage, 'partial');
    assert.equal(manifest.durableSeq, 3);
    assert.throws(() => writer.flush('session'), /closed/);
});

test('restart repairs half-line, middle corruption and a lost projection without changing event IDs', t => {
    const { store, directory } = fixture(t);
    store.commit({ journal: [event(1), event(2)] });
    let writer = new TranscriptWriter(store, directory);
    assert.equal(writer.flush('session').status, 'healthy');
    const file = join(writer.sessionDirectory('session'), 'transcript.jsonl');
    const original = readFileSync(file, 'utf8');
    for (const corruption of [original + '{"eventId":', original.replace('waiting_model', 'failed'), JSON.stringify(event(1)) + '\n']) {
        writeFileSync(file, corruption);
        writer = new TranscriptWriter(store, directory);
        assert.equal(writer.flush('session').status, 'healthy');
        assert.equal(readFileSync(file, 'utf8'), original);
        assert.deepEqual(store.readJournal('session').map(e => e.eventId), ['session-event-1', 'session-event-2']);
    }
});

test('interruption after fsync before acknowledgement returns degraded and restart aligns existing rows', t => {
    const { store, directory } = fixture(t);
    store.commit({ journal: [event(1)] });
    const writer = new TranscriptWriter(store, directory);
    writer.flush('session');
    store.commit({ journal: [event(2)] });
    const originalMark = store.markExported.bind(store);
    store.markExported = () => { throw new Error('simulated acknowledgement interruption'); };
    const failure = writer.flush('session');
    assert.equal(failure.status, 'degraded');
    assert.match(failure.error!, /interruption/);
    assert.deepEqual(store.journalWatermark('session'), { durableSeq: 2, exportedSeq: 1 });
    const file = join(writer.sessionDirectory('session'), 'transcript.jsonl');
    const inode = statSync(file).ino;
    store.markExported = originalMark;
    assert.equal(new TranscriptWriter(store, directory).flush('session').exportedSeq, 2);
    assert.equal(statSync(file).ino, inode);
    assert.equal(readFileSync(file, 'utf8').trimEnd().split('\n').length, 2);
});

test('fsync failure cannot advance exported watermark and committed facts remain recoverable', t => {
    const { store, directory } = fixture(t);
    const writer = new TranscriptWriter(store, directory);
    store.commit({ journal: [event(1)] }); writer.flush('session');
    store.commit({ journal: [event(2)] });
    const original = fs.fsyncSync;
    let result;
    try {
        fs.fsyncSync = () => { throw new Error('simulated disk fsync failure'); };
        syncBuiltinESMExports();
        result = writer.flush('session');
    } finally {
        fs.fsyncSync = original;
        syncBuiltinESMExports();
    }
    assert.equal(result.status, 'degraded');
    assert.match(result.error!, /fsync failure/);
    assert.equal(result.durableSeq, 2); assert.equal(result.exportedSeq, 1);
    assert.equal(store.readJournal('session').length, 2);
    assert.equal(writer.flush('session').exportedSeq, 2);
});

test('disk/path failure leaves SQLite authoritative and reports lag; unsafe IDs cannot escape data directory', t => {
    const { store, directory } = fixture(t);
    const sessionId = '../CON/../../outside:alternate';
    store.commit({ journal: [event(1, sessionId)] });
    writeFileSync(join(directory, 'sessions'), 'blocked directory');
    const writer = new TranscriptWriter(store, directory);
    const result = writer.flush(sessionId);
    assert.equal(result.status, 'degraded');
    assert.ok(result.error);
    assert.deepEqual(store.journalWatermark(sessionId), { durableSeq: 1, exportedSeq: 0 });
    assert.equal(store.readJournal(sessionId)[0].eventId, `${sessionId}-event-1`);
    assert.equal(writer.sessionDirectory(sessionId).startsWith(join(directory, 'sessions') + '\\'), process.platform === 'win32');
});

test('writer refuses symbolic-link/junction projection directories', t => {
    const { store, directory } = fixture(t);
    const external = join(directory, 'external'); mkdirSync(external);
    symlinkSync(external, join(directory, 'sessions'), process.platform === 'win32' ? 'junction' : 'dir');
    store.commit({ journal: [event(1)] });
    const result = new TranscriptWriter(store, directory).flush('session');
    assert.equal(result.status, 'degraded');
    assert.match(result.error!, /symbolic link/);
    assert.equal(result.exportedSeq, 0);
});

test('v2 migration retains existing rows with empty journal; future database versions are rejected', t => {
    const { store, directory } = fixture(t);
    const session = { id: 'legacy', title: 'preserved', createdAt: 'now' } as SessionRecord;
    store.commit({ sessions: [session] }); store.close();
    let db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    db.exec('DROP TABLE canonical_events; DROP TABLE journal_exports; PRAGMA user_version = 2;'); db.close();
    const migrated = new RuntimeStore(directory);
    assert.deepEqual(migrated.readSnapshot().sessions, [session]);
    assert.deepEqual(migrated.readJournal('legacy'), []);
    assert.deepEqual(migrated.journalWatermark('legacy'), { durableSeq: 0, exportedSeq: 0 });
    migrated.close();
    db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    assert.equal((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    db.exec('PRAGMA user_version = 99;'); db.close();
    assert.throws(() => new RuntimeStore(directory), /newer than supported/);
});

test('in-process external tail corruption is detected before subsequent append', t => {
    const { store, directory } = fixture(t);
    const writer = new TranscriptWriter(store, directory);
    store.commit({ journal: [event(1)] }); writer.flush('session');
    const file = join(writer.sessionDirectory('session'), 'transcript.jsonl');
    appendFileSync(file, 'garbage');
    store.commit({ journal: [event(2)] });
    assert.equal(writer.flush('session').status, 'healthy');
    assert.equal(readFileSync(file, 'utf8'), [event(1), event(2)].map(e => JSON.stringify(e) + '\n').join(''));
});

test('journal backlog counts outstanding events and actual UTF-8 JSONL bytes', t => {
    const { store } = fixture(t);
    assert.deepEqual(store.journalBacklog('session'), { events: 0, bytes: 0 });
    store.commit({ journal: [event(1), event(2)] });
    assert.deepEqual(store.journalBacklog('session'), {
        events: 2, bytes: Buffer.byteLength(JSON.stringify(event(1)) + '\n' + JSON.stringify(event(2)) + '\n', 'utf8'),
    });
    store.markExported('session', 1);
    assert.deepEqual(store.journalBacklog('session'), { events: 1, bytes: Buffer.byteLength(JSON.stringify(event(2)) + '\n', 'utf8') });
    store.markExported('session', 2);
    assert.deepEqual(store.journalBacklog('session'), { events: 0, bytes: 0 });
});

test('manifest indexes nested artifact evidence once and reconstructs refs on restart without reading originals', t => {
    const { store, directory } = fixture(t);
    const present: ArtifactReference = { availability: 'present', mediaType: 'application/json',
        relativePath: 'snapshots/unread.json', sha256: 'a'.repeat(64), byteLength: 3, missingReason: null };
    const missing: ArtifactReference = { availability: 'missing', mediaType: 'text/plain',
        relativePath: 'artifacts/missing.txt', sha256: null, byteLength: null, missingReason: 'not captured' };
    const external: ArtifactReference = { availability: 'external_reference_only', mediaType: 'application/pdf',
        relativePath: null, sha256: null, byteLength: null, missingReason: 'provider-only handle', externalReference: 'https://do-not-fetch.invalid/file' };
    const unknown = { ...event(1), type: 'future.evidence', payload: { nested: [{ present }, { duplicates: [present, present] }], external } } as unknown as TranscriptEvent;
    store.commit({ journal: [unknown] });
    let writer = new TranscriptWriter(store, directory, { batchSize: 1 });
    assert.equal(writer.flush('session').status, 'healthy');
    const manifestFile = join(writer.sessionDirectory('session'), 'manifest.json');
    let manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.artifacts.length, 2);
    assert.ok(manifest.artifacts.some((ref: ArtifactReference) => ref.availability === 'present' && ref.sha256 === present.sha256));
    assert.ok(manifest.artifacts.some((ref: ArtifactReference) => ref.availability === 'external_reference_only' && ref.externalReference === external.externalReference));
    store.commit({ journal: [{ ...event(2), type: 'future.evidence', payload: { deeply: { nested: [missing, present] } } } as unknown as TranscriptEvent] });
    assert.equal(writer.flush('session').status, 'healthy');
    manifest = JSON.parse(readFileSync(manifestFile, 'utf8'));
    assert.equal(manifest.artifacts.length, 3);
    const serialized = JSON.stringify(manifest.artifacts);
    writer = new TranscriptWriter(store, directory);
    assert.equal(writer.flush('session').status, 'healthy');
    assert.equal(JSON.stringify(JSON.parse(readFileSync(manifestFile, 'utf8')).artifacts), serialized);
    assert.equal(store.readJournal('session')[0].type as string, 'future.evidence');
    assert.equal(manifest.captureCoverage, 'partial');
});

for (const relativePath of ['../outside', '/absolute', 'C:/drive', 'nested/../../escape', 'nested\\escape', 'file:stream', 'nested/.. /escape']) {
    test(`unsafe artifact reference path ${JSON.stringify(relativePath)} is retained as DB evidence but degrades projection`, t => {
        const { store, directory } = fixture(t);
        const ref = { availability: 'present', mediaType: 'text/plain', relativePath,
            sha256: 'f'.repeat(64), byteLength: 1, missingReason: null };
        store.commit({ journal: [{ ...event(1), type: 'future.evidence', payload: { ref } } as unknown as TranscriptEvent] });
        const result = new TranscriptWriter(store, directory).flush('session');
        assert.equal(result.status, 'degraded'); assert.match(result.error!, /path/);
        assert.equal(result.durableSeq, 1); assert.equal(result.exportedSeq, 0);
        assert.equal(store.readJournal('session').length, 1);
    });
}

function coverageFixture(t: { after(fn: () => void): void }, options: ConstructorParameters<typeof TranscriptWriter>[2] = {}) {
    const { store, directory } = fixture(t);
    const writer = new TranscriptWriter(store, directory, { deriveCoverage: true, ...options });
    const artifacts = new JournalArtifacts(writer.sessionDirectory('session'));
    const identity = { ...event(1).run, stepId: 'step', requestId: 'request', attemptId: 'attempt' };
    const snapshot = artifacts.save({ schemaVersion: 1, identity, coverage: 'complete', body: { messages: [] }, redactionPolicyVersion: 'fixture-policy' }, [], true).ref;
    const native = artifacts.save({ schemaVersion: 1, captureCoverage: 'complete', continuationCoverage: 'native', continuation: [] }, [], true).ref;
    let seq = 0;
    const commit = (type: string, payload: unknown) => store.commit({ journal: [{ ...event(++seq), type, payload } as TranscriptEvent] });
    const readManifest = () => { const result = writer.flush('session'); assert.equal(result.status, 'healthy', result.error); return JSON.parse(readFileSync(join(writer.sessionDirectory('session'), 'manifest.json'), 'utf8')); };
    const complete = () => {
        commit('request.intent', { identity, snapshot });
        commit('response.terminal', { requestId: 'request', attemptId: 'attempt', status: 'completed', partial: false });
        commit('response.native', { requestId: 'request', attemptId: 'attempt', content: native });
        commit('run.state', { state: 'completed', reason: null });
    };
    return { store, writer, directory, artifacts, identity, snapshot, native, commit, readManifest, complete };
}

test('opt-in coverage is complete only after request/native evidence and run terminal; recovery never becomes eligible', t => {
    const f = coverageFixture(t);
    assert.equal(f.readManifest().captureCoverage, 'legacy_partial');
    f.commit('request.intent', { identity: f.identity, snapshot: f.snapshot });
    assert.equal(f.readManifest().captureCoverage, 'partial');
    f.commit('response.terminal', { requestId: 'request', attemptId: 'attempt', status: 'completed', partial: false });
    assert.equal(f.readManifest().captureCoverage, 'partial');
    f.commit('response.native', { requestId: 'request', attemptId: 'attempt', content: f.native });
    assert.equal(f.readManifest().captureCoverage, 'partial');
    f.commit('run.state', { state: 'completed', reason: null });
    const manifest = f.readManifest();
    assert.equal(manifest.captureCoverage, 'complete'); assert.equal(manifest.continuationCoverage, 'native'); assert.equal(manifest.recovery, 'stopped');
    assert.equal(manifest.redactionPolicyVersion, 'fixture-policy');
    const restarted = new TranscriptWriter(f.store, f.directory, { deriveCoverage: true });
    assert.equal(restarted.flush('session').status, 'healthy');
    assert.equal(JSON.parse(readFileSync(join(restarted.sessionDirectory('session'), 'manifest.json'), 'utf8')).captureCoverage, 'complete');
});

test('explicit artifact access rechecks cached coverage and keeps damage degraded until repaired', t => {
    const f = coverageFixture(t); f.complete();
    assert.equal(f.readManifest().captureCoverage, 'complete');
    assert.equal(f.native.availability, 'present');
    if (f.native.availability !== 'present') throw new Error('fixture native missing');
    const file = join(f.writer.sessionDirectory('session'), f.native.relativePath);
    const original = readFileSync(file);
    writeFileSync(file, Buffer.alloc(original.length, 32));
    const failed = f.writer.flush('session', { verifyArtifacts: true });
    assert.equal(failed.status, 'degraded');
    assert.equal(failed.continuationCoverage, 'unavailable');
    assert.equal(f.writer.flush('session').status, 'degraded');
    writeFileSync(file, original);
    const repaired = f.writer.flush('session', { verifyArtifacts: true });
    assert.equal(repaired.status, 'healthy');
    assert.equal(repaired.captureCoverage, 'complete');
});

test('standalone default remains partial and legacy session protection cannot upgrade complete evidence', t => {
    const f = coverageFixture(t, { legacySessionIds: new Set(['session']) }); f.complete();
    assert.equal(f.readManifest().captureCoverage, 'legacy_partial');
    assert.equal(f.readManifest().continuationCoverage, 'unavailable');
    const normal = new TranscriptWriter(f.store, f.directory);
    assert.equal(normal.flush('session').status, 'healthy');
    assert.equal(JSON.parse(readFileSync(join(normal.sessionDirectory('session'), 'manifest.json'), 'utf8')).captureCoverage, 'partial');
});

test('failed/partial terminal, redacted snapshot, unknown events and absent refs cannot derive complete capture', t => {
    const f = coverageFixture(t);
    const redacted = f.artifacts.save({ schemaVersion: 1, identity: f.identity, coverage: 'partial' }, [], true).ref;
    f.commit('request.intent', { identity: f.identity, snapshot: redacted });
    f.commit('response.terminal', { requestId: 'request', attemptId: 'attempt', status: 'failed', partial: true });
    f.commit('response.native', { requestId: 'request', attemptId: 'attempt', content: f.native });
    f.commit('run.state', { state: 'failed', reason: 'partial' });
    assert.equal(f.readManifest().captureCoverage, 'partial'); assert.equal(f.readManifest().continuationCoverage, 'unavailable');
    f.commit('future.unknown', { data: 'not executed' });
    f.commit('artifact.created', { content: { availability: 'missing', relativePath: 'artifacts/missing.json', sha256: null,
        byteLength: null, mediaType: 'application/json', missingReason: 'not captured' } });
    assert.equal(f.readManifest().captureCoverage, 'partial');
});

test('unresolved tool dispatch keeps coverage partial and recovery needs reconciliation until its durable result', t => {
    const f = coverageFixture(t); f.complete();
    f.commit('tool.dispatch', { identity: { ...f.identity, toolCallId: 'call', invocationId: 'invocation' }, executionId: null, approvalId: null });
    const unresolved = f.readManifest(); assert.equal(unresolved.captureCoverage, 'partial'); assert.equal(unresolved.recovery, 'needs_reconciliation');
    f.commit('tool.result', { invocationId: 'invocation', outcome: { recordingState: 'durable' } });
    assert.equal(f.readManifest().captureCoverage, 'complete');
    f.commit('run.state', { state: 'recording_failed', reason: 'durability' });
    assert.equal(f.readManifest().captureCoverage, 'partial'); assert.equal(f.readManifest().continuationCoverage, 'unavailable');
});

test('coverage reads restricted JSON with size/hash/link checks and reports corrupt evidence degraded', t => {
    const f = coverageFixture(t);
    writeFileSync(join(f.writer.sessionDirectory('session'), f.snapshot.relativePath!), 'corrupt');
    f.commit('request.intent', { identity: f.identity, snapshot: f.snapshot });
    const result = f.writer.flush('session');
    assert.equal(result.status, 'degraded'); assert.match(result.error!, /integrity/);
    assert.equal(result.durableSeq, 1); assert.equal(result.exportedSeq, 0);
});

test('coverage visits only new rows after its initial scan and does not reread complete artifact bodies', t => {
    const f = coverageFixture(t); f.complete(); f.readManifest();
    const originalRead = f.store.readJournal.bind(f.store); const after: number[] = [];
    f.store.readJournal = (sessionId, afterSeq = 0, limit = 1000) => { after.push(afterSeq); return originalRead(sessionId, afterSeq, limit); };
    f.commit('recording.checkpoint', { durableSeq: 4, exportedSeq: 4 });
    assert.equal(f.readManifest().captureCoverage, 'complete');
    assert.ok(after.length > 0); assert.ok(after.every(seq => seq >= 4));
});

for (const variant of ['unknown', 'missing', 'external', 'second_unfinished_request', 'reconciliation']) {
    test(`otherwise complete coverage degrades for ${variant}`, t => {
        const f = coverageFixture(t); f.complete(); assert.equal(f.readManifest().captureCoverage, 'complete');
        if (variant === 'unknown') f.commit('future.unknown', { data: 'opaque' });
        if (variant === 'missing') f.commit('artifact.created', { content: { availability: 'missing', relativePath: 'artifacts/missing.json',
            sha256: null, byteLength: null, mediaType: 'application/json', missingReason: 'absent' } });
        if (variant === 'external') f.commit('artifact.created', { content: { availability: 'external_reference_only', relativePath: null,
            sha256: null, byteLength: null, mediaType: 'application/pdf', externalReference: 'provider', missingReason: 'not offline' } });
        if (variant === 'second_unfinished_request') f.commit('usage.snapshot', { usage: { requestId: 'second', attemptId: 'second-attempt' } });
        if (variant === 'reconciliation') f.commit('run.state', { state: 'needs_reconciliation', reason: 'unknown action' });
        const manifest = f.readManifest(); assert.equal(manifest.captureCoverage, 'partial'); assert.equal(manifest.continuationCoverage, 'unavailable');
        if (variant === 'reconciliation') assert.equal(manifest.recovery, 'needs_reconciliation');
    });
}

test('a completed local run without a captured request cannot derive complete', t => {
    const f = coverageFixture(t); f.commit('run.state', { state: 'completed', reason: null });
    assert.equal(f.readManifest().captureCoverage, 'partial');
});

test('coverage JSON artifact exceeding 16 MiB reports degraded while retaining authority', t => {
    const f = coverageFixture(t);
    const snapshot = f.artifacts.save({ schemaVersion: 1, identity: f.identity, coverage: 'complete', body: 'x'.repeat(16 * 1024 * 1024) }, [], true).ref;
    f.commit('request.intent', { identity: f.identity, snapshot });
    const result = f.writer.flush('session');
    assert.equal(result.status, 'degraded'); assert.match(result.error!, /16 MiB/);
    assert.equal(result.durableSeq, 1); assert.equal(f.store.readJournal('session').length, 1);
});
