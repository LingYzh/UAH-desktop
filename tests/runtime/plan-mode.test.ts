import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { defaultAgentSettings } from '../../src/shared/agents';
import { parseCommand, type Command, type Snapshot, type ApprovalIdentity } from '../../src/shared/contracts';
import type { PermissionMode } from '../../src/shared/permissions';
import { displayedReply, conversationMessages } from '../../src/shared/conversation-history';
import { RuntimeStore } from '../../src/runtime/store';
import { writePlanFile } from '../../src/runtime/plan-tools';
import { sessionHasFileChanges } from '../../src/shared/run-effects';

const originalPlan = '# Implementation plan\n\nRead src, compare alternatives, edit fixture.txt, then run regression tests.';
function answer(response: ServerResponse, content = '', calls: { name: string; args: unknown }[] = []) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = { ...(content ? { content } : {}), ...(calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : {}) };
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
async function fixture(t: { after: (fn: () => Promise<void>) => void }, handler: (body: any, response: ServerResponse, number: number) => void, mode: PermissionMode = 'plan', tools = true) {
    const root = mkdtempSync(join(tmpdir(), 'uah-plan-')); const project = join(root, 'project'); mkdirSync(project);
    const dataDirectory = join(root, 'data'); const requests: any[] = []; const errors: unknown[] = [];
    const settings = defaultAgentSettings(); settings.subagents.enabled = true; settings.profiles[0].instructions = 'Locked primary';
    let gate: Promise<void> | undefined; let hit: (() => void) | undefined;
    const server = createServer(async (request, response) => { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        try { const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body); handler(body, response, requests.length); } catch (error) { errors.push(error); response.destroy(); } });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const options = { dataDirectory, onEvent: () => {}, delayMs: 0, getAgentSettings: () => settings,
        resolveAgent: (id: string) => { const profile = settings.profiles.find(item => item.id === id); if (!profile) throw new Error('profile absent'); return profile; },
        resolveConnection: async (id: string) => { if (gate) { hit?.(); await gate; } return { id, name: 'fixture', protocol: 'openai-chat' as const, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'fixture', enabled: true, models: ['one', 'two'], revision: 1, modelDetails: [{ id: 'one', tools }, { id: 'two', tools }] }; } };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); assert.deepEqual(errors, []); rmSync(root, { recursive: true, force: true }); });
    const execute = (command: Command) => supervisor.execute(command);
    const initial = await execute({ type: 'create-session', title: 'Plan fixture', directory: project, selection: { endpointId: 'fixture', modelId: 'one' }, agentId: 'default', controls: { permissionMode: mode, reasoningEffort: 'default' } });
    const sessionId = initial.sessions[0].id;
    const snapshot = () => execute({ type: 'snapshot' });
    const wait = async (predicate: (state: Snapshot) => boolean) => { for (let index = 0; index < 300; index++) { const state = await snapshot(); if (predicate(state)) { await delay(10); return snapshot(); } await delay(10); } throw new Error('Plan fixture timeout'); };
    const start = async (input = 'Plan task') => (await execute({ type: 'start-run', sessionId, input })).runs.filter(item => !item.parentRunId).at(-1)!;
    const terminal = (id: string) => wait(state => ['completed', 'failed', 'stopped'].includes(state.runs.find(run => run.id === id)?.state || ''));
    const block = () => { let release!: () => void; gate = new Promise(resolve => { release = resolve; }); const entered = new Promise<void>(resolve => { hit = resolve; }); return { entered, release: () => { gate = undefined; hit = undefined; release(); } }; };
    return { root, dataDirectory, project, requests, settings, execute, snapshot, sessionId, start, wait, terminal, block, replacePersisted: async (mutate: (state: Snapshot) => Snapshot) => { await supervisor.shutdown(); const store = new RuntimeStore(dataDirectory); const state = mutate(store.readSnapshot()); store.commit({ sessions: state.sessions, runs: state.runs }); store.close(); supervisor = new Supervisor(options); return snapshot(); }, restart: async () => { await supervisor.shutdown(); supervisor = new Supervisor(options); return snapshot(); } };
}
const names = (body: any) => (body.tools || []).map((tool: any) => tool.function.name);
const results = (body: any) => body.messages.filter((message: any) => message.role === 'tool');
const runtimeContextMarker = '[UAH runtime context update v2]';
const stripRuntimeContextUpdate = (content: string): string => {
    const marker = content.indexOf(runtimeContextMarker);
    return marker < 0 ? content : content.slice(0, marker).trimEnd();
};
const lastSemanticMessage = (body: any) => body.messages.map((message: any) => ({
    ...message,
    ...(typeof message.content === 'string' ? { content: stripRuntimeContextUpdate(message.content) } : {}),
})).filter((message: any) => message.content).at(-1);
const lastTaskInput = (body: any) => body.messages.map((message: any) => ({
    ...message,
    ...(typeof message.content === 'string' ? { content: stripRuntimeContextUpdate(message.content) } : {}),
})).filter((message: any) => message.role === 'user' && message.content).at(-1)?.content;
const latestRuntimeContextUpdate = (body: any) => {
    const content = body.messages.filter((message: any) => typeof message.content === 'string' && message.content.includes(runtimeContextMarker)).at(-1)?.content ?? '';
    const marker = content.lastIndexOf(runtimeContextMarker);
    return marker < 0 ? '' : content.slice(marker);
};
function identity(value: ApprovalIdentity): ApprovalIdentity { const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = value; return { runtimeId, sessionId, runId, turnId, requestId, policyVersion }; }

