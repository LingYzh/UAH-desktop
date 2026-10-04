import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { ApiConnection, ProviderCatalogEntry } from '../../src/shared/endpoints.js';
import { defaultAgentSettings, type AgentSettings } from '../../src/shared/agents.js';
import { NATIVE_CODEX_ENDPOINT_ID } from '../../src/shared/native-codex.js';
import type { ArtifactReference, TranscriptEvent } from '../../src/shared/harness-contracts.js';
import type { Snapshot, RunRecord, ApprovalRecord, ApprovalIdentity } from '../../src/shared/contracts.js';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts.js';
import type { McpManager } from '../../src/runtime/mcp-client.js';
import { RuntimeStore } from '../../src/runtime/store.js';
import { Supervisor } from '../../src/runtime/supervisor.js';

const nativeFixture = join(process.cwd(), 'tests', 'fixtures', 'codex-app-server-fixture.mjs');
const ROOT_MARKER = 'ROOT_HISTORY_SENTINEL';
const SELECTED_MARKER = 'SELECTED_CONTEXT_SENTINEL';

interface ChatMessage { role: string; content?: string; tool_call_id?: string; }
interface ChatBody { model: string; messages: ChatMessage[]; tools?: unknown[]; }
const runtimeContextMarker = '[UAH runtime context update v2]';
const stripRuntimeContextUpdate = (content: string): string => {
    const marker = content.indexOf(runtimeContextMarker);
    return marker < 0 ? content : content.slice(0, marker).trimEnd();
};
interface ChatToolCall { name: string; args: unknown; }
interface ApiFixture {
    port: number;
    requests: ChatBody[];
    errors: unknown[];
    close(): Promise<void>;
}
interface NativeHarness {
    root: string;
    dataDirectory: string;
    projectDirectory: string;
    recordFile: string;
    supervisor: Supervisor;
    events: unknown[];
    settings: AgentSettings;
}

function answer(response: ServerResponse, text: string, calls: ChatToolCall[] = []): void {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = {
        ...(text ? { content: text } : {}),
        ...(calls.length ? { tool_calls: calls.map((call, index) => ({
            index,
            id: `native-child-call-${index + 1}`,
            type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.args) },
        })) } : {}),
    };
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
}

async function createApiFixture(handler: (body: ChatBody, response: ServerResponse) => void | Promise<void>): Promise<ApiFixture> {
    const requests: ChatBody[] = [];
    const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as ChatBody;
            requests.push(body);
            await handler(body, response);
        } catch (error) {
            errors.push(error);
            if (!response.headersSent) response.writeHead(500);
            response.end();
        }
    });
    let port = 0;
    for (let attempt = 0; attempt < 16 && !port; attempt++) {
        const candidate = 15_000 + Math.floor(Math.random() * 50_000);
        try {
            await new Promise<void>((resolveListen, reject) => {
                const failed = (error: Error) => reject(error);
                server.once('error', failed);
                server.listen(candidate, '127.0.0.1', () => {
                    server.off('error', failed);
                    resolveListen();
                });
            });
            port = candidate;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        }
    }
    assert.ok(port > 10_080, `could not obtain a free test port above 10080, got ${port}`);
    return {
        port,
        requests,
        errors,
        async close() {
            server.closeAllConnections();
            await new Promise<void>(resolveClose => server.close(() => resolveClose()));
        },
    };
}

