import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import type { McpManager } from '../../src/runtime/mcp-client';
import type { Snapshot } from '../../src/shared/contracts';
import type { PermissionMode } from '../../src/shared/permissions';

async function setup(t: TestContext, mode: PermissionMode, requestedTool = 'mcp_fixture', failure = false) {
    const root = mkdtempSync(join(tmpdir(), 'uah-extensions-loop-')); const project = join(root, 'project'); mkdirSync(project);
    const requests: any[] = []; let calls = 0; let enabled = true; let dispatchCallbacks = 0;
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const hasToolResult = body.messages.some((item: any) => item.role === 'tool');
        const delta = hasToolResult || mode === 'readonly' ? { content: 'done' } : { tool_calls: [{ index: 0, id: 'extension-call', type: 'function', function: { name: requestedTool, arguments: JSON.stringify(requestedTool === 'read_skill' ? { id: 'skill-a' } : {}) } }] };
        for (const value of [{ choices: [{ index: 0, delta }] }, { choices: [{ index: 0, delta: {}, finish_reason: hasToolResult || mode === 'readonly' ? 'stop' : 'tool_calls' }] }]) response.write(`data: ${JSON.stringify(value)}\n\n`);
        response.end('data: [DONE]\n\n');
    });
    await new Promise<void>(done => server.listen(0, '127.0.0.1', done)); const address = server.address(); assert.ok(address && typeof address !== 'string');
    const mcp = { refresh: async () => {}, definitions: () => [{ name: 'mcp_fixture', description: 'fixture', parameters: { type: 'object', properties: {} } }], isTool: (name: string) => name === 'mcp_fixture', secrets: () => [], close: async () => {}, call: async (_name: string, _args: unknown, _signal: AbortSignal, beforeDispatch?: () => void) => {
        if (!enabled) return { content: 'The MCP tool is no longer available.', isError: true, dispatched: false };
        beforeDispatch?.(); dispatchCallbacks++; calls++;
        if (failure) return { content: 'connection lost after dispatch', isError: true, dispatched: true };
        return { content: 'external result', dispatched: true };
    } } as unknown as McpManager;
    const supervisor = new Supervisor({ dataDirectory: join(root, 'data'), onEvent: () => {}, mcp,
        resolveConnection: async () => ({ id: 'fixture', name: 'fixture', enabled: true, revision: 0, protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '', models: ['fixture'] }),
        resolveExtensions: async () => ({ connectors: [], skills: [{ id: 'skill-a', name: 'Fixture skill', description: 'Only test content', enabled: true, source: 'fixture', path: 'fixture/SKILL.md' }], native: { enabled: false, command: '', args: [], model: '', revision: 0 } }),
        readSkill: async id => { assert.equal(id, 'skill-a'); return { name: 'Fixture skill', content: 'skill body', source: 'fixture' }; },
    });
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); });
    const created = await supervisor.execute({ type: 'create-session', title: 'extensions', directory: project, selection: { endpointId: 'fixture', modelId: 'fixture' }, controls: { permissionMode: mode, reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    await supervisor.execute({ type: 'start-run', sessionId, input: 'fixture extensions' });
    const wait = async (predicate: (snapshot: Snapshot) => boolean) => { for (let n = 0; n < 300; n++) { const snapshot = await supervisor.execute({ type: 'snapshot' }); if (predicate(snapshot)) return snapshot; await delay(10); } throw new Error('extension fixture timeout'); };
    const readJournal = () => (supervisor as unknown as { store: { readJournal: (id: string) => Array<{ type: string }> } }).store.readJournal(sessionId);
    return { supervisor, requests, wait, calls: () => calls, dispatchCallbacks: () => dispatchCallbacks, readJournal, revoke: () => { enabled = false; } };
}

for (const decision of ['approved', 'rejected'] as const) test(`MCP ${decision} uses durable approval before external dispatch`, async t => {
    const fixture = await setup(t, 'manual');
    const pending = await fixture.wait(value => value.approvals.some(item => item.status === 'pending'));
    assert.equal(fixture.calls(), 0);
    const approval = pending.approvals.find(item => item.status === 'pending')!;
    const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = approval;
    await fixture.supervisor.execute({ type: 'resolve-approval', identity: { runtimeId, sessionId, runId, turnId, requestId, policyVersion }, decision: decision === 'approved' ? 'approve' : 'reject' });
    const final = await fixture.wait(value => value.runs.some(item => item.state === 'completed'));
    assert.equal(fixture.calls(), decision === 'approved' ? 1 : 0);
    assert.equal(fixture.dispatchCallbacks(), decision === 'approved' ? 1 : 0);
    assert.notEqual(final.runs[0].harnessState, 'needs_reconciliation');
    assert.match(fixture.requests[0].messages[0].content, /UAH_MODULE:extensions.mcp:v1/);
});

test('an approved MCP call revoked while approval is pending stops before durable dispatch', async t => {
    const fixture = await setup(t, 'manual');
    const pending = await fixture.wait(value => value.approvals.some(item => item.status === 'pending'));
    const approval = pending.approvals.find(item => item.status === 'pending')!;
    fixture.revoke();
    const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = approval;
    await fixture.supervisor.execute({ type: 'resolve-approval', identity: { runtimeId, sessionId, runId, turnId, requestId, policyVersion }, decision: 'approve' });
    const final = await fixture.wait(value => value.runs.some(item => item.state === 'completed'));
    const run = final.runs.find(item => item.id === runId)!;
    assert.equal(fixture.calls(), 0);
    assert.equal(fixture.dispatchCallbacks(), 0);
    assert.notEqual(run.harnessState, 'needs_reconciliation');
    assert.equal(fixture.readJournal().filter(event => event.type === 'tool.dispatch').length, 0);
    assert.equal(run.activities?.find(item => item.tool)?.tool?.outcome?.effectState, 'not_started');
});

test('a confirmed MCP side effect prevents regenerating the same run', async t => {
    const fixture = await setup(t, 'bypass');
    const completed = await fixture.wait(value => value.runs.some(item => item.state === 'completed'));
    const run = completed.runs[0];
    assert.ok(run);
    assert.equal(fixture.calls(), 1);
    assert.equal(run.activities?.find(item => item.tool)?.tool?.outcome?.effectState, 'confirmed');
    const requestCount = fixture.requests.length;
    await assert.rejects(fixture.supervisor.execute({ type: 'regenerate-run', runId: run.id }), /文件更改|副作用/);
    assert.equal(fixture.requests.length, requestCount, 'regeneration is rejected before another provider request');
});

test('MCP loss after dispatch retains possible side effects and stops later requests', async t => {
    const fixture = await setup(t, 'bypass', 'mcp_fixture', true);
    const final = await fixture.wait(value => value.runs.some(item => item.state === 'failed'));
    assert.equal(fixture.calls(), 1); assert.equal(fixture.requests.length, 1);
    assert.equal(final.runs[0].harnessState, 'needs_reconciliation');
    assert.equal(final.runs[0].activities?.find(item => item.tool)?.tool?.outcome?.effectState, 'possible');
});

test('readonly excludes external calls but retains genuine skill discovery', async t => {
    const fixture = await setup(t, 'readonly'); await fixture.wait(value => value.runs.some(item => item.state === 'completed'));
    const names = fixture.requests[0].tools.map((item: any) => item.function.name);
    assert.ok(!names.includes('mcp_fixture')); assert.ok(names.includes('read_skill'));
    assert.match(fixture.requests[0].messages[0].content, /Fixture skill/); assert.equal(fixture.calls(), 0);
});

test('read_skill provides enabled content as a tool result', async t => {
    const fixture = await setup(t, 'manual', 'read_skill'); await fixture.wait(value => value.runs.some(item => item.state === 'completed'));
    assert.match(fixture.requests[1].messages.find((item: any) => item.role === 'tool').content, /skill body/);
    assert.equal(fixture.calls(), 0);
});