test('real draft write/read/submit keeps an identity, rejects subsequent batch calls and waits for manual implementation approval', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) { assert.ok(!names(body).includes('write_file')); assert.ok(!names(body).includes('run_command')); answer(response, '', [{ name: 'write_plan', args: { content: 'First draft' } }, { name: 'write_plan', args: { content: originalPlan } }, { name: 'read_plan', args: {} }]); }
        else if (number === 2) { assert.equal(results(body).at(-1).content, originalPlan); answer(response, '', [{ name: 'submit_plan', args: {} }, { name: 'write_plan', args: { content: 'never overwrite submitted plan' } }]); }
        else if (number === 3) { assert.equal(body.model, 'two'); assert.ok(lastSemanticMessage(body).content.includes(originalPlan)); answer(response, '', [{ name: 'write_file', args: { path: 'fixture.txt', content: 'implemented', expectedContent: null } }]); }
        else { assert.equal(results(body).at(-1).content, 'File written.'); answer(response, 'Implementation verified.'); }
    });
    const run = await f.start(); const done = await f.terminal(run.id); const proposal = done.runs[0].plan!;
    assert.equal(proposal.status, 'proposed'); assert.equal(readFileSync(proposal.filePath, 'utf8'), originalPlan); assert.ok(proposal.hash);
    assert.equal(done.runs[0].output, ''); assert.equal(displayedReply(done.runs[0]), originalPlan);
    assert.equal(conversationMessages(done, f.sessionId).at(-1)?.content, originalPlan);
    assert.equal(f.requests.length, 2); assert.equal(existsSync(join(f.project, 'forged.txt')), false); assert.equal(sessionHasFileChanges(done, f.sessionId), false);
    assert.match(done.runs[0].activities!.at(-1)!.tool!.result!, /计划已提交/); assert.equal(done.runs[0].activities!.at(-1)!.status, 'failed');
    await f.restart();
    const started = await f.execute({ type: 'resolve-plan', runId: run.id, planId: proposal.id, decision: 'approve', permissionMode: 'manual', selection: { endpointId: 'fixture', modelId: 'two' } });
    const implementation = started.runs.at(-1)!;
    assert.equal(started.runs[0].plan?.status, 'approved'); assert.equal(started.runs[0].plan?.executionRunId, implementation.id);
    assert.equal(implementation.effective.permissionMode, 'manual'); assert.equal(implementation.effective.agentInstructions, 'Locked primary');
    const pending = await f.wait(state => state.approvals.some(approval => approval.status === 'pending'));
    assert.equal(existsSync(join(f.project, 'fixture.txt')), false);
    await f.execute({ type: 'resolve-approval', identity: identity(pending.approvals[0]), decision: 'approve' });
    const completed = await f.terminal(implementation.id); assert.equal(readFileSync(join(f.project, 'fixture.txt'), 'utf8'), 'implemented');
    assert.equal(sessionHasFileChanges(completed, f.sessionId), true);
    await assert.rejects(f.execute({ type: 'regenerate-run', runId: implementation.id }), /文件更改/);
});

