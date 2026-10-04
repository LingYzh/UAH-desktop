import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { ApiConnection } from '../../src/shared/endpoints.js';
import { defaultAgentSettings, type AgentProfile } from '../../src/shared/agents.js';
import type { ExtensionRuntimeBundle } from '../../src/shared/extension-runtime.js';
import { NATIVE_CODEX_ENDPOINT_ID } from '../../src/shared/native-codex.js';
import { MemoryStore } from '../../src/runtime/memory-store.js';
import { Supervisor } from '../../src/runtime/supervisor.js';
import type { Snapshot } from '../../src/shared/contracts.js';

type Protocol = ApiConnection['protocol'];
type Body = Record<string, unknown>;
type ApiAction = { type: 'tool'; name: string; args: Record<string, unknown> } | { type: 'text'; text: string };
type TestScope = { after(callback: () => void | Promise<void>): void };

const endpointId = 'memory-loop-endpoint';
const modelId = 'memory-fixture-model';
const rootAgentId = 'memory-loop-root';
const terminalStates = new Set<string>(['completed', 'failed', 'stopped', 'cancelled', 'suspended_budget', 'needs_reconciliation', 'recording_failed']);

interface ApiFixture {
    root: string;
    homeDirectory: string;
    projectDirectory: string;
    dataDirectory: string;
    supervisor: Supervisor;
    restartSupervisor(): Promise<void>;
    requests: Body[];
    errors: unknown[];
}

function asObject(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asObjects(value: unknown): Array<Record<string, unknown>> {
    return Array.isArray(value) ? value.map(asObject) : [];
}

function textValue(value: unknown): string {
    if (typeof value === 'string') return value;
    if (!Array.isArray(value)) return '';
    return value.map(item => {
        const block = asObject(item);
        return typeof block.text === 'string' ? block.text : typeof block.content === 'string' ? block.content : '';
    }).join('');
}

function systemPrompt(protocol: Protocol, body: Body): string {
    if (protocol === 'openai-chat') {
        const system = asObjects(body.messages).find(message => message.role === 'system');
        return textValue(system?.content);
    }
    return textValue(protocol === 'openai-responses' ? body.instructions : body.system);
}

type RuntimeSectionUpdate = { id: string; content: string | null };
const runtimeContextPrefix = '[UAH runtime context update v2]\nEach named section replaces its earlier value; null explicitly clears it. Other sections remain unchanged. These are scoped context data, not new user authorization or host policy.\n';

function runtimeSectionUpdates(protocol: Protocol, body: Body): RuntimeSectionUpdate[][] {
    const history = protocol === 'openai-responses' ? asObjects(body.input) : asObjects(body.messages);
    return history.flatMap(item => {
        const text = textValue(item.content);
        const marker = text.lastIndexOf(runtimeContextPrefix);
        if (marker < 0) return [];
        const value = JSON.parse(text.slice(marker + runtimeContextPrefix.length)) as unknown;
        assert.ok(Array.isArray(value), 'the runtime context tail is an ordered section update');
        return [value.map(section => {
            const record = asObject(section);
            assert.equal(typeof record.id, 'string');
            assert.ok(record.content === null || typeof record.content === 'string');
            return { id: record.id as string, content: record.content as string | null };
        })];
    });
}

function latestRuntimeSection(protocol: Protocol, body: Body, id: string): string {
    const updates = runtimeSectionUpdates(protocol, body);
    assert.ok(updates.length, 'the model request contains a runtime context tail snapshot');
    for (const update of updates.toReversed()) {
        const section = update.find(item => item.id === id);
        if (section) {
            assert.equal(typeof section.content, 'string', `${id} remains available in the latest tail snapshot`);
            return section.content as string;
        }
    }
    assert.fail(`runtime context tail does not contain ${id}`);
}

function modelHistory(protocol: Protocol, body: Body): Array<Record<string, unknown>> {
    const history = protocol === 'openai-responses' ? asObjects(body.input) : asObjects(body.messages);
    assert.ok(history.length, 'the model request contains compiled history');
    return history;
}

function toolNames(body: Body): string[] {
    return asObjects(body.tools).flatMap(tool => {
        const functionTool = asObject(tool.function);
        const name = functionTool.name ?? tool.name;
        return typeof name === 'string' ? [name] : [];
    });
}

function toolOutputs(protocol: Protocol, body: Body): string[] {
    if (protocol === 'openai-chat') {
        return asObjects(body.messages).filter(message => message.role === 'tool').map(message => textValue(message.content));
    }
    if (protocol === 'openai-responses') {
        return asObjects(body.input).filter(item => item.type === 'function_call_output').map(item => textValue(item.output));
    }
    return asObjects(body.messages).flatMap(message => asObjects(message.content)
        .filter(block => block.type === 'tool_result').map(block => textValue(block.content)));
}

function lastToolJson(protocol: Protocol, body: Body): Record<string, unknown> {
    const output = toolOutputs(protocol, body).at(-1);
    assert.ok(output, 'the prior tool result is included in the next model request');
    return JSON.parse(output) as Record<string, unknown>;
}

function frame(value: unknown): string {
    return `data: ${JSON.stringify(value)}\n\n`;
}

function respond(response: ServerResponse, protocol: Protocol, action: ApiAction, callId: string): void {
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache' });
    if (action.type === 'text') {
        if (protocol === 'openai-chat') {
            response.end(frame({ choices: [{ delta: { content: action.text }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
        } else if (protocol === 'openai-responses') {
            response.end(frame({ type: 'response.completed', response: { status: 'completed', output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: action.text }] },
            ] } }));
        } else {
            response.end(frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: action.text } })
                + frame({ type: 'content_block_stop', index: 0 })
                + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }) + frame({ type: 'message_stop' }));
        }
        return;
    }
    const args = JSON.stringify(action.args);
    if (protocol === 'openai-chat') {
        response.end(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: callId, type: 'function',
            function: { name: action.name, arguments: args } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    } else if (protocol === 'openai-responses') {
        response.end(frame({ type: 'response.completed', response: { status: 'completed', output: [
            { type: 'function_call', id: `item-${callId}`, call_id: callId, name: action.name, arguments: args },
        ] } }));
    } else {
        response.end(frame({ type: 'content_block_start', index: 0, content_block: {
            type: 'tool_use', id: callId, name: action.name, input: action.args,
        } }) + frame({ type: 'content_block_stop', index: 0 })
            + frame({ type: 'message_delta', delta: { stop_reason: 'tool_use' } }) + frame({ type: 'message_stop' }));
    }
}

