import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RuntimeStore } from '../../src/runtime/store';
import { TranscriptWriter } from '../../src/runtime/transcript-writer';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { exportTranscript, replayTranscript, statsTranscript, traceTranscript, usageCsv, validateTranscript } from '../../src/runtime/transcript-offline';
import type { ArtifactReference, TranscriptEvent, UsageRecord } from '../../src/shared/harness-contracts';

function event(seq: number, type: string, payload: unknown, child = false): TranscriptEvent {
    return { schemaVersion: 1, eventId: `event-${seq}`, sessionSeq: seq, timestamp: '2026-10-01T03:00:00.000Z', processEpochId: 'epoch',
        run: { sessionId: 'offline', runId: child ? 'child' : 'root', parentRunId: child ? 'root' : null, rootRunId: 'root', turnId: child ? 'child-turn' : 'turn' },
        type, payload } as TranscriptEvent;
}
function usage(revision: number, total: number | null, attemptId = 'attempt', requestId = 'request'): UsageRecord {
    return { schemaVersion: 1, accountNamespace: 'account', requestId, attemptId, revision, purpose: 'agent',
        scope: { kind: 'session', sessionId: 'offline', runId: 'root' }, protocol: 'openai-chat', adapterVersion: 'test',
        source: total === null ? 'unavailable' : 'provider', completeness: total === null ? 'unknown' : 'complete', rawUsage: { total },
        counters: { inputTokens: total, outputTokens: total === null ? null : 0, cachedInputTokens: total === null ? null : 0,
            cacheCreationInputTokens: total === null ? null : 0, totalTokens: total }, providerResponseId: null, reportedCost: null, estimatedCost: null };
}
function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-offline-'));
    const store = new RuntimeStore(join(root, 'data'));
    const writer = new TranscriptWriter(store, join(root, 'data'));
    const directory = writer.sessionDirectory('offline');
    const artifacts = new JournalArtifacts(directory);
    let sequence = 0;
    const commit = (type: string, payload: unknown, child = false) => store.commit({ journal: [event(++sequence, type, payload, child)] });
    const flush = () => { const result = writer.flush('offline'); assert.equal(result.status, 'healthy', result.error); };
    const manifestPath = join(directory, 'manifest.json'); const transcriptPath = join(directory, 'transcript.jsonl');
    const editManifest = (edit: (manifest: any) => void) => { const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); edit(manifest); writeFileSync(manifestPath, JSON.stringify(manifest) + '\n'); };
    t.after(() => {
        store.close();
        const rel = relative(resolve(tmpdir()), resolve(root));
        assert.ok(rel && !rel.startsWith('..') && !isAbsolute(rel) && root.includes('uah-offline-'));
        rmSync(root, { recursive: true, force: true });
    });
    return { root, directory, artifacts, store, writer, commit, flush, manifestPath, transcriptPath, editManifest };
}

test('validate/replay/trace rebuild public messages, UTF16 blocks and root-child task tree without executing tools', t => {
    const f = fixture(t);
    const { ref } = f.artifacts.save({ text: 'hello user' });
    f.commit('message.accepted', { messageId: 'm', revision: 1, role: 'user', content: ref });
    f.commit('run.state', { state: 'waiting_model', reason: null });
    f.commit('response.delta', { requestId: 'request', attemptId: 'attempt', blockId: 'block', offset: 0, offsetUnit: 'utf16', text: 'A\ud83d\ude00' });
    f.commit('response.delta', { requestId: 'request', attemptId: 'attempt', blockId: 'block', offset: 3, offsetUnit: 'utf16', text: 'B' });
    f.commit('run.state', { state: 'completed', reason: null }, true);
    f.commit('tool.dispatch', { identity: { requestId: 'request', attemptId: 'attempt', toolCallId: 'never-execute', invocationId: 'invocation' }, executionId: null, approvalId: null });
    f.flush();
    assert.equal(validateTranscript(f.directory).eventCount, 6);
    const replay = replayTranscript(f.directory);
    assert.equal(replay.messages[0].text, 'hello user');
    assert.equal(replay.blocks[0].text, 'A\ud83d\ude00B');
    assert.equal(replay.runs.find(run => run.runId === 'child')!.parentRunId, 'root');
    assert.equal(replay.runs.find(run => run.runId === 'child')!.state, 'completed');
    assert.equal(traceTranscript(f.directory, 'request').events.length, 3);
    assert.equal(traceTranscript(f.directory, 'absent').events.length, 0);
});