function createNativeHarness(apiPort: number, scenario: Record<string, unknown>, providerCatalog?: ProviderCatalogEntry[]): NativeHarness {
    const root = mkdtempSync(join(tmpdir(), 'uah-native-delegation-test-'));
    const dataDirectory = join(root, 'data');
    const projectDirectory = join(root, 'project');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    const recordFile = join(root, 'app-server.jsonl');
    const bundle = {
        connectors: [],
        skills: [{ id: 'fixture-skill', name: 'Fixture skill', description: 'fixture-only', enabled: true, source: 'fixture', path: 'skills/fixture/SKILL.md' }],
        native: {
            enabled: true,
            command: process.execPath,
            args: [nativeFixture, JSON.stringify({ ...scenario, recordFile })],
            model: 'gpt-fixture',
            revision: 1,
        },
    };
    const settings = defaultAgentSettings();
    settings.subagents.enabled = true;
    settings.subagents.maxConcurrentThreads = 4;
    settings.subagents.maxDepth = 1;
    settings.subagents.inheritHistory = false;

    // A small fake manager makes the MCP boundary observable without opening a connector.
    const mcp = {
        refresh: async () => undefined,
        definitions: () => [{ name: 'mcp_fixture_tool', description: 'fixture only', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
        secrets: () => [],
        close: async () => undefined,
        isTool: (name: string) => name === 'mcp_fixture_tool',
        call: async () => ({ content: 'MCP must not be called by a native descendant', dispatched: false }),
    } as unknown as McpManager;
    const events: unknown[] = [];
    const supervisor = new Supervisor({
        dataDirectory,
        resolveExtensions: async () => structuredClone(bundle),
        readSkill: async id => {
            if (id !== 'fixture-skill') throw new Error('Unexpected fixture skill id');
            return { name: 'Fixture skill', content: 'SKILL_CONTENT_SENTINEL', source: 'fixture' };
        },
        mcp,
        resolveConnection: async (id): Promise<ApiConnection> => {
            const entry = providerCatalog?.find(item => item.id === id || item.providerId === id);
            if (id !== 'fixture-api' && !entry) throw new Error(`Unexpected API endpoint ${id}`);
            return {
                id: entry?.id ?? id,
                ...(entry ? { providerId: entry.providerId } : {}),
                name: 'Native delegation API fixture',
                protocol: 'openai-chat',
                baseUrl: `http://127.0.0.1:${apiPort}`,
                models: ['api-fixture'],
                enabled: true,
                revision: 1,
                apiKey: 'fixture-only-key',
            };
        },
        ...(providerCatalog ? { listProviders: async () => structuredClone(providerCatalog) } : {}),
        resolveAgent: id => {
            const profile = settings.profiles.find(item => item.id === id);
            if (!profile) throw new Error(`Unexpected fixture Agent ${id}`);
            return profile;
        },
        getAgentSettings: () => settings,
        onEvent: event => events.push(event),
        delayMs: 0,
    });
    return { root, dataDirectory, projectDirectory, recordFile, supervisor, events, settings };
}

function cleanupHarness(harness: NativeHarness): void {
    const target = resolve(harness.root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-native-delegation-test-')) {
        throw new Error(`Refusing to recursively remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

async function createNativeSession(harness: NativeHarness, permissionMode: 'manual' | 'bypass' = 'manual'): Promise<string> {
    const snapshot = await harness.supervisor.execute({
        type: 'create-session',
        title: 'Native delegation fixture',
        directory: harness.projectDirectory,
        selection: { endpointId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture' },
        controls: { permissionMode, reasoningEffort: 'default' },
    });
    const session = snapshot.sessions.at(-1);
    assert.ok(session);
    assert.equal(session.requested.runtimeId, 'codex-native');
    return session.id;
}

async function waitForSnapshot(
    supervisor: Supervisor,
    predicate: (snapshot: Snapshot) => boolean,
    timeoutMs = 8_000,
): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    let latest = await supervisor.execute({ type: 'snapshot' });
    while (!predicate(latest) && Date.now() < deadline) {
        await delay(10);
        latest = await supervisor.execute({ type: 'snapshot' });
    }
    assert.equal(predicate(latest), true, `snapshot did not reach the expected state: ${JSON.stringify(latest.runs.map(run => ({ id: run.id, parentRunId: run.parentRunId, state: run.state, error: run.error })))}`);
    return latest;
}

function records(harness: NativeHarness): Array<Record<string, unknown>> {
    try {
        return readFileSync(harness.recordFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

function getRun(snapshot: Snapshot, runId: string): RunRecord {
    const run = snapshot.runs.find(item => item.id === runId);
    assert.ok(run, `run ${runId} should exist`);
    return run;
}

function approvalIdentity(approval: ApprovalRecord): ApprovalIdentity {
    return {
        runtimeId: approval.runtimeId,
        sessionId: approval.sessionId,
        runId: approval.runId,
        turnId: approval.turnId,
        requestId: approval.requestId,
        policyVersion: approval.policyVersion,
    };
}

function dynamicPayloads(journal: TranscriptEvent[], parentRunId: string, artifacts: JournalArtifacts): Array<Record<string, unknown>> {
    return journal.flatMap(event => {
        if (event.type !== 'native.event' || event.run.runId !== parentRunId || event.payload.method !== 'uah/tool-result') return [];
        const value = JSON.parse(artifacts.read(event.payload.content).toString('utf8')) as Record<string, unknown>;
        return [value];
    });
}

function nativeEventArtifacts(journal: TranscriptEvent[], parentRunId: string, method: string, artifacts: JournalArtifacts): unknown[] {
    return journal.flatMap(event => {
        if (event.type !== 'native.event' || event.run.runId !== parentRunId || event.payload.method !== method) return [];
        return [JSON.parse(artifacts.read(event.payload.content).toString('utf8')) as unknown];
    });
}

test('API preset directory exposes only bounded provider metadata and canonicalizes an editable alias', async () => {
    const api = await createApiFixture((body, response) => {
        if (body.messages.some(message => message.role === 'tool')) answer(response, 'API_LIST_DONE');
        else answer(response, '', [{ name: 'list_agent_presets', args: {} }]);
    });
    const primary = Object.assign({
        id: 'fixture-api-internal', providerId: 'fixture-api-alias', name: 'Fixture API',
        models: ['api-fixture'], runtimeId: 'api' as const,
    }, { baseUrl: 'https://must-not-leak.invalid', apiKey: 'fixture-secret-must-not-leak' }) as ProviderCatalogEntry;
    const empty = { id: 'empty-provider', providerId: 'empty-alias', name: 'Empty provider', models: [], runtimeId: 'api' as const };
    const harness = createNativeHarness(api.port, {}, [primary, empty]);
    try {
        const created = await harness.supervisor.execute({
            type: 'create-session', title: 'Provider catalog API parent', directory: harness.projectDirectory,
            selection: { endpointId: 'fixture-api-alias', modelId: 'api-fixture' },
            controls: { permissionMode: 'manual', reasoningEffort: 'default' }, agentId: 'default',
        });
        const session = created.sessions.at(-1);
        assert.ok(session);
        assert.equal(session.requested.endpointId, 'fixture-api-internal', 'effective session identity uses the stable ID');
        assert.deepEqual(session.initialConfig?.selection, { endpointId: 'fixture-api-internal', modelId: 'api-fixture' }, 'initial config does not persist the editable alias');
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId: session.id, input: 'Read provider configuration.' });
        const parent = started.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(parent);
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
        const run = getRun(final, parent.id);
        const result = run.activities?.find(activity => activity.kind === 'tool' && activity.tool?.name === 'list_agent_presets')?.tool?.result;
        assert.ok(result);
        const directory = JSON.parse(result) as {
            currentProviderId: string; currentModelId: string; providerCatalogAvailable: boolean;
            providers: Array<{ providerId: string; name: string; models: string[]; runtimeId: string }>;
        };
        assert.equal(directory.currentProviderId, 'fixture-api-alias');
        assert.equal(directory.currentModelId, 'api-fixture');
        assert.equal(directory.providerCatalogAvailable, true);
        assert.deepEqual(directory.providers, [{ providerId: 'fixture-api-alias', name: 'Fixture API', models: ['api-fixture'], runtimeId: 'api' }]);
        assert.doesNotMatch(result, /must-not-leak|fixture-secret|baseUrl|apiKey/);
        assert.deepEqual(api.errors, []);
    } finally {
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});

test('missing API catalog is reported as unavailable, while native parents list their current model only', async () => {
    const api = await createApiFixture((body, response) => {
        if (body.messages.some(message => message.role === 'tool')) answer(response, 'API_LIST_DONE');
        else answer(response, '', [{ name: 'list_agent_presets', args: {} }]);
    });
    const apiHarness = createNativeHarness(api.port, {});
    const nativeHarness = createNativeHarness(api.port, {
        dynamicInputMatch: 'NATIVE_DIRECTORY_CHECK',
        dynamicCalls: [{ callId: 'list-native-providers', tool: 'uah_list_agent_presets', arguments: {} }],
    });
    try {
        const apiCreated = await apiHarness.supervisor.execute({
            type: 'create-session', title: 'Missing provider catalog', directory: apiHarness.projectDirectory,
            selection: { endpointId: 'fixture-api', modelId: 'api-fixture' },
            controls: { permissionMode: 'manual', reasoningEffort: 'default' }, agentId: 'default',
        });
        const apiSession = apiCreated.sessions.at(-1);
        assert.ok(apiSession);
        const apiStarted = await apiHarness.supervisor.execute({ type: 'start-run', sessionId: apiSession.id, input: 'Read unavailable provider configuration.' });
        const apiParent = apiStarted.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(apiParent);
        const apiFinal = await waitForSnapshot(apiHarness.supervisor, snapshot => snapshot.runs.some(run => run.id === apiParent.id && run.state === 'completed'));
        const apiResult = getRun(apiFinal, apiParent.id).activities?.find(activity => activity.kind === 'tool' && activity.tool?.name === 'list_agent_presets')?.tool?.result;
        assert.ok(apiResult);
        const apiDirectory = JSON.parse(apiResult) as { providers: unknown[]; providerCatalogAvailable: boolean };
        assert.deepEqual(apiDirectory.providers, []);
        assert.equal(apiDirectory.providerCatalogAvailable, false, 'an unavailable directory is not an assertion that there are no providers');

        const nativeSessionId = await createNativeSession(nativeHarness);
        const nativeStarted = await nativeHarness.supervisor.execute({ type: 'start-run', sessionId: nativeSessionId, input: 'NATIVE_DIRECTORY_CHECK' });
        const nativeParent = nativeStarted.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(nativeParent);
        const nativeFinal = await waitForSnapshot(nativeHarness.supervisor, snapshot => snapshot.runs.some(run => run.id === nativeParent.id && run.state === 'completed'));
        const toolResponse = records(nativeHarness).find(record => record.method === 'fixture/dynamicToolResponse'
            && (record.params as Record<string, unknown>).tool === 'uah_list_agent_presets');
        assert.ok(toolResponse);
        const encoded = (toolResponse.params as Record<string, unknown>).result as { contentItems: Array<{ text: string }>; success: boolean };
        assert.equal(encoded.success, true);
        const nativeDirectory = JSON.parse(encoded.contentItems[0]!.text) as {
            providers: Array<{ providerId: string; name: string; models: string[]; runtimeId: string }>;
            providerCatalogAvailable: boolean; nativeProviderScope: string;
        };
        assert.equal(nativeDirectory.providerCatalogAvailable, false);
        assert.equal(nativeDirectory.nativeProviderScope, 'current-model-only');
        assert.deepEqual(nativeDirectory.providers, [{ providerId: NATIVE_CODEX_ENDPOINT_ID, name: 'Codex 原生', models: ['gpt-fixture'], runtimeId: 'codex-native' }]);
        assert.deepEqual(api.errors, []);
        assert.equal(nativeFinal.runs.some(run => run.id === nativeParent.id && run.state === 'completed'), true);
    } finally {
        await apiHarness.supervisor.shutdown();
        await nativeHarness.supervisor.shutdown();
        await api.close();
        cleanupHarness(apiHarness);
        cleanupHarness(nativeHarness);
    }
});

test('native child resolves a listed provider alias but stores the canonical endpoint ID', async () => {
    const api = await createApiFixture((_body, response) => answer(response, 'ALIAS_CHILD_DONE'));
    const catalog: ProviderCatalogEntry[] = [{
        id: 'fixture-api-internal', providerId: 'fixture-api-alias', name: 'Fixture API', models: ['api-fixture'], runtimeId: 'api',
    }];
    const harness = createNativeHarness(api.port, {
        dynamicInputMatch: 'ALIAS_PARENT_BRIDGE',
        dynamicCalls: [
            { callId: 'spawn-alias-child', tool: 'uah_spawn_agent', arguments: {
                prompt: 'ALIAS_CHILD_TASK', agent: { type: 'inherit' }, providerId: 'fixture-api-alias', modelId: 'api-fixture',
                permissionMode: 'manual', context: { mode: 'none' },
            } },
            { callId: 'wait-alias-child', tool: 'uah_wait_agents', arguments: { agentIds: ['$lastAgentId'], timeoutMs: 8_000 } },
        ],
    }, catalog);
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'ALIAS_PARENT_BRIDGE' });
        const parent = started.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(parent);
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
        const child = final.runs.find(run => run.parentRunId === parent.id);
        assert.ok(child);
        assert.equal(child.effective.runtimeId, 'api');
        assert.equal(child.effective.endpointId, 'fixture-api-internal', 'child effective config uses resolver canonical identity');
        assert.equal(child.effective.modelId, 'api-fixture');
        assert.ok(child.output.includes('ALIAS_CHILD_DONE'));
        const spawnResult = getRun(final, parent.id).activities?.find(activity => activity.kind === 'agent' && activity.childRunId === child.id)?.content;
        assert.match(spawnResult ?? '', /fixture-api-alias/, 'the tool result can retain the requested alias');
        assert.deepEqual(api.errors, []);
    } finally {
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});

test('native parent delegates to API and native children, yields its write lease, and journals terminal results', async t => {
    const api = await createApiFixture((body, response) => {
        assert.equal(body.model, 'api-fixture');
        const users = body.messages.filter(message => message.role === 'user').map(message => stripRuntimeContextUpdate(message.content ?? '')).filter(Boolean);
        assert.equal(users.at(-1), 'API_CHILD_TASK');
        assert.equal(JSON.stringify(body.messages).includes(ROOT_MARKER), false, 'context:none must exclude the native parent conversation');
        const names = (body.tools ?? []).map(value => (value as { function?: { name?: string } }).function?.name).filter((name): name is string => Boolean(name));
        assert.ok(names.includes('write_file'), 'manual API child keeps the file-edit tool');
        assert.ok(!names.includes('run_command'), 'native descendants cannot inherit the API command tool');
        assert.ok(!names.some(name => name.startsWith('mcp_')), 'native descendants cannot inherit MCP tools');
        if (body.messages.some(message => message.role === 'tool')) {
            answer(response, 'API_CHILD_TERMINAL');
        } else {
            answer(response, '', [{ name: 'write_file', args: { path: 'api-child.txt', content: 'approved child edit', expectedContent: null } }]);
        }
    });
    const harness = createNativeHarness(api.port, {
        dynamicInputMatch: 'PARENT_BRIDGE',
        dynamicCalls: [
            { callId: 'read-skill', tool: 'uah_read_skill', arguments: { id: 'fixture-skill' } },
            { callId: 'spawn-api', tool: 'uah_spawn_agent', arguments: {
                prompt: 'API_CHILD_TASK', agent: { type: 'inherit' }, providerId: 'fixture-api', modelId: 'api-fixture',
                permissionMode: 'manual', context: { mode: 'none' },
            } },
            { callId: 'wait-api', tool: 'uah_wait_agents', arguments: { agentIds: ['$lastAgentId'], timeoutMs: 8_000 } },
            { callId: 'spawn-native', tool: 'uah_spawn_agent', arguments: {
                prompt: 'NATIVE_CHILD_TASK', agent: { type: 'inherit' }, providerId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture',
                permissionMode: 'readonly', context: { mode: 'selected', messages: [{ role: 'user', content: SELECTED_MARKER }] },
            } },
            { callId: 'wait-native', tool: 'uah_wait_agents', arguments: { agentIds: ['$lastAgentId'], timeoutMs: 8_000 } },
        ],
    });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: `PARENT_BRIDGE ${ROOT_MARKER}` });
        const parent = started.runs.at(-1);
        assert.ok(parent);

        const pending = await waitForSnapshot(harness.supervisor, snapshot => snapshot.approvals.some(approval => approval.status === 'pending'));
        // The native parent waits while the API child has a manual file-edit capability.
        // Its native scheduler lease must be yielded so the native child can later start.
        assert.equal(pending.approvals[0].runtimeId, 'api');
        assert.equal(pending.approvals[0].runId, pending.runs.find(run => run.parentRunId === parent.id)?.id);
        await harness.supervisor.execute({ type: 'resolve-approval', identity: approvalIdentity(pending.approvals[0]), decision: 'approve' });

        const completed = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
        const completedParent = getRun(completed, parent.id);
        assert.equal(completedParent.output.includes('你好，native。'), true, 'the parent fixture must return its terminal assistant text');
        const children = completed.runs.filter(run => run.parentRunId === parent.id);
        assert.equal(children.length, 2);
        const apiChild = children.find(run => run.effective.runtimeId === 'api');
        const nativeChild = children.find(run => run.effective.runtimeId === 'codex-native');
        assert.ok(apiChild);
        assert.ok(nativeChild);
        assert.deepEqual(children.map(run => run.state), ['completed', 'completed']);
        assert.equal(apiChild.contextMessages?.length, 0);
        assert.deepEqual(nativeChild.contextMessages, [{ role: 'user', content: SELECTED_MARKER }]);
        assert.ok(apiChild.output.includes('API_CHILD_TERMINAL'));
        assert.ok(nativeChild.output.includes('你好，native。'));
        assert.equal(readFileSync(join(harness.projectDirectory, 'api-child.txt'), 'utf8'), 'approved child edit');
        assert.ok(completedParent.activities?.some(activity => activity.kind === 'agent' && activity.childRunId === apiChild.id));
        assert.ok(completedParent.activities?.some(activity => activity.kind === 'agent' && activity.childRunId === nativeChild.id));

        const nativeRecords = records(harness);
        const nativeStarts = nativeRecords.filter(record => record.direction === 'client' && record.method === 'thread/start');
        assert.equal(nativeStarts.length, 2, 'parent and native child each start one fixture thread');
        for (const record of nativeStarts) {
            const params = record.params as Record<string, unknown>;
            const config = params.config as Record<string, unknown>;
            assert.equal(config['features.multi_agent'], false);
            assert.equal(config['features.multi_agent_v2'], false);
            assert.equal(config['agents.enabled'], false);
            assert.equal(config['features.unified_exec'], false);
        }
        const dynamicNames = (nativeStarts[0]!.params as Record<string, unknown>).dynamicTools as Array<{ name: string }>;
        assert.ok(dynamicNames.some(tool => tool.name === 'uah_spawn_agent'));
        assert.ok(dynamicNames.some(tool => tool.name === 'uah_wait_agents'));
        assert.ok(dynamicNames.some(tool => tool.name === 'uah_read_skill'));

        const nativeTurnInputs = nativeRecords.filter(record => record.method === 'fixture/turnRequest').map(record => {
            const params = record.params as Record<string, unknown>;
            return Array.isArray(params.input) ? params.input.map(item => (item as { text?: string }).text ?? '').join('') : '';
        });
        const selectedChildInput = nativeTurnInputs.find(input => input.includes('NATIVE_CHILD_TASK'));
        assert.ok(selectedChildInput?.includes(SELECTED_MARKER));
        assert.equal(selectedChildInput?.includes(ROOT_MARKER), false, 'selected context must exclude the parent task history');

        const store = new RuntimeStore(harness.dataDirectory);
        try {
            const journal = store.readJournal(sessionId, 0, 1_000);
            const childStateEvents = journal.filter(event => event.type === 'run.state' && children.some(child => event.run.runId === child.id && event.payload.state === 'completed'));
            assert.equal(childStateEvents.length, 2, 'each terminal child has a persisted terminal event');
            const artifactDirectory = join(harness.dataDirectory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
            const artifacts = new JournalArtifacts(artifactDirectory);
            const results = dynamicPayloads(journal, parent.id, artifacts).filter(item => item.name === 'uah_wait_agents');
            assert.equal(results.length, 2, 'each native wait result is journaled');
            const returned = results.flatMap(item => JSON.parse(String(item.content)) as Array<{ agentId: string; status: string; output: string }>);
            assert.deepEqual(new Set(returned.map(item => item.agentId)), new Set(children.map(child => child.id)));
            for (const child of children) {
                const terminal = returned.find(item => item.agentId === child.id);
                assert.equal(terminal?.status, 'completed');
                assert.ok(terminal?.output.length, `wait result for ${child.id} must include its actual terminal output`);
            }
            const skillResult = dynamicPayloads(journal, parent.id, artifacts).find(item => item.name === 'uah_read_skill');
            assert.match(String(skillResult?.content), /SKILL_CONTENT_SENTINEL/);
        } finally {
            store.close();
        }
        assert.deepEqual(api.errors, []);
    } finally {
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});

test('native parent without explicit wait delivers terminal child results and accumulates continuation usage', async () => {
    const api = await createApiFixture((_body, response) => answer(response, 'unused API fixture'));
    const harness = createNativeHarness(api.port, {
        dynamicInputMatch: 'PARENT_BRIDGE',
        dynamicCalls: [{ callId: 'spawn-native-auto', tool: 'uah_spawn_agent', arguments: {
            prompt: 'AUTO_NATIVE_CHILD', agent: { type: 'inherit' }, providerId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture',
            permissionMode: 'readonly', context: { mode: 'none' },
        } }],
    });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'PARENT_BRIDGE automatic result delivery' });
        const parent = started.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(parent);
        const final = await waitForSnapshot(harness.supervisor, snapshot =>
            snapshot.runs.some(run => run.id === parent.id && run.state === 'completed')
            && snapshot.runs.some(run => run.parentRunId === parent.id && run.state === 'completed'));
        const completedParent = getRun(final, parent.id);
        const child = final.runs.find(run => run.parentRunId === parent.id);
        assert.ok(child);
        assert.ok(child.output.includes('你好，native。'));
        assert.equal(completedParent.native?.usage?.inputTokens, 22);
        assert.equal(completedParent.native?.usage?.outputTokens, 14);
        assert.equal(completedParent.native?.usage?.cachedInputTokens, 6);
        const budget = completedParent.budgetState as Record<string, number>;
        assert.equal(budget.requestsUsed, 3, 'the task-tree budget counts parent initial, child, and parent delivery requests');
        assert.equal(budget.toolsUsed, 1, 'the task-tree budget counts the single native spawn tool call');
        assert.equal(budget.inFlight, 0, 'both request reservations settle');

        const store = new RuntimeStore(harness.dataDirectory);
        try {
            const journal = store.readJournal(sessionId, 0, 1_000);
            const artifactDirectory = join(harness.dataDirectory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
            const artifacts = new JournalArtifacts(artifactDirectory);
            const deliveries = nativeEventArtifacts(journal, parent.id, 'uah/child-results', artifacts) as Array<Array<{ agentId: string; status: string; output: string }>>;
            assert.equal(deliveries.length, 1);
            assert.equal(deliveries[0]?.length, 1);
            assert.equal(deliveries[0]?.[0]?.agentId, child.id);
            assert.equal(deliveries[0]?.[0]?.status, 'completed');
            assert.equal(deliveries[0]?.[0]?.output, child.output.slice(0, 2_000));
            const terminal = journal.find(event => event.type === 'run.state' && event.run.runId === child.id && event.payload.state === 'completed');
            assert.ok(terminal, 'the delivered child result references a persisted terminal event for that child run');
        } finally {
            store.close();
        }
        const continuationInputs = records(harness).filter(record => record.method === 'fixture/turnRequest').map(record => {
            const params = record.params as Record<string, unknown>;
            return Array.isArray(params.input) ? params.input.map(item => (item as { text?: string }).text ?? '').join('') : '';
        }).filter(input => input.includes('UAH 子代理已经结束'));
        assert.equal(continuationInputs.length, 1);
        assert.ok(continuationInputs[0]!.includes(child.id));
        assert.ok(continuationInputs[0]!.includes('你好，native。'));
    } finally {
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});

test('stopping a native parent while it waits cancels its active native descendant', async () => {
    const api = await createApiFixture((_body, response) => answer(response, 'unused API fixture'));
    const harness = createNativeHarness(api.port, {
        cancel: true,
        dynamicInputMatch: 'PARENT_BRIDGE',
        dynamicCalls: [
            { callId: 'spawn-hanging-native', tool: 'uah_spawn_agent', arguments: {
                prompt: 'HANGING_NATIVE_CHILD', agent: { type: 'inherit' }, providerId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture',
                permissionMode: 'readonly', context: { mode: 'none' },
            } },
            { callId: 'wait-hanging-native', tool: 'uah_wait_agents', arguments: { agentIds: ['$lastAgentId'], timeoutMs: 30_000 } },
        ],
    });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'PARENT_BRIDGE stop-tree test' });
        const parent = started.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(parent);
        const activeTree = await waitForSnapshot(harness.supervisor, snapshot => {
            const root = snapshot.runs.find(run => run.id === parent.id);
            const child = snapshot.runs.find(run => run.parentRunId === parent.id);
            return Boolean(root?.native?.turnId && child?.native?.turnId && child.state === 'running');
        });
        const child = activeTree.runs.find(run => run.parentRunId === parent.id);
        assert.ok(child);
        const stopped = await harness.supervisor.execute({ type: 'stop-run', runId: parent.id, reason: 'Cancel the native delegation tree fixture.' });
        const final = await waitForSnapshot(harness.supervisor, snapshot =>
            ['stopped', 'failed', 'completed'].includes(getRun(snapshot, parent.id).state)
            && ['stopped', 'failed', 'completed'].includes(getRun(snapshot, child.id).state));
        assert.equal(getRun(stopped, parent.id).state, 'stopped');
        assert.equal(getRun(final, parent.id).state, 'stopped');
        assert.equal(getRun(final, child.id).state, 'stopped');
        assert.ok(records(harness).filter(record => record.direction === 'client' && record.method === 'turn/interrupt').length >= 2,
            'both native parent and child turns receive interruption');
    } finally {
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});

test('a failed child returned from native wait releases the scheduler lease for the next run', async () => {
    const api = await createApiFixture((_body, response) => {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'intentional child fixture failure' } }));
    });
    const harness = createNativeHarness(api.port, {
        dynamicInputMatch: 'PARENT_BRIDGE',
        dynamicCalls: [
            { callId: 'spawn-failing-api', tool: 'uah_spawn_agent', arguments: {
                prompt: 'FAILING_API_CHILD', agent: { type: 'inherit' }, providerId: 'fixture-api', modelId: 'api-fixture',
                permissionMode: 'readonly', context: { mode: 'none' },
            } },
            { callId: 'wait-failing-api', tool: 'uah_wait_agents', arguments: { agentIds: ['$lastAgentId'], timeoutMs: 8_000 } },
        ],
    });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'PARENT_BRIDGE wait-failure lease test' });
        const parent = started.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(parent);
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
        const child = final.runs.find(run => run.parentRunId === parent.id);
        assert.ok(child);
        assert.equal(child.state, 'failed');
        assert.equal(getRun(final, parent.id).state, 'completed', 'a terminal child failure is reported to its parent without failing the parent turn');

        const store = new RuntimeStore(harness.dataDirectory);
        try {
            const journal = store.readJournal(sessionId, 0, 1_000);
            const artifactDirectory = join(harness.dataDirectory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
            const result = dynamicPayloads(journal, parent.id, new JournalArtifacts(artifactDirectory)).find(item => item.name === 'uah_wait_agents');
            const returned = JSON.parse(String(result?.content)) as Array<{ agentId: string; status: string }>;
            assert.deepEqual(returned.map(item => ({ agentId: item.agentId, status: item.status })), [{ agentId: child.id, status: 'failed' }]);
        } finally {
            store.close();
        }

        const followupStart = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'FOLLOWUP_AFTER_FAILED_CHILD' });
        const followup = followupStart.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(followup);
        const afterFollowup = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === followup.id && run.state === 'completed'));
        assert.ok(getRun(afterFollowup, followup.id).output.includes('你好，native。'), 'a subsequent native turn confirms the writer lease was reacquired and released');
    } finally {
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});

test('native parent manual and full-access modes both cap API child permissions at manual', async t => {
    const api = await createApiFixture((_body, response) => answer(response, 'unused API fixture'));
    try {
        for (const mode of ['manual', 'bypass'] as const) {
            await t.test(`parent ${mode}`, async () => {
                const harness = createNativeHarness(api.port, {
                    dynamicInputMatch: 'PARENT_BRIDGE',
                    dynamicCalls: [{ callId: `attempt-bypass-${mode}`, tool: 'uah_spawn_agent', arguments: {
                        prompt: 'SHOULD_NOT_START', agent: { type: 'inherit' }, providerId: 'fixture-api', modelId: 'api-fixture',
                        permissionMode: 'bypass', context: { mode: 'none' },
                    } }],
                });
                try {
                    const sessionId = await createNativeSession(harness, mode);
                    const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'PARENT_BRIDGE permission cap' });
                    const parent = started.runs.filter(run => !run.parentRunId).at(-1);
                    assert.ok(parent);
                    const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
                    assert.equal(final.runs.filter(run => run.parentRunId === parent.id).length, 0);
                    const store = new RuntimeStore(harness.dataDirectory);
                    try {
                        const journal = store.readJournal(sessionId, 0, 1_000);
                        const artifactDirectory = join(harness.dataDirectory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
                        const results = dynamicPayloads(journal, parent.id, new JournalArtifacts(artifactDirectory));
                        const failure = results.find(item => item.name === 'uah_spawn_agent');
                        assert.equal(failure?.isError, true);
                        assert.match(String(failure?.content), /子代理权限不能超过父代理|API 子代理最多使用 manual/);
                    } finally {
                        store.close();
                    }
                } finally {
                    await harness.supervisor.shutdown();
                    cleanupHarness(harness);
                }
            });
        }
    } finally {
        await api.close();
    }
});

test('native delegation honors the global switch and maximum depth', async t => {
    const api = await createApiFixture((_body, response) => answer(response, 'unused API fixture'));
    try {
        await t.test('global switch omits delegation tools', async () => {
            const harness = createNativeHarness(api.port, {});
            harness.settings.subagents.enabled = false;
            try {
                const sessionId = await createNativeSession(harness);
                const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'No delegation tools should be registered.' });
                const parent = started.runs.filter(run => !run.parentRunId).at(-1);
                assert.ok(parent);
                const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
                assert.equal(getRun(final, parent.id).effective.allowDelegation, false);
                const threadStart = records(harness).find(record => record.direction === 'client' && record.method === 'thread/start');
                assert.ok(threadStart);
                const tools = ((threadStart.params as Record<string, unknown>).dynamicTools ?? []) as Array<{ name: string }>;
                assert.ok(!tools.some(tool => ['uah_list_agent_presets', 'uah_spawn_agent', 'uah_wait_agents'].includes(tool.name)));
            } finally {
                await harness.supervisor.shutdown();
                cleanupHarness(harness);
            }
        });

        await t.test('a depth-one child cannot start a grandchild', async () => {
            const harness = createNativeHarness(api.port, {
                dynamicInputMatch: 'PARENT_BRIDGE',
                dynamicCalls: [{ callId: 'depth-attempt', tool: 'uah_spawn_agent', arguments: {
                    prompt: 'GRANDCHILD_ATTEMPT PARENT_BRIDGE', agent: { type: 'inherit' },
                    providerId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture', permissionMode: 'readonly', context: { mode: 'none' },
                } }],
            });
            try {
                harness.settings.subagents.maxDepth = 1;
                const sessionId = await createNativeSession(harness);
                const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'PARENT_BRIDGE depth guard' });
                const parent = started.runs.filter(run => !run.parentRunId).at(-1);
                assert.ok(parent);
                const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
                const children = final.runs.filter(run => run.parentRunId === parent.id);
                assert.equal(children.length, 1, 'the child spawn succeeds but its grandchild spawn is rejected');
                const starts = records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start');
                assert.equal(starts.length, 2, 'the rejected grandchild never starts another native process');
                const childStart = starts.find(record => {
                    const tools = ((record.params as Record<string, unknown>).dynamicTools ?? []) as Array<{ name: string }>;
                    return !tools.some(tool => tool.name === 'uah_spawn_agent');
                });
                assert.ok(childStart, 'the depth-one native child does not receive the spawn tool');
                const rejected = records(harness).find(record => record.method === 'fixture/dynamicToolResponse'
                    && (record.params as Record<string, unknown>).tool === 'uah_spawn_agent'
                    && (record.params as Record<string, unknown>).error !== undefined);
                assert.ok(rejected, 'the fixture’s attempted grandchild call is rejected as unregistered before host dispatch');
                assert.equal(children[0]?.activities?.some(activity => activity.kind === 'agent'), false);
            } finally {
                await harness.supervisor.shutdown();
                cleanupHarness(harness);
            }
        });
    } finally {
        await api.close();
    }
});

test('native parent enforces max concurrent children while an earlier API child is active', async () => {
    let releaseApiChild!: () => void;
    let markApiChildRequest!: () => void;
    const blockedChild = new Promise<void>(resolveBlocked => { releaseApiChild = resolveBlocked; });
    const apiRequestArrived = new Promise<void>(resolveArrived => { markApiChildRequest = resolveArrived; });
    const api = await createApiFixture(async (_body, response) => {
        markApiChildRequest();
        await blockedChild;
        answer(response, 'API_CHILD_AFTER_GATE');
    });
    const harness = createNativeHarness(api.port, {
        dynamicInputMatch: 'PARENT_BRIDGE',
        dynamicCalls: [
            { callId: 'spawn-first-api', tool: 'uah_spawn_agent', arguments: {
                prompt: 'FIRST_API_CHILD', agent: { type: 'inherit' }, providerId: 'fixture-api', modelId: 'api-fixture',
                permissionMode: 'readonly', context: { mode: 'none' },
            } },
            { callId: 'spawn-over-limit-api', tool: 'uah_spawn_agent', arguments: {
                prompt: 'SECOND_API_CHILD_MUST_NOT_START', agent: { type: 'inherit' }, providerId: 'fixture-api', modelId: 'api-fixture',
                permissionMode: 'readonly', context: { mode: 'none' },
            } },
        ],
    });
    try {
        harness.settings.subagents.maxConcurrentThreads = 1;
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'PARENT_BRIDGE concurrency guard' });
        const parent = started.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(parent);
        await Promise.race([
            apiRequestArrived,
            delay(8_000).then(() => { throw new Error('first API child did not reach its fixture'); }),
        ]);
        const active = await waitForSnapshot(harness.supervisor, snapshot =>
            snapshot.runs.some(run => run.id === parent.id && run.state === 'running')
            && snapshot.runs.some(run => run.parentRunId === parent.id && run.state === 'running'));
        assert.equal(active.runs.filter(run => run.parentRunId === parent.id).length, 1);
        releaseApiChild();
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
        const child = final.runs.find(run => run.parentRunId === parent.id);
        assert.ok(child);
        assert.equal(child.state, 'completed');
        assert.ok(child.output.includes('API_CHILD_AFTER_GATE'));
        const store = new RuntimeStore(harness.dataDirectory);
        try {
            const journal = store.readJournal(sessionId, 0, 1_000);
            const artifactDirectory = join(harness.dataDirectory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
            const results = dynamicPayloads(journal, parent.id, new JournalArtifacts(artifactDirectory));
            const rejected = results.find(item => item.name === 'uah_spawn_agent' && String(item.content).includes('并发上限'));
            assert.ok(rejected, 'the second spawn returns the configured concurrency guard');
        } finally {
            store.close();
        }
        assert.equal(api.requests.length, 1, 'only the permitted API child reaches the endpoint');
    } finally {
        releaseApiChild();
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});

test('an API parent cannot delegate directly into the native Codex sandbox', async () => {
    const api = await createApiFixture((body, response) => {
        if (body.messages.some(message => message.role === 'tool')) answer(response, 'API_PARENT_FINAL');
        else answer(response, '', [{ name: 'spawn_agent', args: {
            prompt: 'NATIVE_CHILD_MUST_NOT_START', agent: { type: 'inherit' }, providerId: NATIVE_CODEX_ENDPOINT_ID,
            modelId: 'gpt-fixture', context: { mode: 'none' },
        } }]);
    });
    const harness = createNativeHarness(api.port, {});
    try {
        const created = await harness.supervisor.execute({
            type: 'create-session', title: 'API parent boundary', directory: harness.projectDirectory,
            selection: { endpointId: 'fixture-api', modelId: 'api-fixture' },
            controls: { permissionMode: 'manual', reasoningEffort: 'default' }, agentId: 'default',
        });
        const session = created.sessions.at(-1);
        assert.ok(session);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId: session.id, input: 'Reject native child mapping.' });
        const parent = started.runs.filter(run => !run.parentRunId).at(-1);
        assert.ok(parent);
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === parent.id && run.state === 'completed'));
        assert.equal(final.runs.filter(run => run.parentRunId === parent.id).length, 0);
        assert.ok(getRun(final, parent.id).output.includes('API_PARENT_FINAL'));
        assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 0,
            'the incompatible native child is rejected before starting an app-server process');
        const rejected = getRun(final, parent.id).activities?.find(activity => activity.tool?.name === 'spawn_agent');
        assert.ok(rejected);
        assert.match(rejected.tool?.result ?? '', /不能直接映射到原生沙箱/);
        assert.deepEqual(api.errors, []);
    } finally {
        await harness.supervisor.shutdown();
        await api.close();
        cleanupHarness(harness);
    }
});
