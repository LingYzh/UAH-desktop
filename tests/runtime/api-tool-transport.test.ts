import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import test from 'node:test';
import { appendToolResults, streamAgentApi, streamApi } from '../../src/runtime/api-transport.js';
import type { ApiConnection } from '../../src/shared/endpoints.js';
import type { AgentStreamEvent, ToolDefinition } from '../../src/shared/tool-protocol.js';
import { defaultModelParameters } from '../../src/shared/model-parameters.js';

const tools: ToolDefinition[] = [{ name: 'read_file', description: 'Read a file', parameters: {
    type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false,
} }];
const messages = [{ role: 'user' as const, content: 'Read a and b' }];
function event(payload: unknown, name?: string): string {
    return `${name ? `event: ${name}\n` : ''}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}
function named(type: string, payload: Record<string, unknown> = {}): string { return event({ type, ...payload }, type); }
async function fixture(handler: (body: Record<string, unknown>, response: ServerResponse, round: number) => void) {
    const requests: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
            requests.push(body);
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.flushHeaders();
            handler(body, response, requests.length);
        } catch { response.destroy(); }
    });
    // Windows may allocate from a customized ephemeral range. Match Fetch's
    // restricted ports rather than assuming every OS-assigned port is usable.
    const blocked = new Set([1, 7, 9, 11, 13, 15, 17, 19, 20, 21, 22, 23, 25, 37, 42, 43, 53, 69,
        77, 79, 87, 95, 101, 102, 103, 104, 109, 110, 111, 113, 115, 117, 119, 123, 135, 137, 139,
        143, 161, 179, 389, 427, 465, 512, 513, 514, 515, 526, 530, 531, 532, 540, 548, 554, 556,
        563, 587, 601, 636, 989, 990, 993, 995, 1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060,
        5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6679, 6697, 10080]);
    while (true) {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        const address = server.address();
        assert.ok(address && typeof address !== 'string');
        if (!blocked.has(address.port)) break;
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    return {
        requests,
        connection(protocol: ApiConnection['protocol']): ApiConnection {
            return { id: 'fixture', name: 'Fixture', enabled: true, revision: 1, apiKey: '', models: ['model'],
                baseUrl: `http://127.0.0.1:${address.port}/v1`, protocol };
        },
        async close() { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); },
    };
}
async function collect(source: AsyncIterable<AgentStreamEvent>) {
    const events: AgentStreamEvent[] = [];
    for await (const item of source) events.push(item);
    return events;
}
function complete(events: AgentStreamEvent[]) {
    const completion = events.find((item): item is Extract<AgentStreamEvent, { type: 'complete' }> => item.type === 'complete');
    assert.ok(completion);
    assert.equal(events.at(-1), completion);
    assert.equal(events.filter(item => item.type === 'complete').length, 1);
    return completion;
}
function text(events: AgentStreamEvent[], type: 'text' | 'reasoning') {
    return events.filter(item => item.type === type).map(item => 'text' in item ? item.text : '').join('');
}

test('protocol terminal probes reject missing Chat finish and invalid Responses/Anthropic stops', async () => {
    const output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'partial' }] }];
    const cases: Array<[ApiConnection['protocol'], string, boolean]> = [
        ['openai-chat', event({ choices: [{ delta: { content: 'partial' } }] }) + event('[DONE]'), false],
        ['openai-chat', event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop' }] }) + event('[DONE]'), true],
        ...['incomplete', 'failed', 'in_progress', 'completed'].map(status => ['openai-responses',
            named('response.completed', { response: { status, output } }), status === 'completed'] as [ApiConnection['protocol'], string, boolean]),
        ...[undefined, 'end_turn'].map(stop_reason => ['anthropic',
            named('content_block_start', { index: 0, content_block: { type: 'text', text: 'partial' } })
            + named('content_block_stop', { index: 0 }) + named('message_delta', { delta: { stop_reason } })
            + named('message_stop'), stop_reason === 'end_turn'] as [ApiConnection['protocol'], string, boolean]),
        ['openai-chat', event({ choices: [{ delta: { reasoning_content: 'reasoning only' }, finish_reason: 'stop' }] }) + event('[DONE]'), true],
    ];
    for (const [protocol, source, succeeds] of cases) {
        const fx = await fixture((_body, response) => response.end(source));
        const received: AgentStreamEvent[] = [];
        try {
            const task = async () => { for await (const item of streamAgentApi(fx.connection(protocol), 'model', messages)) received.push(item); };
            if (succeeds) { await task(); complete(received); }
            else { await assert.rejects(task); assert.equal(received.some(item => item.type === 'complete'), false); }
        } finally { await fx.close(); }
    }
});

