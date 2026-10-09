import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { replayTranscript, validateTranscript } from '../../src/runtime/transcript-offline';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RunRecord, RuntimeEvent } from '../../src/shared/contracts';
import type { ToolProgressState } from '../../src/shared/harness-contracts';

interface Body { messages: Array<{ role: string; content?: string }> }
interface Call { name: string; args: unknown }
const invalid = (args: Record<string, unknown> = { value: 'same' }): Call => ({ name: 'read_file', args: { path: 123, ...args } });
const read = (path: string): Call => ({ name: 'read_file', args: { path } });
function answer(response: ServerResponse, calls: Call[] = []) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `progress-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'Progress fixture complete.' };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
async function fixture(t: { after(fn: () => Promise<void>): void }, respond: (body: Body, response: ServerResponse, count: number) => void) {
    const root = mkdtempSync(join(tmpdir(), 'uah-tool-progress-')); const project = join(root, 'project'); mkdirSync(project);
    writeFileSync(join(project, 'read.txt'), 'progress evidence'); const data = join(root, 'data');
    const requests: Body[] = []; const errors: unknown[] = []; const events: RuntimeEvent[] = []; const listeners = new Set<() => void>();
    const server = createServer((request, response) => { void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body); respond(body, response, requests.length);
    })().catch(error => { errors.push(error); response.destroy(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, reject) => {
            const failed = (error: Error) => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); ready(); };
            server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1');
        }); break; } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings();
    const options = { dataDirectory: data, delayMs: 0,
        onEvent: (event: RuntimeEvent) => { events.push(event); for (const listener of [...listeners]) listener(); }, getAgentSettings: () => settings,
        resolveAgent: (id: string) => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async (id: string) => ({ id, name: 'Local progress fixture', protocol: 'openai-chat' as const,
            baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-progress-fixture-key', models: ['fixture-model'], enabled: true, revision: 1, modelDetails: [{ id: 'fixture-model', tools: true }] }),
    };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
        const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-tool-progress-'));
        rmSync(target, { recursive: true, force: true }); assert.deepEqual(errors, []); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Tool progress fixture', directory: project, agentId: 'default',
        selection: { endpointId: 'fixture', modelId: 'fixture-model' }, controls: { permissionMode: 'auto', reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    const start = async () => (await supervisor.execute({ type: 'start-run', sessionId, input: 'Tool progress fixture task.' })).runs.find(run => run.sessionId === sessionId)!;
    const terminal = (id: string) => new Promise<RunRecord>((done, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Tool progress terminal deadline exceeded')); }, 15000);
        const check = () => { const event = events.findLast(event => event.type === 'run-state' && event.runId === id && ['completed', 'failed', 'stopped'].includes(event.payload.run.state));
            if (event?.type === 'run-state') { clearTimeout(timer); listeners.delete(check); done(event.payload.run); } };
        listeners.add(check); check();
    });
    const journal = () => { const store = new RuntimeStore(data); try { return store.readJournal(sessionId, 0, 10000); } finally { store.close(); } };
    return { root, data, project, requests, sessionId, start, terminal, journal,
        execute: (command: Parameters<Supervisor['execute']>[0]) => supervisor.execute(command),
        export: (mode: 'full' | 'share') => { const destination = join(root, mode); supervisor.journalExport(sessionId, destination, mode); return { validation: validateTranscript(destination), replay: replayTranscript(destination) }; },
        reload: async () => { await supervisor.shutdown(); supervisor = new Supervisor(options); return supervisor.execute({ type: 'snapshot' }); } };
}
function progress(f: Awaited<ReturnType<typeof fixture>>): ToolProgressState[] {
    return f.journal().filter(event => event.type === 'progress.updated').map(event => event.payload.state);
}
function paused(run: RunRecord, code: 'no_progress' | 'model_corrections', failed: number, repeated: number) {
    assert.equal(run.state, 'stopped', run.error); assert.equal(run.harnessState, 'suspended_budget'); assert.equal(run.budgetStopCode, code);
    assert.equal(run.toolProgress!.failedBatches, failed); assert.equal(run.toolProgress!.repeatedFailureBatches, repeated); assert.equal(run.toolProgress!.stopCode, code);
    assert.match(run.stopReason!, /已达到.+限制/);
}

test('unknown tool names are rejected by transport immediately without any dispatch', async t => {
    const f = await fixture(t, (_body, response) => answer(response, [{ name: 'unregistered_progress_fixture', args: {} }]));
    const run = await f.terminal((await f.start()).id); assert.equal(run.state, 'failed'); assert.equal(f.requests.length, 1);
    assert.match(run.error!, /不支持的工具/); assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 0);
    assert.equal(f.journal().filter(event => event.type === 'tool.result').length, 0); assert.equal(progress(f).length, 0);
});

test('three identical invalid tool failures pause without dispatch or a fourth request', async t => {
    const f = await fixture(t, (_body, response, count) => answer(response, [invalid(count % 2 ? { a: 1, b: 2 } : { b: 2, a: 1 })]));
    const original = RuntimeStore.prototype.commit; let atomicProgress = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        for (const event of changes.journal ?? []) if (event.type === 'progress.updated') {
            assert.ok(changes.runs?.some(run => run.id === event.run.runId && JSON.stringify(run.toolProgress) === JSON.stringify(event.payload.state)));
            const existing = this.readJournal(f.sessionId, 0, 10000); assert.equal(existing.filter(item => item.type === 'tool.result').length, event.payload.state.failedBatches);
            atomicProgress++;
        }
        return original.call(this, changes);
    });
    const run = await f.terminal((await f.start()).id); paused(run, 'no_progress', 3, 3); assert.equal(f.requests.length, 3); assert.equal(atomicProgress, 3);
    assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 0);
    const states = progress(f); assert.deepEqual(states.map(state => state.failedBatches), [1, 2, 3]);
    assert.equal(new Set(states.map(state => state.lastFailureFingerprint)).size, 1, 'JSON key order and invocation IDs do not invent progress');
    assert.deepEqual(states.at(-1), run.toolProgress); assert.equal(JSON.stringify(f.journal()).includes('local-progress-fixture-key'), false);
    for (const mode of ['full', 'share'] as const) {
        const exported = f.export(mode); assert.ok(exported.validation.eventCount > 0, 'offline export accepts progress.updated');
        assert.deepEqual(exported.replay.runs.find(item => item.runId === run.id)!.toolProgress, run.toolProgress);
    }
    const reloaded = (await f.reload()).runs.find(item => item.id === run.id)!; assert.deepEqual(reloaded.toolProgress, run.toolProgress); assert.equal(reloaded.budgetStopCode, 'no_progress');
});

test('six changing failed batches exhaust model corrections without a seventh request', async t => {
    const f = await fixture(t, (_body, response, count) => answer(response, [invalid({ correction: count })]));
    const run = await f.terminal((await f.start()).id); paused(run, 'model_corrections', 6, 1); assert.equal(f.requests.length, 6);
    assert.deepEqual(progress(f).map(state => state.failedBatches), [1, 2, 3, 4, 5, 6]); assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 0);
});

test('a corrected tool argument succeeds and completes while retaining the failed batch count', async t => {
    const f = await fixture(t, (_body, response, count) => answer(response, count === 1 ? [read('missing.txt')] : count === 2 ? [read('read.txt')] : []));
    const run = await f.terminal((await f.start()).id); assert.equal(run.state, 'completed', run.error); assert.equal(f.requests.length, 3);
    assert.equal(run.toolProgress!.failedBatches, 1); assert.equal(run.toolProgress!.repeatedFailureBatches, 0); assert.equal(run.toolProgress!.stopCode, null);
    assert.ok(f.requests[2].messages.some(message => message.role === 'tool' && message.content === 'progress evidence'));
    assert.deepEqual(progress(f).map(state => [state.failedBatches, state.repeatedFailureBatches]), [[1, 1], [1, 0]]);
});

test('a successful batch interrupts identical failure streaks without refunding corrections', async t => {
    const f = await fixture(t, (_body, response, count) => answer(response, count === 3 ? [read('read.txt')] : count === 6 ? [] : [invalid()]));
    const run = await f.terminal((await f.start()).id); assert.equal(run.state, 'completed', run.error); assert.equal(f.requests.length, 6);
    assert.deepEqual(progress(f).map(state => [state.failedBatches, state.repeatedFailureBatches]), [[1, 1], [2, 2], [2, 0], [3, 1], [4, 2]]);
    assert.equal(run.toolProgress!.failedBatches, 4); assert.equal(run.toolProgress!.stopCode, null);
});

test('a batch containing a successful write counts one failure but preserves its effect and immutable artifact', async t => {
    const f = await fixture(t, (_body, response, count) => answer(response, count === 1
        ? [{ name: 'write_file', args: { path: 'retained.txt', content: 'retained effect', expectedContent: null } }, invalid()] : [invalid()]));
    const run = await f.terminal((await f.start()).id); paused(run, 'no_progress', 4, 3); assert.equal(f.requests.length, 4);
    assert.equal(readFileSync(join(f.project, 'retained.txt'), 'utf8'), 'retained effect');
    const writes = run.activities!.filter(activity => activity.tool?.name === 'write_file'); assert.equal(writes.length, 1);
    assert.equal(writes[0].tool!.outcome!.status, 'succeeded'); assert.equal(writes[0].tool!.outcome!.effectState, 'confirmed'); assert.ok(writes[0].tool!.artifactId);
    assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 1);
    assert.deepEqual(progress(f).map(state => [state.failedBatches, state.repeatedFailureBatches]), [[1, 0], [2, 1], [3, 2], [4, 3]]);
    const snapshot = await f.execute({ type: 'snapshot' }); assert.equal(snapshot.artifacts.length, 1);
    const artifact = snapshot.artifacts[0]; assert.equal(artifact.runId, run.id); assert.equal(artifact.newContent, 'retained effect');
});

test('progress transaction failure stops recording after durable tool results and before any next HTTP', async t => {
    const f = await fixture(t, (_body, response) => answer(response, [invalid()])); const original = RuntimeStore.prototype.commit;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => event.type === 'progress.updated')) throw new Error('private progress storage failure');
        return original.call(this, changes);
    });
    const run = await f.terminal((await f.start()).id); assert.equal(run.state, 'failed'); assert.equal(run.harnessState, 'recording_failed'); assert.equal(f.requests.length, 1);
    assert.equal(f.journal().filter(event => event.type === 'tool.result').length, 1); assert.equal(progress(f).length, 0);
    assert.equal(run.toolProgress, undefined); assert.equal(JSON.stringify(run).includes('private progress storage failure'), false);
    assert.equal(existsSync(join(f.project, 'effect.txt')), false);
});

test('steering cancels an unstarted batch and resets streaks while preserving cumulative failures', async t => {
    let held!: ServerResponse; let received!: () => void; const holding = new Promise<void>(done => { received = done; });
    const f = await fixture(t, (_body, response, count) => {
        if (count === 3) { held = response; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': progress hold\n\n'); received(); }
        else answer(response, count === 6 ? [read('read.txt')] : [invalid()]);
    });
    const original = RuntimeStore.prototype.commit; let atomicReset = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => event.type === 'control.applied')) {
            const updated = changes.journal.find(event => event.type === 'progress.updated'); assert.ok(updated && updated.type === 'progress.updated');
            assert.equal(updated.payload.state.failedBatches, 2); assert.equal(updated.payload.state.repeatedFailureBatches, 0);
            assert.ok(changes.runs?.some(run => JSON.stringify(run.toolProgress) === JSON.stringify(updated.payload.state))); atomicReset++;
        }
        return original.call(this, changes);
    });
    const initial = await f.start(); await Promise.race([holding, f.terminal(initial.id).then(run => { throw new Error(`Run settled before held steering request: ${run.error ?? run.state}`); })]);
    const active = (await f.execute({ type: 'snapshot' })).runs.find(run => run.id === initial.id)!; assert.ok(active.activeStepId);
    await f.execute({ type: 'steer-run', runId: active.id, expectedStepId: active.activeStepId!, input: 'Continue with corrected progress fixture.' });
    const call = invalid(); held.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'held-progress', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    const run = await f.terminal(initial.id); paused(run, 'model_corrections', 6, 2); assert.equal(f.requests.length, 8);
    assert.equal(atomicReset, 1);
    assert.deepEqual(progress(f).map(state => [state.failedBatches, state.repeatedFailureBatches]), [[1, 1], [2, 2], [2, 0], [2, 0], [3, 1], [4, 2], [4, 0], [5, 1], [6, 2]]);
    const cancelled = run.activities!.filter(activity => activity.tool?.outcome?.status === 'cancelled'); assert.equal(cancelled.length, 1);
    assert.equal(cancelled[0].tool!.outcome!.effectState, 'not_started'); assert.equal(cancelled[0].tool!.outcome!.errorCode, 'CONTROL_SUPERSEDED');
    assert.ok(run.steering!.some(item => item.status === 'applied')); assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 1);
});
