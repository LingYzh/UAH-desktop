import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { ApiProtocol } from '../../src/shared/endpoints';
import type { Snapshot } from '../../src/shared/contracts';
import type { TranscriptEvent } from '../../src/shared/harness-contracts';

type WireBody = Record<string, unknown>;

const ROUND_COUNT = 30;
const REPORTED_TOKENS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function sseEvent(type: string, value: Record<string, unknown>): string {
    return `event: ${type}\ndata: ${JSON.stringify({ type, ...value })}\n\n`;
}

function jsonSse(value: Record<string, unknown>): string {
    return `data: ${JSON.stringify(value)}\n\n`;
}

function usage(protocol: ApiProtocol): Record<string, unknown> {
    if (protocol === 'anthropic') return { input_tokens: 9_000, output_tokens: 1_000 };
    return { input_tokens: 9_000, output_tokens: 1_000, prompt_tokens: 9_000, completion_tokens: 1_000, total_tokens: REPORTED_TOKENS };
}

function roundPath(round: number): string {
    return `round-${String(round).padStart(2, '0')}.txt`;
}

function chatReply(round: number | null, protocol: ApiProtocol): string {
    const reported = usage(protocol);
    if (round !== null) {
        const path = roundPath(round);
        const call = { index: 0, id: `long-call-${String(round).padStart(2, '0')}`, type: 'function',
            function: { name: 'read_file', arguments: JSON.stringify({ path }) } };
        return jsonSse({ choices: [{ index: 0, delta: { tool_calls: [call] } }], usage: reported })
            + jsonSse({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })
            + 'data: [DONE]\n\n';
    }
    return jsonSse({ choices: [{ index: 0, delta: { content: 'Long run complete.', }, finish_reason: 'stop' }], usage: reported })
        + 'data: [DONE]\n\n';
}