test('usage snapshots normalize real counters, cache semantics, zeroes and missing or invalid fields', async () => {
    const invalid = [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '12', null];
    const input = (protocol: ApiConnection['protocol'], value: unknown) => protocol === 'openai-chat'
        ? { prompt_tokens: value, completion_tokens: value, total_tokens: value, prompt_tokens_details: { cached_tokens: value } }
        : protocol === 'openai-responses'
            ? { input_tokens: value, output_tokens: value, total_tokens: value, input_tokens_details: { cached_tokens: value } }
            : { input_tokens: value, output_tokens: value, cache_read_input_tokens: value, cache_creation_input_tokens: value };
    const source = (protocol: ApiConnection['protocol'], usage: unknown) => protocol === 'openai-chat'
        ? event({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] })
            + event({ choices: [], usage }) + event({ choices: [], usage }) + event('[DONE]')
        : protocol === 'openai-responses'
            ? named('response.completed', { response: { status: 'completed', usage, output: [
                { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
            ] } })
            : named('message_start', { message: { usage } })
                + named('content_block_start', { index: 0, content_block: { type: 'text', text: 'Done' } })
                + named('content_block_stop', { index: 0 }) + named('message_delta', { delta: { stop_reason: 'end_turn' }, usage })
                + named('message_stop');
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
        for (const value of [undefined, ...invalid, 0, 12]) {
            const fx = await fixture((_body, response) => response.end(source(protocol, value === undefined ? undefined : input(protocol, value))));
            try {
                const events = await collect(streamAgentApi(fx.connection(protocol), 'model', messages));
                complete(events);
                const usages = events.filter(item => item.type === 'usage');
                if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) assert.deepEqual(usages, []);
                else assert.deepEqual(usages, [{ type: 'usage', usage: protocol === 'anthropic'
                    ? { inputTokens: value * 3, outputTokens: value, cachedInputTokens: value, cacheCreationInputTokens: value }
                    : { inputTokens: value, outputTokens: value, totalTokens: value, cachedInputTokens: value } }]);
                if (protocol === 'openai-chat') assert.equal(Object.hasOwn(fx.requests[0], 'stream_options'), false);
            } finally { await fx.close(); }
        }
    }
});