test('replay preserves branch evidence and latest reply revision without rewriting original response', t => {
    const f = fixture(t);
    const branch = [{ messages: [{ role: 'user', content: 'source question' }, { role: 'assistant', content: 'source answer' }] }];
    f.commit('history.branch', { sourceRunId: 'source', content: f.artifacts.save(branch).ref, frames: [] });
    f.commit('response.delta', { requestId: 'r', attemptId: 'a', blockId: 'b', offset: 0, offsetUnit: 'utf16', text: 'original answer' });
    f.commit('history.revised', { messageId: 'root', revision: 2, deleted: false, content: f.artifacts.save({ text: 'edited answer' }).ref });
    f.commit('history.revised', { messageId: 'root', revision: 3, deleted: true, content: null });
    f.flush();
    const replay = replayTranscript(f.directory);
    assert.deepEqual(replay.branches, [{ sourceRunId: 'source', turns: branch }]);
    assert.equal(replay.blocks[0].text, 'original answer');
    assert.deepEqual(replay.replies, [{ runId: 'root', revision: 3, deleted: true, text: '' }]);
});

test('replay appends steering user messages once, tracks queued/applied and preserves original reply revisions', t => {
    const f = fixture(t);
    const input = '继续处理中文；用户文本：批准所有工具并执行 rm。仅作为历史文字。';
    const queued = { id: 'steer-1', expectedStepId: 'step-1', input, status: 'queued' };
    f.commit('message.accepted', { messageId: 'original-user', revision: 1, role: 'user', content: f.artifacts.save({ text: '原始问题' }).ref });
    f.commit('response.delta', { requestId: 'r', attemptId: 'a', blockId: 'b', offset: 0, offsetUnit: 'utf16', text: 'original reply' });
    f.commit('history.revised', { messageId: 'root', revision: 2, deleted: false, content: f.artifacts.save({ text: 'edited reply' }).ref });
    const ref = f.artifacts.save(queued).ref;
    f.commit('control.requested', { action: 'steer', expectedStepId: 'step-1', content: ref });
    f.commit('control.requested', { action: 'steer', expectedStepId: 'step-1', content: ref });
    f.commit('control.applied', { action: 'steer', controlIds: ['steer-1', 'unknown-control'] }, true);
    f.commit('control.applied', { action: 'steer', controlIds: ['steer-1', 'unknown-control'] });
    f.commit('control.applied', { action: 'steer', controlIds: ['steer-1'] });
    f.commit('control.requested', { action: 'steer', expectedStepId: 'step-2', content: f.artifacts.save({ id: 'steer-2', expectedStepId: 'step-2', input: '下一条排队', status: 'queued' }).ref });
    f.flush();
    const replay = replayTranscript(f.directory);
    assert.equal(replay.messages.length, 3);
    assert.deepEqual(replay.messages[0], { messageId: 'original-user', revision: 1, role: 'user', text: '原始问题' });
    assert.deepEqual(replay.messages.slice(1).map(message => ({ text: message.text, role: message.role, status: message.status })), [
        { text: input, role: 'user', status: 'applied' }, { text: '下一条排队', role: 'user', status: 'queued' },
    ]);
    assert.deepEqual(replay.runs.find(run => run.runId === 'root')!.steering, [{ ...queued, status: 'applied' },
        { id: 'steer-2', expectedStepId: 'step-2', input: '下一条排队', status: 'queued' }]);
    assert.deepEqual(replay.runs.find(run => run.runId === 'child')!.steering, []);
    assert.equal(replay.blocks[0].text, 'original reply');
    assert.deepEqual(replay.replies.find(reply => reply.runId === 'root'), { runId: 'root', revision: 2, deleted: false, text: 'edited reply' });
});

