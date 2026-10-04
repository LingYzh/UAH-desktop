import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { streamAgentApi, RequestRecordingError, type RequestObserver } from '../../src/runtime/api-transport';
import { configureDiagnostics, createDiagnosticTrace, recordPromptAssembly } from '../../src/runtime/diagnostics';
import { captureRequestContext } from '../../src/runtime/request-context';
import type { ApiProtocol } from '../../src/shared/endpoints';
import type { AgentStreamEvent } from '../../src/shared/tool-protocol';

const frame = (data: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;
function source(protocol: ApiProtocol): string {
    if (protocol === 'openai-chat') return frame({ choices: [{ index: 0, delta: { content: 'OK' } }] })
        + frame({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 } }) + 'data: [DONE]\n\n';
    if (protocol === 'openai-responses') return frame({ type: 'response.completed', response: { status: 'completed', usage: { input_tokens: 8, output_tokens: 1 },
        output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] }] } }, 'response.completed');
    return frame({ type: 'message_start', message: { usage: { input_tokens: 8 } } }, 'message_start')
        + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'OK' } }, 'content_block_start')
        + frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop')
        + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } }, 'message_delta')
        + frame({ type: 'message_stop' }, 'message_stop');
}
async function fixture(t: { after(fn: () => Promise<void>): void }, protocol: ApiProtocol, stream = source(protocol)) {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (req, res) => {
        const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
        requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
        res.writeHead(200, { 'content-type': 'text/event-stream' }); res.end(stream);
    });
    // Node's fetch forbidden-port list ends at 10080; Windows may allocate lower ports.
    while (true) {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const current = server.address(); assert.ok(current && typeof current !== 'string');
        if (current.port > 10080) break;
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
    const connection = { id: 'fixture', name: 'Fixture', models: ['model'], enabled: true, revision: 1,
        protocol, baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'private-api-key' };
    return { requests, connection };
}
const noop = (): RequestObserver => ({ prepared() {}, dispatch() {}, responseStarted() {}, providerEvent() {}, terminal() {} });
const collect = async (stream: AsyncIterable<AgentStreamEvent>) => { const events: AgentStreamEvent[] = []; for await (const event of stream) events.push(event); return events; };

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) test(`${protocol} captures exact final body and provider usage before completion`, async t => {
    const f = await fixture(t, protocol);
    const order: string[] = []; const frames: Array<{ event?: string; data: string }> = [];
    let captured: Record<string, unknown> | undefined;
    const observer: RequestObserver = {
        prepared(body, actualProtocol) { assert.equal(actualProtocol, protocol); captured = structuredClone(body); body.model = 'mutated'; (body.tools as unknown[]).length = 0; order.push('prepared'); },
        dispatch() { order.push('dispatch'); }, responseStarted() { order.push('response'); },
        providerEvent(event) { frames.push(event); order.push('frame'); }, terminal(status) { order.push(status); },
    };
    const tools = [{ name: 'read_file', description: 'Read text', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
    const history = [{ role: 'user', content: 'native history' }];
    const events = await collect(streamAgentApi(f.connection, 'model', [{ role: 'user', content: 'input' }], undefined,
        { tools, continuation: history, instructions: 'system', observer }));
    assert.deepEqual(captured, f.requests[0]); assert.equal(f.requests[0].model, 'model');
    assert.equal((f.requests[0].tools as unknown[]).length, 1);
    if (protocol === 'openai-responses') { assert.deepEqual(captured?.include, ['reasoning.encrypted_content']); assert.deepEqual(captured?.input, history); }
    else assert.deepEqual(captured?.messages, protocol === 'openai-chat' ? [{ role: 'system', content: 'system' }, ...history] : history);
    assert.deepEqual(order.slice(0, 3), ['prepared', 'dispatch', 'response']); assert.equal(order.at(-1), 'completed');
    assert.equal(order.filter(value => value === 'completed').length, 1);
    assert.ok(frames.some(event => event.data.includes('usage')));
    assert.equal(events.at(-1)?.type, 'complete');
    assert.equal(JSON.stringify(captured).includes('private-api-key'), false);
});

test('prepared acknowledgement failure prevents dispatch and network and emits exactly one failed terminal', async t => {
    const f = await fixture(t, 'openai-chat'); const statuses: string[] = []; let dispatched = 0;
    const observer = { ...noop(), prepared() { throw new Error('private persistence diagnostic'); }, dispatch() { dispatched++; }, terminal(status: string) { statuses.push(status); } };
    await assert.rejects(collect(streamAgentApi(f.connection, 'model', [{ role: 'user', content: 'input' }], undefined, { tools: [], observer })),
        error => error instanceof RequestRecordingError && !error.partial && !error.message.includes('private'));
    assert.equal(f.requests.length, 0); assert.equal(dispatched, 0); assert.deepEqual(statuses, ['failed']);
});

test('provider frame acknowledgement failure preserves partial evidence and cannot release complete or tools', async t => {
    const f = await fixture(t, 'openai-chat'); const statuses: string[] = []; const events: AgentStreamEvent[] = []; let frames = 0;
    const observer = { ...noop(), providerEvent() { if (++frames === 2) throw new Error('private event failure'); }, terminal(status: string) { statuses.push(status); } };
    await assert.rejects(async () => {
        for await (const event of streamAgentApi(f.connection, 'model', [{ role: 'user', content: 'input' }], undefined, { tools: [], observer })) events.push(event);
    }, error => error instanceof RequestRecordingError && error.partial && !error.message.includes('private'));
    assert.ok(events.some(event => event.type === 'text')); assert.ok(!events.some(event => event.type === 'complete'));
    assert.deepEqual(statuses, ['failed']);
});

test('terminal acknowledgement failure is attempted once and prevents complete', async t => {
    const f = await fixture(t, 'openai-chat'); let attempts = 0; const events: AgentStreamEvent[] = [];
    await assert.rejects(async () => {
        for await (const event of streamAgentApi(f.connection, 'model', [{ role: 'user', content: 'input' }], undefined, { tools: [],
            observer: { ...noop(), terminal() { attempts++; throw new Error('private terminal'); } } })) events.push(event);
    }, RequestRecordingError);
    assert.equal(attempts, 1); assert.ok(!events.some(event => event.type === 'complete'));
});

test('cancelled and malformed streams have a single terminal observation', async t => {
    const f = await fixture(t, 'openai-chat', 'data: invalid-json\n\n');
    for (const cancelled of [false, true]) {
        const controller = new AbortController(); if (cancelled) controller.abort(); const statuses: string[] = [];
        await assert.rejects(collect(streamAgentApi(f.connection, 'model', [{ role: 'user', content: 'input' }], controller.signal,
            { tools: [], observer: { ...noop(), terminal(status) { statuses.push(status); } } })));
        assert.deepEqual(statuses, [cancelled ? 'cancelled' : 'failed']);
    }
});

test('request identity correlates HTTP diagnostics, prompt metadata and visible context without unsafe fields', async t => {
    const directory = await mkdtemp(path.join(tmpdir(), 'uah-capture-')); t.after(() => rm(directory, { recursive: true, force: true }));
    configureDiagnostics(directory);
    const identity = { requestId: randomUUID(), attemptId: randomUUID() };
    const f = await fixture(t, 'openai-chat');
    await collect(streamAgentApi(f.connection, 'model', [{ role: 'user', content: 'input' }], undefined, { tools: [], requestIdentity: identity, observer: noop() }));
    recordPromptAssembly('openai-chat', { ...identity, runId: randomUUID(), round: 0, profile: 'gpt', totalCharacters: 10, modules: [] });
    createDiagnosticTrace('stream', 'openai-chat', { requestId: 'private-invalid', attemptId: 'private-invalid' }).event('request.start');
    const log = await readFile(path.join(directory, 'logs', 'runtime.jsonl'), 'utf8');
    const entries = log.trim().split('\n').map(line => JSON.parse(line));
    assert.ok(entries.some(entry => entry.event === 'http.send'));
    for (const entry of entries.filter(entry => entry.requestId === identity.requestId)) assert.equal(entry.attemptId, identity.attemptId);
    assert.equal(entries.find(entry => entry.event === 'prompt.assembled').requestId, identity.requestId);
    assert.equal(log.includes('private-invalid'), false); assert.equal(log.includes('private-api-key'), false);
    const input = { runId: randomUUID(), round: 0, modelId: 'model', protocol: 'openai-chat' as const, sections: [], messages: [], tools: [] };
    assert.equal(captureRequestContext({ ...input, requestId: identity.requestId }).requestId, identity.requestId);
    assert.notEqual(captureRequestContext(input).requestId, identity.requestId);
});
