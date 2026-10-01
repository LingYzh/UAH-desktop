import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { RuntimeStore } from '../../src/runtime/store';
import { RunJournal } from '../../src/runtime/run-journal';
import { RequestJournal } from '../../src/runtime/request-journal';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import type { RunRecord } from '../../src/shared/contracts';
import type { ApiConnection, ApiProtocol } from '../../src/shared/endpoints';
import type { RequestIdentity, ArtifactReference } from '../../src/shared/harness-contracts';
import { setTimeout as delay } from 'node:timers/promises';

function fixture(t: { after(fn: () => void): void }, protocol: ApiProtocol = 'openai-chat', apiKey = 'fixture-key-credential') {
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-request-journal-'));
    const store = new RuntimeStore(directory);
    const run: RunRecord = { id: randomUUID(), sessionId: randomUUID(), turnId: randomUUID(), state: 'running', input: 'task', output: '', sequence: 0,
        createdAt: new Date().toISOString(), effective: { runtimeId: 'api', modelId: 'model', agentId: 'default', policyVersion: 1 } };
    store.commit({ sessions: [{ id: run.sessionId, title: 'Fixture', directory: null, requested: run.effective, createdAt: run.createdAt }], runs: [run] });
    const journal = new RunJournal(store, directory, id => id === run.id ? run : undefined, () => {});
    const identity: RequestIdentity = { ...journal.identity(run), stepId: randomUUID(), requestId: randomUUID(), attemptId: randomUUID() };
    const connection: ApiConnection = { id: randomUUID(), name: 'Fixture', protocol, baseUrl: 'https://private-host.invalid/v1', apiKey,
        enabled: true, models: ['model'], revision: 1 };
    const request = new RequestJournal(journal, run, identity, connection);
    t.after(() => {
        journal.close(); store.close();
        const absolute = path.resolve(directory); assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
        assert.ok(path.basename(absolute).startsWith('uah-request-journal-'));
        rmSync(absolute, { recursive: true, force: true });
    });
    const events = () => store.readJournal(run.sessionId);
    const read = (ref: ArtifactReference) => JSON.parse(journal.artifactStore(run.sessionId).read(ref).toString('utf8'));
    const start = () => { request.observer.prepared({ model: 'model', messages: [{ role: 'user', content: 'task' }] }, protocol); request.observer.dispatch(); request.observer.responseStarted(); };
    return { directory, store, journal, request, identity, connection, run, events, read, start };
}

test('durable request intent precedes dispatch and restricted snapshot carries final identity/body', t => {
    const f = fixture(t);
    assert.equal(f.events()[0].type, 'usage.snapshot');
    assert.throws(() => f.request.observer.dispatch(), /boundary/);
    f.start();
    assert.deepEqual(f.events().map(event => event.type), ['usage.snapshot', 'request.intent', 'request.dispatch', 'response.started']);
    const intent = f.events().find(event => event.type === 'request.intent'); assert.ok(intent && intent.type === 'request.intent');
    assert.equal(intent.payload.snapshot.availability, 'present');
    assert.ok(intent.payload.snapshot.relativePath?.startsWith('restricted/'));
    const snapshot = f.read(intent.payload.snapshot);
    assert.deepEqual(snapshot.identity, f.identity); assert.equal(snapshot.adapterVersion, 'uah-api-v1');
    assert.equal(snapshot.coverage, 'complete'); assert.deepEqual(snapshot.body, { model: 'model', messages: [{ role: 'user', content: 'task' }] });
    assert.equal(JSON.stringify(snapshot).includes(f.connection.apiKey), false);
    f.request.observer.terminal('completed');
    f.request.completed([{ type: 'reasoning', encrypted_content: 'opaque-native' }]);
    const native = f.events().find(event => event.type === 'response.native'); assert.ok(native && native.type === 'response.native');
    assert.equal(f.read(native.payload.content).continuationCoverage, 'native');
    assert.equal(JSON.stringify(f.events()).includes('opaque-native'), false);
    assert.throws(() => f.request.completed([]), /boundary/);
});

test('partial failure saves observed application frames with explicit crash-tail risk', t => {
    const f = fixture(t); f.start();
    const data = JSON.stringify({ choices: [{ index: 0, delta: { content: 'partial' } }] });
    f.request.observer.providerEvent({ event: 'message', data });
    assert.equal(f.events().some(event => event.type === 'provider.frame'), false);
    f.request.observer.terminal('failed');
    const event = f.events().find(event => event.type === 'provider.frame'); assert.ok(event && event.type === 'provider.frame');
    const batch = f.read(event.payload.frame);
    assert.deepEqual(batch.frames, [{ event: 'message', data }]); assert.equal(batch.crashTailRisk, true); assert.equal(batch.captureCoverage, 'partial');
    const terminal = f.events().at(-1); assert.ok(terminal && terminal.type === 'response.terminal');
    assert.equal(terminal.payload.partial, true); assert.equal(terminal.payload.status, 'failed');
    assert.throws(() => f.request.completed([]), /boundary/);
});