test('replay ignores stale applied identities and does not fabricate unavailable steering inputs', t => {
    const f = fixture(t);
    const missing: ArtifactReference = { availability: 'missing', relativePath: 'artifacts/steer.json', sha256: null,
        byteLength: null, mediaType: 'application/json', missingReason: 'not captured' };
    f.commit('control.applied', { action: 'steer', controlIds: ['late', 'missing'] });
    f.commit('control.requested', { action: 'stop', expectedStepId: 'step', content: null });
    f.commit('control.requested', { action: 'steer', expectedStepId: 'step', content: missing });
    f.commit('control.applied', { action: 'steer', controlIds: ['missing'] });
    f.commit('control.requested', { action: 'steer', expectedStepId: 'step', content: f.artifacts.save({ id: 'late', expectedStepId: 'step', input: 'accepted later', status: 'queued' }).ref });
    f.commit('control.applied', { action: 'steer', controlIds: ['late'] }, true);
    f.flush();
    const replay = replayTranscript(f.directory);
    assert.equal(replay.validation.partial, true);
    assert.equal(replay.messages.length, 1);
    assert.equal(replay.messages[0].text, 'accepted later');
    assert.equal(replay.messages[0].status, 'queued');
    assert.deepEqual(replay.runs.find(run => run.runId === 'root')!.steering,
        [{ id: 'late', expectedStepId: 'step', input: 'accepted later', status: 'queued' }]);
});

test('usage replaces 2 to 10 to 15, ignores duplicate finals, separates root/child/account and retains unknown values', t => {
    const f = fixture(t);
    for (const [revision, total] of [[1, 2], [2, 10], [3, 15], [3, 15]]) f.commit('usage.snapshot', { usage: usage(revision, total) });
    f.commit('usage.snapshot', { usage: { ...usage(1, 5, 'child-attempt', 'child-request'), scope: { kind: 'session', sessionId: 'offline', runId: 'child' } } }, true);
    f.commit('usage.snapshot', { usage: usage(1, null, 'unknown', 'unknown-request') });
    f.commit('usage.snapshot', { usage: { ...usage(1, 7), accountNamespace: 'other-account' } });
    f.commit('delegation.delivery', { deliveryId: 'delivery', childRunId: 'child', resultEventId: 'child-final', stage: 'consumed', attemptId: 'attempt' });
    f.flush(); const stats = statsTranscript(f.directory);
    assert.equal(stats.attempts, 4); assert.equal(stats.unknownAttempts, 1);
    assert.equal(stats.knownSubtotals.totalTokens, 27);
    assert.equal(stats.records.find(record => record.attemptId === 'unknown')!.counters.totalTokens, null);
    assert.equal(stats.byDay[0].knownSubtotals.totalTokens, 27);
    assert.match(usageCsv(stats), /2026-10-01,4,1,27,0,0,0,27/);
});

test('unknown highest revision remains unknown and same-revision conflicting values are rejected', t => {
    const f = fixture(t);
    f.commit('usage.snapshot', { usage: usage(1, 2) }); f.commit('usage.snapshot', { usage: usage(2, null) }); f.flush();
    assert.equal(statsTranscript(f.directory).unknownAttempts, 1);
    assert.equal(statsTranscript(f.directory).knownSubtotals.totalTokens, 0);
    f.commit('usage.snapshot', { usage: usage(2, 9) }); f.flush();
    assert.throws(() => statsTranscript(f.directory), /Conflicting usage revision/);
});

test('unknown v1 type and missing/external references are retained as partial; future schema is rejected', t => {
    const f = fixture(t);
    const missing: ArtifactReference = { availability: 'missing', relativePath: 'artifacts/lost.json', sha256: null, byteLength: null, mediaType: 'application/json', missingReason: 'not captured' };
    const external: ArtifactReference = { availability: 'external_reference_only', relativePath: null, sha256: null, byteLength: null, mediaType: 'application/pdf', externalReference: 'provider_file_id', missingReason: 'offline unavailable' };
    f.commit('future.opaque', { refs: [missing, external], command: 'never execute this' }); f.flush();
    const report = validateTranscript(f.directory);
    assert.equal(report.partial, true); assert.ok(report.warnings.includes('unknown_event:future.opaque'));
    assert.equal(report.artifactCount, 2);
    assert.equal(replayTranscript(f.directory).runs.length, 1);
    const exported = exportTranscript(f.directory, join(f.root, 'full'));
    assert.equal(exported.partial, true);
    assert.match(readFileSync(join(f.root, 'full', 'transcript.jsonl'), 'utf8'), /future.opaque/);
    f.editManifest(manifest => { manifest.schemaVersion = 2; });
    assert.throws(() => validateTranscript(f.directory), /Unsupported manifest/);
});