test('Anthropic usage merges cumulative updates without adding repeated output counters', async () => {
    const fx = await fixture((_body, response) => response.end(
        named('message_start', { message: { usage: { input_tokens: 10, cache_read_input_tokens: 30, cache_creation_input_tokens: 20, output_tokens: 0 } } })
        + named('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: 'Think', signature: 'opaque' } })
        + named('content_block_stop', { index: 0 })
        + named('message_delta', { delta: {}, usage: { output_tokens: 2 } })
        + named('message_delta', { delta: {}, usage: { output_tokens: 2 } })
        + named('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }) + named('message_stop')));
    try {
        const events = await collect(streamAgentApi(fx.connection('anthropic'), 'model', messages));
        complete(events);
        assert.deepEqual(events.filter(item => item.type === 'usage').map(item => item.usage), [0, 2, 5].map(outputTokens => ({
            inputTokens: 60, outputTokens, cachedInputTokens: 30, cacheCreationInputTokens: 20,
        })));
    } finally { await fx.close(); }
});

test('usage metadata cannot turn incomplete text or tool streams into completed calls', async () => {
    const sources = [
        event({ choices: [{ delta: { content: 'partial' } }] }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }] }),
    ];
    for (const source of sources) {
        const fx = await fixture((_body, response) => response.end(source + event({ choices: [], usage: { prompt_tokens: 10 } }) + event('[DONE]')));
        const received: AgentStreamEvent[] = [];
        try {
            await assert.rejects(async () => { for await (const item of streamAgentApi(fx.connection('openai-chat'), 'model', messages, undefined, { tools })) received.push(item); });
            assert.deepEqual(received.filter(item => item.type === 'usage'), [{ type: 'usage', usage: { inputTokens: 10 } }]);
            assert.equal(received.some(item => item.type === 'complete'), false);
        } finally { await fx.close(); }
    }
});

test('sparse usage leaves absent counters unknown and cache sums never overflow safe integers', async () => {
    const cases = [
        { usage: { input_tokens: 10 }, expected: { inputTokens: 10 } },
        { usage: { output_tokens: 0 }, expected: { outputTokens: 0 } },
        { usage: { cache_read_input_tokens: 12 }, expected: { cachedInputTokens: 12 } },
        { usage: { input_tokens: Number.MAX_SAFE_INTEGER, cache_creation_input_tokens: 1 }, expected: { cacheCreationInputTokens: 1 } },
        { usage: { input_tokens: 10, output_tokens: 'private', cache_read_input_tokens: 0 }, expected: { inputTokens: 10, cachedInputTokens: 0 } },
        { usage: { input_tokens: 1e400, output_tokens: 1e400 }, expected: undefined },
    ];
    for (const { usage, expected } of cases) {
        const fx = await fixture((_body, response) => response.end(
            named('message_start', { message: { usage } })
            + named('content_block_start', { index: 0, content_block: { type: 'text', text: 'Done' } })
            + named('content_block_stop', { index: 0 }) + named('message_delta', { delta: { stop_reason: 'end_turn' } }) + named('message_stop')));
        try {
            const events = await collect(streamAgentApi(fx.connection('anthropic'), 'model', messages));
            complete(events);
            assert.deepEqual(events.filter(item => item.type === 'usage'), expected ? [{ type: 'usage', usage: expected }] : []);
        } finally { await fx.close(); }
    }
});

test('Chat streams fragmented interleaved calls and actual reasoning, then correlates native tool results', async () => {
    const fx = await fixture((_body, response, round) => {
        if (round === 1) response.end(
            event({ choices: [{ delta: { reasoning_content: 'Inspect ', content: 'Reading ' } }] })
            + event({ choices: [{ delta: { reasoning_content: 'files', tool_calls: [
                { index: 0, id: 'call-a', type: 'function', function: { name: 'read_', arguments: '{"path":' } },
                { index: 1, id: 'call-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b"' } },
            ] } }] })
            + event({ choices: [{ delta: { tool_calls: [
                { index: 1, function: { arguments: '}' } }, { index: 0, function: { name: 'file', arguments: '"a"}' } },
            ] }, finish_reason: 'tool_calls' }] }) + event('[DONE]'));
        else response.end(event({ choices: [{ delta: { content: 'Done', reasoning: 'Results match' }, finish_reason: 'stop' }] }) + event('[DONE]'));
    });
    try {
        const first = await collect(streamAgentApi(fx.connection('openai-chat'), 'model', messages, undefined, { tools, instructions: 'System' }));
        assert.equal(text(first, 'text'), 'Reading ');
        assert.equal(text(first, 'reasoning'), 'Inspect files');
        const done = complete(first);
        assert.deepEqual(done.toolCalls, [{ id: 'call-a', name: 'read_file', arguments: '{"path":"a"}' },
            { id: 'call-b', name: 'read_file', arguments: '{"path":"b"}' }]);
        const continuation = appendToolResults('openai-chat', done.continuation, [
            { id: 'call-b', content: 'B', isError: true }, { id: 'call-a', content: 'A' },
        ]);
        const second = await collect(streamAgentApi(fx.connection('openai-chat'), 'model', messages, undefined, { tools, instructions: 'System', continuation }));
        assert.equal(text(second, 'reasoning'), 'Results match');
        assert.equal(text(second, 'text'), 'Done');
        assert.deepEqual(complete(second).toolCalls, []);
        assert.deepEqual(fx.requests[0].tools, [{ type: 'function', function: tools[0] }]);
        assert.deepEqual(fx.requests[1].messages, [{ role: 'system', content: 'System' }, ...continuation]);
        assert.deepEqual(continuation.slice(-2), [{ role: 'tool', tool_call_id: 'call-a', content: 'A' }, { role: 'tool', tool_call_id: 'call-b', content: 'B' }]);
        assert.equal((done.continuation[1] as Record<string, unknown>).reasoning_content, 'Inspect files');
        assert.equal(done.continuation.length, 2);
    } finally { await fx.close(); }
});

