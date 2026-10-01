import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { defaultAgentSettings } from '../../src/shared/agents';
import { runtimePromptContext } from '../../src/runtime/prompt-context';
import { workspaceToolDefinitions } from '../../src/runtime/workspace-tools';
import type { RuntimeEvent, RunRecord } from '../../src/shared/contracts';
import type { PermissionMode } from '../../src/shared/permissions';

const sha = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
async function fixture(t: { after(fn: () => Promise<void>): void }, mode: PermissionMode, toolName = 'apply_patch') {
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-patch-loop-'));
    const project = path.join(directory, 'project'); mkdirSync(project);
    const file = path.join(project, 'fixture.txt'); writeFileSync(file, 'before\r\n');
    const requests: Array<Record<string, unknown>> = []; const errors: string[] = [];
    const events: RuntimeEvent[] = [];
    const listeners = new Set<() => void>();
    const waitEvent = (predicate: (event: RuntimeEvent) => boolean): Promise<RuntimeEvent> => new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { listeners.delete(check); reject(new Error('Expected durable runtime event was not emitted')); }, 15000);
        const check = () => {
            const found = events.find(predicate);
            if (found) { clearTimeout(timeout); listeners.delete(check); resolve(found); }
        };
        listeners.add(check); check();
    });
    const server = createServer((request, response) => {
        void (async () => {
            const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>; requests.push(body);
            const tool = requests.length === 1;
            const args = toolName === 'apply_patch' ? { path: 'fixture.txt', expectedHash: sha('before\r\n'), edits: [{ oldText: 'before', newText: 'after' }] } : { path: 'fixture.txt', offset: 0, limit: 2 };
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frame({ choices: [{ index: 0, delta: tool ? { tool_calls: [{ index: 0, id: 'patch-loop-call', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } }] } : { content: 'Fixture complete.' }, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
        })().catch(error => { errors.push(String(error)); if (!response.headersSent) response.writeHead(500); response.end(); });
    });
    for (let attempt = 0; attempt < 32; attempt++) {
        try {
            await new Promise<void>((resolve, reject) => {
                const failed = (error: Error) => { server.off('listening', listening); reject(error); };
                const listening = () => { server.off('error', failed); resolve(); };
                server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1');
            });
            break;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string' && address.port >= 20000);
    const settings = defaultAgentSettings();
    const supervisor = new Supervisor({ dataDirectory: path.join(directory, 'data'), delayMs: 0,
        onEvent: event => { events.push(event); for (const listener of [...listeners]) listener(); }, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); if (!profile) throw new Error('Missing fixture Agent'); return profile; },
        resolveConnection: async id => ({ id, name: 'Offline patch fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'local-patch-fixture-credential', models: ['fixture-model'], enabled: true, revision: 1, modelDetails: [{ id: 'fixture-model', tools: true }] }),
    });
    t.after(async () => {
        await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        assert.deepEqual(errors, []);
        const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(tmpdir())); assert.ok(path.basename(target).startsWith('uah-patch-loop-'));
        rmSync(target, { recursive: true, force: true });
    });
    const created = await supervisor.execute({ type: 'create-session', title: 'Patch loop fixture', directory: project, agentId: 'default', selection: { endpointId: 'patch-endpoint', modelId: 'fixture-model' }, controls: { permissionMode: mode, reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    const start = async () => {
        const state = await supervisor.execute({ type: 'start-run', sessionId, input: 'Execute the fixture tool once.' });
        return state.runs.find(run => run.sessionId === sessionId)!.id;
    };
    const completed = async (runId: string, expected: RunRecord['state'] = 'completed'): Promise<RunRecord> => {
        const event = await waitEvent(event => event.type === 'run-state' && event.runId === runId && ['completed', 'failed', 'stopped'].includes(event.payload.run.state));
        assert.equal(event.type, 'run-state'); if (event.type !== 'run-state') throw new Error('Unexpected event');
        assert.equal(event.payload.run.state, expected, event.payload.run.error); return event.payload.run;
    };
    return { supervisor, file, project, requests, events, start, completed, waitEvent };
}
const catalog = (body: Record<string, unknown>): string[] => (body.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name);
const toolResult = (body: Record<string, unknown>): string => (body.messages as Array<{ role: string; content: string }>).find(message => message.role === 'tool')!.content;

for (const mode of ['readonly', 'plan'] as const) {
    test(`${mode} catalog excludes apply_patch and forged calls cannot write`, async t => {
        const f = await fixture(t, mode); const run = await f.completed(await f.start(), 'failed');
        assert.equal(catalog(f.requests[0]).includes('apply_patch'), false); assert.ok(catalog(f.requests[0]).includes('read_file_range'));
        assert.equal(readFileSync(f.file, 'utf8'), 'before\r\n'); assert.equal((await f.supervisor.execute({ type: 'snapshot' })).artifacts.length, 0);
        assert.match(run.error!, /不支持的工具/); assert.equal(f.requests.length, 1, 'unknown catalog call is rejected before tool dispatch or continuation');
        assert.equal(run.activities?.some(activity => activity.tool?.name === 'apply_patch') ?? false, false);
        assert.equal(f.events.some(event => event.type === 'approval-requested'), false);
        const context = runtimePromptContext(run, f.project, catalog(f.requests[0]));
        assert.deepEqual((context.DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS as { tools: string[] }).tools, catalog(f.requests[0]));
        assert.equal(JSON.stringify(context.DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS).includes('apply_patch'), false);
    });
}

test('manual patch rechecks the raw hash after approval and preserves external changes', async t => {
    const f = await fixture(t, 'manual'); const runId = await f.start();
    const requested = await f.waitEvent(event => event.type === 'approval-requested' && event.runId === runId);
    assert.equal(requested.type, 'approval-requested'); if (requested.type !== 'approval-requested') throw new Error('Unexpected event');
    assert.equal(readFileSync(f.file, 'utf8'), 'before\r\n'); assert.ok(catalog(f.requests[0]).includes('apply_patch'));
    writeFileSync(f.file, 'external edit\r\n');
    const { runtimeId, sessionId, runId: approvalRunId, turnId, requestId, policyVersion } = requested.payload.approval;
    await f.supervisor.execute({ type: 'resolve-approval', identity: { runtimeId, sessionId, runId: approvalRunId, turnId, requestId, policyVersion }, decision: 'approve' });
    const run = await f.completed(runId);
    assert.equal(readFileSync(f.file, 'utf8'), 'external edit\r\n'); assert.equal((await f.supervisor.execute({ type: 'snapshot' })).artifacts.length, 0);
    const outcome = run.activities!.find(activity => activity.tool?.name === 'apply_patch')!.tool!.outcome!;
    assert.equal(outcome.errorCode, 'WRITE_CONFLICT'); assert.equal(outcome.effectState, 'not_started'); assert.match(toolResult(f.requests[1]), /bytes changed/);
});

test('auto patch persists a linked artifact and blocks regeneration before another request', async t => {
    const f = await fixture(t, 'auto'); const run = await f.completed(await f.start());
    assert.equal(readFileSync(f.file, 'utf8'), 'after\r\n'); assert.equal(f.events.some(event => event.type === 'approval-requested'), false);
    const snapshot = await f.supervisor.execute({ type: 'snapshot' }); assert.equal(snapshot.artifacts.length, 1);
    const artifact = snapshot.artifacts[0]; const tool = run.activities!.find(activity => activity.tool?.name === 'apply_patch')!.tool!;
    assert.equal(tool.artifactId, artifact.id); assert.equal(artifact.runId, run.id); assert.equal(artifact.oldContent, 'before\r\n'); assert.equal(artifact.newContent, 'after\r\n'); assert.equal(artifact.hash, sha('after\r\n'));
    assert.equal(tool.outcome!.resources[0].hashKind, 'raw_bytes'); assert.equal(tool.outcome!.effectState, 'confirmed'); assert.equal(tool.outcome!.recordingState, 'durable');
    await assert.rejects(f.supervisor.execute({ type: 'regenerate-run', runId: run.id }), /文件更改/);
    assert.equal(f.requests.length, 2); assert.equal((await f.supervisor.execute({ type: 'snapshot' })).runs.length, 1);
});

test('range JSON reaches the model unchanged and prompt context reflects the actual registered tools', async t => {
    const f = await fixture(t, 'readonly', 'read_file_range'); const run = await f.completed(await f.start());
    const result = JSON.parse(toolResult(f.requests[1]));
    assert.deepEqual(result, { text: 'be', offset: 0, offsetUnit: 'utf16', nextOffset: 2, totalCharacters: 8, fileHash: sha('before\r\n'), encoding: 'utf8', truncated: true });
    const tool = run.activities!.find(activity => activity.tool?.name === 'read_file_range')!.tool!;
    assert.deepEqual(JSON.parse(tool.result!), result); assert.equal(tool.outcome!.resources[0].hashKind, 'raw_bytes');
    const names = catalog(f.requests[0]); const context = runtimePromptContext(run, f.project, names);
    assert.deepEqual((context.DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS as { tools: string[] }).tools, names); assert.ok(names.includes('read_file_range'));
    const definition = workspaceToolDefinitions().find(tool => tool.name === 'read_file_range')!;
    assert.match(definition.description, /offsetUnit/); assert.match(definition.description, /fileHash/); assert.match(JSON.stringify(definition.parameters), /UTF-16/);
});