test('revision starts with an independent seeded real file and preserves the submitted source file', async t => {
    const amended = `${originalPlan}\n\nAdd compatibility coverage.`;
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, 'Plan ready.', [{ name: 'submit_plan', args: { plan: originalPlan } }]);
        else if (number === 2) { assert.ok(lastSemanticMessage(body).content.includes('Add compatibility coverage')); answer(response, '', [{ name: 'read_plan', args: {} }]); }
        else { assert.equal(results(body).at(-1).content, originalPlan); answer(response, '', [{ name: 'write_plan', args: { content: amended } }, { name: 'submit_plan', args: {} }]); }
    });
    const run = await f.start(); const done = await f.terminal(run.id); const proposal = done.runs[0].plan!;
    assert.equal(displayedReply(done.runs[0]), `Plan ready.\n\n${originalPlan}`);
    const started = await f.execute({ type: 'resolve-plan', runId: run.id, planId: proposal.id, decision: 'revise', feedback: 'Add compatibility coverage' });
    const revision = started.runs.at(-1)!; assert.equal(revision.plan?.status, 'draft'); assert.equal(revision.plan?.content, originalPlan);
    const final = await f.terminal(revision.id); const revised = final.runs.at(-1)!;
    assert.notEqual(revised.plan?.filePath, proposal.filePath); assert.notEqual(revised.plan?.id, proposal.id);
    assert.equal(revised.plan?.status, 'proposed'); assert.equal(revised.plan?.content, amended);
    assert.equal(readFileSync(proposal.filePath, 'utf8'), originalPlan); assert.equal(final.runs[0].plan?.feedback, 'Add compatibility coverage');
});

