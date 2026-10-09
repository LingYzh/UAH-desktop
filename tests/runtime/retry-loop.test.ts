import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { RequestJournal } from '../../src/runtime/request-journal';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RunRecord, RuntimeEvent } from '../../src/shared/contracts';
import type { TaskTreeBudgetOptions } from '../../src/runtime/context-governor';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function answer(response: ServerResponse, calls?: Array<{ name: string; args: unknown }>) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(frame({ choices: [{ index: 0, delta: calls ? { tool_calls: calls.map((call, index) => ({ index, id: `retry-tool-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'RETRY FINAL' }, finish_reason: calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
}
const httpFailure = (response: ServerResponse, status: number) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify({ error: 'offline fixture status' })); };
function deferred() { let resolveValue!: () => void; const promise = new Promise<void>(resolve => { resolveValue = resolve; }); return { promise, resolve: resolveValue }; }
interface Body { messages: Array<{ role: string; content?: string }> }
async function fixture(t: { after(fn: () => Promise<void>): void }, respond: (body: Body, response: ServerResponse, count: number) => void, taskBudget?: TaskTreeBudgetOptions) {
    const root = mkdtempSync(join(tmpdir(), 'uah-retry-loop-')); const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'read.txt'), 'read evidence');
    const requests: Body[] = []; const errors: unknown[] = []; const events: RuntimeEvent[] = []; const listeners = new Set<() => void>();
    const server = createServer(async (request, response) => {
        try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body); respond(body, response, requests.length); }
        catch (error) { errors.push(error); response.destroy(); }
    });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((resolveListen, reject) => {
            const failed = (error: Error) => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); resolveListen(); };
            server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1');
        }); break; } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string' && address.port >= 20000);
    const settings = defaultAgentSettings();
    const supervisor = new Supervisor({ dataDirectory: join(root, 'data'), delayMs: 0, taskBudget,
        onEvent: event => { events.push(event); for (const listener of [...listeners]) listener(); }, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); if (!profile) throw new Error('Missing fixture profile'); return profile; },
        resolveConnection: async id => ({ id, name: 'Offline retry', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'LOCAL_RETRY_SECRET', models: ['fixture-model'], enabled: true, revision: 1, modelDetails: [{ id: 'fixture-model', tools: true }] }),
    });
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-retry-loop-')); rmSync(target, { recursive: true, force: true }); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Retry fixture', directory: project, agentId: 'default', selection: { endpointId: 'fixture', modelId: 'fixture-model' }, controls: { permissionMode: 'auto', reasoningEffort: 'default' } }); const sessionId = created.sessions[0].id;
    const start = async () => (await supervisor.execute({ type: 'start-run', sessionId, input: 'RETRY FIXTURE TASK' })).runs.find(run => run.sessionId === sessionId)!;
    const terminal = (id: string) => new Promise<RunRecord>((resolveRun, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Retry fixture terminal deadline exceeded')); }, 15000);
        const check = () => { const event = events.find(event => event.type === 'run-state' && event.runId === id && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)); if (event?.type === 'run-state') { clearTimeout(timer); listeners.delete(check); resolveRun(event.payload.run); } };
        listeners.add(check); check();
    });
    const journal = () => { const store = new RuntimeStore(join(root, 'data')); try { return store.readJournal(sessionId, 0, 10000); } finally { store.close(); } };
    return { supervisor, project, requests, start, terminal, journal, snapshot: () => supervisor.execute({ type: 'snapshot' }) };
}

function assertAttemptLedger(f: Awaited<ReturnType<typeof fixture>>, expected: number, statuses: string[]) {
    const events = f.journal(); const intents = events.filter(event => event.type === 'request.intent'); const terminals = events.filter(event => event.type === 'response.terminal');
    assert.equal(intents.length, expected); assert.equal(events.filter(event => event.type === 'request.dispatch').length, expected); assert.equal(terminals.length, expected);
    assert.equal(new Set(intents.map(event => event.payload.identity.attemptId)).size, expected);
    const retries = events.filter(event => event.type === 'request.retry');
    for (let index = 1; index < intents.length; index++) {
        const previous = intents[index - 1].payload.identity; const current = intents[index].payload.identity;
        if (retries.some(event => event.payload.attemptId === previous.attemptId)) {
            assert.equal(current.requestId, previous.requestId, 'network retries retain logical request identity');
            assert.equal(current.stepId, previous.stepId);
        } else assert.notEqual(current.requestId, previous.requestId, 'new model steps have new request identities');
    }
    assert.deepEqual(terminals.map(event => event.payload.status), statuses);
    for (const intent of intents) {
        const identity = intent.payload.identity;
        assert.ok(terminals.some(event => event.payload.requestId === identity.requestId && event.payload.attemptId === identity.attemptId));
        assert.ok(events.some(event => event.type === 'usage.snapshot' && event.payload.usage.requestId === identity.requestId && event.payload.usage.attemptId === identity.attemptId), 'failed attempts retain unknown usage evidence');
    }
    return events.filter(event => event.type === 'request.retry');
}

test('two HTTP 503 failures retry with distinct charged attempts and a complete failure ledger', async t => {
    const f = await fixture(t, (_body, response, count) => count <= 2 ? httpFailure(response, 503) : answer(response)); const run = await f.terminal((await f.start()).id);
    assert.equal(run.state, 'completed', run.error); assert.equal(f.requests.length, 3); assert.equal((run.budgetState as Record<string, unknown>).requestsUsed, 3);
    const retries = assertAttemptLedger(f, 3, ['failed', 'failed', 'completed']);
    assert.deepEqual(retries.map(event => [event.payload.reason, event.payload.retryNumber, event.payload.delayMs]), [['http.503', 1, 250], ['http.503', 2, 1000]]);
    assert.equal(run.output, 'RETRY FINAL'); assert.equal(JSON.stringify(f.journal()).includes('LOCAL_RETRY_SECRET'), false);
    const summary = f.supervisor.journalView({ action: 'summary', sessionId: run.sessionId });
    assert.ok(summary.requests);
    assert.equal(summary.requests.length, 3, 'each attempt keeps its own display and usage row');
    assert.equal(new Set(summary.requests.map(row => row.requestId)).size, 1);
    assert.equal(new Set(summary.requests.map(row => row.attemptId)).size, 3);
    assert.deepEqual(summary.requests.map(row => row.status), ['completed', 'failed', 'failed']);
    assert.throws(() => f.supervisor.journalView({ action: 'request', sessionId: run.sessionId, requestId: summary.requests[0].requestId }), /多次尝试/);
    for (const row of summary.requests) {
        const detail = f.supervisor.journalView({ action: 'request', sessionId: run.sessionId, requestId: row.requestId, attemptId: row.attemptId });
        assert.ok('snapshot' in detail);
        assert.equal(detail.attemptId, row.attemptId);
        assert.equal((detail.snapshot as { identity: { attemptId: string } }).identity.attemptId, row.attemptId);
        assert.equal(detail.events.filter(event => event.type === 'response.terminal').length, 1);
    }
    assert.throws(() => f.supervisor.journalView({ action: 'request', sessionId: run.sessionId, requestId: summary.requests[0].requestId, attemptId: 'another-attempt' }), /不存在/);
});

for (const status of [400, 401]) test(`HTTP ${status} never retries`, async t => {
    const f = await fixture(t, (_body, response) => httpFailure(response, status)); const run = await f.terminal((await f.start()).id);
    assert.equal(run.state, 'failed'); assert.equal(f.requests.length, 1); assert.equal(assertAttemptLedger(f, 1, ['failed']).length, 0);
});

test('HTTP 500 retries stop at three requests for the entire run', async t => {
    const f = await fixture(t, (_body, response) => httpFailure(response, 500)); const run = await f.terminal((await f.start()).id);
    assert.equal(run.state, 'failed'); assert.equal(f.requests.length, 3); assert.equal(assertAttemptLedger(f, 3, ['failed', 'failed', 'failed']).length, 2);
    assert.equal((run.budgetState as Record<string, unknown>).requestsUsed, 3);
});

test('a successful file tool is executed once when the following model request retries', async t => {
    const f = await fixture(t, (_body, response, count) => {
        if (count === 1) answer(response, [{ name: 'write_file', args: { path: 'once.txt', content: 'ONLY ONE EFFECT', expectedContent: null } }]);
        else if (count === 2) httpFailure(response, 503); else answer(response);
    });
    const run = await f.terminal((await f.start()).id); assert.equal(run.state, 'completed', run.error); assert.equal(f.requests.length, 3);
    const events = f.journal(); assert.equal(events.filter(event => event.type === 'tool.dispatch').length, 1); assert.equal(events.filter(event => event.type === 'tool.result').length, 1);
    assert.equal((await f.snapshot()).artifacts.length, 1); assert.equal(readFileSync(join(f.project, 'once.txt'), 'utf8'), 'ONLY ONE EFFECT');
    assert.equal(assertAttemptLedger(f, 3, ['completed', 'failed', 'completed']).length, 1);
    assert.ok(f.requests[2].messages.some(message => message.role === 'tool' && message.content === 'File written.'));
});

test('the two-retry allowance is not reset after a completed tool round', async t => {
    const f = await fixture(t, (_body, response, count) => {
        if (count === 3) answer(response, [{ name: 'write_file', args: { path: 'retained.txt', content: 'RETAINED EFFECT', expectedContent: null } }]);
        else httpFailure(response, 503);
    });
    const run = await f.terminal((await f.start()).id);
    assert.equal(run.state, 'failed'); assert.equal(f.requests.length, 4);
    assert.equal(assertAttemptLedger(f, 4, ['failed', 'failed', 'completed', 'failed']).length, 2);
    assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 1);
    assert.equal(readFileSync(join(f.project, 'retained.txt'), 'utf8'), 'RETAINED EFFECT');
});

test('connection loss after a captured partial tool frame never retries or executes the tool', async t => {
    let pending: ServerResponse | undefined; let frameSeen = false;
    const prototype = RequestJournal.prototype as unknown as { frame(event: { data: string }): void }; const original = prototype.frame;
    t.mock.method(prototype, 'frame', function(this: RequestJournal, event: { data: string }) { original.call(this, event); frameSeen = true; pending!.destroy(); });
    const f = await fixture(t, (_body, response) => {
        pending = response; response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'partial-write', type: 'function', function: { name: 'write_file', arguments: '{"path":"must-not-write.txt",' } }] }, finish_reason: null }] }));
    });
    const run = await f.terminal((await f.start()).id); assert.equal(run.state, 'failed'); assert.equal(frameSeen, true); assert.equal(f.requests.length, 1); assert.equal(existsSync(join(f.project, 'must-not-write.txt')), false);
    const events = f.journal(); assert.equal(events.filter(event => event.type === 'request.retry').length, 0); assert.equal(events.filter(event => event.type === 'tool.dispatch').length, 0); assert.ok(events.some(event => event.type === 'provider.frame')); assert.ok(events.some(event => event.type === 'response.terminal' && event.payload.partial));
});

test('stop during the durable retry boundary aborts backoff without another HTTP request', async t => {
    const boundary = deferred(); const original = RuntimeStore.prototype.commit;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) { original.call(this, changes); if (changes.journal?.some(event => event.type === 'request.retry')) boundary.resolve(); });
    const f = await fixture(t, (_body, response) => httpFailure(response, 503)); const run = await f.start(); await boundary.promise;
    await f.supervisor.execute({ type: 'stop-run', runId: run.id, reason: 'Stop retry fixture' }); const stopped = await f.terminal(run.id);
    assert.equal(stopped.state, 'stopped'); assert.equal(f.requests.length, 1); assert.equal(f.journal().filter(event => event.type === 'request.retry').length, 1);
});

test('one-request budget suspends before retry admission sends another HTTP request', async t => {
    const f = await fixture(t, (_body, response) => httpFailure(response, 503), { maxRequests: 1 }); const run = await f.terminal((await f.start()).id);
    assert.equal(run.state, 'stopped'); assert.equal(run.harnessState, 'suspended_budget'); assert.equal(run.budgetStopCode, 'requests'); assert.equal(f.requests.length, 1); assert.equal((run.budgetState as Record<string, unknown>).requestsUsed, 1);
    assertAttemptLedger(f, 1, ['failed']);
});

test('canonical recording failure cannot initiate a retry HTTP request', async t => {
    const original = RuntimeStore.prototype.commit;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => event.type === 'response.terminal')) throw new Error('private canonical fixture failure');
        original.call(this, changes);
    });
    const f = await fixture(t, (_body, response) => httpFailure(response, 503)); const run = await f.terminal((await f.start()).id);
    assert.equal(run.state, 'failed'); assert.equal(run.harnessState, 'recording_failed'); assert.equal(f.requests.length, 1); assert.equal(f.journal().filter(event => event.type === 'request.retry').length, 0); assert.equal(JSON.stringify(run).includes('private canonical'), false);
});
