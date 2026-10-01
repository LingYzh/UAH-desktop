import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { RuntimeStore } from '../../src/runtime/store';
import { RunJournal } from '../../src/runtime/run-journal';
import { RequestJournal } from '../../src/runtime/request-journal';
import { ApplicationJournal } from '../../src/runtime/application-journal';
import { Supervisor } from '../../src/runtime/supervisor';
import { defaultAgentSettings } from '../../src/shared/agents';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { streamAgentApi } from '../../src/runtime/api-transport';
import type { RunRecord } from '../../src/shared/contracts';
import type { ApiConnection, ApiProtocol } from '../../src/shared/endpoints';
import type { RequestIdentity, ArtifactReference } from '../../src/shared/harness-contracts';

const REQUEST_MARKER = 'ONLY_EXTRA_RAW_REQUEST_FIELD';
const RESPONSE_MARKER = 'ONLY_EXTRA_PROVIDER_EXTENSION_FIELD';
const CHAT_TEXT = 'NECESSARY_CHAT_HISTORY';
const rawUsage = { input_tokens: 10, output_tokens: 3, total_tokens: 13 };
const body = () => ({ model: 'model', messages: [{ role: 'user', content: 'Required task goal' }], extra_debug: REQUEST_MARKER });
const continuation = () => [{ role: 'user', content: 'Required task goal' }, { role: 'assistant', content: CHAT_TEXT }];
function checkDisk(directory: string, absent: string[]) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const filename = path.join(directory, entry.name);
        if (entry.isDirectory()) checkDisk(filename, absent);
        else for (const marker of absent) assert.equal(readFileSync(filename).includes(Buffer.from(marker)), false, `${marker} present in ${entry.name}`);
    }
}
function cleanup(directory: string) {
    const absolute = path.resolve(directory); assert.equal(path.dirname(absolute), path.resolve(tmpdir()));
    assert.ok(path.basename(absolute).startsWith('uah-raw-capture-')); rmSync(absolute, { recursive: true, force: true });
}
function fixture(t: { after(fn: () => void): void }, protocol: ApiProtocol = 'openai-chat', canonical = false) {
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-raw-capture-')); let store = new RuntimeStore(directory);
    const run: RunRecord = { id: randomUUID(), sessionId: randomUUID(), turnId: randomUUID(), state: 'running', input: 'Required task goal', output: '', sequence: 0,
        createdAt: new Date().toISOString(), effective: { runtimeId: 'api', modelId: 'model', agentId: 'default', policyVersion: 1 } };
    store.commit({ sessions: [{ id: run.sessionId, title: 'Raw capture fixture', directory: null, requested: run.effective, createdAt: run.createdAt }], ...(canonical ? {} : { runs: [run] }) });
    let journal = new RunJournal(store, directory, id => id === run.id ? run : undefined, () => {});
    if (canonical) {
        const content = journal.saveContent(run.sessionId, { text: run.input }).ref;
        journal.commit({ runs: [run] }, [
            { run: journal.identity(run), type: 'message.accepted', timestamp: run.createdAt, payload: { messageId: run.turnId, revision: 1, role: 'user', content } },
            { run: journal.identity(run), type: 'run.state', timestamp: run.createdAt, payload: { state: 'waiting_model', reason: null } },
        ]);
        assert.deepEqual([...store.readLegacyJournalSessionIds()], [], 'real canonical message boundary covers the persisted run');
    }
    const connection: ApiConnection = { id: 'fixture', name: 'Fixture', protocol, baseUrl: 'https://unused.invalid/v1', apiKey: 'raw-capture-private-key', models: ['model'], enabled: true, revision: 1 };
    const requestId = randomUUID();
    const create = (options: { captureRaw?: boolean } = {}) => {
        const identity: RequestIdentity = { ...journal.identity(run), requestId, stepId: randomUUID(), attemptId: randomUUID() };
        return { request: new RequestJournal(journal, run, identity, connection, options), identity };
    };
    const events = () => { journal.flush(); return store.readJournal(run.sessionId, 0, 10000); };
    const read = (ref: ArtifactReference) => JSON.parse(journal.artifactStore(run.sessionId).read(ref).toString('utf8'));
    t.after(() => { journal.close(); store.close(); cleanup(directory); });
    const restartProjection = () => {
        journal.close(); store.close(); store = new RuntimeStore(directory);
        assert.deepEqual([...store.readLegacyJournalSessionIds()], [], 'restart must derive nonlegacy coverage from canonical facts');
        journal = new RunJournal(store, directory, id => id === run.id ? run : undefined, () => {});
    };
    return { directory, get store() { return store; }, get journal() { return journal; }, run, connection, create, events, read, restartProjection };
}
function finish(f: ReturnType<typeof fixture>, request: RequestJournal) {
    request.observer.prepared(body(), f.connection.protocol); request.observer.dispatch(); request.observer.responseStarted();
    const payload = f.connection.protocol === 'openai-responses' ? { response: { usage: rawUsage }, extra_debug: RESPONSE_MARKER }
        : f.connection.protocol === 'anthropic' ? { message: { usage: rawUsage }, extra_debug: RESPONSE_MARKER } : { usage: rawUsage, extra_debug: RESPONSE_MARKER };
    request.observer.providerEvent({ data: JSON.stringify(payload) });
    request.usage({ inputTokens: 10, outputTokens: 3, totalTokens: 13 }); request.text(f.run, CHAT_TEXT, 0);
    request.observer.terminal('completed'); return request.completed(continuation());
}