test('approval validates files, controls and endpoint-await races without consuming rejected plans', async t => {
    const f = await fixture(t, (_body, response, number) => number === 1 ? answer(response, '', [{ name: 'submit_plan', args: { plan: originalPlan } }]) : answer(response, 'Done.'));
    const run = await f.start(); const state = await f.terminal(run.id); const plan = state.runs[0].plan!;
    const approve: Command = { type: 'resolve-plan', runId: run.id, planId: plan.id, decision: 'approve', permissionMode: 'accept-edits' };
    writeFileSync(plan.filePath, 'externally changed'); await assert.rejects(f.execute(approve), /文件已改变/);
    assert.equal((await f.snapshot()).runs[0].plan?.status, 'proposed'); assert.equal((await f.snapshot()).sessions[0].controls?.permissionMode, 'plan');
    writeFileSync(plan.filePath, originalPlan);
    await assert.rejects(f.execute({ ...approve, selection: { endpointId: 'fixture', modelId: 'missing' } }), /unavailable/);
    let blocked = f.block(); const pending = f.execute(approve); await blocked.entered; writeFileSync(plan.filePath, 'changed during endpoint lookup'); blocked.release(); await assert.rejects(pending, /文件已改变/);
    writeFileSync(plan.filePath, originalPlan); blocked = f.block(); const controlRace = f.execute(approve); await blocked.entered;
    await f.execute({ type: 'set-session-controls', sessionId: f.sessionId, revision: 0, controls: { permissionMode: 'plan', reasoningEffort: 'high' } }); blocked.release(); await assert.rejects(controlRace, /控制设置/);
    const outcomes = await Promise.allSettled([f.execute(approve), f.execute(approve)]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    const final = await f.terminal((await f.snapshot()).runs.at(-1)!.id); assert.equal(final.runs.length, 2);
    assert.equal(final.runs[1].effective.modelParameters?.reasoningEffort, 'high'); assert.equal(f.requests.length, 2);
});

test('enter mode persists and immediately denies remaining writes, while readonly cannot enter', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) { assert.ok(names(body).includes('enter_plan_mode')); answer(response, '', [{ name: 'enter_plan_mode', args: {} }, { name: 'write_file', args: { path: 'never.txt', content: 'x', expectedContent: null } }]); }
        else { assert.ok(!names(body).includes('write_file')); assert.ok(names(body).includes('write_plan')); assert.match(body.messages[0].content, /UAH_MODULE:plan.workflow:v1/); assert.match(body.messages[0].content, /当前权限：plan/); answer(response, '', [{ name: 'submit_plan', args: { plan: originalPlan } }]); }
    }, 'accept-edits');
    const run = await f.start(); const done = await f.terminal(run.id); assert.equal(done.runs[0].effective.permissionMode, 'plan');
    assert.equal(done.sessions[0].controls?.permissionMode, 'plan'); assert.equal(done.sessions[0].controlsRevision, 1); assert.equal(existsSync(join(f.project, 'never.txt')), false);
    const ro = await fixture(t, (body, response, number) => { assert.ok(!names(body).includes('enter_plan_mode')); if (number === 1) answer(response, '', [{ name: 'enter_plan_mode', args: {} }]); else answer(response, 'Readonly findings.'); }, 'readonly');
    const readonly = await ro.start(); const end = await ro.terminal(readonly.id); assert.equal(end.sessions[0].controls?.permissionMode, 'readonly'); assert.equal(end.runs[0].plan, undefined);
});

test('clarification and tool-incapable Plan models never fabricate drafts or approval submissions', async t => {
    for (const capable of [true, false]) {
        const f = await fixture(t, (body, response) => { if (!capable) assert.equal(body.tools, undefined); answer(response, 'Which existing flow should I preserve?'); }, 'plan', capable);
        const run = await f.start(); const end = await f.terminal(run.id);
        assert.equal(end.runs[0].plan, undefined); assert.equal(end.runs[0].output, 'Which existing flow should I preserve?');
        assert.equal(existsSync(join(f.dataDirectory, 'plans')), false);
    }
});

test('children remain readonly and cannot write/read/submit plans or approve root state', async t => {
    const f = await fixture(t, (body, response) => {
        const input = lastTaskInput(body);
        if (input === 'child exploration') {
            assert.ok(!names(body).some((name: string) => ['write_file', 'run_command', 'write_plan', 'read_plan', 'submit_plan', 'enter_plan_mode'].includes(name)));
            if (!results(body).length) answer(response, '', [{ name: 'write_plan', args: { content: originalPlan } }, { name: 'submit_plan', args: { plan: originalPlan } }, { name: 'enter_plan_mode', args: {} }]);
            else answer(response, 'Child readonly findings.');
        } else if (!results(body).length) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'child exploration', agent: { type: 'inline', name: 'Explorer', instructions: 'Investigate only.' }, permissionMode: 'readonly', context: { mode: 'none' } } }]);
        else if (results(body).length === 1) answer(response, '', [{ name: 'wait_agents', args: { agentIds: [JSON.parse(results(body)[0].content).agentId] } }]);
        else answer(response, '', [{ name: 'submit_plan', args: { plan: originalPlan } }]);
    });
    const run = await f.start(); const end = await f.terminal(run.id); const child = end.runs.find(item => item.parentRunId)!;
    assert.equal(child.effective.permissionMode, 'readonly'); assert.equal(child.plan, undefined); assert.equal(child.state, 'failed'); assert.match(child.error!, /不支持的工具/);
    await assert.rejects(f.execute({ type: 'resolve-plan', runId: child.id, planId: end.runs[0].plan!.id, decision: 'approve', permissionMode: 'manual' }), /主代理/);
});

