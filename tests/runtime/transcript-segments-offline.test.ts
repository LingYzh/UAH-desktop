import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RuntimeStore } from '../../src/runtime/store';
import { TranscriptWriter } from '../../src/runtime/transcript-writer';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { exportTranscript, replayTranscript, statsTranscript, traceTranscript, validateTranscript } from '../../src/runtime/transcript-offline';
import { collectJournalOrphans, reviewJournalCleanup } from '../../src/runtime/journal-gc';
import type { TranscriptEvent, TranscriptManifest, UsageRecord } from '../../src/shared/harness-contracts';

const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-segment-offline-')); const data = join(root, 'data');
    const store = new RuntimeStore(data); const writer = new TranscriptWriter(store, data, { deriveCoverage: true });
    const directory = writer.sessionDirectory('segments'); const artifacts = new JournalArtifacts(directory); const requestId = randomUUID(), attemptId = randomUUID(); let seq = 0;
    const commit = (type: string, payload: unknown) => store.commit({ journal: [{ schemaVersion: 1, eventId: `segment-event-${++seq}`, sessionSeq: seq,
        timestamp: '2026-10-02T00:00:00.000Z', processEpochId: 'epoch', run: { sessionId: 'segments', runId: 'root', parentRunId: null, rootRunId: 'root', turnId: 'turn' }, type, payload } as TranscriptEvent] });
    const child = artifacts.save({ text: 'nested user evidence' }).ref; const parent = artifacts.save({ text: 'user target', evidence: child }).ref;
    const snapshot = artifacts.save({ schemaVersion: 1, protocol: 'openai-chat', coverage: 'complete', body: { messages: [{ role: 'user', content: 'local request' }] } }).ref;
    const native = artifacts.save({ schemaVersion: 1, captureCoverage: 'complete', continuation: [{ signature: 'OPAQUE SIGNATURE', text: 'assistant' }] }, [], true).ref;
    commit('message.accepted', { messageId: 'message', revision: 1, role: 'user', content: parent });
    commit('artifact.created', { snapshot: child });
    commit('request.intent', { requestId, attemptId, snapshot }); commit('request.dispatch', { requestId, attemptId });
    commit('response.delta', { requestId, attemptId, blockId: 'text', offset: 0, offsetUnit: 'utf16', text: 'A😀B' });
    const usage: UsageRecord = { schemaVersion: 1, accountNamespace: 'fixture', requestId, attemptId, revision: 1, purpose: 'agent',
        scope: { kind: 'session', sessionId: 'segments', runId: 'root' }, protocol: 'openai-chat', adapterVersion: 'test', source: 'provider', completeness: 'complete', rawUsage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
        counters: { inputTokens: 10, outputTokens: 4, totalTokens: 14, cachedInputTokens: null, cacheCreationInputTokens: null }, providerResponseId: null, reportedCost: null, estimatedCost: null };
    commit('usage.snapshot', { usage }); commit('response.native', { requestId, attemptId, content: native });
    commit('response.terminal', { requestId, attemptId, status: 'completed', partial: false }); commit('run.state', { state: 'completed', reason: null });
    assert.equal(writer.flush('segments').status, 'healthy');
    const manifestPath = join(directory, 'manifest.json'), tailPath = join(directory, 'transcript.jsonl');
    const flatLog = readFileSync(tailPath); const flatManifest = readFileSync(manifestPath); const rows = flatLog.toString('utf8').trimEnd().split('\n');
    const edit = (fn: (manifest: TranscriptManifest) => void) => { const value = JSON.parse(readFileSync(manifestPath, 'utf8')); fn(value); writeFileSync(manifestPath, JSON.stringify(value) + '\n'); };
    const split = (emptyTail = false) => {
        mkdirSync(join(directory, 'segments'), { recursive: true }); const ends = [3, emptyTail ? rows.length : 6]; let start = 0;
        const segments = ends.map(end => { const bytes = Buffer.from(rows.slice(start, end).join('\n') + '\n'); const relativePath = `segments/${start + 1}-${end}-${hash(bytes)}.jsonl`; writeFileSync(join(directory, relativePath), bytes); const value = { relativePath, firstSeq: start + 1, lastSeq: end, sha256: hash(bytes) }; start = end; return value; });
        writeFileSync(tailPath, start === rows.length ? '' : rows.slice(start).join('\n') + '\n'); edit(value => { value.segments = segments; }); return segments;
    };
    t.after(() => { store.close(); assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith('uah-segment-offline-')); rmSync(root, { recursive: true, force: true }); });
    return { root, directory, requestId, attemptId, manifestPath, tailPath, flatLog, flatManifest, rows, edit, split, refs: [child, parent, snapshot, native] };
}
function contents(directory: string): Record<string, string> {
    const result: Record<string, string> = {};
    for (const name of readdirSync(directory, { withFileTypes: true })) {
        if (name.isDirectory()) for (const [child, digest] of Object.entries(contents(join(directory, name.name)))) result[`${name.name}/${child}`] = digest;
        else result[name.name] = hash(readFileSync(join(directory, name.name)));
    }
    return result;
}

