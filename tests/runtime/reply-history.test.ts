import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { defaultAgentSettings } from '../../src/shared/agents';
import { defaultModelParameters } from '../../src/shared/model-parameters';
import { parseCommand, type Command, type RunRecord } from '../../src/shared/contracts';
import { visibleRootRuns, latestVisibleRootRun, conversationMessages } from '../../src/shared/conversation-history';
import { parentConversation } from '../../src/shared/delegation';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const directory = mkdtempSync(join(tmpdir(), 'uah-history-')); const project = join(directory, 'project'); mkdirSync(project);
    const settings = defaultAgentSettings(); settings.profiles[0].instructions = 'Original agent';
    const requests: any[] = []; let gate: Promise<void> | undefined; let entered: (() => void) | undefined;
    const parameters = defaultModelParameters();
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        const input = body.messages.filter((message: any) => message.role === 'user').at(-1).content;
        if (input === 'fail' && requests.filter(item => item.messages.at(-1)?.content === 'fail').length === 1) { response.writeHead(400); response.end('fixture failure'); return; }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const tools = body.messages.filter((message: any) => message.role === 'tool');
        const delta = input === 'write' && !tools.length ? { tool_calls: [{ index: 0, id: 'edit-call', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'edit.txt', expectedContent: null, content: 'actual file edit' }) } }] } : { content: `answer ${input}` };
        response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const options = { dataDirectory: join(directory, 'data'), delayMs: 0, onEvent: () => {},
        resolveAgent: (id: string) => settings.profiles.find(profile => profile.id === id)!,
        resolveConnection: async (id: string) => { if (gate) { entered?.(); await gate; } return { id, name: 'fixture', protocol: 'openai-chat' as const, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', enabled: true, models: ['one', 'two'], revision: 1, modelParameters: [{ id: 'one', parameters: { ...parameters } }, { id: 'two', parameters: { ...parameters } }] }; } };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); });
    const initial = await supervisor.execute({ type: 'create-session', title: 'source', directory: project, selection: { endpointId: 'fixture', modelId: 'one' }, agentId: 'default', controls: { permissionMode: 'accept-edits', reasoningEffort: 'default' } });
    const sessionId = initial.sessions[0].id;
    const execute = (command: Command) => supervisor.execute(command);
    const snapshot = () => execute({ type: 'snapshot' });
    const wait = async (id: string) => { for (let index = 0; index < 200; index++) { const state = await snapshot(); if (['completed', 'failed', 'stopped'].includes(state.runs.find(run => run.id === id)?.state || '')) { await delay(10); return snapshot(); } await delay(10); } throw new Error('History fixture timeout'); };
    const start = async (input: string, target = sessionId) => { const state = await execute({ type: 'start-run', sessionId: target, input }); const run = state.runs.filter(run => run.sessionId === target && !run.parentRunId).at(-1)!; return (await wait(run.id)).runs.find(item => item.id === run.id)!; };
    const block = () => { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); const hit = new Promise<void>(resolve => { entered = resolve; }); return { hit, release: () => { gate = undefined; entered = undefined; release(); } }; };
    return { project, settings, requests, parameters, sessionId, execute, snapshot, start, wait, block,
        restart: async () => { await supervisor.shutdown(); supervisor = new Supervisor(options); return snapshot(); } };
}

test('edit/delete preserve immutable model output, activities and real artifacts without any execution', async t => {
    const f = await fixture(t); const run = await f.start('write'); const original = await f.snapshot();
    assert.ok(run.finishedAt); assert.ok(Date.parse(run.finishedAt!) >= Date.parse(run.createdAt));
    const count = f.requests.length;
    await f.execute({ type: 'edit-reply', runId: run.id, output: 'corrected response\n\nwith exact whitespace' });
    let state = await f.restart(); const edited = state.runs.find(item => item.id === run.id)!;
    assert.equal(edited.output, run.output); assert.deepEqual(edited.activities, run.activities); assert.deepEqual(state.artifacts, original.artifacts);
    assert.equal(edited.history?.editedOutput, 'corrected response\n\nwith exact whitespace'); assert.equal(edited.finishedAt, run.finishedAt);
    assert.equal(f.requests.length, count); assert.equal(readFileSync(join(f.project, 'edit.txt'), 'utf8'), 'actual file edit');
    await f.start('next'); assert.equal(f.requests.at(-1).messages.find((message: any) => message.role === 'assistant').content, edited.history!.editedOutput);
    await f.execute({ type: 'delete-reply', runId: run.id }); state = await f.restart();
    assert.equal(state.runs.find(item => item.id === run.id)?.history?.deleted, true); assert.deepEqual(state.artifacts, original.artifacts);
    await f.start('third');
    assert.ok(f.requests.at(-1).messages.some((message: any) => message.role === 'user' && message.content === 'write'));
    assert.ok(!f.requests.at(-1).messages.some((message: any) => message.content === edited.history!.editedOutput));
});

test('regenerate uses current selection/controls and locked Agent; retries never duplicate old context', async t => {
    const f = await fixture(t); const first = await f.start('first'); const failed = await f.start('fail'); assert.equal(failed.state, 'failed');
    await assert.rejects(f.execute({ type: 'regenerate-run', runId: first.id }), /最后一轮/);
    await f.execute({ type: 'set-session-controls', sessionId: f.sessionId, revision: 0, controls: { permissionMode: 'readonly', reasoningEffort: 'high' } });
    f.settings.profiles[0].instructions = 'Changed profile must not replace lock';
    const started = await f.execute({ type: 'regenerate-run', runId: failed.id, selection: { endpointId: 'fixture', modelId: 'two' } });
    const retry = started.runs.at(-1)!; const done = await f.wait(retry.id);
    assert.equal(done.runs.at(-1)!.state, 'completed'); assert.equal(retry.retryOfRunId, failed.id); assert.equal(retry.input, failed.input);
    assert.equal(retry.effective.modelId, 'two'); assert.equal(retry.effective.agentInstructions, first.effective.agentInstructions);
    assert.equal(retry.effective.permissionMode, 'readonly'); assert.equal(retry.effective.modelParameters?.reasoningEffort, 'high');
    assert.deepEqual(f.requests.at(-1).messages.filter((message: any) => message.role !== 'system'), [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer first' }, { role: 'user', content: 'fail' }]);
    assert.deepEqual(visibleRootRuns(done.runs, f.sessionId).map(run => run.id), [first.id, retry.id]);
    await assert.rejects(f.execute({ type: 'regenerate-run', runId: failed.id }), /最后一轮/);
    await f.execute({ type: 'delete-reply', runId: retry.id });
    assert.equal(latestVisibleRootRun((await f.snapshot()).runs, f.sessionId)?.id, retry.id);
    await assert.rejects(f.execute({ type: 'regenerate-run', runId: first.id }), /最后一轮/);
});

test('branch copies only visible text through cutoff with independent edits and explicit new controls', async t => {
    const f = await fixture(t); const first = await f.start('first'); const second = await f.start('second'); await f.start('later');
    await f.execute({ type: 'edit-reply', runId: first.id, output: 'edited first' }); await f.execute({ type: 'delete-reply', runId: second.id });
    const branched = await f.execute({ type: 'create-session', title: 'branch', directory: null, branchFromRunId: second.id,
        selection: { endpointId: 'fixture', modelId: 'two' }, agentId: 'default', controls: { permissionMode: 'readonly', reasoningEffort: 'low' } });
    const branch = branched.sessions.at(-1)!;
    assert.equal(branch.branchFromRunId, second.id); assert.equal(branch.directory, null); assert.equal(branch.requested.modelId, 'two');
    assert.deepEqual(branch.branchMessages, [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'edited first' }, { role: 'user', content: 'second' }]);
    assert.equal(branch.controls?.permissionMode, 'readonly');
    await f.execute({ type: 'edit-reply', runId: first.id, output: 'changed after branch' });
    await f.start('branch task', branch.id);
    assert.deepEqual(f.requests.at(-1).messages.filter((message: any) => message.role !== 'system'), [...branch.branchMessages!, { role: 'user', content: 'branch task' }]);
    assert.deepEqual((await f.restart()).sessions.find(session => session.id === branch.id)?.branchMessages, branch.branchMessages);
    await f.execute({ type: 'edit-reply', runId: first.id, output: '字'.repeat(400000) });
    const count = (await f.snapshot()).sessions.length;
    await assert.rejects(f.execute({ type: 'create-session', title: 'oversized', directory: null, branchFromRunId: first.id, selection: { endpointId: 'fixture', modelId: 'one' } }), /1 MB/);
    assert.equal((await f.snapshot()).sessions.length, count);
});

test('regenerate and branch recheck endpoint-await races; live sessions reject history mutations', async t => {
    const f = await fixture(t); const original = await f.start('first');
    let blocked = f.block(); const pending = f.execute({ type: 'regenerate-run', runId: original.id }); await blocked.hit;
    await f.execute({ type: 'edit-reply', runId: original.id, output: 'changed during resolver' }); blocked.release();
    await assert.rejects(pending, /历史已更新/);
    blocked = f.block(); const branchPending = f.execute({ type: 'create-session', title: 'branch', directory: null, branchFromRunId: original.id, selection: { endpointId: 'fixture', modelId: 'one' } }); await blocked.hit;
    await f.execute({ type: 'delete-reply', runId: original.id }); blocked.release(); await assert.rejects(branchPending, /历史已更新/);
    const last = await f.start('next'); blocked = f.block();
    const one = f.execute({ type: 'regenerate-run', runId: last.id }); const two = f.execute({ type: 'regenerate-run', runId: last.id }); await blocked.hit; blocked.release();
    const results = await Promise.allSettled([one, two]); assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const newest = (await f.snapshot()).runs.at(-1)!;
    await assert.rejects(f.execute({ type: 'edit-reply', runId: last.id, output: 'cannot race execution' }), /正在运行/);
    await f.wait(newest.id);
});

test('history IPC exact fields and bounded output reject malformed operations', () => {
    assert.equal(parseCommand({ type: 'edit-reply', runId: 'id', output: '' }).type, 'edit-reply');
    for (const bad of [{ type: 'edit-reply', runId: 'id', output: null }, { type: 'edit-reply', runId: 'id', output: 'x'.repeat(1_000_001) }, { type: 'delete-reply', runId: 'id', undo: true }, { type: 'regenerate-run', runId: 'id', input: 'override' }, { type: 'create-session', title: 'branch', directory: null, branchFromRunId: 2 }]) assert.throws(() => parseCommand(bad));
});

test('branch locks source Agent identity before its first run while model and session controls remain independent', async t => {
    const f = await fixture(t); const source = await f.start('source');
    await assert.rejects(f.execute({ type: 'create-session', title: 'bad runtime', directory: null, branchFromRunId: source.id }), /运行/);
    await assert.rejects(f.execute({ type: 'create-session', title: 'bad Agent', directory: null, branchFromRunId: source.id, selection: { endpointId: 'fixture', modelId: 'two' }, agentId: 'other' }), /Agent|智能体/);
    const state = await f.execute({ type: 'create-session', title: 'branch', directory: null, branchFromRunId: source.id, selection: { endpointId: 'fixture', modelId: 'two' }, controls: { permissionMode: 'readonly', reasoningEffort: 'high' } });
    const branch = state.sessions.at(-1)!;
    assert.equal(branch.branchAgent?.agentInstructions, 'Original agent');
    f.settings.profiles.splice(0); await f.restart();
    await assert.rejects(f.execute({ type: 'start-run', sessionId: branch.id, input: 'switch', agentId: 'other' }), /Agent|智能体/);
    await assert.rejects(f.execute({ type: 'start-run', sessionId: branch.id, input: 'local', selection: null }), /运行/);
    const run = await f.start('follow source', branch.id);
    assert.equal(run.effective.agentId, source.effective.agentId); assert.equal(run.effective.agentInstructions, 'Original agent');
    assert.equal(run.effective.modelId, 'two'); assert.equal(run.effective.permissionMode, 'readonly');
    assert.equal(run.effective.modelParameters?.reasoningEffort, 'high');
});

test('conversation window applies to branch and local turns together, including deleted user-only turns', async t => {
    const f = await fixture(t); const run = await f.start('first');
    const state = await f.snapshot();
    state.sessions[0].branchMessages = [{ role: 'user', content: 'branch one' }, { role: 'assistant', content: 'branch answer' }, { role: 'user', content: 'branch deleted' }];
    assert.deepEqual(conversationMessages(state, f.sessionId, { historyTurns: 0 }), []);
    assert.deepEqual(conversationMessages(state, f.sessionId, { historyTurns: 1 }), [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'answer first' }]);
    assert.deepEqual(conversationMessages(state, f.sessionId, { historyTurns: 2 }), [{ role: 'user', content: 'branch deleted' }, { role: 'user', content: 'first' }, { role: 'assistant', content: 'answer first' }]);
    assert.throws(() => conversationMessages(state, f.sessionId, { throughRunId: 'missing' }), /不存在/);
    const next: RunRecord = { ...run, id: 'new-attempt', state: 'running', retryOfRunId: run.id, activities: [], output: '', effective: { ...run.effective, modelParameters: { ...defaultModelParameters(), historyTurns: 1 } } };
    state.runs.push(next);
    assert.deepEqual(parentConversation(state, next.id), [{ role: 'user', content: 'branch deleted' }, { role: 'user', content: 'first' }]);
    state.runs[0].history = { editedOutput: 'visible edit' };
    next.retryOfRunId = undefined;
    assert.deepEqual(parentConversation(state, next.id), [{ role: 'user', content: 'first' }, { role: 'assistant', content: 'visible edit' }, { role: 'user', content: 'first' }]);
    state.runs[0].history = { deleted: true };
    assert.deepEqual(parentConversation(state, next.id), [{ role: 'user', content: 'first' }, { role: 'user', content: 'first' }]);
});