function testAgentSettings() {
    const settings = defaultAgentSettings();
    settings.subagents.enabled = true;
    const inherited = settings.profiles.find(profile => profile.id === 'gpt-default');
    assert.ok(inherited);
    const rootAgent: AgentProfile = { ...inherited, id: rootAgentId, name: 'Memory loop fixture', allowDelegation: true };
    settings.profiles.push(rootAgent);
    return settings;
}

function safeRemove(root: string): void {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-memory-loop-')) {
        throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

async function createApiFixture(t: TestScope, protocol: Protocol, onRequest: (body: Body, index: number) => ApiAction | Promise<ApiAction>): Promise<ApiFixture> {
    const root = mkdtempSync(join(tmpdir(), 'uah-memory-loop-'));
    const homeDirectory = join(root, 'home');
    const projectDirectory = join(root, 'project');
    const dataDirectory = join(root, 'data');
    mkdirSync(homeDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    const requests: Body[] = [];
    const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
            const index = requests.push(body) - 1;
            respond(response, protocol, await onRequest(body, index), `memory-call-${index + 1}`);
        } catch (error) {
            errors.push(error);
            response.writeHead(500, { 'content-type': 'text/plain' });
            response.end('memory loop fixture failed');
        }
    });
    await new Promise<void>((resolveListen, rejectListen) => {
        server.once('error', rejectListen);
        server.listen(0, '127.0.0.1', resolveListen);
    });
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const settings = testAgentSettings();
    let activeSupervisor!: Supervisor;
    const createSupervisor = () => {
        activeSupervisor = new Supervisor({
            dataDirectory,
            homeDirectory,
            delayMs: 0,
            onEvent: () => {},
            getAgentSettings: () => settings,
            resolveAgent: id => {
                const profile = settings.profiles.find(item => item.id === id);
                if (!profile) throw new Error(`Unknown fixture Agent: ${id}`);
                return profile;
            },
            resolveConnection: async id => {
                if (id !== endpointId) throw new Error(`Unknown fixture endpoint: ${id}`);
                return {
                    id, name: 'Isolated memory fixture', protocol,
                    baseUrl: `http://127.0.0.1:${address.port}`, apiKey: '',
                    enabled: true, models: [modelId], revision: 1,
                    modelDetails: [{ id: modelId, tools: true }],
                };
            },
        });
        return activeSupervisor;
    };
    createSupervisor();
    t.after(async () => {
        await activeSupervisor.shutdown();
        server.closeAllConnections();
        await new Promise<void>((resolveClose, rejectClose) => server.close(error => error ? rejectClose(error) : resolveClose()));
        safeRemove(root);
        assert.deepEqual(errors, [], errors.map(error => String(error)).join('\n'));
    });
    return {
        root, homeDirectory, projectDirectory, dataDirectory,
        get supervisor() { return activeSupervisor; },
        async restartSupervisor() {
            await activeSupervisor.shutdown();
            createSupervisor();
        },
        requests, errors,
    };
}

