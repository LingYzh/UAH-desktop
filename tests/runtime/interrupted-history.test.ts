import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { defaultAgentSettings } from '../../src/shared/agents';
import { conversationMessages } from '../../src/shared/conversation-history';
import { parentConversation } from '../../src/shared/delegation';
import type { ApiProtocol } from '../../src/shared/endpoints';
import type { Snapshot } from '../../src/shared/contracts';

const named = (type: string, data: object = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
function reply(protocol: ApiProtocol, text: string, tool?: { name: string; args: object }): Response {
    let source: string;
    if (protocol === 'openai-chat') source = `data: ${JSON.stringify({ choices: [{ delta: tool ? { tool_calls: [{ index: 0, id: 'call', type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] } : { content: text }, finish_reason: tool ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`;
    else if (protocol === 'openai-responses') source = named('response.completed', { response: { status: 'completed', output: tool ? [{ type: 'function_call', id: 'call-item', call_id: 'call', name: tool.name, arguments: JSON.stringify(tool.args), status: 'completed' }] : [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] } });
    else source = named('message_start', { message: { content: [] } }) + named('content_block_start', { index: 0, content_block: tool ? { type: 'tool_use', id: 'call', name: tool.name, input: {} } : { type: 'text', text: '' } }) + named('content_block_delta', { index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(tool.args) } : { type: 'text_delta', text } }) + named('content_block_stop', { index: 0 }) + named('message_delta', { delta: { stop_reason: tool ? 'tool_use' : 'end_turn' } }) + named('message_stop');
    return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, handler: (body: any, signal?: AbortSignal) => Response | Promise<Response>, protocol: ApiProtocol = 'openai-chat') {
    const root = mkdtempSync(join(tmpdir(), 'uah-interrupted-')); const project = join(root, 'project'); mkdirSync(project);
    const original = globalThis.fetch; const requests: any[] = [];
    globalThis.fetch = async (_input, init) => { const body = JSON.parse(String(init?.body)); requests.push(body); return handler(body, init?.signal ?? undefined); };
    const settings = defaultAgentSettings(); settings.subagents.enabled = true;
    const options = { dataDirectory: join(root, 'data'), onEvent: () => {}, getAgentSettings: () => settings,
        resolveAgent: (id: string) => settings.profiles.find(profile => profile.id === id)!,
        resolveConnection: async (id: string) => ({ id, name: 'Offline', protocol, baseUrl: 'https://offline.invalid', apiKey: '', enabled: true, models: ['root', 'child'], revision: 1 }) };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); globalThis.fetch = original; rmSync(root, { recursive: true, force: true }); });
    const initial = await supervisor.execute({ type: 'create-session', title: 'Offline', directory: project, selection: { endpointId: 'offline', modelId: 'root' }, agentId: 'default', controls: { permissionMode: 'accept-edits', reasoningEffort: 'default' } });
    const sessionId = initial.sessions[0].id;
    const snapshot = () => supervisor.execute({ type: 'snapshot' });
    const wait = async (predicate: (state: Snapshot) => boolean) => { for (let i = 0; i < 300; i++) { const state = await snapshot(); if (predicate(state)) return state; await delay(5); } throw new Error('Offline timeout'); };
    const start = async (input: string) => (await supervisor.execute({ type: 'start-run', sessionId, input })).runs.filter(run => !run.parentRunId).at(-1)!;
    return { project, sessionId, requests, start, snapshot, wait, execute: (command: Parameters<Supervisor['execute']>[0]) => supervisor.execute(command), restart: async () => { await supervisor.shutdown(); supervisor = new Supervisor(options); } };
}