test('full export fixes targetSeq and validates all referenced files; source remains byte-identical', t => {
    const f = fixture(t);
    const ref = f.artifacts.save({ text: 'source original' }).ref;
    f.commit('message.accepted', { messageId: 'm', revision: 1, role: 'user', content: ref }); f.flush();
    const manifestBefore = readFileSync(f.manifestPath); const logBefore = readFileSync(f.transcriptPath);
    appendFileSync(f.transcriptPath, Buffer.from([0xff, 0x00]));
    const destination = join(f.root, 'export');
    const result = exportTranscript(f.directory, destination, 'full');
    assert.equal(result.targetSeq, 1);
    assert.deepEqual(readFileSync(join(destination, ref.relativePath!)), readFileSync(join(f.directory, ref.relativePath!)));
    assert.deepEqual(readFileSync(join(destination, 'transcript.jsonl')), logBefore);
    assert.deepEqual(readFileSync(f.manifestPath), manifestBefore);
    assert.deepEqual(readFileSync(f.transcriptPath), Buffer.concat([logBefore, Buffer.from([0xff, 0x00])]));
    assert.throws(() => exportTranscript(f.directory, destination), /already exists/);
    assert.throws(() => exportTranscript(f.directory, join(f.directory, 'nested')), /overlap/);
});

test('share drops restricted originals, redacts public structures and credential URLs, and rehashes changed artifacts', t => {
    const f = fixture(t);
    // Write a known credential-bearing JSON manually: save() normally redacts it already.
    const bytes = Buffer.from(JSON.stringify({ text: 'hello', apiKey: 'sensitive', url: 'https://user:password@example.test/path?token=secret' }));
    const hash = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(join(f.directory, 'artifacts'), { recursive: true }); writeFileSync(join(f.directory, 'artifacts', hash + '.json'), bytes);
    const publicRef: ArtifactReference = { availability: 'present', relativePath: `artifacts/${hash}.json`, sha256: hash, byteLength: bytes.length, mediaType: 'application/json', missingReason: null };
    const restrictedRef = f.artifacts.save({ signature: 'protected-original', text: 'native secret' }, [], true).ref;
    f.commit('message.accepted', { messageId: 'm', revision: 1, role: 'user', content: publicRef });
    f.commit('response.native', { requestId: 'request', attemptId: 'attempt', content: restrictedRef });
    f.commit('future.secret', { authorization: 'Bearer sensitive', url: 'https://me:pass@example.test/?api_key=secret' }); f.flush();
    const original = readFileSync(f.transcriptPath); const originalManifest = readFileSync(f.manifestPath);
    const destination = join(f.root, 'share'); const result = exportTranscript(f.directory, destination, 'share');
    assert.equal(result.partial, true);
    const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8'));
    assert.equal(manifest.continuationCoverage, 'unavailable');
    const dropped = manifest.artifacts.find((ref: ArtifactReference) => ref.relativePath === restrictedRef.relativePath);
    assert.equal(dropped.availability, 'missing'); assert.equal(dropped.missingReason, 'share_redacted');
    assert.equal(dropped.sha256, restrictedRef.sha256);
    assert.equal(existsSync(join(destination, restrictedRef.relativePath!)), false);
    const present = manifest.artifacts.find((ref: ArtifactReference) => ref.availability === 'present');
    assert.notEqual(present.sha256, publicRef.sha256);
    const redacted = readFileSync(join(destination, present.relativePath), 'utf8');
    assert.doesNotMatch(redacted, /sensitive|user:password|token=secret/);
    assert.doesNotMatch(readFileSync(join(destination, 'transcript.jsonl'), 'utf8'), /Bearer sensitive|me:pass|api_key=secret/);
    assert.deepEqual(readFileSync(f.transcriptPath), original); assert.deepEqual(readFileSync(f.manifestPath), originalManifest);
    assert.deepEqual(readFileSync(join(f.directory, publicRef.relativePath)), bytes);
    assert.match(readFileSync(join(f.directory, restrictedRef.relativePath!), 'utf8'), /protected-original/);
});