for (const [protocol, field] of [['openai-chat', 'content'], ['openai-chat', 'reasoning_content'], ['anthropic', 'thinking'], ['anthropic', 'partial_json'], ['openai-responses', 'arguments']] as const) {
    test(`${protocol} removes credentials split across ${field} frames before disk persistence`, t => {
        const key = 'unique-secret-credential-material'; const f = fixture(t, protocol, key); f.start();
        const parts = [key.slice(0, 12), key.slice(12)];
        for (const part of parts) {
            const payload = protocol === 'openai-chat' ? { choices: [{ index: 0, delta: { [field]: part } }] }
                : { type: 'fixture', index: 0, delta: { [field]: part } };
            f.request.observer.providerEvent({ data: JSON.stringify(payload) });
        }
        f.request.observer.terminal('completed');
        const frame = f.events().find(event => event.type === 'provider.frame'); assert.ok(frame && frame.type === 'provider.frame');
        const batch = f.read(frame.payload.frame); assert.equal(batch.redacted, true); assert.equal(batch.continuationCoverage, 'unavailable');
        assert.equal(batch.captureCoverage, 'partial'); assert.equal(batch.crashTailRisk, false);
        const terminal = f.events().at(-1); assert.ok(terminal && terminal.type === 'response.terminal'); assert.equal(terminal.payload.partial, true);
        const visit = (directory: string): void => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
                const full = path.join(directory, entry.name);
                if (entry.isDirectory()) visit(full);
                else {
                    const bytes = readFileSync(full); assert.equal(bytes.includes(Buffer.from(key)), false);
                    for (const part of parts) assert.equal(bytes.includes(Buffer.from(part)), false);
                }
            }
        };
        visit(f.directory);
    });
}

test('Responses text delta split credentials and sensitive JSON keys are removed without dropping frames', t => {
    const f = fixture(t, 'openai-responses', 'split-private-key'); f.start();
    for (const delta of ['split-', 'private-key']) f.request.observer.providerEvent({ event: 'response.output_text.delta', data: JSON.stringify({ type: 'response.output_text.delta', delta }) });
    f.request.observer.providerEvent({ data: JSON.stringify({ authorization: 'Bearer private', api_key: 'other-private' }) });
    f.request.observer.terminal('completed');
    const frame = f.events().find(event => event.type === 'provider.frame'); assert.ok(frame && frame.type === 'provider.frame');
    const batch = f.read(frame.payload.frame); assert.equal(batch.frames.length, 3);
    assert.deepEqual(batch.frames.slice(0, 2).map((item: { data: string }) => JSON.parse(item.data).delta), ['******', '***********']);
    const text = JSON.stringify(batch); assert.equal(text.includes('Bearer private'), false); assert.equal(text.includes('other-private'), false);
    f.request.completed([{ type: 'thinking', signature: 'signature containing split-private-key' }]);
    const native = f.events().find(event => event.type === 'response.native'); assert.ok(native && native.type === 'response.native');
    assert.equal(f.read(native.payload.content).continuationCoverage, 'unavailable');
});

test('normal completed terminal records full application frame coverage without a permanent partial flag', t => {
    const f = fixture(t); f.start();
    f.request.observer.providerEvent({ data: JSON.stringify({ choices: [{ index: 0, delta: { content: 'complete text' } }] }) });
    f.request.observer.providerEvent({ data: '[DONE]' });
    f.request.observer.terminal('completed');
    const frame = f.events().find(event => event.type === 'provider.frame'); assert.ok(frame && frame.type === 'provider.frame');
    const batch = f.read(frame.payload.frame);
    assert.equal(batch.captureCoverage, 'complete'); assert.equal(batch.crashTailRisk, false); assert.equal(batch.redacted, false);
    const terminal = f.events().at(-1); assert.ok(terminal && terminal.type === 'response.terminal');
    assert.equal(terminal.payload.status, 'completed'); assert.equal(terminal.payload.partial, false);
});

