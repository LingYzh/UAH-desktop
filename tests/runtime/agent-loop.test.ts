import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { defaultAgentSettings } from '../../src/shared/agents';
import { parsePromptProfile } from '../../src/shared/conditional-prompts';
import { parseCommand, type Snapshot, type RuntimeEvent, type ApprovalIdentity } from '../../src/shared/contracts';
import type { PermissionMode } from '../../src/shared/permissions';
import type { TranscriptEvent } from '../../src/shared/harness-contracts';

interface Message { role: string; content?: string; tool_call_id?: string; }
interface Body { model: string; messages: Message[]; tools?: unknown[]; reasoning_effort?: string; }
interface Call { name: string; args: unknown; }
function answer(response: ServerResponse, text: string, calls: Call[] = [], reasoning = '') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = { ...(text ? { content: text } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, handler: (body: Body, response: ServerResponse, number: number) => void | Promise<void>, mode: PermissionMode = 'manual', toolsSupported?: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'uah-loop-')); const project = join(root, 'project'); mkdirSync(project);
    const requests: Body[] = []; const errors: unknown[] = []; const events: RuntimeEvent[] = [];
    const settings = defaultAgentSettings(); settings.subagents.enabled = true; settings.profiles[0].instructions = 'ROOT INSTRUCTIONS';
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        try { const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body; requests.push(body); await handler(body, response, requests.length); }
        catch (error) { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const options = { dataDirectory: join(root, 'data'), delayMs: 0, onEvent: (event: RuntimeEvent) => events.push(event), getAgentSettings: () => settings,
        resolveAgent: (id: string) => { const profile = settings.profiles.find(item => item.id === id); if (!profile) throw new Error('Missing profile'); return profile; },
        resolveConnection: async (id: string) => ({ id, name: 'Local fixture', protocol: 'openai-chat' as const, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture-only-key', enabled: true, models: ['root-model', 'child-model'], revision: 1,
            ...(toolsSupported === undefined ? {} : { modelDetails: [{ id: 'root-model', tools: toolsSupported }] }) }) };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-loop-')); rmSync(target, { recursive: true, force: true }); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Loop test', directory: project, selection: { endpointId: 'fixture', modelId: 'root-model' }, controls: { permissionMode: mode, reasoningEffort: 'default' }, agentId: 'default' });
    const sessionId = created.sessions[0].id;
    const start = async (input = 'ROOT TASK') => { const snapshot = await supervisor.execute({ type: 'start-run', sessionId, input }); return snapshot.runs.filter(run => !run.parentRunId).at(-1)!; };
    const snapshot = () => supervisor.execute({ type: 'snapshot' });
    const wait = async (predicate: (value: Snapshot) => boolean) => { for (let i = 0; i < 400; i++) { const state = await snapshot(); if (predicate(state)) return state; await delay(10); } throw new Error(`Loop fixture timed out: ${JSON.stringify(await snapshot())}`); };
    const restart = async (afterShutdown?: () => void) => { await supervisor.shutdown(); afterShutdown?.(); supervisor = new Supervisor(options); return snapshot(); };
    return { root, project, requests, settings, events, start, snapshot, wait, restart, execute: (command: Parameters<Supervisor['execute']>[0]) => supervisor.execute(command) };
}
function identity(value: ApprovalIdentity): ApprovalIdentity { const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = value; return { runtimeId, sessionId, runId, turnId, requestId, policyVersion }; }
const toolMessages = (body: Body) => body.messages.filter(message => message.role === 'tool');