test('Responses preserves opaque reasoning and final items without duplicating deltas in two-round continuation', async () => {
    const reasoning = { type: 'reasoning', id: 'reasoning-1', encrypted_content: 'opaque-encrypted', summary: [{ type: 'summary_text', text: 'Inspect files' }] };
    const callA = { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'read_file', arguments: '{"path":"a"}', status: 'completed' };
    const callB = { type: 'function_call', id: 'item-b', call_id: 'call-b', name: 'read_file', arguments: '{"path":"b"}', status: 'completed' };
    const message = { type: 'message', id: 'message-1', role: 'assistant', content: [{ type: 'output_text', text: 'Reading files', annotations: [] }], status: 'completed' };
    const output = [reasoning, callA, callB, message];
    const fx = await fixture((_body, response, round) => {
        if (round === 1) response.end(
            named('response.reasoning_summary_text.delta', { output_index: 0, summary_index: 0, delta: 'Inspect ' })
            + named('response.reasoning_summary_text.delta', { output_index: 0, summary_index: 0, delta: 'files' })
            + named('response.output_item.added', { output_index: 1, item: { ...callA, arguments: '', status: 'in_progress' } })
            + named('response.output_item.added', { output_index: 2, item: { ...callB, arguments: '', status: 'in_progress' } })
            + named('response.function_call_arguments.delta', { output_index: 1, item_id: 'item-a', delta: '{"path":' })
            + named('response.function_call_arguments.delta', { output_index: 2, item_id: 'item-b', delta: '{"path":"b"}' })
            + named('response.function_call_arguments.delta', { output_index: 1, item_id: 'item-a', delta: '"a"}' })
            + named('response.function_call_arguments.done', { output_index: 1, item_id: 'item-a', arguments: callA.arguments })
            + named('response.output_item.done', { output_index: 1, item: callA })
            + named('response.output_item.done', { output_index: 2, item: callB })
            + named('response.output_text.delta', { output_index: 3, content_index: 0, delta: 'Reading files' })
            + named('response.completed', { response: { status: 'completed', output } }));
        else response.end(named('response.completed', { response: { status: 'completed', output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
        ] } }));
    });
    try {
        const first = await collect(streamAgentApi(fx.connection('openai-responses'), 'model', messages, undefined, { tools }));
        const done = complete(first);
        assert.equal(text(first, 'reasoning'), 'Inspect files');
        assert.equal(text(first, 'text'), 'Reading files');
        assert.equal(done.toolCalls.length, 2);
        assert.deepEqual(done.continuation, [...messages, ...output]);
        const continuation = appendToolResults('openai-responses', done.continuation, [{ id: 'call-a', content: 'A' }, { id: 'call-b', content: 'B' }]);
        const second = await collect(streamAgentApi(fx.connection('openai-responses'), 'model', messages, undefined, { tools, continuation }));
        assert.equal(text(second, 'text'), 'Done');
        assert.deepEqual(complete(second).toolCalls, []);
        assert.deepEqual(fx.requests[0].tools, [{ type: 'function', ...tools[0], strict: false }]);
        assert.deepEqual(fx.requests[0].include, ['reasoning.encrypted_content']);
        assert.deepEqual(fx.requests[1].input, continuation);
        assert.deepEqual(continuation.slice(-2), [{ type: 'function_call_output', call_id: 'call-a', output: 'A' },
            { type: 'function_call_output', call_id: 'call-b', output: 'B' }]);
    } finally { await fx.close(); }
});

test('Responses requests summaries for explicit reasoning or declared capability without inventing model support', async () => {
    const fx = await fixture((_body, response) => response.end(named('response.completed', { response: { status: 'completed', output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
    ] } })));
    try {
        const base = fx.connection('openai-responses');
        const cases = [
            { connection: base, effort: 'default' as const, expected: undefined },
            { connection: base, effort: 'high' as const, expected: { effort: 'high', summary: 'auto' } },
            { connection: { ...base, modelDetails: [{ id: 'model', reasoning: true }] }, effort: 'default' as const, expected: { summary: 'auto' } },
            { connection: { ...base, modelDetails: [{ id: 'model', reasoning: true }], modelOverrides: [{ id: 'model', reasoning: false }] }, effort: 'default' as const, expected: undefined },
            { connection: { ...base, modelDetails: [{ id: 'model', reasoning: true }] }, effort: 'none' as const, expected: { effort: 'none' } },
        ];
        for (const item of cases) {
            await collect(streamAgentApi(item.connection, 'model', messages, undefined, { tools,
                parameters: { ...defaultModelParameters(), reasoningEffort: item.effort } }));
            assert.deepEqual(fx.requests.at(-1)?.reasoning, item.expected);
        }
    } finally { await fx.close(); }
});

