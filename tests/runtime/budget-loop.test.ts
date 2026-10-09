import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { Snapshot, RunRecord } from '../../src/shared/contracts';
import type { TaskTreeBudgetOptions } from '../../src/runtime/context-governor';
import type { PermissionMode } from '../../src/shared/permissions';

interface Body { messages: Array<{ role: string; content?: string; tool_call_id?: string }>; }
interface Call { name: string; args: unknown; }
function answer(response: ServerResponse, calls: Call[] = [], reportedTokens?: number) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `budget-call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'Fixture complete.' };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }], ...(reportedTokens === undefined ? {} : { usage: { prompt_tokens: reportedTokens - 1, completion_tokens: 1, total_tokens: reportedTokens } }) })}\n\ndata: [DONE]\n\n`);
}
const read = { name: 'read_file', args: { path: 'input.txt' } };
const write = (file: string) => ({ name: 'write_file', args: { path: file, content: 'MUST NOT WRITE', expectedContent: null } });
const spawn = (prompt: string) => ({ name: 'spawn_agent', args: { prompt, agent: { type: 'inherit' }, context: { mode: 'none' } } });
async function fixture(t: { after(fn: () => Promise<void>): void }, handler: (body: Body, response: ServerResponse, number: number) => void,
    options: { taskBudget?: TaskTreeBudgetOptions; capacity?: number; mode?: PermissionMode } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'uah-budget-loop-')); const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'input.txt'), 'Budget read evidence');
    const requests: Body[] = []; const errors: unknown[] = [];
    const server = createServer((request, response) => { void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body); handler(body, response, requests.length);
    })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try {
            await new Promise<void>((resolveListen, reject) => {
                const failed = (error: Error) => { server.off('listening', listening); reject(error); };
                const listening = () => { server.off('error', failed); resolveListen(); };
                server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1');
            }); break;
        // Windows reserved port ranges reject an otherwise unused random fixture port.
        } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const settings = defaultAgentSettings(); settings.subagents.enabled = true; settings.profiles[0].instructions = 'ROOT BUDGET FIXTURE';
    const supervisor = new Supervisor({ dataDirectory: join(root, 'data'), delayMs: 0, onEvent: () => {}, taskBudget: options.taskBudget,
        getAgentSettings: () => settings, resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async id => ({ id, name: 'Local budget fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-budget-fixture', enabled: true, revision: 1, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true, ...(options.capacity === undefined ? {} : { contextWindow: options.capacity }) }] }),
    });
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-budget-loop-')); rmSync(target, { recursive: true, force: true }); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Budget fixture', directory: project, agentId: 'default', selection: { endpointId: 'fixture', modelId: 'fixture-model' }, controls: { permissionMode: options.mode ?? 'accept-edits', reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    const snapshot = () => supervisor.execute({ type: 'snapshot' });
    const wait = async (predicate: (state: Snapshot) => boolean) => { for (let i = 0; i < 800; i++) { const state = await snapshot(); if (predicate(state)) return state; await delay(10); } throw new Error(`Budget fixture timed out: ${JSON.stringify(await snapshot())}`); };
    const start = async () => (await supervisor.execute({ type: 'start-run', sessionId, input: 'ROOT BUDGET TASK' })).runs.find(run => !run.parentRunId)!;
    const events = () => { const store = new RuntimeStore(join(root, 'data')); try { return store.readJournal(sessionId, 0, 10000); } finally { store.close(); } };
    const terminal = async (id: string) => (await wait(state => ['completed', 'failed', 'stopped'].includes(state.runs.find(run => run.id === id)!.state))).runs.find(run => run.id === id)!;
    return { project, requests, start, wait, terminal, snapshot, events };
}
function assertSuspended(run: RunRecord, code: string) { assert.equal(run.state, 'stopped', run.error); assert.equal(run.harnessState, 'suspended_budget'); assert.equal(run.budgetStopCode, code); assert.match(run.stopReason ?? '', /已达到.+限制/); }