test('resolve-plan IPC requires explicit implementation permission or feedback with exact fields', () => {
    for (const value of [{ decision: 'approve' }, { decision: 'approve', permissionMode: 'plan' }, { decision: 'approve', permissionMode: 'readonly' }, { decision: 'revise', feedback: '' }, { decision: 'revise', feedback: 'x', permissionMode: 'auto' }, { decision: 'revise', feedback: 'x'.repeat(20001) }]) assert.throws(() => parseCommand({ type: 'resolve-plan', runId: 'run', planId: 'plan', ...value }));
});

test('a root cannot enter Plan while an owned child remains live', async t => {
    let childResponse: ServerResponse | undefined; let parentRound = 0; let parentDenied = false;
    const f = await fixture(t, (body, response) => {
        const input = lastTaskInput(body);
        if (input === 'live exploration') { childResponse = response; return; }
        if (++parentRound === 1) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'live exploration', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else if (parentRound === 2) answer(response, '', [{ name: 'enter_plan_mode', args: {} }]);
        else { assert.match(results(body).at(-1).content, /收拢/); parentDenied = true; answer(response, 'Keep current mode.'); }
    }, 'accept-edits');
    const run = await f.start();
    await f.wait(state => state.runs.some(item => item.parentRunId === run.id));
    for (let i = 0; i < 1000 && (!childResponse || !parentDenied); i++) await delay(5);
    assert.ok(childResponse && parentDenied, 'child stays live until parent mode change is refused');
    if (childResponse && !childResponse.writableEnded) answer(childResponse, 'Exploration completed.');
    const end = await f.terminal(run.id);
    assert.equal(end.sessions[0].controls?.permissionMode, 'accept-edits'); assert.equal(end.runs[0].effective.permissionMode, 'accept-edits');
});


test('task versions survive clarification, user Markdown edits, agent revision and restart', async t => {
    const revised = '# Revised by agent';
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, '', [{ name: 'write_plan', args: { content: originalPlan, title: 'Task Alpha' } }, { name: 'submit_plan', args: {} }]);
        else if (number === 2) answer(response, 'Clarification only.');
        else if (number === 3) { assert.ok(lastSemanticMessage(body).content.includes('User Markdown')); assert.ok(lastSemanticMessage(body).content.includes('Please improve tests')); assert.match(lastSemanticMessage(body).content, /当前任务标题：User title；当前版本：2/); answer(response, '', [{ name: 'write_plan', args: { content: revised } }, { name: 'submit_plan', args: {} }]); }
        else { assert.ok(lastSemanticMessage(body).content.includes(revised)); assert.match(lastSemanticMessage(body).content, /批准版本：3/); assert.match(latestRuntimeContextUpdate(body), /UAH_MODULE:plan.transition/); assert.match(latestRuntimeContextUpdate(body), /宿主批准/); answer(response, 'Implementation complete.'); }
    });
    const first = await f.start(); let state = await f.terminal(first.id); const v1 = state.runs[0].plan!;
    assert.equal(v1.version, 1); assert.equal(v1.title, 'Task Alpha'); assert.ok(v1.documentId); assert.ok(v1.draftPath);
    const clarification = await f.start('Clarify details'); await f.terminal(clarification.id);
    assert.equal((await f.snapshot()).sessions[0].activePlanRunId, first.id);
    state = await f.execute({ type: 'edit-plan', runId: first.id, planId: v1.id, title: 'User title', content: '# User Markdown' });
    const v2 = state.runs[0].plan!;
    assert.equal(v2.version, 2); assert.equal(v2.documentId, v1.documentId); assert.notEqual(v2.id, v1.id);
    assert.equal(v2.history?.length, 1); assert.equal(v2.history?.[0].content, originalPlan); assert.equal(readFileSync(v1.filePath, 'utf8'), originalPlan);
    assert.equal(f.requests.length, 2);
    await assert.rejects(f.execute({ type: 'resolve-plan', runId: first.id, planId: v1.id, decision: 'approve', permissionMode: 'auto' }), /标识/);
    await f.restart();
    state = await f.execute({ type: 'resolve-plan', runId: first.id, planId: v2.id, decision: 'revise', feedback: 'Please improve tests' });
    const revision = state.runs.at(-1)!; state = await f.terminal(revision.id); const v3 = state.runs.at(-1)!.plan!;
    assert.equal(v3.documentId, v1.documentId); assert.equal(v3.version, 3); assert.equal(v3.title, 'User title'); assert.equal(state.runs.at(-1)!.effective.permissionMode, 'plan');
    assert.equal(readFileSync(v2.filePath, 'utf8'), '# User Markdown'); assert.equal(state.runs[0].plan?.history?.[0].id, v1.id);
    const approved = await f.execute({ type: 'resolve-plan', runId: revision.id, planId: v3.id, decision: 'approve', permissionMode: 'auto' });
    const implementation = approved.runs.at(-1)!; assert.equal(implementation.effective.permissionMode, 'auto');
    assert.equal(implementation.modeTransition?.reason, 'plan-approved'); assert.equal(implementation.modeTransition?.planId, v3.id); assert.equal(implementation.modeTransition?.planVersion, 3);
    await f.terminal(implementation.id);
});