async function createSession(fixture: ApiFixture, title: string, permissionMode: 'manual' | 'accept-edits' | 'auto' | 'bypass' | 'readonly' | 'plan'): Promise<string> {
    const snapshot = await fixture.supervisor.execute({
        type: 'create-session', title, directory: fixture.projectDirectory,
        selection: { endpointId, modelId }, agentId: rootAgentId,
        controls: { permissionMode, reasoningEffort: 'default' },
    });
    const session = snapshot.sessions.at(-1);
    assert.ok(session);
    return session.id;
}

async function startRun(supervisor: Supervisor, sessionId: string, input: string): Promise<string> {
    const snapshot = await supervisor.execute({ type: 'start-run', sessionId, input });
    const run = snapshot.runs.at(-1);
    assert.ok(run);
    return run.id;
}

async function waitForSnapshot(supervisor: Supervisor, predicate: (snapshot: Snapshot) => boolean, timeoutMs = 10_000): Promise<Snapshot> {
    const deadline = Date.now() + timeoutMs;
    let snapshot = await supervisor.execute({ type: 'snapshot' });
    while (!predicate(snapshot) && Date.now() < deadline) {
        await delay(10);
        snapshot = await supervisor.execute({ type: 'snapshot' });
    }
    assert.equal(predicate(snapshot), true, 'runtime did not reach the expected state');
    return snapshot;
}

async function waitForRun(supervisor: Supervisor, runId: string): Promise<Snapshot> {
    const snapshot = await waitForSnapshot(supervisor, current => {
        const run = current.runs.find(item => item.id === runId);
        return Boolean(run && terminalStates.has(run.state));
    });
    assert.equal(snapshot.runs.find(item => item.id === runId)?.state, 'completed', snapshot.runs.find(item => item.id === runId)?.error);
    return snapshot;
}

function setFixtureRules(projectDirectory: string): void {
    const agents = join(projectDirectory, 'AGENTS.md');
    const claude = join(projectDirectory, 'CLAUDE.md');
    writeFileSync(agents, '# Old same-scope rule\nPROJECT_OLDER_RULE_SENTINEL\n', 'utf8');
    writeFileSync(claude, '# Latest same-scope rule\nPROJECT_LATEST_RULE_SENTINEL\n', 'utf8');
    const now = Date.now();
    const older = new Date(now - 60_000);
    const newer = new Date(now - 20_000);
    utimesSync(agents, older, older);
    utimesSync(claude, newer, newer);
}

function seedPinnedPreference(homeDirectory: string, projectDirectory: string): Promise<unknown> {
    const memory = new MemoryStore({ homeDirectory });
    return memory.save(projectDirectory, {
        scope: 'user', title: 'Pinned fixture preference', body: 'PINNED_USER_PREFERENCE_SENTINEL',
        kind: 'preference', status: 'active', pinned: true,
        source: { sessionId: 'fixture-user', runId: 'fixture-user', origin: 'user', evidenceIds: [] },
    });
}

function externalProjectPath(homeDirectory: string): string {
    return join(homeDirectory, '.claude', 'projects');
}