test('applied write with failed artifact recording stops the batch and persists a reconciliation gate', async t => {
    const original = RuntimeStore.prototype.commit;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.artifacts?.length) throw new Error('fixture private disk failure');
        return original.call(this, changes);
    });
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, '', [
            { name: 'write_file', args: { path: 'first.txt', content: 'applied', expectedContent: null } },
            { name: 'write_file', args: { path: 'second.txt', content: 'must not happen', expectedContent: null } },
        ]);
        else {
            const names = (body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name);
            assert.ok(!names.includes('write_file') && !names.includes('run_command') && !names.includes('spawn_agent'));
            answer(response, 'Read-only followup.');
        }
    }, 'accept-edits');
    const run = await f.start();
    const failed = await f.wait(state => state.runs.find(item => item.id === run.id)?.state === 'failed');
    const saved = failed.runs.find(item => item.id === run.id)!;
    assert.equal(saved.harnessState, 'recording_failed');
    assert.equal(saved.activities?.find(item => item.kind === 'tool')?.tool?.outcome?.effectState, 'confirmed');
    assert.equal(saved.activities?.find(item => item.kind === 'tool')?.tool?.outcome?.recordingState, 'failed');
    assert.equal(readFileSync(join(f.project, 'first.txt'), 'utf8'), 'applied');
    assert.equal(existsSync(join(f.project, 'second.txt')), false);
    assert.equal(f.requests.length, 1);
    assert.ok(!JSON.stringify(saved).includes('fixture private disk failure'));
    await f.restart();
    const followup = await f.start('inspect failure');
    await f.wait(state => state.runs.find(item => item.id === followup.id)?.state === 'completed');
    assert.equal(f.requests.length, 2);
});

test('read roundtrip streams reasoning and text, persists ordered activities and restarts terminal history', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, 'Checking. ', [{ name: 'read_file', args: { path: 'input.txt' } }], 'Need to inspect the file.');
        else { assert.equal(toolMessages(body).at(-1)?.content, 'workspace data'); answer(response, 'Done.'); }
    });
    writeFileSync(join(f.project, 'input.txt'), 'workspace data'); const run = await f.start();
    const done = await f.wait(state => state.runs[0].state === 'completed');
    assert.equal(done.runs[0].output, 'Checking. Done.');
    assert.deepEqual(done.runs[0].activities?.map(activity => activity.kind), ['text', 'reasoning', 'tool', 'text']);
    assert.ok(done.runs[0].activities?.every(activity => activity.status === 'completed'));
    assert.match(done.runs[0].activities!.find(activity => activity.kind === 'tool')!.content, /workspace data/);
    const { outcome, ...legacyTool } = done.runs[0].activities!.find(activity => activity.kind === 'tool')!.tool!;
    assert.deepEqual(legacyTool, { name: 'read_file', arguments: { path: 'input.txt' }, result: 'workspace data', isError: false });
    assert.equal(outcome?.recordingState, 'durable');
    assert.equal(outcome?.effectState, 'not_started');
    assert.equal(done.approvals.length, 0); assert.equal(done.artifacts.length, 0);
    const restored = await f.restart(); assert.deepEqual(restored.runs.find(item => item.id === run.id), done.runs[0]);
});

for (const decision of ['approve', 'reject'] as const) test(`manual write approval ${decision} returns result and preserves snapshot provenance`, async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, '', [{ name: 'write_file', args: { path: 'edited.txt', content: 'new', expectedContent: 'old' } }]);
        else { assert.match(toolMessages(body).at(-1)!.content!, decision === 'approve' ? /File written/ : /denied/); answer(response, 'Finished.'); }
    });
    const file = join(f.project, 'edited.txt'); writeFileSync(file, 'old'); const run = await f.start();
    const pending = await f.wait(state => state.approvals.some(item => item.status === 'pending'));
    assert.equal(readFileSync(file, 'utf8'), 'old'); assert.equal(pending.runs[0].state, 'approval');
    assert.equal(pending.runs[0].activities?.[0].status, 'approval'); assert.equal(pending.approvals[0].path, file);
    await f.execute({ type: 'resolve-approval', identity: identity(pending.approvals[0]), decision });
    const done = await f.wait(state => state.runs[0].state === 'completed');
    assert.equal(done.approvals[0].status, decision === 'approve' ? 'approved' : 'rejected');
    assert.equal(readFileSync(file, 'utf8'), decision === 'approve' ? 'new' : 'old');
    assert.equal(done.artifacts.length, decision === 'approve' ? 1 : 0);
    if (decision === 'approve') { const artifact = done.artifacts[0]; assert.equal(artifact.runId, run.id); assert.equal(artifact.oldContent, 'old'); assert.equal(artifact.newContent, 'new'); assert.equal(artifact.path, file); assert.equal(done.runs[0].activities?.[0].tool?.artifactId, artifact.id); }
    else assert.equal(done.runs[0].activities?.[0].status, 'failed');
    assert.equal(done.runs[0].activities?.[0].tool?.isError, decision === 'reject');
    assert.deepEqual((await f.restart()).runs.find(item => item.id === run.id), done.runs[0]);
});