for (const emptyTail of [false, true]) test(`two segments with ${emptyTail ? 'empty' : 'populated'} tail reproduce flat validation/stats/replay/trace and flatten exports`, t => {
    const f = fixture(t); const flat = { validation: validateTranscript(f.directory), stats: statsTranscript(f.directory), replay: replayTranscript(f.directory), trace: traceTranscript(f.directory, f.requestId) };
    f.split(emptyTail); const source = contents(f.directory);
    assert.deepEqual(validateTranscript(f.directory), flat.validation); assert.deepEqual(statsTranscript(f.directory), flat.stats); assert.deepEqual(replayTranscript(f.directory), flat.replay); assert.deepEqual(traceTranscript(f.directory, f.requestId), flat.trace);
    for (const mode of ['full', 'share'] as const) {
        const destination = join(f.root, mode); const exported = exportTranscript(f.directory, destination, mode); assert.equal(exported.eventCount, f.rows.length);
        const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')); assert.deepEqual(manifest.segments, []); assert.equal(existsSync(join(destination, 'segments')), false);
        const output = readFileSync(join(destination, 'transcript.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.deepEqual(output.map(event => event.eventId), f.rows.map(line => JSON.parse(line).eventId));
        assert.equal(validateTranscript(destination).eventCount, f.rows.length); assert.deepEqual(replayTranscript(destination).blocks, flat.replay.blocks);
        const parent = output.find(event => event.type === 'message.accepted').payload.content;
        const nested = JSON.parse(readFileSync(join(destination, parent.relativePath), 'utf8')).evidence;
        assert.equal(hash(readFileSync(join(destination, nested.relativePath))), nested.sha256, 'public closure survives flattening');
        if (mode === 'full') assert.deepEqual(readFileSync(join(destination, 'transcript.jsonl')), f.flatLog);
        else assert.equal(manifest.continuationCoverage, 'unavailable');
    }
    assert.deepEqual(contents(f.directory), source, 'offline reads and both exports never change source segments or artifacts');
});

test('fixed target ignores extra tail events but sealed segments cannot cross the target watermark', t => {
    const f = fixture(t); f.split(); const extra = { ...JSON.parse(f.rows.at(-1)!), eventId: 'later-event', sessionSeq: f.rows.length + 1 };
    appendFileSync(f.tailPath, JSON.stringify(extra) + '\n'); const report = validateTranscript(f.directory); assert.equal(report.eventCount, f.rows.length); assert.equal(report.partial, true); assert.ok(report.warnings.includes('ignored_tail_after_target'));
    const exported = join(f.root, 'fixed-target'); exportTranscript(f.directory, exported); assert.equal(readFileSync(join(exported, 'transcript.jsonl'), 'utf8'), f.flatLog.toString());
    f.edit(value => { value.segments[1].lastSeq = value.exportedSeq + 1; }); assert.throws(() => validateTranscript(f.directory), /watermark/);
});

test('missing, modified, wrong-hash and truncated sealed segments fail closed', t => {
    const f = fixture(t); const parts = f.split(); const file = join(f.directory, parts[0].relativePath), original = readFileSync(file);
    unlinkSync(file); assert.throws(() => validateTranscript(f.directory)); writeFileSync(file, original);
    writeFileSync(file, Buffer.concat([original, Buffer.from('x')])); assert.throws(() => validateTranscript(f.directory), /integrity/);
    writeFileSync(file, original); f.edit(value => { value.segments[0].sha256 = '0'.repeat(64); }); assert.throws(() => validateTranscript(f.directory), /integrity/);
    f.edit(value => { value.segments[0].sha256 = parts[0].sha256; }); writeFileSync(file, original.subarray(0, original.length - 1)); assert.throws(() => validateTranscript(f.directory), /integrity/);
    assert.throws(() => exportTranscript(f.directory, join(f.root, 'bad'))); assert.equal(existsSync(join(f.root, 'bad')), false);
});

test('segment ranges reject overlaps/gaps/wrong declared line counts and aliased paths', t => {
    const f = fixture(t); const parts = f.split(); const original = readFileSync(f.manifestPath);
    const changes: Array<(value: TranscriptManifest) => void> = [value => { value.segments[1].firstSeq = 3; }, value => { value.segments[1].firstSeq = 5; },
        value => { value.segments[0].lastSeq = 4; }, value => { value.segments[1].relativePath = parts[0].relativePath.toUpperCase().replace('SEGMENTS/', 'segments/').replace('.JSONL', '.jsonl'); },
        value => { value.segments[0].firstSeq = 0; }, value => { value.segments[0].firstSeq = 1.5; }];
    for (const change of changes) { writeFileSync(f.manifestPath, original); f.edit(change); assert.throws(() => validateTranscript(f.directory)); }
});

test('segments reject escaping/non-segment paths and linked files', t => {
    const f = fixture(t); const parts = f.split(); const original = readFileSync(f.manifestPath);
    for (const path of ['../part.jsonl', 'segments/../part.jsonl', 'segments\\part.jsonl', '/segments/part.jsonl', 'artifacts/part.jsonl', 'segments/con.jsonl', 'segments/part.txt']) {
        writeFileSync(f.manifestPath, original); f.edit(value => { value.segments[0].relativePath = path; }); assert.throws(() => validateTranscript(f.directory), /path/);
    }
    writeFileSync(f.manifestPath, original); linkSync(join(f.directory, parts[0].relativePath), join(f.root, 'linked-segment')); assert.throws(() => validateTranscript(f.directory), /linked/);
});

test('byte/event/file caps cover all segments plus tail and referenced artifacts together', t => {
    const f = fixture(t); f.split(); const byteLength = f.flatLog.length;
    assert.throws(() => validateTranscript(f.directory, { maxTranscriptBytes: byteLength - 1 }), /byte limit/);
    assert.throws(() => validateTranscript(f.directory, { maxTotalBytes: byteLength + readFileSync(f.manifestPath).length - 1 }), /byte limit/);
    assert.throws(() => validateTranscript(f.directory, { maxFiles: 3 }), /segment-count/);
    assert.throws(() => validateTranscript(f.directory, { maxFiles: 7 }), /file-count/);
    assert.throws(() => validateTranscript(f.directory, { maxEvents: f.rows.length - 1 }), /watermark/);
});

test('GC protects manifest segments and removes only aged unreferenced hash-named segment content', t => {
    const f = fixture(t); const parts = f.split(); const before = contents(f.directory);
    const bytes = Buffer.from(JSON.stringify({ ...JSON.parse(f.rows[0]), eventId: 'unused-segment-copy' }) + '\n');
    const orphanPath = join(f.directory, 'segments', `1-1-${hash(bytes)}.jsonl`); writeFileSync(orphanPath, bytes);
    const now = Date.now() + 25 * 3600000;
    const review = reviewJournalCleanup(f.directory, 'segments', {}, now);
    assert.equal(review.files.length, 1); assert.equal(review.files[0].relativePath, `segments/1-1-${hash(bytes)}.jsonl`);
    assert.deepEqual(collectJournalOrphans(f.directory, 'segments', {}, review.fingerprint, now), { removedFiles: 1, removedBytes: bytes.length, remainingFiles: 0 });
    assert.equal(existsSync(orphanPath), false); for (const part of parts) assert.ok(existsSync(join(f.directory, part.relativePath)));
    assert.deepEqual(contents(f.directory), before); assert.deepEqual(traceTranscript(f.directory, f.requestId).events.map(event => event.eventId), f.rows.map(row => JSON.parse(row)).filter(event => event.payload.requestId === f.requestId || event.payload.usage?.requestId === f.requestId).map(event => event.eventId));
});