test('new task invalidates old approval; external draft changes and edit/approval races are rejected', async t => {
    const f = await fixture(t, (_body, response, number) => {
        if (number === 1) answer(response, '', [{ name: 'submit_plan', args: { plan: originalPlan } }]);
        else if (number === 2) answer(response, '', [{ name: 'write_plan', args: { content: 'Independent task', title: 'Other task', newPlan: true } }, { name: 'submit_plan', args: {} }]);
        else answer(response, 'Done');
    });
    const first = await f.start(); let state = await f.terminal(first.id); const old = state.runs[0].plan!;
    const second = await f.start(); state = await f.terminal(second.id); const current = state.runs.at(-1)!.plan!;
    assert.notEqual(current.documentId, old.documentId); assert.equal(current.version, 1);
    await assert.rejects(f.execute({ type: 'resolve-plan', runId: first.id, planId: old.id, decision: 'approve', permissionMode: 'manual' }), /过期/);
    const approve: Command = { type: 'resolve-plan', runId: second.id, planId: current.id, decision: 'approve', permissionMode: 'manual' };
    writeFileSync(current.draftPath!, 'External draft change'); await assert.rejects(f.execute(approve), /文件已改变/);
    await assert.rejects(f.execute({ type: 'edit-plan', runId: second.id, planId: current.id, title: 'edited', content: 'edit' }), /文件已改变/);
    assert.equal((await f.snapshot()).runs.at(-1)!.plan?.id, current.id);
    writeFileSync(current.draftPath!, current.content);
    const outcomes = await Promise.allSettled([f.execute({ type: 'edit-plan', runId: second.id, planId: current.id, title: 'edited', content: 'edit' }), f.execute(approve)]);
    assert.equal(outcomes.filter(item => item.status === 'fulfilled').length, 1);
    state = await f.snapshot(); assert.equal(state.runs.length, 2); assert.equal(state.runs.at(-1)!.plan?.version, 2); assert.equal(state.runs.at(-1)!.plan?.status, 'proposed');
});

test('manual mode exits are events, preserve unapproved plans and expose read_plan without writes', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, '', [{ name: 'submit_plan', args: { plan: originalPlan } }]);
        else if (number === 2) { assert.match(latestRuntimeContextUpdate(body), /UAH_MODULE:plan.transition/); assert.match(latestRuntimeContextUpdate(body), /不是计划审批/); assert.ok(names(body).includes('read_plan')); assert.ok(!names(body).includes('write_plan')); answer(response, '', [{ name: 'read_plan', args: {} }]); }
        else { assert.doesNotMatch(latestRuntimeContextUpdate(body), /UAH_MODULE:plan.transition/); assert.equal(results(body).at(-1).content, originalPlan); answer(response, 'Read existing plan.'); }
    });
    const first = await f.start(); await f.terminal(first.id);
    let state = await f.execute({ type: 'set-session-controls', sessionId: f.sessionId, revision: 0, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
    assert.equal(state.sessions[0].pendingModeTransition?.reason, 'manual'); assert.equal(state.runs[0].plan?.status, 'proposed');
    const reader = await f.start('Read existing plan'); state = await f.terminal(reader.id);
    assert.equal(state.sessions[0].pendingModeTransition, undefined); assert.equal(state.runs.at(-1)!.modeTransition?.to, 'readonly'); assert.equal(state.runs[0].plan?.status, 'proposed');
});