test('readonly catalog excludes writes and forged requests fail without approval or file creation', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, '', [{ name: 'write_file', args: { path: 'denied.txt', content: 'x', expectedContent: null } }]);
        else { assert.match(toolMessages(body).at(-1)!.content!, /Permission mode denies/); answer(response, 'Cannot write.'); }
    }, 'readonly');
    await f.start(); const done = await f.wait(state => state.runs[0].state === 'failed');
    assert.match(done.runs[0].error!, /不支持的工具/);
    assert.equal(f.requests.length, 1);
    assert.equal(done.approvals.length, 0); assert.equal(done.artifacts.length, 0); assert.equal(existsSync(join(f.project, 'denied.txt')), false);
});

test('two writes to the same path retain distinct exact activity-artifact mappings after restart', async t => {
    const f = await fixture(t, (_body, response, number) => {
        if (number === 1) answer(response, '', [
            { name: 'write_file', args: { path: 'twice.txt', expectedContent: 'old', content: 'middle' } },
            { name: 'write_file', args: { path: 'twice.txt', expectedContent: 'middle', content: 'final' } },
        ]);
        else answer(response, 'Done.');
    }, 'accept-edits');
    writeFileSync(join(f.project, 'twice.txt'), 'old');
    const run = await f.start();
    const done = await f.wait(state => state.runs[0].state === 'completed');
    const tools = done.runs[0].activities!.filter(item => item.kind === 'tool');
    assert.equal(tools.length, 2);
    assert.notEqual(tools[0].tool!.artifactId, tools[1].tool!.artifactId);
    assert.deepEqual(tools.map(item => done.artifacts.find(artifact => artifact.id === item.tool!.artifactId)?.newContent), ['middle', 'final']);
    assert.deepEqual((await f.restart()).runs.find(item => item.id === run.id), done.runs[0]);
});

test('stop while write approval is pending expires approval and cannot resume or write', async t => {
    const f = await fixture(t, (_body, response) => answer(response, '', [{ name: 'write_file', args: { path: 'cancelled.txt', content: 'x', expectedContent: null } }]));
    const run = await f.start(); const pending = await f.wait(state => state.approvals[0]?.status === 'pending');
    await assert.rejects(f.execute({ type: 'edit-reply', runId: run.id, output: 'cannot edit a tool approval' }), /已结束/);
    await assert.rejects(f.execute({ type: 'delete-reply', runId: run.id }), /已结束/);
    await assert.rejects(f.execute({ type: 'regenerate-run', runId: run.id }), /已结束/);
    await assert.rejects(f.execute({ type: 'create-session', title: 'invalid live branch', directory: null, branchFromRunId: run.id }), /已结束/);
    const stopped = await f.execute({ type: 'stop-run', runId: run.id });
    assert.equal(stopped.runs[0].state, 'stopped'); assert.equal(stopped.approvals[0].status, 'expired');
    assert.equal(stopped.runs[0].activities?.[0].status, 'stopped');
    assert.equal(existsSync(join(f.project, 'cancelled.txt')), false); assert.equal(f.requests.length, 1);
    await assert.rejects(f.execute({ type: 'resolve-approval', identity: identity(pending.approvals[0]), decision: 'approve' }), /pending|stale/);
});