function prepareExternalSources(homeDirectory: string): void {
    const claude = join(homeDirectory, '.claude');
    const projects = externalProjectPath(homeDirectory);
    mkdirSync(projects, { recursive: true });
    writeFileSync(join(claude, 'CLAUDE.md'), '# Global rule\nGLOBAL_EXTERNAL_RULE_BODY_SENTINEL\n', 'utf8');
    writeFileSync(join(projects, 'memory-fixture.md'), '# External memory fixture\nEXTERNAL_SEARCH_SENTINEL is searchable.\nEXTERNAL_READ_SENTINEL is only useful after reading.\n', 'utf8');
}

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
    test(`${protocol} injects selected rules and memory, then reads external sources and saves a candidate on demand`, async t => {
        let fixture: ApiFixture;
        let memorySourceId = '';
        const result = await createApiFixture(t, protocol, async (body, index) => {
            const rules = latestRuntimeSection(protocol, body, 'project.rules');
            const sources = latestRuntimeSection(protocol, body, 'context.sources');
            const memory = latestRuntimeSection(protocol, body, 'context.memory');
            assert.match(rules, /UAH_MODULE:project\.rules:v\d+/);
            assert.match(rules, /PROJECT_LATEST_RULE_SENTINEL/);
            assert.doesNotMatch(rules, /PROJECT_OLDER_RULE_SENTINEL/);
            assert.match(memory, /UAH_MODULE:context\.memory:v\d+/);
            assert.match(memory, /PINNED_USER_PREFERENCE_SENTINEL/);
            assert.match(sources, /UAH_MODULE:context\.sources:v\d+/);
            assert.match(sources, /external-memory/);

            const names = toolNames(body);
            for (const name of ['list_context_sources', 'search_context', 'read_context', 'save_memory']) assert.ok(names.includes(name), `${name} is registered`);
            if (index === 0) {
                assert.doesNotMatch(JSON.stringify(body), /GLOBAL_EXTERNAL_RULE_BODY_SENTINEL|EXTERNAL_SEARCH_SENTINEL|EXTERNAL_READ_SENTINEL/,
                    'external Markdown bodies are absent from the default request');
                return { type: 'tool', name: 'list_context_sources', args: {} };
            }
            if (index === 1) {
                assert.doesNotMatch(JSON.stringify(body), /EXTERNAL_SEARCH_SENTINEL|EXTERNAL_READ_SENTINEL/,
                    'listing source metadata does not load source bodies');
                const listing = lastToolJson(protocol, body);
                const sources = asObjects(listing.sources);
                const source = sources.find(item => item.kind === 'external-memory'
                    && typeof item.path === 'string'
                    && item.path.replaceAll('\\', '/').toLowerCase().endsWith('/.claude/projects'));
                assert.ok(source, 'list_context_sources returns the isolated external memory directory');
                memorySourceId = String(source.id);
                return { type: 'tool', name: 'search_context', args: { query: 'EXTERNAL_SEARCH_SENTINEL', sourceIds: [memorySourceId] } };
            }
            if (index === 2) {
                const search = lastToolJson(protocol, body);
                const match = asObjects(search.matches).find(item => item.sourceId === memorySourceId && typeof item.path === 'string'
                    && typeof item.text === 'string' && item.text.includes('EXTERNAL_SEARCH_SENTINEL'));
                assert.ok(match, 'explicit search returns only the matching external excerpt');
                assert.doesNotMatch(JSON.stringify(search), /EXTERNAL_READ_SENTINEL/);
                return { type: 'tool', name: 'read_context', args: { sourceId: memorySourceId, relativePath: match.path as string } };
            }
            if (index === 3) {
                const read = lastToolJson(protocol, body);
                assert.match(String(read.text), /EXTERNAL_SEARCH_SENTINEL/);
                assert.match(String(read.text), /EXTERNAL_READ_SENTINEL/);
                return { type: 'tool', name: 'save_memory', args: {
                    scope: 'project', title: 'Memory candidate from fixture', body: 'CANDIDATE_BODY_SENTINEL', kind: 'lesson',
                } };
            }
            if (index === 4) {
                assert.match(latestRuntimeSection(protocol, body, 'context.memory'), /Memory candidate from fixture/);
                assert.match(latestRuntimeSection(protocol, body, 'context.memory'), /candidate/);
                const saved = lastToolJson(protocol, body);
                assert.equal(saved.status, 'candidate');
                assert.equal(asObject(saved.source).origin, 'agent');
                return { type: 'text', text: 'Memory fixture complete.' };
            }
            throw new Error(`Unexpected ${protocol} request ${index + 1}`);
        });
        fixture = result;

        setFixtureRules(fixture.projectDirectory);
        prepareExternalSources(fixture.homeDirectory);
        await seedPinnedPreference(fixture.homeDirectory, fixture.projectDirectory);
        const sessionId = await createSession(fixture, `${protocol} memory fixture`, 'bypass');
        const runId = await startRun(fixture.supervisor, sessionId, 'Read project guidance, consult external notes on demand, and save a reusable lesson.');
        const snapshot = await waitForRun(fixture.supervisor, runId);

        assert.equal(fixture.requests.length, 5, 'memory operations use actual tool rounds and no hidden model request');
        const entries = await new MemoryStore({ homeDirectory: fixture.homeDirectory }).list(fixture.projectDirectory, 'project');
        assert.equal(entries.entries.length, 1);
        assert.equal(entries.entries[0].title, 'Memory candidate from fixture');
        assert.equal(entries.entries[0].status, 'candidate');
        assert.equal(entries.entries[0].pinned, false);
        assert.equal(entries.entries[0].source?.origin, 'agent');
        assert.equal(entries.entries[0].source?.sessionId, sessionId);
        assert.equal(entries.entries[0].source?.runId, runId);
        assert.equal(snapshot.runs.find(run => run.id === runId)?.state, 'completed');
    });
}