test('Responses argument delta chunks redact within their output channel across interleaved text', t => {
    const f = fixture(t, 'openai-responses', 'secret-argument-key'); f.start();
    f.request.observer.providerEvent({ data: JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: 'secret-' }) });
    f.request.observer.providerEvent({ data: JSON.stringify({ type: 'response.output_text.delta', output_index: 0, delta: 'unrelated text' }) });
    f.request.observer.providerEvent({ data: JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: 'argument-key' }) });
    f.request.observer.terminal('completed');
    const frame = f.events().find(event => event.type === 'provider.frame'); assert.ok(frame && frame.type === 'provider.frame');
    const batch = f.read(frame.payload.frame);
    assert.deepEqual(batch.frames.map((item: { data: string }) => JSON.parse(item.data).delta), ['*******', 'unrelated text', '************']);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) test(`${protocol} usage snapshots replace revisions with raw provider evidence and null missing fields`, t => {
    const f = fixture(t, protocol); f.start();
    const raw = { input_tokens: 10, output_tokens: 3 };
    const payload = protocol === 'openai-responses' ? { response: { usage: raw } } : protocol === 'anthropic' ? { message: { usage: raw } } : { usage: raw };
    f.request.observer.providerEvent({ data: JSON.stringify(payload) });
    f.request.usage({ inputTokens: 10, outputTokens: 3 });
    f.request.usage({ inputTokens: 10, outputTokens: 4, totalTokens: 14 });
    const usage = f.events().filter(event => event.type === 'usage.snapshot');
    assert.deepEqual(usage.map(event => event.payload.usage.revision), [1, 2, 3]);
    assert.equal(usage[0].payload.usage.source, 'unavailable'); assert.equal(usage[0].payload.usage.rawUsage, null);
    const latest = usage.at(-1)!.payload.usage; assert.deepEqual(latest.rawUsage, raw); assert.equal(latest.counters.outputTokens, 4);
    assert.equal(latest.counters.cachedInputTokens, null); assert.equal(latest.counters.cacheCreationInputTokens, null);
    assert.equal(latest.accountNamespace, f.connection.id); assert.equal(latest.requestId, f.identity.requestId);
    assert.equal(JSON.stringify(usage).includes(f.connection.baseUrl), false);
    f.request.observer.terminal('completed');
});

test('artifact and canonical acknowledgement failures escape and prevent dispatch', t => {
    const f = fixture(t);
    t.mock.method(JournalArtifacts.prototype, 'save', () => { throw new Error('fixture disk failure'); });
    assert.throws(() => f.request.observer.prepared({ model: 'model' }, f.connection.protocol), /disk failure/);
    assert.throws(() => f.request.observer.dispatch(), /boundary/); t.mock.restoreAll();
    const original = f.store.commit.bind(f.store);
    t.mock.method(f.store, 'commit', (changes: Parameters<RuntimeStore['commit']>[0]) => {
        if (changes.journal?.some(event => event.type === 'request.intent')) throw new Error('fixture acknowledgement failure');
        return original(changes);
    });
    assert.throws(() => f.request.observer.prepared({ model: 'model' }, f.connection.protocol), /acknowledgement/);
    assert.throws(() => f.request.observer.dispatch(), /boundary/);
    assert.equal(f.events().some(event => event.type === 'request.dispatch'), false);
});

test('frame buffer rejects over 16 MB and preserves prior frames for failure terminal', t => {
    const f = fixture(t); f.start(); f.request.observer.providerEvent({ data: '[DONE]' });
    assert.throws(() => f.request.observer.providerEvent({ data: 'x'.repeat(16_000_000) }), /limit exceeded/);
    f.request.observer.terminal('failed');
    const frame = f.events().find(event => event.type === 'provider.frame'); assert.ok(frame && frame.type === 'provider.frame');
    assert.deepEqual(f.read(frame.payload.frame).frames, [{ data: '[DONE]' }]);
});

test('canonical text tail masks split credentials despite timed flush and preserves original continuous offsets', async t => {
    const f = fixture(t, 'openai-chat', 'private-cross-chunk-key'); f.start();
    const chunks = ['prefix ', 'private-cross-', 'chunk-key', ' suffix ending'];
    let offset = 100;
    for (const chunk of chunks) {
        f.request.text(f.run, chunk, offset); offset += chunk.length;
        await delay(70); // Exercise the real journal batching timer between secret fragments.
        const deltas = f.events().filter(event => event.type === 'response.delta');
        assert.equal(deltas.map(event => event.payload.text).join('').includes(f.connection.apiKey), false);
    }
    f.request.observer.terminal('completed');
    const deltas = f.events().filter(event => event.type === 'response.delta');
    assert.equal(deltas.map(event => event.payload.text).join(''), `prefix ${'*'.repeat(f.connection.apiKey.length)} suffix ending`);
    let expected = 0;
    for (const delta of deltas) { assert.equal(delta.payload.offset, expected); expected += delta.payload.text.length; assert.equal(delta.payload.blockId, `${f.identity.attemptId}:text`); }
    assert.equal(expected, offset - 100);
    assert.throws(() => f.request.text(f.run, 'late', offset), /offset/);
});

test('canonical text rejects discontinuous offsets and does not join secrets across requests', t => {
    const f = fixture(t, 'openai-chat', 'split-key'); f.start();
    f.request.text(f.run, 'split-', 0);
    assert.throws(() => f.request.text(f.run, 'key', 7), /offset/);
    f.request.observer.terminal('completed');
    const identity = { ...f.identity, requestId: randomUUID(), attemptId: randomUUID(), stepId: randomUUID() };
    const next = new RequestJournal(f.journal, f.run, identity, f.connection);
    next.observer.prepared({ model: 'model' }, f.connection.protocol); next.observer.dispatch();
    next.text(f.run, 'key', 6); next.observer.terminal('completed');
    const deltas = f.events().filter(event => event.type === 'response.delta');
    assert.equal(deltas[0].payload.text, 'split-'); assert.equal(deltas[1].payload.text, 'key');
    assert.notEqual(deltas[0].payload.blockId, deltas[1].payload.blockId);
});