test('inherit, preset and inline children preserve correlated wait results without impersonating later root answers', async t => {
    let rootRound = 0;
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user?.startsWith('CHILD')) { answer(response, `PRIVATE ${user}`); return; }
        rootRound++;
        if (rootRound === 1) answer(response, '', [{ name: 'list_agent_presets', args: {} }]);
        else if (rootRound === 2) { assert.match(toolMessages(body).at(-1)!.content!, /preset/); answer(response, '', [
            { name: 'spawn_agent', args: { prompt: 'CHILD INHERIT', agent: { type: 'inherit' }, context: { mode: 'none' }, reasoningEffort: 'low' } },
            { name: 'spawn_agent', args: { prompt: 'CHILD PRESET', agent: { type: 'preset', id: 'preset' }, context: { mode: 'none' } } },
            { name: 'spawn_agent', args: { prompt: 'CHILD INLINE', agent: { type: 'inline', name: 'Temporary', instructions: 'INLINE INSTRUCTIONS' }, modelId: 'child-model', permissionMode: 'readonly', context: { mode: 'selected', messages: [{ role: 'user', content: 'SELECTED HISTORY' }] }, reasoningEffort: 'high' } },
        ]); }
        else if (rootRound === 3) { const ids = toolMessages(body).map(message => { try { return JSON.parse(message.content!).agentId; } catch { return undefined; } }).filter(Boolean); assert.equal(ids.length, 3); answer(response, '', [{ name: 'wait_agents', args: { agentIds: ids } }]); }
        else if (rootRound === 4) { const results = JSON.parse(toolMessages(body).at(-1)!.content!); assert.equal(results.length, 3); assert.ok(results.every((item: { status: string; output: string }) => item.status === 'completed' && item.output.startsWith('PRIVATE CHILD'))); answer(response, 'ROOT FINAL'); }
        else {
            assert.ok(!body.messages.some(message => message.role === 'assistant' && String(message.content).includes('PRIVATE CHILD')));
            assert.ok(toolMessages(body).some(message => String(message.content).includes('PRIVATE CHILD')));
            answer(response, 'SECOND FINAL');
        }
    }, 'accept-edits');
    f.settings.profiles.push({ id: 'preset', name: 'Preset', kind: 'subagent', description: '', instructions: 'PRESET INSTRUCTIONS', enabled: true, allowDelegation: false, model: { endpointId: 'fixture', modelId: 'child-model' } });
    const root = await f.start(); const done = await f.wait(state => state.runs.find(run => run.id === root.id)?.state === 'completed');
    const children = done.runs.filter(run => run.parentRunId === root.id); assert.equal(children.length, 3);
    assert.ok(children.every(run => run.depth === 1 && run.sessionId === root.sessionId && run.state === 'completed'));
    assert.deepEqual(children.map(run => [run.effective.agentId, run.effective.agentInstructions, run.effective.modelId, run.effective.permissionMode, run.effective.modelParameters?.reasoningEffort]), [
        ['default', 'ROOT INSTRUCTIONS', 'root-model', 'accept-edits', 'low'], ['preset', 'PRESET INSTRUCTIONS', 'child-model', 'accept-edits', 'default'], ['inline', 'INLINE INSTRUCTIONS', 'child-model', 'readonly', 'high'],
    ]);
    assert.deepEqual(children[2].contextMessages, [{ role: 'user', content: 'SELECTED HISTORY' }]);
    const ledger = new RuntimeStore(join(f.root, 'data'));
    try {
        const events = ledger.readJournal(root.sessionId, 0, 1000);
        for (const child of children) {
            const receipts = events.filter((event): event is Extract<TranscriptEvent, { type: 'delegation.delivery' }> => event.type === 'delegation.delivery' && event.payload.childRunId === child.id);
            assert.deepEqual(receipts.map(event => event.payload.stage), ['delivered', 'prepared', 'sent', 'consumed']);
            assert.equal(new Set(receipts.map(event => event.payload.deliveryId)).size, 1);
            assert.ok(events.some(event => event.eventId === receipts[0].payload.resultEventId && event.run.runId === child.id && event.type === 'run.state'));
            const consumed = receipts.at(-1)!;
            assert.ok(events.some(event => event.type === 'response.terminal' && event.payload.attemptId === consumed.payload.attemptId && event.payload.status === 'completed' && event.sessionSeq < consumed.sessionSeq));
        }
    } finally { ledger.close(); }
    assert.equal(done.runs[0].activities?.filter(item => item.kind === 'agent').length, 3);
    const second = await f.start('SECOND ROOT'); await f.wait(state => state.runs.find(run => run.id === second.id)?.state === 'completed');
});