test('legacy run-path plans retain their family ID when edited or revised', async t => {
    for (const decision of ['edit', 'revise'] as const) {
        const f = await fixture(t, (_body, response, number) => answer(response, '', [{ name: 'submit_plan', args: { plan: number === 1 ? originalPlan : 'Legacy revised' } }]));
        const first = await f.start(); let state = await f.terminal(first.id); const saved = state.runs[0].plan!;
        const file = await writePlanFile(f.dataDirectory, f.sessionId, first.id, saved.content);
        const legacy = { ...file, id: saved.id, status: 'proposed' as const, createdAt: saved.createdAt };
        state = await f.replacePersisted(snapshot => ({ ...snapshot, sessions: snapshot.sessions.map(session => ({ ...session, activePlanRunId: undefined })), runs: snapshot.runs.map(run => run.id === first.id ? { ...run, plan: legacy } : run) }));
        assert.equal(state.runs[0].plan?.documentId, undefined);
        if (decision === 'edit') state = await f.execute({ type: 'edit-plan', runId: first.id, planId: legacy.id, title: 'Legacy title', content: 'Legacy edited' });
        else { state = await f.execute({ type: 'resolve-plan', runId: first.id, planId: legacy.id, decision: 'revise', feedback: 'Revise legacy task' }); state = await f.terminal(state.runs.at(-1)!.id); }
        const current = state.runs.at(-1)!.plan!;
        assert.equal(current.documentId, legacy.id); assert.equal(current.version, 2); assert.equal(readFileSync(file.filePath, 'utf8'), originalPlan);
    }
});

test('deleting the active plan prevents read_plan from reviving an older plan', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number <= 2) answer(response, '', [{ name: 'write_plan', args: { content: 'Task ' + number, newPlan: true } }, { name: 'submit_plan', args: {} }]);
        else if (number === 3) answer(response, '', [{ name: 'read_plan', args: {} }]);
        else { assert.match(results(body).at(-1).content, /还没有计划/); answer(response, 'No current plan.'); }
    });
    const first = await f.start(); await f.terminal(first.id); const second = await f.start(); await f.terminal(second.id);
    await f.execute({ type: 'delete-reply', runId: second.id });
    const third = await f.start('Read plan'); const state = await f.terminal(third.id);
    assert.equal(state.sessions[0].activePlanRunId, second.id); assert.equal(state.runs[0].plan?.status, 'proposed');
});

test('start-run preserves latest task metadata after an endpoint lookup overlaps user editing', async t => {
    const f = await fixture(t, (_body, response, number) => number === 1 ? answer(response, '', [{ name: 'submit_plan', args: { plan: originalPlan } }]) : answer(response, 'Clarification'));
    const first = await f.start(); let state = await f.terminal(first.id); const plan = state.runs[0].plan!;
    await f.replacePersisted(snapshot => ({ ...snapshot, sessions: snapshot.sessions.map(session => ({ ...session, activePlanRunId: undefined })) }));
    const blocked = f.block(); const started = f.start('Question'); await blocked.entered;
    await f.execute({ type: 'edit-plan', runId: first.id, planId: plan.id, content: 'Edited task', title: 'Edited title' });
    blocked.release(); const next = await started; state = await f.terminal(next.id);
    assert.equal(state.sessions[0].activePlanRunId, first.id); assert.equal(state.runs[0].plan?.version, 2);
});
