import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { ApiConnection } from '../../src/shared/endpoints.js';
import { parseCommand, type RuntimeEvent, type Snapshot } from '../../src/shared/contracts.js';
import { Supervisor } from '../../src/runtime/supervisor.js';
import { defaultAgentParameters, type AgentProfile } from '../../src/shared/agents.js';
import { defaultModelParameters } from '../../src/shared/model-parameters.js';

interface Fixture {
    server: Server;
    baseUrl: string;
    requests: Array<{ url: string; body: Record<string, unknown> }>;
    waitForStalledRequest: (count?: number) => Promise<void>;
    waitForAbort: () => Promise<void>;
    close: () => Promise<void>;
}

function createFixture(): Promise<Fixture> {
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    let stalledRequests = 0;
    const stalledWaiters: Array<{ count: number; resolve: () => void }> = [];
    let signalAbort: (() => void) | undefined;
    const aborted = new Promise<void>((resolveAbort) => {
        signalAbort = resolveAbort;
    });
    const server = createServer(async (request, response) => {
        const body = await readJson(request);
        requests.push({ url: request.url ?? '', body });
        response.writeHead(200, {
            'content-type': 'text/event-stream; charset=utf-8',
            'cache-control': 'no-cache',
        });
        if (body.messages && Array.isArray(body.messages)
            && body.messages.some((message) => message && typeof message === 'object'
                && (message as { content?: unknown }).content === 'stall')) {
            request.once('aborted', () => signalAbort?.());
            response.once('close', () => signalAbort?.());
            stalledRequests += 1;
            for (const waiter of stalledWaiters.splice(0)) {
                if (stalledRequests >= waiter.count) {
                    waiter.resolve();
                } else {
                    stalledWaiters.push(waiter);
                }
            }
            return;
        }
        const answer = requests.length === 1 ? 'first answer' : 'second answer';
        response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: 'stop' }] })}\n\n`);
        response.end('data: [DONE]\n\n');
    });

    return new Promise((resolveFixture, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            assert.ok(address && typeof address !== 'string');
            resolveFixture({
                server,
                baseUrl: `http://127.0.0.1:${address.port}`,
                requests,
                waitForStalledRequest: (count = 1) => {
                    if (stalledRequests >= count) {
                        return Promise.resolve();
                    }
                    return new Promise((resolveRequest) => {
                        stalledWaiters.push({ count, resolve: resolveRequest });
                    });
                },
                waitForAbort: () => aborted,
                close: () => new Promise((resolveClose, rejectClose) =>
                    server.close((error) => error ? rejectClose(error) : resolveClose())),
            });
        });
    });
}

function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolveBody, reject) => {
        const chunks: Buffer[] = [];
        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.once('error', reject);
        request.once('end', () => {
            try {
                resolveBody(JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>);
            } catch (error) {
                reject(error);
            }
        });
    });
}

function connection(baseUrl: string, revision = 1): ApiConnection {
    return {
        id: 'endpoint-1',
        name: 'Local fixture',
        protocol: 'openai-chat',
        baseUrl,
        apiKey: 'api-secret-must-never-persist',
        models: ['test-model'],
        enabled: true,
        revision,
    };
}

function isRuntimeContextUpdate(message: { role: string; content: unknown }): boolean {
    return message.role === 'user' && typeof message.content === 'string'
        && message.content.includes('[UAH runtime context update v2]');
}

function visibleApiMessages(messages: Array<{ role: string; content: string }>): Array<{ role: string; content: string }> {
    return messages.filter(message => message.role !== 'system').flatMap(message => {
        const marker = message.content.indexOf('[UAH runtime context update v2]');
        const content = marker < 0 ? message.content : message.content.slice(0, marker).trimEnd();
        return content ? [{ role: message.role, content }] : [];
    });
}