test('failed response after child delivery leaves durable receipt unconsumed', async t => {
    let parentRound = 0;
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD RECEIPT') { answer(response, 'Child complete.'); return; }
        parentRound++;
        if (parentRound === 1) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD RECEIPT', agent: { type: 'inherit' }, permissionMode: 'readonly' } }]);
        else if (parentRound === 2) answer(response, 'Provisional parent answer.');
        else { response.writeHead(500); response.end('fixture request failed'); }
    });
    const run = await f.start();
    await f.wait(state => state.runs.find(item => item.id === run.id)?.state === 'failed');
    const ledger = new RuntimeStore(join(f.root, 'data'));
    try {
        const receipts = ledger.readJournal(run.sessionId, 0, 1000).filter((event): event is Extract<TranscriptEvent, { type: 'delegation.delivery' }> => event.type === 'delegation.delivery');
        assert.ok(receipts.some(event => event.payload.stage === 'delivered'));
        assert.ok(receipts.some(event => event.payload.stage === 'prepared'));
        assert.ok(!receipts.some(event => event.payload.stage === 'consumed'));
        assert.equal(new Set(receipts.map(event => event.payload.deliveryId)).size, 1);
    } finally { ledger.close(); }
});

test('permission escalation is rejected before any child endpoint request', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD ESCALATE', agent: { type: 'inherit' }, permissionMode: 'bypass' } }]);
        else { assert.match(toolMessages(body).at(-1)!.content!, /不能超过父代理/); answer(response, 'Denied.'); }
    }, 'readonly');
    await f.start(); const done = await f.wait(state => state.runs[0].state === 'completed');
    assert.equal(done.runs.length, 1); assert.equal(f.requests.length, 2);
});

test('maximum depth blocks grandchildren and inherited context excludes historical children', async t => {
    let rootRound = 0;
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD DEPTH') {
            assert.ok(!(body.tools || []).some(value => (value as { function: { name: string } }).function.name === 'spawn_agent'));
            assert.match(body.messages.find(message => message.role === 'system')?.content || '', /UAH_MODULE:delegation.unavailable:v1/);
            assert.doesNotMatch(body.messages[0].content || '', /UAH_MODULE:delegation.spawn:v1/);
            answer(response, 'PRIVATE HISTORIC CHILD');
        }
        else if (user === 'CHILD NEXT') { assert.ok(!JSON.stringify(body.messages).includes('PRIVATE HISTORIC CHILD')); assert.ok(!body.messages.some(message => message.content === 'CHILD DEPTH')); answer(response, 'Next child.'); }
        else if (++rootRound === 1) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD DEPTH', agent: { type: 'inherit' } } }]);
        else if (rootRound === 2) answer(response, 'First root.');
        else if (rootRound === 3) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD NEXT', agent: { type: 'inherit' }, context: { mode: 'all' } } }]);
        else answer(response, 'Second root.');
    });
    const first = await f.start(); await f.wait(state => state.runs.find(run => run.id === first.id)?.state === 'completed');
    const second = await f.start('SECOND ROOT'); const done = await f.wait(state => state.runs.find(run => run.id === second.id)?.state === 'completed');
    assert.equal(done.runs.length, 4); assert.ok(done.runs.every(run => run.state === 'completed'));
});

test('concurrent child bound rejects extra child; root stop cancels owned pending child', async t => {
    let rounds = 0;
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD STALL') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return; }
        if (++rounds === 1) answer(response, '', [
            { name: 'spawn_agent', args: { prompt: 'CHILD STALL', agent: { type: 'inherit' } } },
            { name: 'spawn_agent', args: { prompt: 'CHILD EXTRA', agent: { type: 'inherit' } } },
        ]);
        else { assert.match(toolMessages(body).at(-1)!.content!, /并发上限/); const id = JSON.parse(toolMessages(body)[0].content!).agentId; answer(response, '', [{ name: 'wait_agents', args: { agentIds: [id] } }]); }
    });
    f.settings.subagents.maxConcurrentThreads = 1;
    const root = await f.start(); await f.wait(state => state.runs[0].activities?.some(item => item.title === 'wait_agents') === true);
    const stopped = await f.execute({ type: 'stop-run', runId: root.id });
    assert.equal(stopped.runs.length, 2); assert.ok(stopped.runs.every(run => run.state === 'stopped'));
    assert.equal(f.requests.filter(body => body.messages.some(message => message.content === 'CHILD EXTRA')).length, 0);
});