test('default capture retains complete request and raw frames with native continuation', t => {
    const f = fixture(t); const { request } = f.create(); finish(f, request); const events = f.events();
    const intent = events.find(event => event.type === 'request.intent'); assert.ok(intent?.type === 'request.intent');
    const saved = f.read(intent.payload.snapshot); assert.equal(saved.coverage, 'complete'); assert.deepEqual(saved.body, body()); assert.equal(saved.bodyCapture, undefined);
    const raw = events.find(event => event.type === 'provider.frame'); assert.ok(raw?.type === 'provider.frame'); assert.ok(JSON.stringify(f.read(raw.payload.frame)).includes(RESPONSE_MARKER));
    const native = events.find(event => event.type === 'response.native'); assert.ok(native?.type === 'response.native');
    assert.equal(f.read(native.payload.content).captureCoverage, 'complete'); assert.equal(f.read(native.payload.content).continuationCoverage, 'native');
    const terminal = events.find(event => event.type === 'response.terminal'); assert.ok(terminal?.type === 'response.terminal'); assert.equal(terminal.payload.partial, false);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
    test(`${protocol} disabled raw capture preserves usage, chat and native history with explicit partial coverage`, t => {
        const f = fixture(t, protocol); const { request } = f.create({ captureRaw: false }); const result = finish(f, request); const events = f.events();
        const intent = events.find(event => event.type === 'request.intent'); assert.ok(intent?.type === 'request.intent'); const saved = f.read(intent.payload.snapshot);
        assert.equal(saved.body, null); assert.equal(saved.bodyCapture, 'disabled'); assert.equal(saved.coverage, 'partial');
        assert.ok(saved.identity.requestId); assert.equal(saved.protocol, protocol); assert.ok(saved.adapterVersion); assert.ok(saved.redactionPolicyVersion);
        assert.equal(events.some(event => event.type === 'provider.frame'), false);
        const usage = events.findLast(event => event.type === 'usage.snapshot'); assert.ok(usage?.type === 'usage.snapshot');
        assert.deepEqual(usage.payload.usage.rawUsage, rawUsage); assert.equal(usage.payload.usage.source, 'provider'); assert.equal(usage.payload.usage.counters.totalTokens, 13);
        assert.equal(events.filter(event => event.type === 'response.delta').map(event => event.payload.text).join(''), CHAT_TEXT);
        const native = events.find(event => event.type === 'response.native'); assert.ok(native?.type === 'response.native'); const history = f.read(native.payload.content);
        assert.deepEqual(history.continuation, continuation()); assert.equal(history.captureCoverage, 'partial'); assert.equal(history.continuationCoverage, 'native'); assert.equal(history.rawCapture, 'disabled');
        assert.equal(result.continuationCoverage, 'native');
        const terminal = events.find(event => event.type === 'response.terminal'); assert.ok(terminal?.type === 'response.terminal'); assert.equal(terminal.payload.status, 'completed'); assert.equal(terminal.payload.partial, true);
        assert.ok(events.some(event => event.type === 'request.dispatch')); assert.equal((request as unknown as { frames: unknown }).frames, null);
        checkDisk(f.directory, [REQUEST_MARKER, RESPONSE_MARKER]);
    });
}

test('capture policy is fixed on construction and changing it affects only new attempts', t => {
    const f = fixture(t); const options = { captureRaw: false }; const first = f.create(options); options.captureRaw = true; finish(f, first.request);
    const historical = structuredClone(f.events()); const second = f.create(options); options.captureRaw = false; finish(f, second.request);
    const events = f.events(); assert.deepEqual(events.slice(0, historical.length), historical, 'existing journal facts are not rewritten');
    const intents = events.filter(event => event.type === 'request.intent'); assert.equal(intents.length, 2);
    assert.equal(f.read(intents[0].payload.snapshot).body, null); assert.deepEqual(f.read(intents[1].payload.snapshot).body, body());
    const frames = events.filter(event => event.type === 'provider.frame'); assert.equal(frames.length, 1); assert.equal(frames[0].payload.attemptId, second.identity.attemptId);
});

test('off retains frame byte limit and redaction rules for necessary continuation', t => {
    const f = fixture(t); const { request } = f.create({ captureRaw: false }); request.observer.prepared(body(), f.connection.protocol); request.observer.dispatch();
    request.observer.providerEvent({ data: 'X'.repeat(8_000_000) }); request.observer.providerEvent({ data: 'Y'.repeat(8_000_000) });
    assert.throws(() => request.observer.providerEvent({ data: 'Z' }), /limit/);
    assert.equal((request as unknown as { frames: unknown }).frames, null);
    request.observer.terminal('completed'); const native = request.completed([{ role: 'assistant', content: f.connection.apiKey }]);
    const saved = f.read(native.ref); assert.equal(saved.rawCapture, 'disabled'); assert.equal(saved.captureCoverage, 'partial'); assert.equal(saved.continuationCoverage, 'unavailable');
    assert.equal(JSON.stringify(saved).includes(f.connection.apiKey), false);
});

async function serverFixture(t: { after(fn: () => Promise<void>): void }, respond: (response: ServerResponse) => void) {
    const requests: Record<string, unknown>[] = []; const errors: unknown[] = [];
    const server = createServer(async (incoming, response) => { try {
        const chunks: Buffer[] = []; for await (const chunk of incoming) chunks.push(Buffer.from(chunk)); requests.push(JSON.parse(Buffer.concat(chunks).toString())); respond(response);
    } catch (error) { errors.push(error); response.destroy(); } });
    await new Promise<void>(ready => server.listen(0, '127.0.0.1', ready)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.deepEqual(errors, []); });
    return { requests, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}
const answer = (response: ServerResponse) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: CHAT_TEXT }, finish_reason: 'stop' }], extra_debug: RESPONSE_MARKER,
        usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } })}\n\ndata: [DONE]\n\n`);
};

test('disabled raw capture still requires a durable request intent before any HTTP send', async t => {
    const server = await serverFixture(t, answer); const f = fixture(t); f.connection.baseUrl = server.baseUrl;
    const { request, identity } = f.create({ captureRaw: false });
    const original = JournalArtifacts.prototype.save;
    const mocked = t.mock.method(JournalArtifacts.prototype, 'save', function(this: JournalArtifacts, ...args: Parameters<JournalArtifacts['save']>) {
        const value = args[0];
        if (value && typeof value === 'object' && 'bodyCapture' in value) throw new Error('fixture disabled-intent recording failure');
        return original.apply(this, args);
    });
    await assert.rejects(async () => { for await (const _event of streamAgentApi(f.connection, 'model', [{ role: 'user', content: 'Required task goal' }], undefined,
        { requestIdentity: identity, tools: [], observer: request.observer })) { /* No provider response may be reached. */ } });
    mocked.mock.restore(); assert.equal(server.requests.length, 0); assert.equal(f.events().some(event => event.type === 'request.dispatch'), false);
});

test('application raw capture is sampled for each new probe while execution and usage remain unchanged', async t => {
    let capture = false; const server = await serverFixture(t, response => { capture = true; answer(response); });
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-raw-capture-')); const app = new ApplicationJournal(directory, () => capture);
    t.after(async () => { app.close(); cleanup(directory); });
    const connection: ApiConnection = { id: 'app', name: 'Application', protocol: 'openai-chat', baseUrl: server.baseUrl, apiKey: 'local-app-private-key', models: ['model'], enabled: true, revision: 1 };
    const readEvents = () => { const store = new RuntimeStore(path.join(directory, 'application-journal')); try { return store.readJournal('application', 0, 10000); } finally { store.close(); } };
    const readArtifact = (ref: ArtifactReference) => { assert.ok(ref.availability === 'present'); const folders = readdirSync(path.join(directory, 'application-journal', 'sessions'));
        return JSON.parse(readFileSync(path.join(directory, 'application-journal', 'sessions', folders[0], ref.relativePath), 'utf8')); };
    assert.equal((await app.testConnection(connection, 'model')).text, CHAT_TEXT); assert.equal(server.requests.length, 1);
    const offEvents = readEvents(); const intent = offEvents.find(event => event.type === 'request.intent'); assert.ok(intent?.type === 'request.intent'); assert.equal(readArtifact(intent.payload.snapshot).body, null);
    assert.equal(offEvents.some(event => event.type === 'provider.frame'), false); checkDisk(directory, [RESPONSE_MARKER]);
    const native = offEvents.find(event => event.type === 'response.native'); assert.ok(native?.type === 'response.native'); const history = readArtifact(native.payload.content);
    assert.equal(history.rawCapture, 'disabled'); assert.equal(history.captureCoverage, 'partial'); assert.equal(history.continuationCoverage, 'native');
    assert.ok(offEvents.some(event => event.type === 'usage.snapshot' && event.payload.usage.counters.totalTokens === 13));
    assert.equal((await app.testConnection(connection, 'model')).text, CHAT_TEXT); assert.equal(server.requests.length, 2);
    const all = readEvents(); assert.deepEqual(all.slice(0, offEvents.length), offEvents);
    const intents = all.filter(event => event.type === 'request.intent'); assert.equal(readArtifact(intents[1].payload.snapshot).coverage, 'complete');
    assert.equal(all.filter(event => event.type === 'provider.frame').length, 1);
    assert.deepEqual(server.requests[0], server.requests[1], 'capture policy does not change outbound probe payload');
});

test('application probes with raw capture disabled still latch recording failure before HTTP', async t => {
    const server = await serverFixture(t, answer); const directory = mkdtempSync(path.join(tmpdir(), 'uah-raw-capture-'));
    const app = new ApplicationJournal(directory, () => false); t.after(async () => { app.close(); cleanup(directory); });
    const connection: ApiConnection = { id: 'app', name: 'Application', protocol: 'openai-chat', baseUrl: server.baseUrl, apiKey: 'local-app-private-key', models: ['model'], enabled: true, revision: 1 };
    const original = JournalArtifacts.prototype.save;
    const mocked = t.mock.method(JournalArtifacts.prototype, 'save', function(this: JournalArtifacts, ...args: Parameters<JournalArtifacts['save']>) {
        const value = args[0];
        if (value && typeof value === 'object' && 'bodyCapture' in value) throw new Error('fixture off probe intent failure');
        return original.apply(this, args);
    });
    await assert.rejects(app.testConnection(connection, 'model'), /record|failure|记录/); mocked.mock.restore();
    await assert.rejects(app.testConnection(connection, 'model'), /recording is unavailable/); assert.equal(server.requests.length, 0);
    const store = new RuntimeStore(path.join(directory, 'application-journal'));
    try { assert.ok(store.readJournal('application', 0, 10000).some(event => event.type === 'run.state' && event.payload.state === 'recording_failed')); }
    finally { store.close(); }
});

function manifest(f: ReturnType<typeof fixture>): Record<string, unknown> {
    const directory = f.journal.project(f.run.sessionId);
    return JSON.parse(readFileSync(path.join(directory, 'manifest.json'), 'utf8'));
}
function settleCanonical(f: ReturnType<typeof fixture>) {
    f.run.state = 'completed'; f.run.harnessState = 'completed'; f.run.sequence++;
    f.journal.event(f.run, 'run.state', { state: 'completed', reason: null }, { runs: [f.run] });
}

test('canonical off manifests distinguish partial raw capture from native continuation across projection and restart', t => {
    const f = fixture(t, 'openai-chat', true); const { request } = f.create({ captureRaw: false }); finish(f, request); settleCanonical(f);
    for (let index = 0; index < 2; index++) {
        const projected = manifest(f); assert.equal(projected.captureCoverage, 'partial'); assert.equal(projected.continuationCoverage, 'native');
        assert.equal(projected.recovery, 'stopped');
    }
    f.restartProjection(); const restarted = manifest(f);
    assert.equal(restarted.captureCoverage, 'partial'); assert.equal(restarted.continuationCoverage, 'native');
    assert.equal(f.events().some(event => event.type === 'provider.frame'), false); checkDisk(f.directory, [REQUEST_MARKER, RESPONSE_MARKER]);
});

for (const kind of ['request', 'native', 'provider'] as const) {
    test(`ordinary redacted ${kind} capture remains partial and unavailable after canonical reprojection`, t => {
        const f = fixture(t, 'openai-chat', true); const { request } = f.create();
        const actualBody = body(); if (kind === 'request') actualBody.extra_debug = f.connection.apiKey;
        request.observer.prepared(actualBody, f.connection.protocol); request.observer.dispatch(); request.observer.responseStarted();
        request.observer.providerEvent({ data: JSON.stringify({ extra_debug: kind === 'provider' ? f.connection.apiKey : RESPONSE_MARKER }) });
        request.observer.terminal('completed'); request.completed(kind === 'native' ? [{ role: 'user', content: f.connection.apiKey }] : continuation());
        settleCanonical(f); const initial = manifest(f);
        assert.equal(initial.captureCoverage, 'partial'); assert.equal(initial.continuationCoverage, 'unavailable');
        f.restartProjection(); const restarted = manifest(f); assert.equal(restarted.captureCoverage, 'partial'); assert.equal(restarted.continuationCoverage, 'unavailable');
    });
}

test('Supervisor off capture retains opaque native Responses history across turns and process restart', async t => {
    const opaque = 'NECESSARY_NATIVE_OPAQUE_BLOCK'; let count = 0;
    const server = await serverFixture(t, response => {
        const index = ++count;
        const output = [
            ...(index === 1 ? [{ type: 'reasoning', id: 'opaque-reasoning', summary: [], encrypted_content: opaque }] : []),
            { type: 'message', id: `answer-${index}`, role: 'assistant', content: [{ type: 'output_text', text: `ANSWER ${index}` }] },
        ];
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', extra_debug: RESPONSE_MARKER,
            response: { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } })}\n\n`);
    });
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-raw-capture-')); const settings = defaultAgentSettings();
    const connection: ApiConnection = { id: 'native-off', name: 'Native capture off', protocol: 'openai-responses', baseUrl: server.baseUrl,
        apiKey: 'local-native-private-key', models: ['model'], enabled: true, revision: 1, modelDetails: [{ id: 'model', tools: false }] };
    const options = { dataDirectory: directory, getCaptureRaw: () => false, delayMs: 0, onEvent: () => {}, getAgentSettings: () => settings,
        resolveAgent: (id: string) => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async () => structuredClone(connection) };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); cleanup(directory); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Native off fixture', directory: null, agentId: 'default',
        selection: { endpointId: connection.id, modelId: 'model' }, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    const start = async (input: string) => {
        const started = await supervisor.execute({ type: 'start-run', sessionId, input }); const runId = started.runs.at(-1)!.id;
        for (let attempt = 0; attempt < 500; attempt++) {
            const snapshot = await supervisor.execute({ type: 'snapshot' }); const run = snapshot.runs.find(item => item.id === runId)!;
            if (['completed', 'failed', 'stopped'].includes(run.state)) { assert.equal(run.state, 'completed', run.error); return run; }
            await delay(10);
        }
        throw new Error('Off native fixture terminal deadline');
    };
    const first = await start('FIRST NATIVE TASK'); assert.equal(first.modelFrame?.continuationCoverage, 'native');
    await start('SECOND NATIVE TASK'); assert.equal(server.requests.length, 2);
    const nativeCount = (request: unknown) => JSON.stringify(request).split(opaque).length - 1;
    assert.equal(nativeCount(server.requests[1]), 1, 'opaque history is sent once through native continuation');
    await supervisor.shutdown(); supervisor = new Supervisor(options); await start('THIRD NATIVE TASK');
    assert.equal(server.requests.length, 3); assert.equal(nativeCount(server.requests[2]), 1, 'restarted history keeps the opaque block');
    const partition = supervisor.journalSessionDirectory(sessionId);
    const manifest = JSON.parse(readFileSync(path.join(partition, 'manifest.json'), 'utf8'));
    assert.equal(manifest.captureCoverage, 'partial'); assert.equal(manifest.continuationCoverage, 'native');
    const store = new RuntimeStore(directory);
    try { assert.deepEqual([...store.readLegacyJournalSessionIds()], []); assert.equal(store.readJournal(sessionId, 0, 10000).some(event => event.type === 'provider.frame'), false); }
    finally { store.close(); }
    checkDisk(directory, [RESPONSE_MARKER]);
});