function responsesReply(round: number | null, protocol: ApiProtocol): string {
    const output = round === null
        ? [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Long run complete.' }] }]
        : [{ type: 'function_call', id: `long-item-${String(round).padStart(2, '0')}`,
            call_id: `long-call-${String(round).padStart(2, '0')}`, name: 'read_file',
            arguments: JSON.stringify({ path: roundPath(round) }), status: 'completed' }];
    return sseEvent('response.completed', { response: { status: 'completed', output, usage: protocol === 'anthropic' ? usage(protocol) : usage(protocol) } });
}

function anthropicReply(round: number | null): string {
    const start = sseEvent('message_start', { message: { id: `long-message-${round ?? 'final'}`, role: 'assistant', content: [], usage: usage('anthropic') } });
    if (round !== null) {
        const path = roundPath(round);
        return start
            + sseEvent('content_block_start', { index: 0, content_block: { type: 'tool_use', id: `long-call-${String(round).padStart(2, '0')}`, name: 'read_file', input: {} } })
            + sseEvent('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ path }) } })
            + sseEvent('content_block_stop', { index: 0 })
            + sseEvent('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1_000 } })
            + sseEvent('message_stop', {});
    }
    return start
        + sseEvent('content_block_start', { index: 0, content_block: { type: 'text', text: 'Long run complete.' } })
        + sseEvent('content_block_stop', { index: 0 })
        + sseEvent('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1_000 } })
        + sseEvent('message_stop', {});
}

function resultCount(protocol: ApiProtocol, body: WireBody): number {
    if (protocol === 'openai-responses') {
        const input = Array.isArray(body.input) ? body.input : [];
        return input.filter(item => isRecord(item) && item.type === 'function_call_output').length;
    }
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (protocol === 'openai-chat') return messages.filter(item => isRecord(item) && item.role === 'tool').length;
    return messages.reduce((total, item) => {
        if (!isRecord(item) || item.role !== 'user' || !Array.isArray(item.content)) return total;
        return total + item.content.filter(block => isRecord(block) && block.type === 'tool_result').length;
    }, 0);
}

function bodyHistory(protocol: ApiProtocol, body: WireBody): unknown[] {
    const key = protocol === 'openai-responses' ? 'input' : 'messages';
    const history = body[key];
    assert.ok(Array.isArray(history), `${protocol} request must have ${key}`);
    return history;
}

function withoutCacheMarkers(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(item => withoutCacheMarkers(item));
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
        if (key === 'cache_control' || key === 'prompt_cache_breakpoint') continue;
        result[key] = withoutCacheMarkers(item);
    }
    return result;
}

function hash(value: unknown): string {
    return createHash('sha256').update(JSON.stringify(value === undefined ? null : value)).digest('hex');
}

function staticFields(protocol: ApiProtocol, body: WireBody): { system: unknown; instructions: unknown; tools: unknown } {
    const messages = Array.isArray(body.messages) ? body.messages : [];
    const system = protocol === 'openai-chat'
        ? messages.find(item => isRecord(item) && item.role === 'system')?.content
        : protocol === 'anthropic' ? body.system : undefined;
    return { system, instructions: protocol === 'openai-responses' ? body.instructions : undefined, tools: body.tools };
}

function toolNames(protocol: ApiProtocol, value: unknown): string[] {
    assert.ok(Array.isArray(value), `${protocol} request must expose tools`);
    return value.map(item => {
        assert.ok(isRecord(item));
        if (protocol === 'anthropic') {
            assert.equal(typeof item.name, 'string');
            return item.name as string;
        }
        const fn = isRecord(item.function) ? item.function : item;
        assert.equal(typeof fn.name, 'string');
        return fn.name as string;
    });
}

function assertStableRequests(protocol: ApiProtocol, requests: readonly WireBody[]): void {
    assert.ok(requests.length >= ROUND_COUNT + 3, `${protocol} did not make the expected long run requests`);
    const first = staticFields(protocol, requests[0]);
    if (protocol !== 'openai-responses') assert.notEqual(first.system, undefined, `${protocol} static system is missing`);
    if (protocol === 'openai-responses') assert.notEqual(first.instructions, undefined, 'Responses instructions are missing');
    assert.notEqual(first.tools, undefined, `${protocol} tools are missing`);
    const expectedHashes = Object.fromEntries(Object.entries(first).map(([key, value]) => [key, hash(value)]));
    for (const [index, body] of requests.entries()) {
        const fields = staticFields(protocol, body);
        for (const [key, value] of Object.entries(fields)) assert.equal(hash(value), expectedHashes[key], `${protocol} ${key} changed at request ${index + 1}`);
        const names = toolNames(protocol, fields.tools);
        assert.ok(names.includes('read_file'), `${protocol} read_file is not registered`);
        assert.deepEqual(names, [...names].sort(), `${protocol} tool order changed at request ${index + 1}`);
    }
}

function assertAppendOnly(protocol: ApiProtocol, requests: readonly WireBody[]): void {
    let previous: unknown[] | undefined;
    for (const [index, body] of requests.entries()) {
        const current = withoutCacheMarkers(bodyHistory(protocol, body)) as unknown[];
        if (previous) {
            assert.ok(current.length >= previous.length, `${protocol} history shrank at request ${index + 1}`);
            for (let item = 0; item < previous.length; item++) {
                assert.deepEqual(current[item], previous[item], `${protocol} history prefix changed at request ${index + 1}, item ${item}`);
            }
        }
        previous = current;
    }
}

function journal(dataDirectory: string, sessionId: string): TranscriptEvent[] {
    const store = new RuntimeStore(dataDirectory);
    try { return store.readJournal(sessionId, 0, 100_000); } finally { store.close(); }
}

async function runProtocol(protocol: ApiProtocol): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), `uah-context-long-${protocol}-`));
    const project = join(root, 'project');
    mkdirSync(project);
    for (let index = 1; index <= ROUND_COUNT; index++) writeFileSync(join(project, roundPath(index)), `unique-read-content-${String(index).padStart(2, '0')}`);

    const requests: WireBody[] = [];
    const servedPaths: string[] = [];
    const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as WireBody;
            requests.push(body);
            const completedResults = resultCount(protocol, body);
            assert.ok(completedResults <= ROUND_COUNT, `${protocol} sent too many tool results`);
            const round = completedResults < ROUND_COUNT ? completedResults + 1 : null;
            if (round !== null) servedPaths.push(roundPath(round));
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            if (protocol === 'openai-chat') response.end(chatReply(round, protocol));
            else if (protocol === 'openai-responses') response.end(responsesReply(round, protocol));
            else response.end(anthropicReply(round));
        } catch (error) {
            errors.push(error);
            if (!response.headersSent) response.writeHead(500);
            response.end();
        }
    });

    let supervisor: Supervisor | undefined;
    try {
        await new Promise<void>((resolveListen, reject) => {
            const onError = (error: Error) => { server.off('listening', onListening); reject(error); };
            const onListening = () => { server.off('error', onError); resolveListen(); };
            server.once('error', onError); server.once('listening', onListening); server.listen(0, '127.0.0.1');
        });
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        const settings = defaultAgentSettings();
        settings.subagents.enabled = false;
        settings.profiles[0].instructions = 'LONG RUN CONTEXT FIXTURE';
        const options = {
            dataDirectory: join(root, 'data'),
            delayMs: 0,
            onEvent: () => {},
            getAgentSettings: () => settings,
            resolveAgent: (id: string) => {
                const profile = settings.profiles.find(item => item.id === id);
                assert.ok(profile, `missing fixture profile ${id}`);
                return profile;
            },
            resolveConnection: async (id: string) => ({
                id,
                name: `Local ${protocol} context fixture`,
                protocol,
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: 'local-context-long-run-key',
                enabled: true,
                models: ['fixture-model'],
                revision: 1,
                modelDetails: [{ id: 'fixture-model', tools: true, reasoning: false, contextWindow: 1_000_000, maxOutputTokens: 4_096 }],
            }),
        };
        supervisor = new Supervisor(options);
        const created = await supervisor.execute({ type: 'create-session', title: `Long ${protocol}`, directory: project,
            selection: { endpointId: 'fixture', modelId: 'fixture-model' }, agentId: 'default',
            controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
        const sessionId = created.sessions[0].id;
        const snapshot = () => supervisor!.execute({ type: 'snapshot' });
        const waitForTerminal = async (runId: string): Promise<Snapshot> => {
            for (let attempt = 0; attempt < 2_000; attempt++) {
                const current = await snapshot();
                const run = current.runs.find(item => item.id === runId);
                if (run && ['completed', 'failed', 'stopped'].includes(run.state)) return current;
                await delay(5);
            }
            throw new Error(`${protocol} long run timed out`);
        };
        const start = async (input: string) => {
            const current = await supervisor!.execute({ type: 'start-run', sessionId, input });
            return current.runs.filter(run => run.sessionId === sessionId && !run.parentRunId).at(-1)!;
        };

        const first = await start('Read every fixture file exactly once.');
        const afterFirst = await waitForTerminal(first.id);
        const firstRun = afterFirst.runs.find(item => item.id === first.id)!;
        assert.equal(firstRun.state, 'completed', firstRun.error);
        assert.equal(firstRun.budgetStopCode, undefined);
        assert.equal(firstRun.toolProgress?.repeatedFailureBatches ?? 0, 0);
        const firstBudget = firstRun.budgetState as Record<string, unknown>;
        assert.equal(firstBudget.requestsUsed, ROUND_COUNT + 1, `${protocol} should use 30 tool requests plus one final request`);
        assert.ok(Number((firstBudget.limits as Record<string, unknown>).maxRequests) >= ROUND_COUNT + 1);
        assert.ok(Number(firstBudget.tokensCharged) >= (ROUND_COUNT + 1) * REPORTED_TOKENS, `${protocol} cumulative usage did not exceed the legacy threshold`);
        assert.equal(servedPaths.length, ROUND_COUNT);
        assert.deepEqual([...servedPaths].sort(), Array.from({ length: ROUND_COUNT }, (_, index) => roundPath(index + 1)));

        const second = await start('Continue after the thirty reads.');
        const afterSecond = await waitForTerminal(second.id);
        assert.equal(afterSecond.runs.find(item => item.id === second.id)?.state, 'completed');
        await supervisor.shutdown();
        supervisor = new Supervisor(options);
        const restored = await snapshot();
        assert.equal(restored.runs.find(item => item.id === first.id)?.state, 'completed');
        assert.equal(restored.runs.find(item => item.id === second.id)?.state, 'completed');
        const third = await start('Continue after Supervisor restart.');
        const afterRestart = await waitForTerminal(third.id);
        assert.equal(afterRestart.runs.find(item => item.id === third.id)?.state, 'completed');

        assert.equal(requests.length, ROUND_COUNT + 3, `${protocol} should make 30 tool requests, one final request, and two followups`);
        assertStableRequests(protocol, requests);
        assertAppendOnly(protocol, requests);
        assert.ok(servedPaths.every((path, index) => path === roundPath(index + 1)));
        assert.ok(afterRestart.runs.filter(run => run.sessionId === sessionId).every(run => run.parentRunId === undefined));

        const events = journal(join(root, 'data'), sessionId);
        const contextRequests = events.filter(event => event.type === 'context.request');
        assert.ok(contextRequests.length >= ROUND_COUNT + 3, `${protocol} context requests were not persisted`);
        assert.ok(contextRequests.every(event => event.payload.ownerId === 'primary'), `${protocol} context owner was not persisted as primary`);
        const surfaces = events.filter(event => event.type === 'context.surface');
        assert.ok(surfaces.length > 0 && surfaces.every(event => event.payload.ownerId === 'primary'));
        assert.deepEqual(errors, []);
    } finally {
        if (supervisor) await supervisor.shutdown();
        server.closeAllConnections();
        if (server.listening) await new Promise<void>(resolveClose => server.close(() => resolveClose()));
        const target = resolve(root);
        assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith(`uah-context-long-${protocol}-`));
        rmSync(target, { recursive: true, force: true });
        assert.equal(existsSync(target), false, `${protocol} isolated fixture directory was not removed`);
    }
}

test('context V2 stays stable through 30 unique read rounds, followup, and restart', async t => {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
        await t.test(protocol, async () => { await runProtocol(protocol); });
    }
});