test('restart recovers interrupted root and child runs and expires stale tool approval', async t => {
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD RECOVERY') answer(response, '', [{ name: 'write_file', args: { path: 'recovery.txt', content: 'x', expectedContent: null } }]);
        else if (!toolMessages(body).length) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD RECOVERY', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else { const agentId = JSON.parse(toolMessages(body)[0].content!).agentId; answer(response, '', [{ name: 'wait_agents', args: { agentIds: [agentId] } }]); }
    });
    const run = await f.start(); const pending = await f.wait(state => state.approvals[0]?.status === 'pending');
    const restored = await f.restart(() => {
        const database = new DatabaseSync(join(f.root, 'data', 'runtime.sqlite'));
        try {
            for (const item of pending.runs) { const row = database.prepare('SELECT MAX(sequence) AS sequence FROM events WHERE run_id = ?').get(item.id) as { sequence: number }; const restoredRun = { ...item, sequence: row.sequence }; database.prepare('UPDATE runs SET data = ?, state = ?, sequence = ? WHERE id = ?').run(JSON.stringify(restoredRun), item.state, row.sequence, item.id); }
            const approval = pending.approvals[0]; database.prepare('UPDATE approvals SET data = ?, status = ? WHERE request_id = ?').run(JSON.stringify(approval), 'pending', approval.requestId);
        } finally { database.close(); }
    });
    assert.equal(restored.runs.length, 2); assert.ok(restored.runs.every(item => item.state === 'stopped'));
    assert.ok(restored.runs.every(item => item.activities?.every(activity => !['running', 'approval'].includes(activity.status))));
    assert.equal(restored.approvals[0].status, 'expired'); assert.equal(existsSync(join(f.project, 'recovery.txt')), false);
    assert.equal(restored.runs.find(item => item.parentRunId)?.parentRunId, run.id);
});

test('root model failure stops owned children and expires their pending approval', async t => {
    const f = await fixture(t, async (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD FAILURE') answer(response, '', [{ name: 'write_file', args: { path: 'failure.txt', content: 'x', expectedContent: null } }]);
        else if (!toolMessages(body).length) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD FAILURE', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else { await f.wait(state => state.approvals.some(item => item.status === 'pending')); response.writeHead(500); response.end('fixture error'); }
    });
    await f.start(); const done = await f.wait(state => state.runs[0].state === 'failed');
    assert.equal(done.runs.length, 2); assert.equal(done.runs.find(item => item.parentRunId)?.state, 'stopped');
    assert.equal(done.approvals[0]?.status, 'expired'); assert.equal(existsSync(join(f.project, 'failure.txt')), false);
});

test('optional stop reason has strict bounded IPC validation and preserves exact user text', () => {
    assert.deepEqual(parseCommand({ type: 'stop-run', runId: 'run' }), { type: 'stop-run', runId: 'run' });
    const reason = ' 用户停止：调整任务范围。 ';
    assert.deepEqual(parseCommand({ type: 'stop-run', runId: 'run', reason }), { type: 'stop-run', runId: 'run', reason });
    assert.doesNotThrow(() => parseCommand({ type: 'stop-run', runId: 'run', reason: 'x'.repeat(2000) }));
    for (const invalid of ['', ' ', null, undefined, 5, 'x'.repeat(2001)]) assert.throws(() => parseCommand({ type: 'stop-run', runId: 'run', reason: invalid }));
    assert.throws(() => parseCommand({ type: 'stop-run', runId: 'run', reason: 'reason', unexpected: true }));
    assert.throws(() => parseCommand(Object.defineProperty({ type: 'stop-run', runId: 'run' }, 'reason', { enumerable: true, get: () => 'reason' })));
});

