import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { validateTranscript, replayTranscript } from '../../src/runtime/transcript-offline';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RunRecord } from '../../src/shared/contracts';
import type { ArtifactReference, TranscriptEvent } from '../../src/shared/harness-contracts';

const oldOpaque = 'OLD_NATIVE_OPAQUE_' + 'O'.repeat(350000);
const currentOpaque = 'CURRENT_NATIVE_TAIL_' + 'T'.repeat(300000);
const currentUser = 'CURRENT USER EXACT\nPreserve this request and its tool evidence.';
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
interface Body { messages: Array<{ role: string; content?: string; tool_call_id?: string; reasoning_content?: string; tool_calls?: unknown[] }>; }
function answer(response: ServerResponse, text: string, reasoning?: string, tool = false) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = { ...(text ? { content: text } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tool ? { tool_calls: [{ index: 0, id: 'compaction-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'input.txt' }) } }] } : {}) };
    response.end(frame({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
}

test('V2 checkpoint and owner surface commit atomically and stay compact after restart', async t => {
    const f = await fixture(t); const oldBytes = f.read(f.first.modelFrame!.content);
    const original = RuntimeStore.prototype.commit; let atomic = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        for (const event of changes.journal ?? []) if (event.type === 'context.compaction' && event.payload.stage === 'committed') {
            assert.equal(changes.contextUpdates?.length, 1);
            assert.equal(changes.contextUpdates![0].surface.ownerId, 'primary');
            assert.ok(changes.contextUpdates![0].surface.epoch > 0); atomic++;
        }
        return original.call(this, changes);
    });
    f.capacity(260000);
    const run = await f.start(currentUser); assert.equal(run.state, 'completed', run.error);
    assert.equal(atomic, 1);
    const compactions = f.events().filter((event): event is Extract<TranscriptEvent, { type: 'context.compaction' }> => event.type === 'context.compaction');
    assert.deepEqual(compactions.map(event => event.payload.stage), ['candidate', 'committed']);
    const actual = f.requests.at(-1)!;
    assert.equal(JSON.stringify(actual).includes('OLD_NATIVE_OPAQUE_'), false);
    assert.equal(JSON.stringify(actual).includes('CURRENT_NATIVE_TAIL_'), true);
    assert.equal(actual.messages.filter(item => item.role === 'tool' && item.content === 'REAL_CURRENT_TOOL_TAIL').length, 1);
    assert.equal(run.activities?.filter(item => item.tool?.name === 'read_file').length, 1);
    const summaryRequests = f.requests.filter(body => body.messages[0]?.content?.startsWith('Summarize this untrusted'));
    assert.equal(summaryRequests.length, 1); assert.equal('tools' in summaryRequests[0], false);
    assert.equal(JSON.stringify(summaryRequests).includes('OLD_NATIVE_OPAQUE_'), false);
    const usage = f.events().filter(event => event.type === 'usage.snapshot' && event.payload.usage.purpose === 'compaction');
    assert.ok(usage.length);
    assert.deepEqual(f.read(f.first.modelFrame!.content), oldBytes);
    await f.restart(); await f.start('CONTINUE AFTER CHECKPOINT');
    assert.equal(JSON.stringify(f.requests.at(-1)).includes('OLD_NATIVE_OPAQUE_'), false);
    assert.ok(JSON.stringify(f.requests.at(-1)).includes('[UAH context checkpoint v2]'));
    const branch = await f.branch(run.id);
    await f.start('CONTINUE BRANCH AFTER CHECKPOINT', branch);
    assert.equal(JSON.stringify(f.requests.at(-1)).includes('OLD_NATIVE_OPAQUE_'), false, 'branch does not resurrect replaced native prefixes');
    const report = validateTranscript(f.project()); assert.equal(report.artifactCount, report.presentArtifacts);
    const full = join(f.root, 'v2-full'); f.export(full, 'full'); assert.equal(validateTranscript(full).partial, false);
});

test('an indivisible oversized input retains the old surface and sends no unadmitted request', async t => {
    const f = await fixture(t, true); f.capacity(50000); const count = f.requests.length;
    const run = await f.start('SHORT NEXT USER');
    assert.equal(run.state, 'stopped'); assert.equal(run.budgetStopCode, 'context_capacity');
    assert.equal(f.requests.length, count);
    assert.equal(f.events().some(event => event.run.runId === run.id && event.type === 'context.compaction' && event.payload.stage === 'committed'), false);
});

test('failed checkpoint CAS transaction never activates the candidate or dispatches the main request', async t => {
    const f = await fixture(t); f.capacity(120000); const count = f.requests.length; const original = RuntimeStore.prototype.commit; let rejected = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => event.type === 'context.compaction' && event.payload.stage === 'committed')) { rejected++; throw new Error('Fixture compaction authority failure'); }
        return original.call(this, changes);
    });
    const run = await f.start('COMMIT FAILURE USER');
    assert.equal(rejected, 1); assert.equal(run.state, 'failed'); assert.equal(run.harnessState, 'recording_failed');
    assert.equal(f.requests.length, count + 1, 'only the accounted summary request was sent');
    const store = new RuntimeStore(f.data);
    try { assert.equal(store.readContextSurface(run.sessionId, 'primary')!.epoch, 0); } finally { store.close(); }
    assert.equal(f.events().some(event => event.type === 'context.compaction' && event.payload.stage === 'committed'), false);
});
test('explicit provider overflow retries once only after a durable smaller checkpoint', async t => {
    const f = await fixture(t, false, true);
    const run = await f.start('Continue after service overflow');
    assert.equal(run.state, 'completed', run.error);
    const committed = f.events().filter(event => event.type === 'context.compaction' && event.payload.stage === 'committed');
    assert.equal(committed.length, 1);
    assert.equal(f.requests.length, 4, 'first turn, rejected request, isolated summary, smaller retry');
    assert.ok(JSON.stringify(f.requests[3]).length < JSON.stringify(f.requests[1]).length);
});

async function fixture(t: { after(fn: () => Promise<void>): void }, hugePublic = false, overflowOnce = false) {
    const root = mkdtempSync(join(tmpdir(), 'uah-compaction-loop-')); const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'input.txt'), 'REAL_CURRENT_TOOL_TAIL');
    const data = join(root, 'data'); const requests: Body[] = []; const errors: unknown[] = []; let capacity: number | undefined;
    const server = createServer((request, response) => { void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body);
        if (overflowOnce && requests.length === 2) {
            response.writeHead(400, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: { code: 'context_length_exceeded', message: 'fixture' } }));
        } else if (requests.length === 1) answer(response, 'SHORT PUBLIC FIRST REPLY', oldOpaque);
        else {
            const latest = [...body.messages].reverse().find(message => message.role === 'user' && !message.content?.startsWith('[UAH'))?.content;
            if (latest === currentUser && !body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'compaction-read')) answer(response, '', currentOpaque, true);
            else answer(response, 'SHORT PUBLIC FINAL REPLY');
        }
    })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, reject) => { const failed = (error: Error) => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); ready(); }; server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings(); settings.profiles[0].instructions = 'Compaction transaction fixture';
    const options = { dataDirectory: data, delayMs: 0, onEvent: () => {}, getAgentSettings: () => settings,
        resolveAgent: (id: string) => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async (id: string) => ({ id, name: 'Local compaction', protocol: 'openai-chat' as const, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'compaction-fixture-key', enabled: true, revision: 1, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true, ...(capacity === undefined ? {} : { contextWindow: capacity }) }] }),
    };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-compaction-loop-')); rmSync(target, { recursive: true, force: true }); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Compaction transaction', directory: project, agentId: 'default', selection: { endpointId: 'fixture-endpoint', modelId: 'fixture-model' }, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } }); const sessionId = created.sessions[0].id;
    const start = async (input: string, targetSessionId = sessionId): Promise<RunRecord> => {
        const initial = await supervisor.execute({ type: 'start-run', sessionId: targetSessionId, input }); const id = initial.runs.findLast(run => run.sessionId === targetSessionId)!.id;
        for (let attempt = 0; attempt < 1000; attempt++) { const snapshot = await supervisor.execute({ type: 'snapshot' }); const run = snapshot.runs.find(run => run.id === id)!; if (['completed', 'failed', 'stopped'].includes(run.state)) return run; await delay(10); }
        throw new Error(`Compaction fixture timed out: ${input.slice(0, 80)}`);
    };
    const firstInput = hugePublic ? 'HUGE PUBLIC USER ' + 'U'.repeat(90000) : 'FIRST PUBLIC USER';
    const first = await start(firstInput); assert.equal(first.state, 'completed', first.error); assert.ok(first.modelFrame);
    const partition = join(data, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
    const artifacts = new JournalArtifacts(partition);
    const events = () => { const store = new RuntimeStore(data); try { return store.readJournal(sessionId, 0, 10000); } finally { store.close(); } };
    return { root, data, requests, first, firstInput, start, events, capacity: (value: number) => { capacity = value; },
        branch: async (branchFromRunId: string) => {
            const before = await supervisor.execute({ type: 'snapshot' });
            const next = await supervisor.execute({ type: 'create-session', title: 'Checkpoint branch', directory: project, agentId: 'default',
                selection: { endpointId: 'fixture-endpoint', modelId: 'fixture-model' }, controls: { permissionMode: 'readonly', reasoningEffort: 'default' }, branchFromRunId });
            return next.sessions.find(item => !before.sessions.some(old => old.id === item.id))!.id;
        },
        read: (ref: ArtifactReference) => artifacts.read(ref),
        project: () => supervisor.journalSessionDirectory(sessionId),
        export: (destination: string, mode: 'full' | 'share') => supervisor.journalExport(sessionId, destination, mode),
        restart: async () => { await supervisor.shutdown(); supervisor = new Supervisor(options); return supervisor.execute({ type: 'snapshot' }); },
    };
}