test('known context rejects before request recording/dispatch; unknown capacity sends normally', async t => {
    const known = await fixture(t, (_body, response) => answer(response), { capacity: 1024 }); const first = await known.start(); assertSuspended(await known.terminal(first.id), 'context_capacity');
    assert.equal(known.requests.length, 0); const events = known.events();
    const admission = events.find(event => event.type === 'context.admission'); assert.ok(admission);
    if (admission.type === 'context.admission') { const assessment = admission.payload.assessment as Record<string, unknown>; assert.equal(assessment.admitted, false); assert.equal(assessment.capacityKnown, true); }
    assert.equal(events.some(event => event.type === 'request.intent' || event.type === 'request.dispatch'), false);
    const unknown = await fixture(t, (_body, response) => answer(response)); const second = await unknown.start(); assert.equal((await unknown.terminal(second.id)).state, 'completed'); assert.equal(unknown.requests.length, 1);
    const admitted = unknown.events().find(event => event.type === 'context.admission'); assert.ok(admitted && admitted.type === 'context.admission'); assert.equal((admitted.payload.assessment as Record<string, unknown>).capacityKnown, false);
});
test('one request budget allows a real read result and blocks the second HTTP request', async t => {
    const f = await fixture(t, (_body, response) => answer(response, [read]), { taskBudget: { maxRequests: 1 } }); const root = await f.start(); const stopped = await f.terminal(root.id); assertSuspended(stopped, 'requests');
    assert.equal(f.requests.length, 1); const events = f.events(); assert.equal(events.filter(event => event.type === 'tool.dispatch').length, 1); assert.equal(events.filter(event => event.type === 'tool.result').length, 1);
    assert.ok(stopped.activities?.some(activity => activity.tool?.result?.includes('Budget read evidence'))); assert.equal((stopped.budgetState as Record<string, unknown>).requestsUsed, 1);
});
test('zero tool budget preserves completed provider evidence before blocking disk effects', async t => {
    const f = await fixture(t, (_body, response) => answer(response, [write('zero-tools.txt')]), { taskBudget: { maxTools: 0 } }); const root = await f.start(); assertSuspended(await f.terminal(root.id), 'tools');
    assert.equal(f.requests.length, 1); assert.equal(existsSync(join(f.project, 'zero-tools.txt')), false); const events = f.events();
    assert.equal(events.filter(event => event.type === 'tool.dispatch').length, 0); assert.ok(events.some(event => event.type === 'response.terminal' && event.payload.status === 'completed'));
});
test('root and child share request reservations without refunding unknown usage', async t => {
    let rootRound = 0;
    const f = await fixture(t, (body, response) => {
        const child = body.messages.some(message => message.role === 'user' && message.content === 'CHILD SHARED BUDGET');
        if (child) answer(response);
        else if (++rootRound === 1) answer(response, [spawn('CHILD SHARED BUDGET')]);
        else answer(response, [read]);
    }, { taskBudget: { maxRequests: 3, maxConcurrentRequests: 4 } });
    const root = await f.start(); assertSuspended(await f.terminal(root.id), 'requests');
    const state = await f.wait(state => state.runs.every(run => ['completed', 'failed', 'stopped'].includes(run.state)));
    assert.ok(state.runs.some(run => run.parentRunId === root.id)); assert.equal(f.requests.length, 3); assert.ok(f.requests.some(body => body.messages.some(message => message.content === 'CHILD SHARED BUDGET')));
    const saved = state.runs.find(run => run.id === root.id)!; const budget = saved.budgetState as Record<string, unknown>; assert.equal(budget.requestsUsed, 3); assert.equal(budget.inFlight, 0); assert.ok(Number(budget.tokensCharged) > 0);
    const usages = f.events().filter(event => event.type === 'usage.snapshot'); assert.ok(usages.every(event => event.payload.usage.counters.totalTokens === null));
    assert.ok(f.events().filter(event => event.type === 'budget.updated').length >= 6);
});
test('elapsed budget interrupts pending manual approval and stops owned children', async t => {
    let rootRound = 0;
    const f = await fixture(t, (body, response) => {
        if (body.messages.some(message => message.content === 'CHILD DEADLINE WAIT')) { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); }
        else if (++rootRound === 1) answer(response, [spawn('CHILD DEADLINE WAIT')]);
        else answer(response, [write('deadline.txt')]);
    // Leave startup/headroom for full-suite concurrent Git and journal work so
    // the test observes a real pending approval before its deadline expires.
    }, { mode: 'manual', taskBudget: { maxElapsedMs: 5000 } });
    const root = await f.start(); const pending = await f.wait(state => state.approvals.some(approval => approval.status === 'pending')); assert.equal(pending.runs.find(run => run.id === root.id)!.state, 'approval');
    const state = await f.wait(state => state.runs.find(run => run.id === root.id)?.harnessState === 'suspended_budget' && state.runs.every(run => ['completed', 'failed', 'stopped'].includes(run.state)));
    assertSuspended(state.runs.find(run => run.id === root.id)!, 'elapsed_ms'); assert.ok(state.runs.some(run => run.parentRunId === root.id)); assert.ok(state.approvals.length > 0 && state.approvals.every(approval => approval.status === 'expired')); assert.equal(existsSync(join(f.project, 'deadline.txt')), false);
});
test('legacy token limit is ignored after high usage; the write and next request complete', async t => {
    const f = await fixture(t, (_body, response, number) => {
        answer(response, number === 1 ? [write('overrun.txt')] : [], number === 1 ? 500000 : 1);
    }, { taskBudget: { maxEstimatedTokens: 100000 } });
    const root = await f.start(); const completed = await f.terminal(root.id);
    assert.equal(completed.state, 'completed', completed.error);
    assert.equal(f.requests.length, 2);
    assert.equal(readFileSync(join(f.project, 'overrun.txt'), 'utf8'), 'MUST NOT WRITE');
    const events = f.events();
    assert.equal(events.filter(event => event.type === 'tool.dispatch').length, 1);
    assert.equal(events.filter(event => event.type === 'tool.result').length, 1);
    assert.ok(events.some(event => event.type === 'usage.snapshot' && event.payload.usage.counters.totalTokens === 500000));
    assert.ok(events.some(event => event.type === 'usage.snapshot' && event.payload.usage.counters.totalTokens === 1));
    const budget = completed.budgetState as Record<string, unknown>;
    const limits = budget.limits as Record<string, unknown>;
    assert.ok(Number(budget.tokensCharged) >= 500000, 'observed usage remains in the cumulative accounting');
    assert.equal(budget.estimatedTokensExceeded, false);
    assert.equal(limits.maxEstimatedTokens, null, 'legacy numeric configuration is accepted but ignored');
    assert.equal(budget.inFlight, 0);
});
test('lower later provider usage does not roll back cumulative accounting or billing revisions', async t => {
    const f = await fixture(t, (_body, response, number) => {
        if (number > 1) { answer(response, [], 1); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const totalTokens of [500000, 1]) response.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: totalTokens - 1, completion_tokens: 1, total_tokens: totalTokens } })}\n\n`);
        const call = write('high-watermark.txt');
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'high-watermark-write', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }, finish_reason: 'tool_calls' }] })}\n\ndata: [DONE]\n\n`);
    }, { taskBudget: { maxEstimatedTokens: 100000 } });
    const root = await f.start(); const completed = await f.terminal(root.id);
    assert.equal(completed.state, 'completed', completed.error);
    assert.equal(f.requests.length, 2);
    assert.equal(readFileSync(join(f.project, 'high-watermark.txt'), 'utf8'), 'MUST NOT WRITE');
    const events = f.events(); assert.equal(events.filter(event => event.type === 'tool.dispatch').length, 1);
    const revisions = events.filter(event => event.type === 'usage.snapshot').map(event => event.payload.usage);
    const highUsage = revisions.find(usage => usage.counters.totalTokens === 500000);
    assert.ok(highUsage);
    const firstRequest = revisions.filter(usage => usage.requestId === highUsage.requestId).sort((left, right) => left.revision - right.revision);
    assert.deepEqual(firstRequest.map(usage => usage.counters.totalTokens), [null, 500000, 1], 'all provider revisions remain truthful');
    assert.equal(firstRequest.at(-1)!.counters.totalTokens, 1, 'latest billing value is not replaced by a cumulative budget counter');
    assert.equal((firstRequest.at(-1)!.rawUsage as Record<string, unknown>).total_tokens, 1);
    const budget = completed.budgetState as Record<string, unknown>;
    const limits = budget.limits as Record<string, unknown>;
    assert.ok(Number(budget.tokensCharged) >= 500000, 'smaller later reports do not erase previously observed usage');
    assert.equal(budget.estimatedTokensExceeded, false);
    assert.equal(limits.maxEstimatedTokens, null);
    assert.equal(budget.inFlight, 0);
});
test('provider-reported output above the former four-million default completes', async t => {
    const outputTokens = 4_500_000;
    const totalTokens = outputTokens + 100;
    const f = await fixture(t, (_body, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({
            choices: [{ index: 0, delta: { content: 'High output fixture completed.' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 100, completion_tokens: outputTokens, total_tokens: totalTokens },
        })}\n\ndata: [DONE]\n\n`);
    });
    const root = await f.start(); const completed = await f.terminal(root.id);
    assert.equal(completed.state, 'completed', completed.error);
    assert.equal(f.requests.length, 1);
    const usage = f.events().find(event => event.type === 'usage.snapshot' && event.payload.usage.counters.totalTokens === totalTokens);
    assert.ok(usage && usage.type === 'usage.snapshot');
    assert.equal(usage.payload.usage.counters.outputTokens, outputTokens);
    const budget = completed.budgetState as Record<string, unknown>;
    const limits = budget.limits as Record<string, unknown>;
    assert.ok(Number(budget.tokensCharged) >= totalTokens);
    assert.equal(budget.estimatedTokensExceeded, false);
    assert.equal(limits.maxEstimatedTokens, null);
});