test('explicit child stop reason reaches waiting parent and survives restart with expired approval', async t => {
    let parentReceived = false;
    const reason = '需求已变更，请停止此子任务。';
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD STOP REASON') answer(response, '', [{ name: 'write_file', args: { path: 'child-reason.txt', content: 'x', expectedContent: null } }]);
        else if (!toolMessages(body).length) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD STOP REASON', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else if (toolMessages(body).length === 1) { const id = JSON.parse(toolMessages(body)[0].content!).agentId; answer(response, '', [{ name: 'wait_agents', args: { agentIds: [id] } }]); }
        else {
            const results = JSON.parse(toolMessages(body).at(-1)!.content!);
            assert.equal(results[0].status, 'stopped'); assert.equal(results[0].stopReason, reason); parentReceived = true;
            answer(response, 'Child stopped for the supplied reason.');
        }
    });
    const root = await f.start(); const pending = await f.wait(state => state.approvals[0]?.status === 'pending');
    const child = pending.runs.find(item => item.parentRunId === root.id)!;
    const stopped = await f.execute({ type: 'stop-run', runId: child.id, reason });
    assert.equal(stopped.runs.find(item => item.id === child.id)?.stopReason, reason);
    assert.equal(stopped.approvals[0].status, 'expired'); assert.equal(existsSync(join(f.project, 'child-reason.txt')), false);
    const completed = await f.wait(state => state.runs.find(item => item.id === root.id)?.state === 'completed');
    assert.equal(parentReceived, true); assert.equal(completed.runs.find(item => item.id === child.id)?.state, 'stopped');
    await f.execute({ type: 'stop-run', runId: child.id, reason: 'late replacement' });
    const restored = await f.restart(); assert.equal(restored.runs.find(item => item.id === child.id)?.stopReason, reason);
    assert.equal(restored.runs.find(item => item.id === root.id)?.stopReason, undefined);
});

for (const gate of ['enabled', 'global-off', 'agent-off', 'model-off'] as const) test(`request exposes truthful orchestration tool availability: ${gate}`, async t => {
    const f = await fixture(t, (_body, response) => answer(response, 'Inspected tools.'), 'readonly', gate === 'model-off' ? false : undefined);
    if (gate === 'global-off') f.settings.subagents.enabled = false;
    if (gate === 'agent-off') f.settings.profiles[0].allowDelegation = false;
    f.settings.profiles[0].instructions = defaultAgentSettings().profiles[0].instructions;
    await f.start(); await f.wait(state => state.runs[0].state === 'completed');
    const body = f.requests[0];
    const names = (body.tools || []).map(value => (value as { function: { name: string } }).function.name);
    for (const name of ['list_agent_presets', 'spawn_agent', 'wait_agents']) assert.equal(names.includes(name), gate === 'enabled');
    assert.equal(names.includes('read_file'), gate !== 'model-off');
    const instructions = body.messages.find(message => message.role === 'system')?.content || '';
    assert.ok(instructions.includes(parsePromptProfile(f.settings.profiles[0].instructions).instructions));
    assert.match(instructions, /UAH_MODULE:host.contract:v2/);
    assert.match(instructions, /UAH_MODULE:context.tools:v1/);
    for (const module of ['delegation.spawn', 'delegation.wait', 'delegation.presets', 'delegation.limits']) {
        assert.equal(instructions.includes(`UAH_MODULE:${module}:v1`), gate === 'enabled', module);
    }
    assert.equal(instructions.includes('UAH_MODULE:delegation.unavailable:v1'), gate !== 'enabled');
    assert.equal(instructions.includes('UAH_MODULE:tools.none:v1'), gate === 'model-off');
});