test('persisted successful write followed by failure retains original task and bounded host evidence after restart, delete removes summary', async t => {
    let request = 0;
    const f = await fixture(t, () => ++request === 1 ? reply('openai-chat', '', { name: 'write_file', args: { path: 'effect.txt', content: 'persisted effect', expectedContent: null } }) : request === 2 ? new Response('service failed', { status: 400 }) : reply('openai-chat', 'Continued'));
    const run = await f.start('ORIGINAL TASK'); const failed = await f.wait(state => state.runs[0].state === 'failed');
    assert.equal(readFileSync(join(f.project, 'effect.txt'), 'utf8'), 'persisted effect');
    await f.restart(); const next = await f.start('continue'); await f.wait(state => state.runs.find(item => item.id === next.id)?.state === 'completed');
    const sent = JSON.stringify(f.requests.at(-1).messages); assert.match(sent, /ORIGINAL TASK/); assert.match(sent, /UAH host interruption record/); assert.match(sent, new RegExp(failed.artifacts[0].id)); assert.match(sent, /HTTP 400/);
    assert.equal(f.requests.at(-1).messages.filter((item: any) => item.role === 'assistant').length, 0);
    const branched = await f.execute({ type: 'create-session', title: 'interrupted branch', directory: null, branchFromRunId: run.id, selection: { endpointId: 'offline', modelId: 'root' } });
    const branch = branched.sessions.at(-1)!;
    assert.equal(branch.branchMessages?.length, 1); assert.match(branch.branchMessages![0].content, /^ORIGINAL TASK\n\n\[UAH host interruption record\]/);
    assert.equal(conversationMessages(branched, branch.id, { historyTurns: 1 }).length, 1);
    await f.execute({ type: 'delete-reply', runId: run.id });
    const messages = conversationMessages(await f.snapshot(), f.sessionId, { includeFailed: true });
    assert.ok(messages.some(item => item.content === 'ORIGINAL TASK')); assert.ok(!JSON.stringify(messages).includes(failed.artifacts[0].id));
});

test('ordinary user messages resembling a host notice remain separate branch turns', async t => {
    const f = await fixture(t, () => reply('openai-chat', 'answer'));
    const state = await f.snapshot(); state.sessions[0].branchMessages = [{ role: 'user', content: 'first original task' }, { role: 'user', content: '[UAH host interruption record] user-authored text' }];
    assert.deepEqual(conversationMessages(state, f.sessionId, { historyTurns: 1 }), [state.sessions[0].branchMessages[1]]);
});

test('stopped parent history includes descendant artifact evidence, excludes reasoning, partial answers and deleted child state', async t => {
    const f = await fixture(t, () => reply('openai-chat', 'done'));
    await f.start('original'); const state = await f.wait(value => value.runs[0].state === 'completed');
    const run = state.runs[0]; run.state = 'stopped'; run.stopReason = 'user changed scope'; run.output = 'PARTIAL ANSWER'; run.activities = [{ id: 'reasoning', kind: 'reasoning', title: 'thinking', content: 'PRIVATE REASONING', status: 'stopped' }, { id: 'command', kind: 'tool', title: 'run_command', content: '', status: 'stopped', tool: { name: 'run_command', arguments: {} } }];
    const child = { ...run, id: 'child-evidence', parentRunId: run.id, state: 'failed' as const, output: 'PRIVATE CHILD', activities: [], error: 'child failed' }; state.runs.push(child);
    state.artifacts.push({ id: 'artifact-evidence', sessionId: f.sessionId, runId: child.id, turnId: child.turnId, path: 'child.txt', oldContent: null, newContent: 'child edit', hash: 'verified-hash', createdAt: child.createdAt });
    let serialized = JSON.stringify(conversationMessages(state, f.sessionId, { includeFailed: true }));
    assert.match(serialized, /artifact-evidence/); assert.match(serialized, /user changed scope/); assert.match(serialized, /Do not automatically replay/); assert.doesNotMatch(serialized, /PRIVATE REASONING|PARTIAL ANSWER|PRIVATE CHILD/);
    child.history = { deleted: true }; serialized = JSON.stringify(conversationMessages(state, f.sessionId, { includeFailed: true })); assert.doesNotMatch(serialized, /artifact-evidence|child failed/);
    const current = { ...run, id: 'current', state: 'running' as const, activities: [], output: '' }; state.runs.push(current);
    assert.match(JSON.stringify(parentConversation(state, current.id)), /user changed scope/);
    run.history = { deleted: true }; assert.doesNotMatch(JSON.stringify(conversationMessages(state, f.sessionId, { includeFailed: true })), /host interruption|user changed scope/);
});

