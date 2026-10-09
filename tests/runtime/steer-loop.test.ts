import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { validateTranscript, replayTranscript } from '../../src/runtime/transcript-offline';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RunRecord, Snapshot, RuntimeEvent } from '../../src/shared/contracts';
import type { PermissionMode } from '../../src/shared/permissions';

interface Body { messages: Array<{ role: string; content?: string }>; }
interface Call { name: string; args: unknown; }
const direction = 'NEW USER DIRECTION\nKeep this exact user supplement.';
const write = (path: string) => ({ name: 'write_file', args: { path, content: 'CONFIRMED FIRST EFFECT', expectedContent: null } });
function answer(response: ServerResponse, calls: Call[] = []) {
    if (!response.headersSent) response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `steer-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'Steered fixture complete.' };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
function hold(response: ServerResponse) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': fixture waits for explicit control\n\n'); }
async function fixture(t: { after(fn: () => Promise<void>): void }, handler: (body: Body, response: ServerResponse, number: number) => void, mode: PermissionMode = 'accept-edits') {
    const root = mkdtempSync(join(tmpdir(), 'uah-steer-loop-')); const project = join(root, 'project'); mkdirSync(project); const data = join(root, 'data');
    const requests: Body[] = []; const errors: unknown[] = []; let hook: ((event: RuntimeEvent) => void) | undefined;
    const server = createServer((request, response) => { void (async () => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body); handler(body, response, requests.length); })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, reject) => { const failed = (error: Error) => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); ready(); }; server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; }
        // Retry Windows reserved ports within the existing bounded fixture allocation.
        catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings(); settings.subagents.enabled = true;
    const options = { dataDirectory: data, delayMs: 0, onEvent: (event: RuntimeEvent) => hook?.(event), getAgentSettings: () => settings,
        resolveAgent: (id: string) => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async (id: string) => ({ id, name: 'Local steer', protocol: 'openai-chat' as const, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'steer-local-key', enabled: true, revision: 1, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true }] }),
    };
    let supervisor = new Supervisor(options);
    t.after(async () => { hook = undefined; await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-steer-loop-')); rmSync(target, { recursive: true, force: true }); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Steer fixture', directory: project, agentId: 'default', selection: { endpointId: 'fixture-endpoint', modelId: 'fixture-model' }, controls: { permissionMode: mode, reasoningEffort: 'default' } }); const sessionId = created.sessions[0].id;
    const execute = (command: Parameters<Supervisor['execute']>[0]) => supervisor.execute(command);
    const snapshot = () => execute({ type: 'snapshot' });
    const wait = async (predicate: (state: Snapshot) => boolean) => { for (let i = 0; i < 1000; i++) { const state = await snapshot(); if (predicate(state)) return state; await delay(10); } throw new Error(`Steer fixture timed out: ${JSON.stringify(await snapshot())}`); };
    const start = async (input = 'ROOT STEER TASK', session = sessionId) => (await execute({ type: 'start-run', sessionId: session, input })).runs.findLast(run => run.sessionId === session)!;
    const active = async (id: string) => (await wait(state => !!state.runs.find(run => run.id === id)?.activeStepId)).runs.find(run => run.id === id)!;
    const terminal = async (id: string) => (await wait(state => ['completed', 'failed', 'stopped'].includes(state.runs.find(run => run.id === id)!.state))).runs.find(run => run.id === id)!;
    const steer = (run: RunRecord, input = direction) => execute({ type: 'steer-run', runId: run.id, expectedStepId: run.activeStepId!, input });
    const events = () => { const store = new RuntimeStore(data); try { return store.readJournal(sessionId, 0, 10000); } finally { store.close(); } };
    return { root, project, data, sessionId, requests, execute, snapshot, wait, start, active, terminal, steer, events,
        projectJournal: () => supervisor.journalSessionDirectory(sessionId), exportJournal: (destination: string, mode: 'full' | 'share') => supervisor.journalExport(sessionId, destination, mode),
        hook: (next: (event: RuntimeEvent) => void) => { hook = next; }, restart: async () => { await supervisor.shutdown(); supervisor = new Supervisor(options); return snapshot(); } };
}
function assertSuperseded(run: RunRecord, path: string) {
    const outcome = run.activities?.find(activity => activity.tool?.arguments.path === path)?.tool?.outcome; assert.ok(outcome, path);
    assert.equal(outcome.status, 'cancelled'); assert.equal(outcome.effectState, 'not_started'); assert.equal(outcome.errorCode, 'CONTROL_SUPERSEDED');
}

test('stream steering supersedes unstarted write, commits controls atomically and survives public fallback/branch', async t => {
    let held: ServerResponse | undefined;
    const f = await fixture(t, (_body, response, number) => { if (number === 1) { held = response; hold(response); } else answer(response); });
    const original = RuntimeStore.prototype.commit; let requested = 0; let applied = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        for (const event of changes.journal ?? []) {
            if (event.type === 'control.requested' && event.payload.action === 'steer') { assert.ok(changes.runs?.some(run => run.steering?.some(item => item.status === 'queued' && item.expectedStepId === event.payload.expectedStepId))); requested++; }
            if (event.type === 'control.applied') { assert.ok(changes.runs?.some(run => event.payload.controlIds.every(id => run.steering?.some(item => item.id === id && item.status === 'applied')))); applied++; }
        }
        return original.call(this, changes);
    });
    const root = await f.start(); const active = await f.active(root.id); await f.wait(() => !!held); await f.steer(active); answer(held!, [write('old-stream.txt')]);
    const done = await f.terminal(root.id); assert.equal(done.state, 'completed', done.error); assert.equal(existsSync(join(f.project, 'old-stream.txt')), false); assertSuperseded(done, 'old-stream.txt');
    assert.equal(f.requests.length, 2); assert.equal(f.requests[1].messages.filter(message => message.role === 'user' && message.content === direction).length, 1); assert.equal(requested, 1); assert.equal(applied, 1);
    assert.equal(done.effective.permissionMode, 'accept-edits'); assert.equal(done.steering?.[0].status, 'applied');
    await f.execute({ type: 'edit-reply', runId: root.id, output: 'PUBLIC EDITED REPLY' });
    const followup = await f.start('PUBLIC FOLLOWUP'); assert.equal((await f.terminal(followup.id)).state, 'completed'); assert.equal(f.requests.at(-1)!.messages.filter(message => message.role === 'user' && message.content === direction).length, 1);
    const before = await f.snapshot(); const branched = await f.execute({ type: 'create-session', title: 'Steer branch', directory: f.project, agentId: 'default', selection: { endpointId: 'fixture-endpoint', modelId: 'fixture-model' }, controls: { permissionMode: 'accept-edits', reasoningEffort: 'default' }, branchFromRunId: root.id });
    const branch = branched.sessions.find(session => !before.sessions.some(item => item.id === session.id))!; const branchRun = await f.start('BRANCH FOLLOWUP', branch.id); assert.equal((await f.terminal(branchRun.id)).state, 'completed'); assert.equal(f.requests.at(-1)!.messages.filter(message => message.role === 'user' && message.content === direction).length, 1);
    const local = validateTranscript(f.projectJournal()); assert.equal(local.artifactCount, local.presentArtifacts);
    for (const mode of ['full', 'share'] as const) {
        const destination = join(f.root, `steer-${mode}`); f.exportJournal(destination, mode); const report = validateTranscript(destination); assert.ok(report.eventCount > 0); assert.ok(replayTranscript(destination).runs.some(run => run.runId === root.id));
        if (mode === 'full') assert.equal(report.artifactCount, report.presentArtifacts); else assert.equal(report.partial, true);
        const transcript = readFileSync(join(destination, 'transcript.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.ok(transcript.some(event => event.type === 'control.requested' && event.payload.action === 'steer')); assert.ok(transcript.some(event => event.type === 'control.applied'));
    }
});
test('synchronous request-context notification steering prevents old-direction HTTP before dispatch', async t => {
    const originalInput = 'ORIGINAL USER BEFORE UI CONTEXT NOTIFICATION';
    const f = await fixture(t, (body, response) => {
        const latest = [...body.messages].reverse().find(message => message.role === 'user')?.content;
        answer(response, latest === direction ? [] : [write('pre-send-old-direction.txt')]);
    });
    let injected = false; let steering: Promise<Snapshot> | undefined;
    f.hook(event => {
        if (!injected && event.type === 'run-state' && event.payload.run.activeStepId && event.payload.run.requestContext) {
            injected = true;
            // execute enters steerRun synchronously until its first await, exactly
            // as a UI notification consumer can react before HTTP dispatch.
            steering = f.execute({ type: 'steer-run', runId: event.payload.run.id, expectedStepId: event.payload.run.activeStepId, input: direction });
        }
    });
    const root = await f.start(originalInput); const done = await f.terminal(root.id); assert.ok(injected && steering); await steering; assert.equal(done.state, 'completed', done.error);
    assert.equal(f.requests.length, 1, 'the cancelled pre-send direction has no HTTP attempt');
    assert.equal(f.requests[0].messages.filter(message => message.role === 'user' && message.content === direction).length, 1);
    assert.equal(f.requests[0].messages.filter(message => message.role === 'user' && message.content === originalInput).length, 1, 'original input remains intact');
    assert.equal(existsSync(join(f.project, 'pre-send-old-direction.txt')), false); assert.equal(f.events().filter(event => event.type === 'tool.dispatch').length, 0);
    assert.equal(f.events().filter(event => event.type === 'request.intent').length, 1); assert.equal(f.events().filter(event => event.type === 'request.dispatch').length, 1);
    assert.equal(done.steering?.[0].status, 'applied');
});
test('steering pending manual approval expires it and prevents the old write', async t => {
    const f = await fixture(t, (_body, response, number) => answer(response, number === 1 ? [write('old-approval.txt')] : []), 'manual');
    const root = await f.start(); const pending = await f.wait(state => state.approvals.some(item => item.status === 'pending')); await f.steer(pending.runs.find(run => run.id === root.id)!);
    const done = await f.terminal(root.id); assert.equal(done.state, 'completed', done.error); assertSuperseded(done, 'old-approval.txt'); assert.equal(existsSync(join(f.project, 'old-approval.txt')), false); assert.equal((await f.snapshot()).approvals[0].status, 'expired'); assert.equal(f.requests.length, 2);
});
test('steering after a confirmed write preserves that effect and skips later batch writes', async t => {
    const f = await fixture(t, (_body, response, number) => answer(response, number === 1 ? [write('first-effect.txt'), write('later-effect.txt')] : []));
    let issued = false; let steering: Promise<Snapshot> | undefined;
    f.hook(event => { if (!issued && event.type === 'run-state' && event.payload.run.activities?.some(activity => activity.tool?.arguments.path === 'first-effect.txt' && activity.status === 'completed')) { issued = true; steering = f.steer(event.payload.run); } });
    const root = await f.start(); const done = await f.terminal(root.id); assert.ok(steering); await steering; assert.equal(done.state, 'completed', done.error);
    assert.equal(readFileSync(join(f.project, 'first-effect.txt'), 'utf8'), 'CONFIRMED FIRST EFFECT'); assert.equal(existsSync(join(f.project, 'later-effect.txt')), false); assertSuperseded(done, 'later-effect.txt'); assert.equal(done.activities?.filter(activity => activity.tool?.arguments.path === 'first-effect.txt').length, 1);
});
test('stale and terminal steps reject, and Plan runs cannot accept steering', async t => {
    let held: ServerResponse | undefined; const f = await fixture(t, (_body, response, number) => { if (number === 1) { held = response; hold(response); } else answer(response); });
    const root = await f.start(); const active = await f.active(root.id); await f.wait(() => !!held);
    await assert.rejects(f.execute({ type: 'steer-run', runId: root.id, expectedStepId: 'stale-step', input: direction })); assert.equal(f.events().some(event => event.type === 'control.requested'), false);
    answer(held!); await f.terminal(root.id); await assert.rejects(f.steer(active));
    let planHeld: ServerResponse | undefined; const plan = await fixture(t, (_body, response) => { planHeld = response; hold(response); }, 'plan'); const planRoot = await plan.start(); const planActive = await plan.active(planRoot.id); await plan.wait(() => !!planHeld); await assert.rejects(plan.steer(planActive)); await plan.execute({ type: 'stop-run', runId: planRoot.id });
});
test('child steering rejects and root steering settles old owned children before its next request', async t => {
    let parentHeld: ServerResponse | undefined; let childHeld: ServerResponse | undefined; let rootRounds = 0;
    const f = await fixture(t, (body, response) => {
        if (body.messages.some(message => message.content === 'CHILD OLD TASK')) { childHeld = response; hold(response); }
        else if (++rootRounds === 1) answer(response, [{ name: 'spawn_agent', args: { prompt: 'CHILD OLD TASK', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else if (rootRounds === 2) { parentHeld = response; hold(response); } else answer(response);
    });
    const root = await f.start(); const ready = await f.wait(state => !!parentHeld && !!childHeld && state.runs.some(run => run.parentRunId === root.id && run.activeStepId)); const child = ready.runs.find(run => run.parentRunId === root.id)!;
    await assert.rejects(f.steer(child)); await f.steer(ready.runs.find(run => run.id === root.id)!); assert.equal((await f.snapshot()).runs.find(run => run.id === child.id)!.state, 'stopped'); answer(parentHeld!);
    const done = await f.terminal(root.id); assert.equal(done.state, 'completed', done.error); assert.equal((await f.snapshot()).runs.find(run => run.id === child.id)!.state, 'stopped'); assert.equal(f.requests.at(-1)!.messages.filter(message => message.content === direction).length, 1);
});
test('stop leaves accepted steering queued and restart never sends it automatically', async t => {
    let held: ServerResponse | undefined; const f = await fixture(t, (_body, response) => { held = response; hold(response); }); const root = await f.start(); const active = await f.active(root.id); await f.wait(() => !!held); await f.steer(active);
    await f.execute({ type: 'stop-run', runId: root.id }); const stopped = await f.terminal(root.id); assert.equal(stopped.steering?.[0].status, 'queued'); assert.equal(f.events().some(event => event.type === 'control.applied'), false);
    const count = f.requests.length; const restarted = await f.restart(); assert.equal(restarted.runs.find(run => run.id === root.id)!.steering?.[0].status, 'queued'); await delay(50); assert.equal(f.requests.length, count);
});
for (const boundary of ['requested', 'applied'] as const) test(`steering ${boundary} authority commit failure cannot dispatch or activate uncommitted direction`, async t => {
    let held: ServerResponse | undefined; const f = await fixture(t, (_body, response, number) => { if (number === 1) { held = response; hold(response); } else answer(response); }); const root = await f.start(); const active = await f.active(root.id); await f.wait(() => !!held);
    const original = RuntimeStore.prototype.commit; let failures = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => boundary === 'requested' ? event.type === 'control.requested' && event.payload.action === 'steer' : event.type === 'control.applied')) { failures++; throw new Error('Fixture steering authority commit failure'); }
        return original.call(this, changes);
    });
    if (boundary === 'requested') await assert.rejects(f.steer(active)); else { await f.steer(active); answer(held!, [write('failed-control.txt')]); }
    const stopped = await f.terminal(root.id); assert.equal(stopped.state, 'failed'); assert.equal(stopped.harnessState, 'recording_failed'); assert.equal(failures, 1); assert.equal(f.requests.length, 1); assert.equal(existsSync(join(f.project, 'failed-control.txt')), false); assert.equal(f.events().some(event => event.type === 'tool.dispatch'), false);
    assert.equal(stopped.steering?.[0]?.status, boundary === 'requested' ? undefined : 'queued'); assert.equal(f.events().some(event => event.type === 'control.applied'), false);
});