test('nonblocking spawn permits independent parent work, zero/positive wait snapshots, then terminal wait result', async t => {
    let childResponse: ServerResponse | undefined;
    let round = 0; let id = ''; let sawIndependentWork = false; let shortWaitReturned = false;
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD CONTROLLED') { childResponse = response; return; } // Explicit barrier: no child output until the test releases it.
        round++;
        if (round === 1) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD CONTROLLED', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else if (round === 2) { id = JSON.parse(toolMessages(body)[0].content!).agentId; answer(response, '', [{ name: 'read_file', args: { path: 'independent.txt' } }]); }
        else if (round === 3) { assert.equal(toolMessages(body).at(-1)?.content, 'Independent parent evidence'); sawIndependentWork = true; answer(response, '', [{ name: 'wait_agents', args: { agentIds: [id], timeoutMs: 0 } }]); }
        else if (round === 4) { const child = JSON.parse(toolMessages(body).at(-1)!.content!)[0]; assert.equal(child.status, 'running'); assert.equal(child.output, ''); answer(response, '', [{ name: 'wait_agents', args: { agentIds: [id], timeoutMs: 20 } }]); }
        else if (round === 5) { const child = JSON.parse(toolMessages(body).at(-1)!.content!)[0]; assert.equal(child.status, 'running'); assert.equal(child.output, ''); shortWaitReturned = true; answer(response, '', [{ name: 'wait_agents', args: { agentIds: [id], timeoutMs: 60000 } }]); }
        else { const child = JSON.parse(toolMessages(body).at(-1)!.content!)[0]; assert.equal(child.status, 'completed'); assert.equal(child.output, 'Controlled child result'); answer(response, 'Parent integrated result.'); }
    });
    writeFileSync(join(f.project, 'independent.txt'), 'Independent parent evidence');
    const root = await f.start();
    await f.wait(state => shortWaitReturned && !!childResponse && state.runs.find(item => item.id === root.id)?.activities?.filter(activity => activity.title === 'wait_agents').length === 3);
    assert.equal(sawIndependentWork, true); assert.ok(childResponse); answer(childResponse, 'Controlled child result');
    const done = await f.wait(state => state.runs.find(item => item.id === root.id)?.state === 'completed');
    assert.ok(done.runs.every(item => item.state === 'completed')); assert.equal(round, 6);
});

test('wait rejects invalid timeout values and a run that is not this parent direct child', async t => {
    let rootId = ''; let childResponse: ServerResponse | undefined; let checked = false;
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD VALIDATION') { childResponse = response; return; }
        const results = toolMessages(body);
        if (!results.length) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD VALIDATION', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else if (results.length === 1) {
            const id = JSON.parse(results[0].content!).agentId;
            answer(response, '', [
                ...[-1, '10', 0.5, 60001].map(timeoutMs => ({ name: 'wait_agents', args: { agentIds: [id], timeoutMs } })),
                { name: 'wait_agents', args: { agentIds: [rootId], timeoutMs: 0 } },
            ]);
        } else {
            for (const message of results.slice(1, 5)) assert.match(message.content!, /等待子代理参数无效/);
            assert.match(results.at(-1)!.content!, /直接启动的子代理/); checked = true; answer(response, 'Rejected invalid wait requests.');
        }
    });
    const root = await f.start(); rootId = root.id;
    await f.wait(() => checked && !!childResponse);
    assert.ok(childResponse); answer(childResponse, 'Validation child done');
    const done = await f.wait(state => state.runs.find(item => item.id === rootId)?.state === 'completed');
    assert.equal(done.runs[0].activities?.filter(activity => activity.title === 'wait_agents' && activity.status === 'failed').length, 5);
});

test('stop during a bounded wait aborts parent and owned paused child without awaiting the timeout', async t => {
    let parentRound = 0; let childStarted = false;
    const f = await fixture(t, (body, response) => {
        const user = body.messages.filter(message => message.role === 'user').at(-1)?.content;
        if (user === 'CHILD BOUNDED STOP') { childStarted = true; response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); return; }
        if (++parentRound === 1) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD BOUNDED STOP', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else { const id = JSON.parse(toolMessages(body)[0].content!).agentId; answer(response, '', [{ name: 'wait_agents', args: { agentIds: [id], timeoutMs: 60000 } }]); }
    });
    const root = await f.start(); await f.wait(state => childStarted && state.runs.find(item => item.id === root.id)?.activities?.some(activity => activity.title === 'wait_agents' && activity.status === 'running') === true);
    const stopped = await f.execute({ type: 'stop-run', runId: root.id });
    assert.equal(stopped.runs.length, 2); assert.ok(stopped.runs.every(item => item.state === 'stopped'));
    assert.equal(parentRound, 2);
});