test('Anthropic retains thinking signatures, redacted thinking and grouped tool results across rounds', async () => {
    const fx = await fixture((_body, response, round) => {
        if (round === 1) response.end(
            named('message_start', { message: { content: [] } })
            + named('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
            + named('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'Inspect files' } })
            + named('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'signed-' } })
            + named('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'opaque' } })
            + named('content_block_stop', { index: 0 })
            + named('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'call-a', name: 'read_file', input: {} } })
            + named('content_block_start', { index: 2, content_block: { type: 'tool_use', id: 'call-b', name: 'read_file', input: {} } })
            + named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":' } })
            + named('content_block_delta', { index: 2, delta: { type: 'input_json_delta', partial_json: '{"path":"b"}' } })
            + named('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"a"}' } })
            + named('content_block_stop', { index: 1 }) + named('content_block_stop', { index: 2 })
            + named('content_block_start', { index: 3, content_block: { type: 'redacted_thinking', data: 'opaque-redacted' } })
            + named('content_block_stop', { index: 3 })
            + named('content_block_start', { index: 4, content_block: { type: 'text', text: 'Reading ' } })
            + named('content_block_delta', { index: 4, delta: { type: 'text_delta', text: 'files' } })
            + named('content_block_stop', { index: 4 })
            + named('message_delta', { delta: { stop_reason: 'tool_use' } }) + named('message_stop'));
        else response.end(named('content_block_start', { index: 0, content_block: { type: 'text', text: 'Done' } })
            + named('content_block_stop', { index: 0 }) + named('message_delta', { delta: { stop_reason: 'end_turn' } }) + named('message_stop'));
    });
    try {
        const first = await collect(streamAgentApi(fx.connection('anthropic'), 'model', messages, undefined, { tools }));
        const done = complete(first);
        assert.equal(text(first, 'reasoning'), 'Inspect files');
        assert.equal(text(first, 'text'), 'Reading files');
        const assistant = done.continuation[1] as { content: unknown[] };
        assert.deepEqual(assistant.content[0], { type: 'thinking', thinking: 'Inspect files', signature: 'signed-opaque' });
        assert.deepEqual(assistant.content[3], { type: 'redacted_thinking', data: 'opaque-redacted' });
        const continuation = appendToolResults('anthropic', done.continuation, [{ id: 'call-b', content: 'B', isError: true }, { id: 'call-a', content: 'A' }]);
        const second = await collect(streamAgentApi(fx.connection('anthropic'), 'model', messages, undefined, { tools, continuation }));
        assert.equal(text(second, 'text'), 'Done');
        assert.deepEqual(complete(second).toolCalls, []);
        assert.deepEqual(fx.requests[0].tools, [{ name: tools[0].name, description: tools[0].description, input_schema: tools[0].parameters }]);
        assert.deepEqual(fx.requests[1].messages, continuation);
        assert.deepEqual(continuation.at(-1), { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'call-a', content: 'A' },
            { type: 'tool_result', tool_use_id: 'call-b', content: 'B', is_error: true },
        ] });
    } finally { await fx.close(); }
});

test('partial calls, invalid arguments, provider errors and interrupted streams never expose a completed call', async () => {
    const chunk = (argumentsValue: string) => event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'function',
        function: { name: 'read_file', arguments: argumentsValue } }] }, finish_reason: 'tool_calls' }] });
    const sources = [chunk('{}'), chunk('{') + event('[DONE]'), chunk('{}') + event({ error: { message: 'private error' } }),
        chunk('{}') + event({ choices: [{ delta: {}, finish_reason: 'length' }] }) + event('[DONE]')];
    for (const source of sources) {
        const fx = await fixture((_body, response) => response.end(source));
        const received: AgentStreamEvent[] = [];
        try {
            await assert.rejects(async () => { for await (const item of streamAgentApi(fx.connection('openai-chat'), 'model', messages, undefined, { tools })) received.push(item); });
            assert.equal(received.some(item => item.type === 'complete'), false);
        } finally { await fx.close(); }
    }
});

test('cancellation stops a partial tool stream and text-only transport still refuses tools', async () => {
    const chunk = event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } }] } }] });
    const fx = await fixture((_body, response) => { response.write(chunk); });
    try {
        const controller = new AbortController();
        const task = collect(streamAgentApi(fx.connection('openai-chat'), 'model', messages, controller.signal, { tools }));
        setTimeout(() => controller.abort(), 30);
        await assert.rejects(task, /取消/);
        await assert.rejects(async () => { for await (const _delta of streamApi(fx.connection('openai-chat'), 'model', messages)) { /* Text-only calls must reject before executing. */ } }, /工具/);
    } finally { await fx.close(); }
});