function cleanup(root: string): void {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-api-test-')) {
        throw new Error(`Refusing to recursively remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

async function waitForSnapshot(
    supervisor: Supervisor,
    predicate: (snapshot: Snapshot) => boolean,
): Promise<Snapshot> {
    const timeout = Date.now() + 5_000;
    let snapshot = await supervisor.execute({ type: 'snapshot' });
    while (!predicate(snapshot) && Date.now() < timeout) {
        await delay(5);
        snapshot = await supervisor.execute({ type: 'snapshot' });
    }
    assert.equal(predicate(snapshot), true, 'runtime did not reach the expected state');
    return snapshot;
}

test('API runs fail closed while the V2 context engine is operationally paused', async () => {
    const previous = process.env.UAH_CONTEXT_V2_ENABLED;
    process.env.UAH_CONTEXT_V2_ENABLED = '0';
    let root: string | undefined;
    let fixture: Fixture | undefined;
    let supervisor: Supervisor | undefined;
    try {
        root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
        fixture = await createFixture();
        const profile: AgentProfile = { id: 'default', name: 'Agent', description: '', instructions: 'Agent instructions',
            enabled: true, kind: 'primary', allowDelegation: true };
        supervisor = new Supervisor({ dataDirectory: root, delayMs: 0, onEvent: () => {},
            resolveConnection: async () => connection(fixture!.baseUrl), resolveAgent: () => profile });
        const created = await supervisor.execute({ type: 'create-session', title: 'Paused V2', directory: null,
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' } });
        const started = await supervisor.execute({ type: 'start-run', sessionId: created.sessions[0].id, input: 'must not dispatch' });
        const failed = await waitForSnapshot(supervisor, snapshot => snapshot.runs.some(run => run.id === started.runs[0].id && run.state === 'failed'));
        const run = failed.runs.find(item => item.id === started.runs[0].id)!;
        assert.match(run.error ?? '', /API 上下文引擎 V2 已由运行配置暂停/);
        assert.equal(fixture.requests.length, 0);
    } finally {
        try {
            if (supervisor) await supervisor.shutdown();
            if (fixture) await fixture.close();
            if (root) cleanup(root);
        } finally {
            if (previous === undefined) delete process.env.UAH_CONTEXT_V2_ENABLED;
            else process.env.UAH_CONTEXT_V2_ENABLED = previous;
        }
    }
});

test('session agent stays locked across model changes, profile deletion and restart', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const fixture = await createFixture();
    const profile: AgentProfile = {
        id: 'custom-agent', name: 'Original', description: '', instructions: 'Original instructions', enabled: true,
        kind: 'primary', allowDelegation: true,
    };
    const selectedConnection: ApiConnection = { ...connection(fixture.baseUrl), models: ['test-model', 'other-model'], modelParameters: [
        { id: 'test-model', parameters: { ...defaultModelParameters(), temperature: 0.2, historyTurns: 0 } },
        { id: 'other-model', parameters: { ...defaultModelParameters(), temperature: 0.8, historyTurns: 1 } },
    ] };
    let deleted = false;
    const options = { dataDirectory: root, delayMs: 0, onEvent: () => {},
        resolveConnection: async () => selectedConnection,
        resolveAgent: () => { if (deleted) throw new Error('profile deleted'); return profile; } };
    let supervisor = new Supervisor(options);
    try {
        const created = await supervisor.execute({ type: 'create-session', title: 'Agent', directory: null,
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' },
            controls: { permissionMode: 'accept-edits', reasoningEffort: 'default' } });
        const sessionId = created.sessions[0].id;
        const first = await supervisor.execute({ type: 'start-run', sessionId, input: 'one', agentId: profile.id });
        profile.name = 'Changed'; profile.instructions = 'Changed instructions'; profile.enabled = false;
        profile.allowDelegation = false;
        await waitForSnapshot(supervisor, (snapshot) => snapshot.runs[0].state === 'completed');
        assert.equal(first.runs[0].effective.agentName, 'Original');
        assert.equal(first.runs[0].effective.modelParameters?.temperature, 0.2);
        assert.equal(Object.hasOwn(first.runs[0].effective, 'agentParameters'), false);
        assert.equal(first.runs[0].effective.permissionMode, 'accept-edits');
        assert.equal(first.runs[0].effective.allowDelegation, true);
        assert.equal(first.runs[0].effective.modelId, 'test-model');
        await supervisor.execute({ type: 'start-run', sessionId, input: 'two' });
        await waitForSnapshot(supervisor, (snapshot) => snapshot.runs.at(-1)?.state === 'completed');
        const secondMessages = fixture.requests[1].body.messages as Array<{ role: string; content: string }>;
        assert.match(secondMessages[0].content, /UAH_MODULE:agent.instructions:v1\s*-->\nOriginal instructions/);
        assert.match(secondMessages[0].content, /UAH_MODULE:host.contract:v4/);
        assert.doesNotMatch(secondMessages[0].content, /Changed instructions/);
        assert.equal(secondMessages.some(message => isRuntimeContextUpdate(message)), true);
        // historyTurns: 0 intentionally starts this request with a fresh semantic window;
        // the V2 runtime tail remains observable, but the old surface is not reused.
        assert.deepEqual(visibleApiMessages(secondMessages), [{ role: 'user', content: 'two' }]);
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId, input: 'bad', agentId: 'different-agent' }), /已固定/);
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId, input: 'bad', selection: null }), /已固定/);
        deleted = true;
        await supervisor.shutdown();
        supervisor = new Supervisor(options);
        await supervisor.execute({ type: 'start-run', sessionId, input: 'three', agentId: profile.id,
            selection: { endpointId: 'endpoint-1', modelId: 'other-model' } });
        await waitForSnapshot(supervisor, (snapshot) => snapshot.runs.at(-1)?.state === 'completed');
        const thirdMessages = fixture.requests[2].body.messages as Array<{ role: string; content: string }>;
        assert.match(thirdMessages[0].content, /UAH_MODULE:agent.instructions:v1\s*-->\nOriginal instructions/);
        assert.doesNotMatch(thirdMessages[0].content, /Changed instructions/);
        assert.equal(thirdMessages.some(message => isRuntimeContextUpdate(message)), true);
        assert.deepEqual(visibleApiMessages(thirdMessages), [
            { role: 'user', content: 'two' }, { role: 'assistant', content: 'second answer' }, { role: 'user', content: 'three' },
        ]);
        const snapshot = await supervisor.execute({ type: 'snapshot' });
        assert.equal(snapshot.runs.at(-1)?.effective.modelParameters?.temperature, 0.8);
        assert.equal(snapshot.runs.at(-1)?.effective.modelId, 'other-model');
        assert.equal(snapshot.runs.at(-1)?.effective.agentId, 'custom-agent');
        assert.equal(snapshot.runs.at(-1)?.effective.permissionMode, 'accept-edits');
        const local = await supervisor.execute({ type: 'create-session', title: 'Local', directory: null });
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId: local.sessions.at(-1)!.id, input: 'bad', agentId: profile.id }), /本地验证/);
    } finally { await supervisor.shutdown(); await fixture.close(); cleanup(root); }
});

test('rejected first start does not lock the session agent and default profile is resolved', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const fixture = await createFixture();
    let profile: AgentProfile = { id: 'disabled', name: 'Agent', description: '', instructions: '', enabled: false,
        kind: 'primary', allowDelegation: true };
    const supervisor = new Supervisor({ dataDirectory: root, delayMs: 0, onEvent: () => {},
        resolveConnection: async () => connection(fixture.baseUrl), resolveAgent: (id) => {
            assert.equal(id, profile.id); return profile;
        } });
    try {
        const created = await supervisor.execute({ type: 'create-session', title: 'API', directory: null,
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' } });
        const sessionId = created.sessions[0].id;
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId, input: 'bad', agentId: 'disabled' }), /停用/);
        assert.equal((await supervisor.execute({ type: 'snapshot' })).runs.length, 0);
        profile = { ...profile, id: 'default', enabled: true, kind: 'subagent' };
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId, input: 'bad' }), /主智能体/);
        profile = { id: profile.id, name: profile.name, description: profile.description, instructions: profile.instructions,
            enabled: true, kind: 'primary', allowDelegation: profile.allowDelegation };
        const started = await supervisor.execute({ type: 'start-run', sessionId, input: 'good' });
        assert.equal(started.runs[0].effective.agentId, 'default');
        assert.equal(started.runs[0].effective.permissionMode, 'manual');
        assert.deepEqual(started.runs[0].effective.modelParameters, defaultModelParameters());
        await waitForSnapshot(supervisor, (snapshot) => snapshot.runs[0].state === 'completed');
    } finally { await supervisor.shutdown(); await fixture.close(); cleanup(root); }
});

test('legacy defaultAgentParameters alias retains model parameter defaults', () => {
    assert.deepEqual(defaultAgentParameters(), defaultModelParameters());
});

test('session controls persist without a run, revise optimistically, and leave locked agents and old runs immutable', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const fixture = await createFixture();
    const profile: AgentProfile = { id: 'default', kind: 'primary', name: 'Main', instructions: 'Agent instructions',
        description: '', enabled: true, allowDelegation: true };
    const options = { dataDirectory: root, delayMs: 0, onEvent: () => {}, resolveAgent: () => profile,
        resolveConnection: async () => ({ ...connection(fixture.baseUrl), modelParameters: [
            { id: 'test-model', parameters: { ...defaultModelParameters(), thinkingBudget: 1024 } },
        ] }) };
    let supervisor = new Supervisor(options);
    try {
        const created = await supervisor.execute({ type: 'create-session', title: 'Controls', directory: null, agentId: 'default',
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' } });
        const sessionId = created.sessions[0].id;
        assert.deepEqual(created.sessions[0].controls, { permissionMode: 'manual', reasoningEffort: 'default' });
        const controls = { permissionMode: 'plan' as const, reasoningEffort: 'high' as const };
        const configured = await supervisor.execute({ type: 'set-session-controls', sessionId, controls, revision: 0 });
        assert.equal(configured.runs.length, 0);
        assert.equal(configured.sessions[0].controlsRevision, 1);
        await assert.rejects(supervisor.execute({ type: 'set-session-controls', sessionId, controls, revision: 0 }), /已更新/);
        const started = await supervisor.execute({ type: 'start-run', sessionId, input: 'first' });
        await waitForSnapshot(supervisor, snapshot => snapshot.runs[0].state === 'completed');
        assert.deepEqual(started.sessions[0].initialConfig, created.sessions[0].initialConfig, 'creation snapshot must survive pre-run configuration changes');
        assert.deepEqual(started.sessions[0].initialConfig?.controls, { permissionMode: 'manual', reasoningEffort: 'default' });
        assert.equal(started.runs[0].effective.agentInstructions, 'Agent instructions');
        assert.equal(started.runs[0].effective.modelParameters?.thinkingBudget, null);
        assert.equal(started.runs[0].effective.modelParameters?.reasoningEffort, 'high');
        const system = (fixture.requests[0].body.messages as Array<{ role: string; content: string }>)[0];
        assert.equal(system.role, 'system');
        assert.ok(system.content.includes('Agent instructions'));
        assert.match(system.content, /UAH_MODULE:session.permissions:v1/);
        assert.match(system.content, /当前权限：plan/);
        assert.match(system.content, /UAH_MODULE:plan.workflow:v1/);
        assert.equal(profile.instructions, 'Agent instructions');
        const nextControls = { permissionMode: 'bypass' as const, reasoningEffort: 'low' as const };
        const updated = await supervisor.execute({ type: 'set-session-controls', sessionId, controls: nextControls, revision: 1 });
        assert.equal(updated.runs[0].effective.permissionMode, 'plan');
        assert.equal(updated.sessions[0].controlsRevision, 2);
        await supervisor.shutdown();
        supervisor = new Supervisor({ ...options, resolveAgent: () => { throw new Error('Agent deleted'); } });
        const restored = await supervisor.execute({ type: 'snapshot' });
        assert.deepEqual(restored.sessions[0].controls, nextControls);
        assert.equal(restored.sessions[0].controlsRevision, 2);
        const next = await supervisor.execute({ type: 'start-run', sessionId, input: 'stall' });
        await fixture.waitForStalledRequest();
        assert.equal(next.runs.at(-1)?.effective.permissionMode, 'bypass');
        assert.equal(next.runs.at(-1)?.effective.agentId, 'default');
        assert.equal(next.runs.at(-1)?.effective.modelParameters?.reasoningEffort, 'low');
        await assert.rejects(supervisor.execute({ type: 'set-session-controls', sessionId, controls, revision: 2 }), /正在运行/);
        await supervisor.execute({ type: 'stop-run', runId: next.runs.at(-1)!.id });
        const local = await supervisor.execute({ type: 'create-session', title: 'Local', directory: null });
        await assert.rejects(supervisor.execute({ type: 'set-session-controls', sessionId: local.sessions.at(-1)!.id, controls, revision: 0 }), /本地验证/);
        await assert.rejects(supervisor.execute({ type: 'create-session', title: 'Local', directory: null, controls }), /本地验证/);
    } finally { await supervisor.shutdown(); await fixture.close(); cleanup(root); }
});

test('session control IPC rejects extra fields, invalid modes, effort, revisions and accessors', () => {
    const valid = { type: 'set-session-controls', sessionId: 'session', controls: { permissionMode: 'manual', reasoningEffort: 'default' }, revision: 0 };
    assert.deepEqual(parseCommand(valid), valid);
    for (const permissionMode of ['manual', 'plan', 'readonly', 'accept-edits', 'auto', 'bypass']) {
        assert.doesNotThrow(() => parseCommand({ ...valid, controls: { ...valid.controls, permissionMode } }));
    }
    for (const controls of [{ permissionMode: 'inherit', reasoningEffort: 'high' }, { permissionMode: 'manual', reasoningEffort: 'wrong' },
        { permissionMode: 'manual' }, { ...valid.controls, extra: true },
        Object.defineProperty({ reasoningEffort: 'high' }, 'permissionMode', { get: () => 'manual', enumerable: true })]) {
        assert.throws(() => parseCommand({ ...valid, controls }));
        assert.throws(() => parseCommand({ type: 'create-session', title: 'Title', directory: null, controls }));
    }
    for (const revision of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0']) assert.throws(() => parseCommand({ ...valid, revision }));
    assert.throws(() => parseCommand({ ...valid, extra: true }));
});

test('legacy sessions retain a valid requested permission and default invalid legacy permission to manual', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const fixture = await createFixture();
    const options = { dataDirectory: root, delayMs: 0, onEvent: () => {}, resolveConnection: async () => connection(fixture.baseUrl) };
    let supervisor = new Supervisor(options);
    try {
        for (const title of ['valid', 'invalid']) await supervisor.execute({ type: 'create-session', title, directory: null,
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' } });
        const created = await supervisor.execute({ type: 'snapshot' });
        await supervisor.shutdown();
        const database = new DatabaseSync(join(root, 'runtime.sqlite'));
        try {
            for (const session of created.sessions) {
                const { controls: _controls, controlsRevision: _revision, ...legacy } = session;
                database.prepare('UPDATE sessions SET data = ? WHERE id = ?').run(JSON.stringify({ ...legacy,
                    requested: { ...legacy.requested, permissionMode: session.title === 'valid' ? 'auto' : 'unknown' } }), session.id);
            }
        } finally { database.close(); }
        supervisor = new Supervisor(options);
        for (const session of created.sessions) {
            await supervisor.execute({ type: 'start-run', sessionId: session.id, input: 'hello' });
            const snapshot = await waitForSnapshot(supervisor, state => state.runs.at(-1)?.state === 'completed');
            assert.equal(snapshot.runs.at(-1)?.effective.permissionMode, session.title === 'valid' ? 'auto' : 'manual');
            assert.equal(snapshot.sessions.find(item => item.id === session.id)?.controls?.reasoningEffort, 'default');
        }
    } finally { await supervisor.shutdown(); await fixture.close(); cleanup(root); }
});

test('start-run reads controls updated while endpoint resolution is pending', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const fixture = await createFixture();
    let release: (() => void) | undefined;
    let pauseResolution = false;
    const supervisor = new Supervisor({ dataDirectory: root, delayMs: 0, onEvent: () => {}, resolveConnection: async () => {
        if (pauseResolution) await new Promise<void>(resolvePending => { release = resolvePending; });
        return connection(fixture.baseUrl);
    } });
    try {
        const created = await supervisor.execute({ type: 'create-session', title: 'Race', directory: null,
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' } });
        const sessionId = created.sessions[0].id;
        pauseResolution = true;
        const pending = supervisor.execute({ type: 'start-run', sessionId, input: 'hello' });
        assert.ok(release);
        await supervisor.execute({ type: 'set-session-controls', sessionId, controls: { permissionMode: 'readonly', reasoningEffort: 'medium' }, revision: 0 });
        release();
        const started = await pending;
        assert.equal(started.runs[0].effective.permissionMode, 'readonly');
        assert.equal(started.runs[0].effective.modelParameters?.reasoningEffort, 'medium');
        assert.equal(started.sessions[0].controlsRevision, 1);
        await waitForSnapshot(supervisor, snapshot => snapshot.runs[0].state === 'completed');
    } finally { release?.(); await supervisor.shutdown(); await fixture.close(); cleanup(root); }
});

test('legacy API and local identities cannot be bypassed by toggling runtime selection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const fixture = await createFixture();
    const supervisor = new Supervisor({ dataDirectory: root, delayMs: 0, onEvent: () => {},
        resolveConnection: async () => connection(fixture.baseUrl) });
    try {
        const api = await supervisor.execute({ type: 'create-session', title: 'API', directory: null,
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' } });
        const apiSessionId = api.sessions[0].id;
        await supervisor.execute({ type: 'start-run', sessionId: apiSessionId, input: 'hello' });
        await waitForSnapshot(supervisor, (snapshot) => snapshot.runs[0].state === 'completed');
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId: apiSessionId, input: 'bad', agentId: 'default' }), /已固定/);
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId: apiSessionId, input: 'bad', selection: null }), /已固定/);
        const local = await supervisor.execute({ type: 'create-session', title: 'Local', directory: null });
        const localSessionId = local.sessions.at(-1)!.id;
        await supervisor.execute({ type: 'start-run', sessionId: localSessionId, input: 'hello' });
        await waitForSnapshot(supervisor, (snapshot) => snapshot.runs.at(-1)?.state === 'completed');
        await assert.rejects(supervisor.execute({ type: 'start-run', sessionId: localSessionId, input: 'bad',
            selection: { endpointId: 'endpoint-1', modelId: 'test-model' } }), /已固定/);
        const snapshot = await supervisor.execute({ type: 'snapshot' });
        assert.equal(snapshot.runs[0].effective.agentId, 'api-text');
        assert.equal(snapshot.runs[0].effective.permissionMode, 'manual');
        assert.equal(snapshot.runs[0].effective.allowDelegation, false);
        assert.equal(snapshot.runs[1].effective.agentId, 'local-verification');
        assert.equal(Object.hasOwn(snapshot.runs[1].effective, 'modelParameters'), false);
    } finally { await supervisor.shutdown(); await fixture.close(); cleanup(root); }
});

test('API sessions stream selected models with fresh endpoint metadata and persistent history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const dataDirectory = join(root, 'data');
    const projectDirectory = join(root, 'project');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    const fixture = await createFixture();
    const events: RuntimeEvent[] = [];
    let current = connection(fixture.baseUrl, 3);
    const supervisor = new Supervisor({
        dataDirectory,
        delayMs: 0,
        onEvent: (event) => events.push(event),
        resolveConnection: async (id) => {
            if (id !== current.id) {
                throw new Error('endpoint deleted');
            }
            return current;
        },
    });
    try {
        const created = await supervisor.execute({
            type: 'create-session',
            title: 'API chat',
            directory: projectDirectory,
            selection: { endpointId: current.id, modelId: 'test-model' },
        });
        const session = created.sessions.at(-1);
        assert.ok(session);
        assert.deepEqual(session.requested, {
            runtimeId: 'api',
            agentId: 'api-text',
            modelId: 'test-model',
            policyVersion: 1,
            endpointId: current.id,
            endpointRevision: 3,
            endpointUrl: fixture.baseUrl,
            protocol: 'openai-chat',
        });

        current = { ...current, baseUrl: `${fixture.baseUrl}/v2`, revision: 4 };
        const firstStarted = await supervisor.execute({
            type: 'start-run', sessionId: session.id, input: 'first prompt',
        });
        const firstRun = firstStarted.runs.at(-1);
        assert.ok(firstRun);
        const firstDone = await waitForSnapshot(supervisor, (snapshot) =>
            snapshot.runs.some((run) => run.id === firstRun.id && run.state === 'completed'));
        assert.equal(firstDone.runs.find((run) => run.id === firstRun.id)?.effective.endpointRevision, 4);
        assert.equal(firstDone.runs.find((run) => run.id === firstRun.id)?.effective.endpointUrl, `${fixture.baseUrl}/v2`);
        assert.match(fixture.requests[0].url, /^\/v2\//);

        current = { ...current, models: ['test-model', 'second-model'] };
        const secondStarted = await supervisor.execute({
            type: 'start-run', sessionId: session.id, input: 'second prompt',
            selection: { endpointId: current.id, modelId: 'second-model' },
        });
        const secondRun = secondStarted.runs.at(-1);
        assert.ok(secondRun);
        const completed = await waitForSnapshot(supervisor, (snapshot) =>
            snapshot.runs.some((run) => run.id === secondRun.id && run.state === 'completed'));
        assert.equal(completed.approvals.length, 0, 'API runs never request file approval');
        assert.equal(completed.artifacts.length, 0, 'API runs never create file artifacts');
        assert.equal(fixture.requests[1].body.model, 'second-model');
        assert.equal(completed.sessions[0].requested.modelId, 'second-model');
        assert.equal(completed.runs.find(run => run.id === firstRun.id)?.effective.modelId, 'test-model');
        const historyMessages = fixture.requests[1].body.messages as Array<{ role: string; content: string }>;
        assert.equal(historyMessages[0].role, 'system');
        assert.match(historyMessages[0].content, /UAH_MODULE:host.contract:v4/);
        assert.equal(historyMessages.some(message => isRuntimeContextUpdate(message)), true);
        assert.deepEqual(visibleApiMessages(historyMessages), [
            { role: 'user', content: 'first prompt' },
            { role: 'assistant', content: 'first answer' },
            { role: 'user', content: 'second prompt' },
        ]);

        const database = new DatabaseSync(join(dataDirectory, 'runtime.sqlite'));
        const rows = database.prepare('SELECT data FROM sessions UNION ALL SELECT data FROM runs UNION ALL SELECT data FROM events').all() as Array<{ data: string }>;
        database.close();
        assert.equal(JSON.stringify({ completed, events, rows }).includes(current.apiKey), false);

        const beforeRejectedStarts = completed.runs.length;
        current = { ...current, enabled: false };
        await assert.rejects(
            supervisor.execute({ type: 'start-run', sessionId: session.id, input: 'disabled endpoint' }),
            /unavailable|offers this model/,
        );
        current = { ...current, enabled: true, models: [] };
        await assert.rejects(
            supervisor.execute({ type: 'start-run', sessionId: session.id, input: 'missing model' }),
            /unavailable|offers this model/,
        );
        current = { ...current, models: ['test-model'], id: 'replacement' };
        await assert.rejects(
            supervisor.execute({ type: 'start-run', sessionId: session.id, input: 'deleted endpoint' }),
            /endpoint deleted/,
        );
        const afterRejectedStarts = await supervisor.execute({ type: 'snapshot' });
        assert.equal(afterRejectedStarts.runs.length, beforeRejectedStarts);
    } finally {
        await supervisor.shutdown();
        await fixture.close();
        cleanup(root);
    }
});

test('API stop and shutdown wait for an aborted stream before recording stopped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-api-test-'));
    const dataDirectory = join(root, 'data');
    mkdirSync(dataDirectory, { recursive: true });
    const fixture = await createFixture();
    const current = connection(fixture.baseUrl);
    const supervisor = new Supervisor({
        dataDirectory,
        delayMs: 0,
        onEvent: () => undefined,
        resolveConnection: async () => current,
    });
    try {
        const created = await supervisor.execute({
            type: 'create-session',
            title: 'Cancellation',
            directory: null,
            selection: { endpointId: current.id, modelId: 'test-model' },
        });
        const session = created.sessions.at(-1);
        assert.ok(session);
        const started = await supervisor.execute({
            type: 'start-run', sessionId: session.id, input: 'stall',
        });
        const run = started.runs.at(-1);
        assert.ok(run);
        await fixture.waitForStalledRequest();
        const stopped = await supervisor.execute({ type: 'stop-run', runId: run.id });
        await fixture.waitForAbort();
        assert.equal(stopped.runs.find((item) => item.id === run.id)?.state, 'stopped');

        const restarted = await supervisor.execute({
            type: 'start-run', sessionId: session.id, input: 'stall',
        });
        assert.ok(restarted.runs.at(-1));
        await fixture.waitForStalledRequest(2);
        await supervisor.shutdown();
    } finally {
        await fixture.close();
        cleanup(root);
    }
});
