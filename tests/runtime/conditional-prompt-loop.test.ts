import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { Supervisor } from '../../src/runtime/supervisor';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { Snapshot } from '../../src/shared/contracts';
import type { PermissionMode } from '../../src/shared/permissions';

interface Body { messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }
function answer(response: ServerResponse, text: string, calls: Array<{ name: string; args: unknown }> = []) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: text };
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
const modules = (body: Body) => [...body.messages[0].content.matchAll(/<!-- UAH_MODULE:([^:]+):v\d+ -->/g)].map(match => match[1]);
const tools = (body: Body) => (body.tools || []).map(tool => tool.function.name);
async function fixture(t: { after: (callback: () => Promise<void>) => void }, handler: (body: Body, response: ServerResponse, number: number) => void, mode: PermissionMode = 'manual', supported = true) {
    const root = mkdtempSync(join(tmpdir(), 'uah-conditional-loop-')); const project = join(root, 'project'); mkdirSync(project);
    const settings = defaultAgentSettings(); settings.subagents.enabled = true;
    const originalInstructions = settings.profiles.find(profile => profile.id === 'gpt-default')!.instructions;
    const requests: Body[] = []; const errors: unknown[] = []; const observers = new Set<() => void>();
    const server = createServer(async (request, response) => {
        try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body; requests.push(body); handler(body, response, requests.length);
        } catch (error) { errors.push(error); response.destroy(); }
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const supervisor = new Supervisor({ dataDirectory: join(root, 'data'), delayMs: 0, onEvent: () => { for (const observer of observers) observer(); }, getAgentSettings: () => settings,
        resolveAgent: id => settings.profiles.find(profile => profile.id === id)!,
        resolveConnection: async id => ({ id, name: 'Isolated fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-fixture', enabled: true, models: ['model'], revision: 1, modelDetails: [{ id: 'model', tools: supported }] }) });
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolveClose => server.close(() => resolveClose()));
        const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-conditional-loop-')); rmSync(target, { recursive: true, force: true }); assert.deepEqual(errors, []); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Conditional prompts', directory: project, agentId: 'gpt-default', selection: { endpointId: 'fixture', modelId: 'model' }, controls: { permissionMode: mode, reasoningEffort: 'default' } });
    const execute = supervisor.execute.bind(supervisor);
    const wait = (predicate: (state: Snapshot) => boolean) => new Promise<Snapshot>((resolveWait, reject) => {
        let settled = false;
        const clean = () => { clearTimeout(timeout); observers.delete(check); };
        const check = () => { void execute({ type: 'snapshot' }).then(state => { if (!settled && predicate(state)) { settled = true; clean(); resolveWait(state); } }, error => { if (!settled) { settled = true; clean(); reject(error); } }); };
        const timeout = setTimeout(() => { settled = true; clean(); reject(new Error('Conditional prompt fixture timed out')); }, 15000);
        observers.add(check); check();
    });
    const start = async () => (await execute({ type: 'start-run', sessionId: created.sessions[0].id, input: 'ROOT TASK' })).runs[0];
    const terminal = (id: string) => wait(state => ['completed', 'failed', 'stopped'].includes(state.runs.find(run => run.id === id)?.state || ''));
    return { requests, execute, wait, start, terminal, originalInstructions, project };
}

test('actual manual-to-Plan requests reassemble modules against the exact changing tool catalog', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) {
            for (const id of ['workspace.edit', 'workspace.command', 'plan.enter']) assert.ok(modules(body).includes(id));
            assert.ok(!modules(body).includes('plan.workflow')); assert.ok(tools(body).includes('enter_plan_mode'));
            answer(response, '', [{ name: 'enter_plan_mode', args: {} }]);
        } else {
            for (const id of ['workspace.edit', 'workspace.command', 'plan.enter']) assert.ok(!modules(body).includes(id));
            assert.ok(modules(body).includes('plan.workflow'));
            for (const name of ['write_file', 'run_command', 'enter_plan_mode']) assert.ok(!tools(body).includes(name));
            for (const name of ['write_plan', 'read_plan', 'submit_plan']) assert.ok(tools(body).includes(name));
            answer(response, 'Readonly planning analysis.');
        }
    });
    const run = await f.start(); const state = await f.terminal(run.id); assert.equal(state.runs[0].state, 'completed');
    assert.equal(f.requests.length, 2); assert.equal(state.sessions[0].controls?.permissionMode, 'plan');
    assert.equal(state.runs[0].effective.agentInstructions, f.originalInstructions); assert.match(f.originalInstructions, /UAH_PROMPT_PROFILE:gpt/);
});

test('inherited GPT child receives only the Subagent role while parent retains only Main-agent role', async t => {
    const f = await fixture(t, (body, response) => {
        const child = body.messages.filter(message => message.role === 'user').at(-1)?.content === 'CHILD TASK';
        const system = body.messages[0].content;
        assert.ok(modules(body).includes(child ? 'role.subagent' : 'role.primary'));
        assert.ok(!modules(body).includes(child ? 'role.primary' : 'role.subagent'));
        assert.match(system, child ? /Subagent role/ : /Main-agent role/);
        assert.doesNotMatch(system, child ? /Main-agent role/ : /Subagent role/);
        if (child) answer(response, 'Child findings.');
        else if (!body.messages.some(message => message.role === 'tool')) answer(response, '', [{ name: 'spawn_agent', args: { prompt: 'CHILD TASK', agent: { type: 'inherit' }, context: { mode: 'none' } } }]);
        else answer(response, 'Parent verified findings.');
    });
    const run = await f.start(); const state = await f.terminal(run.id);
    assert.equal(state.runs[0].state, 'completed'); const child = state.runs.find(item => item.parentRunId === run.id)!;
    assert.ok(child); assert.equal(child.state, 'completed'); assert.equal(child.effective.agentInstructions, f.originalInstructions);
    assert.equal(state.runs[0].effective.agentInstructions, f.originalInstructions);
});

test('tool-incapable model request has no action teaching or falsely advertised delegation', async t => {
    const f = await fixture(t, (body, response) => {
        assert.equal(body.tools, undefined); assert.ok(modules(body).includes('tools.none'));
        for (const id of modules(body)) assert.ok(!/^(?:workspace\.|plan\.(?:enter|workflow)$|delegation\.(?!unavailable$))/.test(id), id);
        assert.ok(!modules(body).includes('tools.contract')); assert.ok(modules(body).includes('delegation.unavailable'));
        answer(response, 'Analysis from provided context only.');
    }, 'manual', false);
    const run = await f.start(); const state = await f.terminal(run.id); assert.equal(state.runs[0].state, 'completed'); assert.equal(state.runs.length, 1);
});

test('GPT profile marker grants no ability to bypass a rejected write approval', async t => {
    const f = await fixture(t, (body, response, number) => {
        if (number === 1) answer(response, '', [{ name: 'write_file', args: { path: 'never.txt', expectedContent: null, content: 'denied' } }]);
        else { assert.match(body.messages.filter(message => message.role === 'tool').at(-1)!.content, /denied/); answer(response, 'Write rejected.'); }
    });
    const run = await f.start(); const pending = await f.wait(state => state.approvals.some(approval => approval.status === 'pending'));
    const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = pending.approvals[0];
    await f.execute({ type: 'resolve-approval', identity: { runtimeId, sessionId, runId, turnId, requestId, policyVersion }, decision: 'reject' });
    const state = await f.terminal(run.id); assert.equal(state.runs[0].state, 'completed'); assert.equal(state.artifacts.length, 0); assert.equal(existsSync(join(f.project, 'never.txt')), false);
});