test('project memory Markdown is readable from a fresh root session and after restarting the supervisor', async t => {
    const title = 'Project persistence fixture';
    const bodySentinel = 'PERSISTED_PROJECT_MEMORY_BODY_SENTINEL';
    let fixture: ApiFixture;
    let savedPath = '';
    let savedId = '';
    const result = await createApiFixture(t, 'openai-chat', (body, index) => {
        const serialized = JSON.stringify(body);
        if (index === 0) {
            assert.doesNotMatch(serialized, /PERSISTED_PROJECT_MEMORY_BODY_SENTINEL/);
            assert.ok(toolNames(body).includes('save_memory'));
            return { type: 'tool', name: 'save_memory', args: {
                scope: 'project', title, body: bodySentinel, kind: 'lesson',
            } };
        }
        if (index === 1) {
            const memory = latestRuntimeSection('openai-chat', body, 'context.memory');
            assert.match(memory, /Project persistence fixture/);
            assert.doesNotMatch(memory, /PERSISTED_PROJECT_MEMORY_BODY_SENTINEL/,
                'the snapshot exposes the index, not the candidate body');
            const saved = lastToolJson('openai-chat', body);
            assert.equal(saved.status, 'candidate');
            assert.equal(asObject(saved.source).origin, 'agent');
            savedPath = String(saved.path);
            savedId = String(saved.id);
            assert.match(savedId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
            const memoryRoot = join(fixture.projectDirectory, '.memory');
            const relativeMemoryPath = relative(memoryRoot, savedPath).replaceAll('\\', '/');
            assert.match(relativeMemoryPath, /^\d{4}-\d{2}-\d{2}-project-persistence-fixture\.md$/,
                'the record uses the date-title slug Markdown path');
            return { type: 'text', text: 'Candidate saved.' };
        }
        if (index === 2 || index === 5) {
            const restarted = index === 5;
            const memory = latestRuntimeSection('openai-chat', body, 'context.memory');
            assert.match(memory, /Project persistence fixture/,
                'the current request snapshot includes the project memory index');
            assert.ok(memory.includes(basename(savedPath)),
                'the current request snapshot exposes the record path for the new session to discover');
            assert.doesNotMatch(memory, /PERSISTED_PROJECT_MEMORY_BODY_SENTINEL/,
                'the full Markdown body is not injected into the prompt');
            assert.doesNotMatch(serialized, /FIRST_SESSION_ONLY_INPUT_SENTINEL/);
            if (restarted) assert.doesNotMatch(serialized, /SECOND_SESSION_ONLY_INPUT_SENTINEL/);
            assert.match(serialized, restarted
                ? /RESTARTED_SESSION_ONLY_INPUT_SENTINEL/
                : /SECOND_SESSION_ONLY_INPUT_SENTINEL/);
            assert.ok(toolNames(body).includes('list_context_sources'));
            assert.ok(toolNames(body).includes('read_context'));
            return { type: 'tool', name: 'list_context_sources', args: {} };
        }
        if (index === 3 || index === 6) {
            const listed = lastToolJson('openai-chat', body);
            const projectMemory = asObjects(listed.sources).find(source => source.kind === 'memory' && source.scope === 'project');
            assert.ok(projectMemory, 'the independent root receives the project memory source');
            assert.equal(typeof projectMemory.path, 'string');
            const relativeMemoryPath = relative(String(projectMemory.path), savedPath).replaceAll('\\', '/');
            assert.ok(relativeMemoryPath && !relativeMemoryPath.startsWith('../') && relativeMemoryPath !== '..');
            return { type: 'tool', name: 'read_context', args: {
                sourceId: projectMemory.id, relativePath: relativeMemoryPath,
            } };
        }
        if (index === 4 || index === 7) {
            const read = lastToolJson('openai-chat', body);
            assert.equal(read.path, savedPath);
            assert.match(String(read.text), /PERSISTED_PROJECT_MEMORY_BODY_SENTINEL/,
                'read_context returns the saved Markdown after an independent session or restart');
            assert.match(String(read.text), /Project persistence fixture/);
            return { type: 'text', text: 'Project memory read and verified.' };
        }
        throw new Error(`Unexpected persistence request ${index + 1}`);
    });
    fixture = result;

    const originalSession = await createSession(fixture, 'Project memory writer', 'bypass');
    const originalRun = await startRun(fixture.supervisor, originalSession, 'FIRST_SESSION_ONLY_INPUT_SENTINEL Save a reusable project lesson.');
    await waitForRun(fixture.supervisor, originalRun);
    assert.equal(fixture.requests.length, 2, 'saving a candidate uses one tool round and one final response');

    const independentSession = await createSession(fixture, 'Independent project memory reader', 'bypass');
    assert.notEqual(independentSession, originalSession);
    const independentRun = await startRun(fixture.supervisor, independentSession, 'SECOND_SESSION_ONLY_INPUT_SENTINEL Read the saved project lesson.');
    await waitForRun(fixture.supervisor, independentRun);
    assert.equal(fixture.requests.length, 5, 'the fresh root reads through list_context_sources and read_context');

    await fixture.restartSupervisor();
    const restartedSession = await createSession(fixture, 'Restarted project memory reader', 'bypass');
    assert.notEqual(restartedSession, originalSession);
    assert.notEqual(restartedSession, independentSession);
    const restartedRun = await startRun(fixture.supervisor, restartedSession, 'RESTARTED_SESSION_ONLY_INPUT_SENTINEL Read persisted project memory.');
    const completed = await waitForRun(fixture.supervisor, restartedRun);
    assert.equal(fixture.requests.length, 8, 'restart persistence is checked with only the requested tool rounds');

    const listed = await new MemoryStore({ homeDirectory: fixture.homeDirectory }).list(fixture.projectDirectory, 'project');
    assert.equal(listed.entries.length, 1);
    assert.equal(listed.entries[0].id, savedId);
    assert.equal(listed.entries[0].path, savedPath);
    assert.equal(listed.entries[0].source?.sessionId, originalSession);
    assert.equal(completed.runs.find(run => run.id === restartedRun)?.state, 'completed');
});

test('same-session V2 history keeps its prefix across restart and appends semantic memory changes at the tail', async t => {
    const result = await createApiFixture(t, 'openai-chat', (_body, index) => ({
        type: 'text', text: `same-session request ${index + 1} complete.`,
    }));
    const fixture = result;
    setFixtureRules(fixture.projectDirectory);
    const sessionId = await createSession(fixture, 'Same-session context persistence', 'bypass');

    const firstRun = await startRun(fixture.supervisor, sessionId, 'FIRST_SAME_SESSION_INPUT_SENTINEL');
    await waitForRun(fixture.supervisor, firstRun);
    assert.equal(fixture.requests.length, 1);
    const firstHistory = modelHistory('openai-chat', fixture.requests[0]);
    const firstUpdates = runtimeSectionUpdates('openai-chat', fixture.requests[0]);
    assert.ok(firstUpdates.length, 'the first request stores its runtime sections in the model body');

    const claudePath = join(fixture.projectDirectory, 'CLAUDE.md');
    const mtimeBeforeSecondRun = statSync(claudePath).mtimeMs;
    const secondRun = await startRun(fixture.supervisor, sessionId, 'SECOND_SAME_SESSION_INPUT_SENTINEL');
    await waitForRun(fixture.supervisor, secondRun);
    assert.equal(fixture.requests.length, 2);
    const secondHistory = modelHistory('openai-chat', fixture.requests[1]);
    assert.deepEqual(secondHistory.slice(0, firstHistory.length), firstHistory,
        'a second run retains the exact compiled request prefix from the first run');
    assert.deepEqual(runtimeSectionUpdates('openai-chat', fixture.requests[1]), firstUpdates,
        'unchanged rules do not append a new runtime snapshot');
    assert.equal(statSync(claudePath).mtimeMs, mtimeBeforeSecondRun,
        'runtime context reads do not rewrite the rule file while checking its mtime');

    await fixture.restartSupervisor();
    await new MemoryStore({ homeDirectory: fixture.homeDirectory }).save(fixture.projectDirectory, {
        scope: 'project', title: 'Append-only memory change', body: 'MEMORY_APPEND_ONLY_SENTINEL', kind: 'lesson',
        status: 'candidate', pinned: false,
        source: { sessionId, runId: secondRun, origin: 'user', evidenceIds: [] },
    });
    const thirdRun = await startRun(fixture.supervisor, sessionId, 'THIRD_SAME_SESSION_INPUT_SENTINEL');
    await waitForRun(fixture.supervisor, thirdRun);
    assert.equal(fixture.requests.length, 3);
    const thirdBody = fixture.requests[2];
    const thirdHistory = modelHistory('openai-chat', thirdBody);
    assert.deepEqual(thirdHistory.slice(0, secondHistory.length), secondHistory,
        'restart restores the prior request prefix before adding the new run');
    const thirdUpdates = runtimeSectionUpdates('openai-chat', thirdBody);
    assert.equal(thirdUpdates.length, firstUpdates.length + 1,
        'a real memory change adds one runtime tail update after restart');
    assert.deepEqual(thirdUpdates.at(-1)?.map(section => section.id), ['context.memory']);
    const memoryTail = latestRuntimeSection('openai-chat', thirdBody, 'context.memory');
    assert.match(memoryTail, /Append-only memory change/);
    assert.doesNotMatch(memoryTail, /MEMORY_APPEND_ONLY_SENTINEL/,
        'the runtime tail carries the changed index while the Markdown body remains on-demand');
});

test('memory writers are root-only and hidden in readonly and Plan requests', async t => {
    let spawned = false;
    let childRequests = 0;
    const fixture = await createApiFixture(t, 'openai-chat', (body) => {
        const system = systemPrompt('openai-chat', body);
        const environment = latestRuntimeSection('openai-chat', body, 'context.environment');
        const names = toolNames(body);
        if (system.includes('UAH_MODULE:role.subagent:')) {
            childRequests++;
            assert.ok(names.includes('read_context'));
            assert.ok(!names.includes('save_memory'));
            assert.ok(!names.includes('forget_memory'));
            return { type: 'text', text: 'Child returned findings.' };
        }
        if (environment.includes('"permissionMode":"readonly"')) {
            assert.ok(names.includes('list_context_sources'));
            assert.ok(!names.includes('save_memory'));
            assert.ok(!names.includes('forget_memory'));
            return { type: 'text', text: 'Readonly request complete.' };
        }
        if (environment.includes('"permissionMode":"plan"')) {
            assert.ok(!names.includes('save_memory'));
            assert.ok(!names.includes('forget_memory'));
            return { type: 'text', text: 'Plan request complete.' };
        }
        assert.ok(names.includes('save_memory'));
        assert.ok(names.includes('forget_memory'));
        assert.ok(names.includes('spawn_agent'));
        if (!spawned) {
            spawned = true;
            return { type: 'tool', name: 'spawn_agent', args: {
                prompt: 'Check that child memory publishing is unavailable.', agent: { type: 'inherit' }, context: { mode: 'none' },
            } };
        }
        return { type: 'text', text: 'Root request complete.' };
    });

    const readonly = await createSession(fixture, 'Readonly memory permissions', 'readonly');
    const readonlyRun = await startRun(fixture.supervisor, readonly, 'Readonly memory permissions check.');
    await waitForRun(fixture.supervisor, readonlyRun);

    const plan = await createSession(fixture, 'Plan memory permissions', 'plan');
    const planRun = await startRun(fixture.supervisor, plan, 'Plan memory permissions check.');
    await waitForRun(fixture.supervisor, planRun);

    const parent = await createSession(fixture, 'Root and child memory permissions', 'bypass');
    const parentRun = await startRun(fixture.supervisor, parent, 'Root memory publishing check.');
    const completed = await waitForRun(fixture.supervisor, parentRun);
    const child = completed.runs.find(run => run.parentRunId === parentRun);
    assert.ok(child);
    assert.equal(child.state, 'completed');
    assert.equal(childRequests, 1);
});

test('chat gates a write into a new nested scope until the next request includes its rule', async t => {
    const fixture = await createApiFixture(t, 'openai-chat', (body, index) => {
        const rules = latestRuntimeSection('openai-chat', body, 'project.rules');
        assert.match(rules, /ROOT_RULE_SENTINEL/);
        assert.ok(toolNames(body).includes('write_file'));
        if (index === 0) {
            assert.doesNotMatch(rules, /NESTED_CHILD_RULE_SENTINEL/);
            return { type: 'tool', name: 'write_file', args: {
                path: 'child/new.txt', content: 'written after child rules are loaded', expectedContent: null,
            } };
        }
        if (index === 1) {
            assert.match(toolOutputs('openai-chat', body).at(-1) ?? '', /RULE_CONTEXT_CHANGED/);
            assert.match(rules, /NESTED_CHILD_RULE_SENTINEL/);
            assert.equal(existsSync(join(fixture.projectDirectory, 'child', 'new.txt')), false,
                'the first write is rejected before touching disk');
            return { type: 'tool', name: 'write_file', args: {
                path: 'child/new.txt', content: 'written after child rules are loaded', expectedContent: null,
            } };
        }
        if (index === 2) {
            assert.match(rules, /NESTED_CHILD_RULE_SENTINEL/);
            assert.match(toolOutputs('openai-chat', body).at(-1) ?? '', /File written/);
            assert.equal(readFileSync(join(fixture.projectDirectory, 'child', 'new.txt'), 'utf8'),
                'written after child rules are loaded');
            return { type: 'text', text: 'Nested rule checked and write completed.' };
        }
        throw new Error(`Unexpected nested-rule request ${index + 1}`);
    });
    writeFileSync(join(fixture.projectDirectory, 'AGENTS.md'), '# Project rules\nROOT_RULE_SENTINEL\n', 'utf8');
    const childDirectory = join(fixture.projectDirectory, 'child');
    mkdirSync(childDirectory, { recursive: true });
    writeFileSync(join(childDirectory, 'AGENTS.md'), '# Child rules\nNESTED_CHILD_RULE_SENTINEL\n', 'utf8');

    const sessionId = await createSession(fixture, 'Nested rule gate', 'bypass');
    const runId = await startRun(fixture.supervisor, sessionId, 'Create a file in the child directory.');
    await waitForRun(fixture.supervisor, runId);
    assert.equal(fixture.requests.length, 3);
});

test('bypass cannot activate a pinned preference without confirmation or persist a rejected write', async t => {
    const fixture = await createApiFixture(t, 'openai-chat', (body, index) => {
        if (index === 0) {
            const save = asObjects(body.tools).find(tool => asObject(tool.function).name === 'save_memory');
            const properties = asObject(asObject(save?.function).parameters).properties;
            assert.ok(Object.hasOwn(asObject(properties), 'status'));
            assert.ok(Object.hasOwn(asObject(properties), 'pinned'));
            return { type: 'tool', name: 'save_memory', args: {
                scope: 'user', title: 'Explicit preference confirmation fixture', body: 'MUST_NOT_BE_SAVED_SENTINEL',
                kind: 'preference', status: 'active', pinned: true,
            } };
        }
        return { type: 'text', text: 'Rejected memory write handled.' };
    });
    const sessionId = await createSession(fixture, 'Explicit preference confirmation', 'bypass');
    const runId = await startRun(fixture.supervisor, sessionId, 'Try to activate a user preference.');
    const pending = await waitForSnapshot(fixture.supervisor, snapshot => snapshot.approvals.some(item => item.status === 'pending'));
    const approval = pending.approvals.find(item => item.status === 'pending');
    assert.ok(approval);
    await fixture.supervisor.execute({
        type: 'resolve-approval',
        identity: { runtimeId: approval.runtimeId, sessionId: approval.sessionId, runId: approval.runId,
            turnId: approval.turnId, requestId: approval.requestId, policyVersion: approval.policyVersion },
        decision: 'reject',
    });
    const completed = await waitForRun(fixture.supervisor, runId);
    assert.ok(completed.approvals.some(item => item.requestId === approval.requestId && item.status === 'rejected'));
    const saved = await new MemoryStore({ homeDirectory: fixture.homeDirectory }).list(fixture.projectDirectory, 'user');
    assert.equal(saved.entries.length, 0);
    assert.equal(existsSync(join(fixture.homeDirectory, '.uah', 'memory')), false);
});

test('native Codex receives none of the API project rules, memory context, or knowledge tools', async t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-memory-loop-'));
    const homeDirectory = join(root, 'home');
    const projectDirectory = join(root, 'project');
    const dataDirectory = join(root, 'data');
    const recordFile = join(root, 'app-server.jsonl');
    mkdirSync(homeDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    writeFileSync(join(projectDirectory, 'AGENTS.md'), 'NATIVE_PROJECT_RULE_SENTINEL\n', 'utf8');
    prepareExternalSources(homeDirectory);
    const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'codex-app-server-fixture.mjs');
    const bundle: ExtensionRuntimeBundle = {
        connectors: [], skills: [],
        native: { enabled: true, command: process.execPath, args: [fixturePath, JSON.stringify({ recordFile })], model: 'gpt-fixture', revision: 1 },
    };
    const supervisor = new Supervisor({
        dataDirectory, homeDirectory, delayMs: 0, onEvent: () => {},
        resolveExtensions: async () => structuredClone(bundle),
    });
    t.after(async () => {
        await supervisor.shutdown();
        safeRemove(root);
    });

    const created = await supervisor.execute({
        type: 'create-session', title: 'Native knowledge isolation', directory: projectDirectory,
        selection: { endpointId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture' },
        controls: { permissionMode: 'manual', reasoningEffort: 'default' },
    });
    const sessionId = created.sessions.at(-1)!.id;
    const runId = await startRun(supervisor, sessionId, 'Native context isolation check.');
    await waitForRun(supervisor, runId);

    const records = readFileSync(recordFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Body);
    const thread = records.find(record => record.direction === 'client' && record.method === 'thread/start');
    assert.ok(thread);
    const threadParams = asObject(thread.params);
    const threadKnowledgeFields = JSON.stringify({
        baseInstructions: threadParams.baseInstructions,
        developerInstructions: threadParams.developerInstructions,
        dynamicTools: threadParams.dynamicTools,
    });
    assert.doesNotMatch(threadKnowledgeFields, /UAH_MODULE:(?:project\.rules|context\.sources|context\.memory)/);
    assert.doesNotMatch(threadKnowledgeFields, /NATIVE_PROJECT_RULE_SENTINEL|GLOBAL_EXTERNAL_RULE_BODY_SENTINEL|EXTERNAL_SEARCH_SENTINEL|EXTERNAL_READ_SENTINEL/);
    assert.doesNotMatch(threadKnowledgeFields, /list_context_sources|search_context|read_context|save_memory|forget_memory/);

    const turn = records.find(record => record.direction === 'client' && record.method === 'turn/start');
    assert.ok(turn);
    const serialized = JSON.stringify(turn.params);
    assert.doesNotMatch(serialized, /UAH_MODULE:(?:project\.rules|context\.sources|context\.memory)/);
    assert.doesNotMatch(serialized, /NATIVE_PROJECT_RULE_SENTINEL|GLOBAL_EXTERNAL_RULE_BODY_SENTINEL|EXTERNAL_SEARCH_SENTINEL|EXTERNAL_READ_SENTINEL/);
    assert.doesNotMatch(serialized, /list_context_sources|search_context|read_context|save_memory|forget_memory/);
});