test('present missing/hash mismatch, missing manifest cross-reference and malformed JSON explicitly fail without a success package', t => {
    const f = fixture(t); const ref = f.artifacts.save({ text: 'evidence' }).ref;
    f.commit('message.accepted', { messageId: 'm', revision: 1, role: 'user', content: ref }); f.flush();
    const artifactFile = join(f.directory, ref.relativePath!); const bytes = readFileSync(artifactFile);
    writeFileSync(artifactFile, 'bad');
    assert.throws(() => validateTranscript(f.directory), /integrity mismatch/);
    assert.throws(() => exportTranscript(f.directory, join(f.root, 'bad')), /integrity mismatch/);
    assert.equal(existsSync(join(f.root, 'bad')), false);
    unlinkSync(artifactFile); assert.throws(() => validateTranscript(f.directory), /missing or unsafe/);
    writeFileSync(artifactFile, bytes);
    const manifest = readFileSync(f.manifestPath); f.editManifest(m => { m.artifacts = []; });
    assert.throws(() => validateTranscript(f.directory), /missing from manifest/);
    writeFileSync(f.manifestPath, manifest);
    writeFileSync(f.transcriptPath, '{invalid}\n'); assert.throws(() => validateTranscript(f.directory), /Invalid JSON/);
    assert.equal(readdirSync(f.root).some(name => name.startsWith('.uah-transcript-export-')), false);
});

test('export stage failure cleans only staging directory and never changes originals', t => {
    const f = fixture(t);
    const bytes = Buffer.from('invalid JSON'); const hash = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(join(f.directory, 'artifacts')); writeFileSync(join(f.directory, 'artifacts', hash + '.json'), bytes);
    const ref = { availability: 'present', relativePath: `artifacts/${hash}.json`, sha256: hash, byteLength: bytes.length, mediaType: 'application/json', missingReason: null };
    f.commit('future.evidence', { ref }); f.flush();
    const source = readFileSync(f.transcriptPath); const destination = join(f.root, 'failed-share');
    assert.throws(() => exportTranscript(f.directory, destination, 'share'), /Invalid JSON/);
    assert.equal(existsSync(destination), false); assert.deepEqual(readFileSync(f.transcriptPath), source);
    assert.equal(readdirSync(f.root).some(name => name.startsWith('.uah-transcript-export-')), false);
});

test('duplicate IDs, seq gaps, future event schema and public offset gaps fail deterministically', t => {
    const f = fixture(t);
    f.commit('run.state', { state: 'waiting_model', reason: null }); f.commit('run.state', { state: 'completed', reason: null }); f.flush();
    const events = readFileSync(f.transcriptPath, 'utf8').trimEnd().split('\n').map(line => JSON.parse(line));
    const write = () => writeFileSync(f.transcriptPath, events.map(e => JSON.stringify(e) + '\n').join(''));
    events[1].eventId = events[0].eventId; write(); assert.throws(() => validateTranscript(f.directory), /Duplicate/);
    events[1].eventId = 'event-2'; events[1].sessionSeq = 3; write(); assert.throws(() => validateTranscript(f.directory), /Non-contiguous/);
    events[1].sessionSeq = 2; events[1].schemaVersion = 2; write(); assert.throws(() => validateTranscript(f.directory), /Unsupported event/);
    events[1].schemaVersion = 1; events[1].type = 'response.delta'; events[1].payload = { requestId: 'r', attemptId: 'a', blockId: 'b', offset: 1, offsetUnit: 'utf16', text: 'bad' }; write();
    assert.throws(() => replayTranscript(f.directory), /offset gap/);
});