test('Responses and Anthropic incomplete tool rounds never release partial calls', async () => {
    const call = { type: 'function_call', id: 'item-a', call_id: 'call-a', name: 'read_file', arguments: '{}' };
    const responsesSources = [
        named('response.output_item.added', { output_index: 0, item: call }),
        named('response.output_item.added', { output_index: 0, item: call }) + named('response.completed', { response: { status: 'incomplete', output: [call] } }),
        named('response.output_item.added', { output_index: 0, item: call }) + named('response.completed', { response: { status: 'completed', output: [] } }),
        named('response.completed', { response: { status: 'completed', output: [{ ...call, arguments: '{' }] } }),
        named('response.completed', { response: { status: 'completed', output: [call, { ...call, id: 'item-b' }] } }),
        named('response.failed', { response: { error: { message: 'private' } } }),
    ];
    const toolBlock = named('content_block_start', { index: 0, content_block: { type: 'tool_use', id: 'call-a', name: 'read_file', input: {} } });
    const anthropicSources = [
        toolBlock,
        toolBlock + named('message_delta', { delta: { stop_reason: 'tool_use' } }) + named('message_stop'),
        toolBlock + named('content_block_stop', { index: 0 }) + named('message_delta', { delta: { stop_reason: 'max_tokens' } }) + named('message_stop'),
        toolBlock + named('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: '{' } }) + named('content_block_stop', { index: 0 }),
        toolBlock + named('error', { error: { type: 'overloaded_error', message: 'private' } }),
    ];
    for (const [protocol, sources] of [['openai-responses', responsesSources], ['anthropic', anthropicSources]] as const) {
        for (const source of sources) {
            const fx = await fixture((_body, response) => response.end(source));
            const events: AgentStreamEvent[] = [];
            try {
                await assert.rejects(async () => { for await (const item of streamAgentApi(fx.connection(protocol), 'model', messages, undefined, { tools })) events.push(item); });
                assert.equal(events.some(item => item.type === 'complete'), false);
            } finally { await fx.close(); }
        }
    }
});

test('all protocols display no invented reasoning when only final text exists', async () => {
    const streams = {
        'openai-chat': event({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] }) + event('[DONE]'),
        'openai-responses': named('response.completed', { response: { status: 'completed', output: [
            { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Done' }] },
        ] } }),
        anthropic: named('content_block_start', { index: 0, content_block: { type: 'text', text: 'Done' } })
            + named('content_block_stop', { index: 0 }) + named('message_delta', { delta: { stop_reason: 'end_turn' } }) + named('message_stop'),
    };
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
        const fx = await fixture((_body, response) => response.end(streams[protocol]));
        try {
            const events = await collect(streamAgentApi(fx.connection(protocol), 'model', messages, undefined, { tools: [] }));
            assert.equal(text(events, 'text'), 'Done');
            assert.equal(text(events, 'reasoning'), '');
            assert.deepEqual(complete(events).toolCalls, []);
            assert.equal(Object.hasOwn(fx.requests[0], 'tools'), false);
        } finally { await fx.close(); }
    }
});

test('tool count, arguments and reasoning are bounded; result IDs must match once', async () => {
    const tool_calls = Array.from({ length: 65 }, (_, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }));
    const sources = [event({ choices: [{ delta: { tool_calls } }] }),
        event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'read_file', arguments: 'a'.repeat(600_000) } }] } }] })
            + event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'a'.repeat(600_000) } }] } }] }),
        event({ choices: [{ delta: { reasoning_content: 'a'.repeat(250_001) } }] })
            + event({ choices: [{ delta: { reasoning_content: 'a'.repeat(250_001) } }] })];
    for (const source of sources) {
        const fx = await fixture((_body, response) => response.end(source));
        try { await assert.rejects(collect(streamAgentApi(fx.connection('openai-chat'), 'model', messages, undefined, { tools }))); }
        finally { await fx.close(); }
    }
    const continuation = [...messages, { role: 'assistant', content: null, tool_calls: [
        { id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'call-b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
    ] }];
    for (const results of [[{ id: 'call-a', content: 'A' }], [{ id: 'call-a', content: 'A' }, { id: 'call-a', content: 'B' }],
        [{ id: 'call-a', content: 'A' }, { id: 'unknown', content: 'B' }]]) assert.throws(() => appendToolResults('openai-chat', continuation, results));
    const completed = appendToolResults('openai-chat', continuation, [{ id: 'call-a', content: 'A' }, { id: 'call-b', content: 'B' }]);
    assert.throws(() => appendToolResults('openai-chat', completed, [{ id: 'call-a', content: 'A' }, { id: 'call-b', content: 'B' }]));
});