test('stop after real persisted write survives restart and next request without replaying write', async t => {
    let requests = 0; let stalled = false;
    const f = await fixture(t, (_body, signal) => {
        if (++requests === 1) return reply('openai-chat', '', { name: 'write_file', args: { path: 'stopped.txt', content: 'already written', expectedContent: null } });
        if (requests === 2) { stalled = true; return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })); }
        return reply('openai-chat', 'Continued without writing');
    });
    const root = await f.start('write and continue original task'); await f.wait(state => stalled && state.artifacts.length === 1);
    await f.execute({ type: 'stop-run', runId: root.id, reason: 'pause here' }); await f.restart();
    const next = await f.start('continue'); const state = await f.wait(value => value.runs.find(item => item.id === next.id)?.state === 'completed');
    const sent = JSON.stringify(f.requests.at(-1).messages); assert.match(sent, /write and continue original task|pause here/); assert.match(sent, /Persisted file snapshot/); assert.match(sent, /stopped/);
    assert.equal(state.artifacts.length, 1); assert.equal(readFileSync(join(f.project, 'stopped.txt'), 'utf8'), 'already written'); assert.equal(requests, 3);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) for (const outcome of ['completed', 'failed', 'stopped'] as const) test(`${protocol}: late child ${outcome} triggers exactly one parent verification request`, async t => {
    let parentRequests = 0; let release!: (response: Response) => void;
    const f = await fixture(t, (body, signal) => {
        if (body.model === 'child') return new Promise<Response>((resolve, reject) => { release = resolve; signal?.addEventListener('abort', () => reject(new Error('Stopped')), { once: true }); });
        parentRequests++;
        if (parentRequests === 1) return reply(protocol, '', { name: 'spawn_agent', args: { prompt: 'child task', modelId: 'child', agent: { type: 'inherit' }, context: { mode: 'none' } } });
        if (parentRequests === 2) return reply(protocol, 'Premature final');
        assert.equal(parentRequests, 3);
        const messages = protocol === 'openai-responses' ? body.input : body.messages;
        const last = messages.at(-1); assert.equal(last.role, 'user'); const sent = JSON.stringify(last);
        assert.match(sent, /UAH host child terminal delivery/); assert.match(sent, new RegExp(outcome));
        if (outcome === 'completed') { assert.match(sent, /truncated/); assert.ok(sent.length < 15000); }
        return reply(protocol, 'Verified final');
    }, protocol);
    const root = await f.start('root task'); const waiting = await f.wait(state => parentRequests === 2 && !!release && state.runs.length === 2);
    const child = waiting.runs.find(item => item.parentRunId === root.id)!;
    if (outcome === 'stopped') await f.execute({ type: 'stop-run', runId: child.id, reason: 'scope changed' });
    else release(outcome === 'failed' ? new Response('late child failure', { status: 400 }) : reply(protocol, 'Child result ' + 'x'.repeat(10000)));
    const done = await f.wait(state => state.runs.find(item => item.id === root.id)?.state === 'completed');
    assert.equal(done.runs.find(item => item.id === child.id)?.state, outcome); assert.equal(parentRequests, 3); assert.match(done.runs[0].output, /Verified final/);
});

test('wait_agents terminal result already provided to parent is not delivered again', async t => {
    let requests = 0;
    const f = await fixture(t, body => {
        if (body.model === 'child') return reply('openai-chat', 'Consumed child result');
        if (++requests === 1) return reply('openai-chat', '', { name: 'spawn_agent', args: { prompt: 'child task', modelId: 'child', agent: { type: 'inherit' }, context: { mode: 'none' } } });
        if (requests === 2) {
            const id = JSON.parse(body.messages.find((item: any) => item.role === 'tool').content).agentId;
            return reply('openai-chat', '', { name: 'wait_agents', args: { agentIds: [id] } });
        }
        assert.equal(requests, 3); assert.doesNotMatch(JSON.stringify(body), /UAH host child terminal delivery/);
        assert.match(body.messages.filter((item: any) => item.role === 'tool').at(-1).content, /Consumed child result/);
        return reply('openai-chat', 'Verified through wait');
    });
    const root = await f.start('root task'); await f.wait(state => state.runs.find(item => item.id === root.id)?.state === 'completed'); assert.equal(requests, 3);
});

test('cancelling parent finalization propagates promptly to pending child', async t => {
    let requests = 0; let childRequested = false;
    const f = await fixture(t, (body, signal) => {
        if (body.model === 'child') { childRequested = true; return new Promise<Response>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true })); }
        return ++requests === 1 ? reply('openai-chat', '', { name: 'spawn_agent', args: { prompt: 'child task', modelId: 'child', agent: { type: 'inherit' }, context: { mode: 'none' } } }) : reply('openai-chat', 'Premature final');
    });
    const root = await f.start('root task'); await f.wait(() => requests === 2 && childRequested);
    const stopped = await f.execute({ type: 'stop-run', runId: root.id, reason: 'cancel all' }); assert.ok(stopped.runs.every(item => item.state === 'stopped')); assert.equal(requests, 2);
});