test('bounded parser rejects bytes/events/depth/files limits', t => {
    const f = fixture(t); const ref = f.artifacts.save({ text: 'evidence' }).ref;
    f.commit('message.accepted', { messageId: 'm', revision: 1, role: 'user', content: ref }); f.flush();
    assert.throws(() => validateTranscript(f.directory, { maxManifestBytes: 1 }), /byte limit/);
    assert.throws(() => validateTranscript(f.directory, { maxArtifactBytes: 1 }), /artifact byte limit/);
    assert.throws(() => validateTranscript(f.directory, { maxFiles: 2 }), /file-count/);
    assert.throws(() => validateTranscript(f.directory, { maxJsonDepth: 1 }), /complexity/);
    f.commit('run.state', { state: 'completed', reason: null }); f.flush();
    assert.throws(() => validateTranscript(f.directory, { maxEvents: 1 }), /watermark/);
});

for (const unsafe of ['../outside', '/absolute', 'C:/drive', 'nested\\escape', 'file:stream', 'nested/../escape', 'CON/file']) {
    test(`offline rejects unsafe referenced path ${JSON.stringify(unsafe)}`, t => {
        const f = fixture(t); f.commit('run.state', { state: 'completed', reason: null }); f.flush();
        f.editManifest(m => { m.artifacts.push({ availability: 'missing', relativePath: unsafe, sha256: null, byteLength: null, mediaType: 'text/plain', missingReason: 'unsafe' }); });
        assert.throws(() => validateTranscript(f.directory), /Unsafe artifact path/);
    });
}

test('offline rejects hardlinked originals and symlink/junction directories', t => {
    const f = fixture(t); const ref = f.artifacts.save({ text: 'content' }).ref;
    f.commit('message.accepted', { messageId: 'm', revision: 1, role: 'user', content: ref }); f.flush();
    linkSync(join(f.directory, ref.relativePath!), join(f.root, 'hardlink'));
    assert.throws(() => validateTranscript(f.directory), /missing or unsafe/);
    unlinkSync(join(f.root, 'hardlink'));
    const linked = join(f.root, 'linked'); symlinkSync(f.directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
    assert.throws(() => validateTranscript(linked), /symbolic link/);
});

test('CLI exposes validate/stats/trace/replay/export and invalid inputs return nonzero', t => {
    const f = fixture(t); f.commit('run.state', { state: 'completed', reason: null }); f.flush();
    for (const [command, extra] of [['validate', undefined], ['stats', 'csv'], ['trace', 'request'], ['replay', undefined], ['export', join(f.root, 'cli-export')]]) {
        const args = ['--import', 'tsx', resolve('scripts/transcript.ts'), command!, f.directory]; if (extra) args.push(extra);
        const result = spawnSync(process.execPath, args, { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr); assert.ok(result.stdout);
    }
    const result = spawnSync(process.execPath, ['--import', 'tsx', resolve('scripts/transcript.ts'), 'validate', join(f.root, 'missing')], { encoding: 'utf8' });
    assert.equal(result.status, 1);
});


test('share transforms child dependencies before parents regardless of manifest order and preserves source', t => {
    const f = fixture(t);
    const bytes = Buffer.from(JSON.stringify({ apiKey: 'nested-sensitive', text: 'child' }));
    const hash = createHash('sha256').update(bytes).digest('hex');
    mkdirSync(join(f.directory, 'artifacts'), { recursive: true }); writeFileSync(join(f.directory, 'artifacts', hash + '.json'), bytes);
    const child: ArtifactReference = { availability: 'present', relativePath: `artifacts/${hash}.json`, sha256: hash, byteLength: bytes.length, mediaType: 'application/json', missingReason: null };
    const parent = f.artifacts.save({ child }).ref;
    // Public JSON references must be declared in the manifest, even when only
    // their parent is a primary event reference.
    f.commit('artifact.created', { parent, child }); f.flush();
    const originalManifest = readFileSync(f.manifestPath); const originalLog = readFileSync(f.transcriptPath);
    const originalParent = readFileSync(join(f.directory, parent.relativePath!));
    for (const parentFirst of [true, false]) {
        f.editManifest(manifest => { manifest.artifacts = parentFirst ? [parent, child] : [child, parent]; });
        const manifestBefore = readFileSync(f.manifestPath);
        const destination = join(f.root, parentFirst ? 'parent-first' : 'child-first');
        assert.equal(exportTranscript(f.directory, destination, 'share').presentArtifacts, 2);
        const event = JSON.parse(readFileSync(join(destination, 'transcript.jsonl'), 'utf8').trim());
        const updatedParent = event.payload.parent as ArtifactReference;
        const updatedChild = event.payload.child as ArtifactReference;
        const parentValue = JSON.parse(readFileSync(join(destination, updatedParent.relativePath!), 'utf8'));
        assert.deepEqual(parentValue.child, updatedChild);
        assert.notEqual(updatedChild.sha256, child.sha256); assert.notEqual(updatedParent.sha256, parent.sha256);
        assert.equal(JSON.parse(readFileSync(join(destination, parentValue.child.relativePath), 'utf8')).apiKey, '[REDACTED]');
        assert.equal(validateTranscript(destination).artifactCount, 2);
        assert.deepEqual(readFileSync(f.manifestPath), manifestBefore); assert.deepEqual(readFileSync(f.transcriptPath), originalLog);
        assert.deepEqual(readFileSync(join(f.directory, parent.relativePath!)), originalParent); assert.deepEqual(readFileSync(join(f.directory, child.relativePath!)), bytes);
    }
    writeFileSync(f.manifestPath, originalManifest);
});

test('offline rejects undeclared nested references instead of exporting an incomplete closure', t => {
    const f = fixture(t); const child = f.artifacts.save({ text: 'child' }).ref; const parent = f.artifacts.save({ child }).ref;
    f.commit('artifact.created', { parent }); f.flush();
    assert.throws(() => validateTranscript(f.directory), /Nested artifact reference missing from manifest/);
    const destination = join(f.root, 'incomplete');
    assert.throws(() => exportTranscript(f.directory, destination, 'full'), /Nested artifact reference missing from manifest/);
    assert.equal(existsSync(destination), false);
});

test('nested graph depth is bounded even when descendants appear before their parents', t => {
    const f = fixture(t); const refs: ArtifactReference[] = [f.artifacts.save({ text: 'leaf' }).ref];
    for (let index = 0; index < 8; index++) refs.push(f.artifacts.save({ child: refs.at(-1)! }).ref);
    f.commit('artifact.created', { refs }); f.flush();
    f.editManifest(manifest => { manifest.artifacts = refs; });
    assert.throws(() => validateTranscript(f.directory, { maxJsonDepth: 6 }), /reference depth limit/);
    assert.equal(validateTranscript(f.directory).artifactCount, 9);
});

test('tampered cyclic reference bundles fail integrity validation before graph traversal and leave no export', t => {
    const f = fixture(t);
    // A SHA-256-authenticated present cycle would require mutually recursive hash
    // fixed points. An attacker-created cycle with claimed hashes is rejected at
    // the earlier integrity boundary, rather than recursively following it.
    const a: ArtifactReference = { availability: 'present', relativePath: 'artifacts/a.json', sha256: 'a'.repeat(64), byteLength: 0, mediaType: 'application/json', missingReason: null };
    const b: ArtifactReference = { ...a, relativePath: 'artifacts/b.json', sha256: 'b'.repeat(64) };
    let first = Buffer.from(JSON.stringify({ child: b })); let second = Buffer.from(JSON.stringify({ child: a }));
    a.byteLength = first.length; b.byteLength = second.length;
    first = Buffer.from(JSON.stringify({ child: b })); second = Buffer.from(JSON.stringify({ child: a }));
    a.byteLength = first.length; b.byteLength = second.length;
    mkdirSync(join(f.directory, 'artifacts'), { recursive: true }); writeFileSync(join(f.directory, a.relativePath!), first); writeFileSync(join(f.directory, b.relativePath!), second);
    f.commit('artifact.created', { refs: [a, b] }); f.flush();
    const destination = join(f.root, 'cyclic');
    assert.throws(() => exportTranscript(f.directory, destination, 'share'), /Artifact integrity mismatch/);
    assert.equal(existsSync(destination), false);
});
