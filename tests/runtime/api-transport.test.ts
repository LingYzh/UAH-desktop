import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureDiagnostics } from '../../src/runtime/diagnostics';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { defaultAgentParameters } from '../../src/shared/agents.js';
import type { ApiConnection, ApiMessage } from '../../src/shared/endpoints.js';
import { discoverApiModels, listApiModels, streamApi, testApiConnection } from '../../src/runtime/api-transport.js';

interface CapturedRequest {
    method: string;
    url: string;
    headers: IncomingMessage['headers'];
    body: unknown;
}

interface Fixture {
    baseUrl: string;
    requests: CapturedRequest[];
    close(): Promise<void>;
}

type FixtureHandler = (request: CapturedRequest, response: ServerResponse) => void | Promise<void>;

async function startFixture(handler: FixtureHandler): Promise<Fixture> {
    const requests: CapturedRequest[] = [];
    const server = createServer((request, response) => {
        void (async () => {
            const chunks: Buffer[] = [];
            for await (const chunk of request) {
                chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const source = Buffer.concat(chunks).toString('utf8');
            let body: unknown;
            if (source.length > 0) {
                try {
                    body = JSON.parse(source);
                } catch {
                    body = source;
                }
            }
            const captured: CapturedRequest = {
                method: request.method ?? '',
                url: request.url ?? '',
                headers: request.headers,
                body,
            };
            requests.push(captured);
            await handler(captured, response);
        })().catch(() => {
            if (!response.headersSent) {
                response.writeHead(500);
            }
            response.end();
        });
    });

    const blockedPorts = new Set([3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
    while (true) {
        await new Promise<void>((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', () => {
                server.removeListener('error', reject);
                resolve();
            });
        });
        if (!blockedPorts.has((server.address() as AddressInfo).port)) break;
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
    const address = server.address() as AddressInfo;
    return {
        baseUrl: `http://127.0.0.1:${address.port}/v1`,
        requests,
        async close() {
            server.closeAllConnections();
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
            });
        },
    };
}

async function sendSse(response: ServerResponse, source: string, chunkSize = 11): Promise<void> {
    response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
    });
    const bytes = Buffer.from(source, 'utf8');
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        response.write(bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length)));
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
    response.end();
}

function connection(
    baseUrl: string,
    protocol: ApiConnection['protocol'],
    apiKey = 'test-api-key',
): ApiConnection {
    return {
        id: 'endpoint-1',
        name: 'Local fixture',
        protocol,
        baseUrl,
        apiKey,
        models: [],
        enabled: true,
        revision: 1,
    };
}

async function collect(source: AsyncIterable<string>): Promise<string> {
    let output = '';
    for await (const delta of source) {
        output += delta;
    }
    return output;
}

function sseEvent(data: string, event?: string): string {
    const prefix = event ? `event: ${event}\r\n` : '';
    return `${prefix}data: ${data}\r\n\r\n`;
}

test('agent options map instructions and configured parameters to all three protocols', async () => {
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
        const fixture = await startFixture(async (_request, response) => {
            const source = protocol === 'openai-chat'
                ? sseEvent('{"choices":[{"delta":{"content":"ok"}}]}') + sseEvent('[DONE]')
                : protocol === 'openai-responses'
                    ? sseEvent('{"type":"response.output_text.delta","delta":"ok"}', 'response.output_text.delta') + sseEvent('{"type":"response.completed","response":{"status":"completed"}}', 'response.completed')
                    : sseEvent('{"type":"content_block_delta","delta":{"type":"text_delta","text":"ok"}}', 'content_block_delta') + sseEvent('{"type":"message_delta","delta":{"stop_reason":"end_turn"}}', 'message_delta') + sseEvent('{"type":"message_stop"}', 'message_stop');
            await sendSse(response, source);
        });
        try {
            const parameters = { ...defaultAgentParameters(), temperature: 0.4, topP: 0.8, maxOutputTokens: 8000,
                reasoningEffort: 'high' as const,
                stop: protocol === 'openai-responses' ? [] : ['END'] };
            assert.equal(await collect(streamApi(connection(fixture.baseUrl, protocol), 'test', [{ role: 'user', content: 'hello' }], undefined,
                { instructions: 'be concise', parameters })), 'ok');
            const body = fixture.requests[0].body as Record<string, unknown>;
            assert.equal(body.temperature, 0.4);
            assert.equal(body.top_p, 0.8);
            assert.equal(body[protocol === 'openai-chat' ? 'max_completion_tokens' : protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'], 8000);
            if (protocol === 'openai-chat') {
                assert.deepEqual((body.messages as unknown[])[0], { role: 'system', content: 'be concise' });
                assert.equal(body.reasoning_effort, 'high');
                assert.deepEqual(body.stop, ['END']);
            } else if (protocol === 'openai-responses') {
                assert.equal(body.instructions, 'be concise');
                assert.deepEqual(body.reasoning, { effort: 'high' });
            } else {
                assert.equal(body.system, 'be concise');
                assert.deepEqual(body.stop_sequences, ['END']);
                assert.deepEqual(body.thinking, { type: 'adaptive' });
                assert.deepEqual(body.output_config, { effort: 'high' });
                await collect(streamApi(connection(fixture.baseUrl, protocol), 'test', [{ role: 'user', content: 'hello' }], undefined,
                    { parameters: { ...defaultAgentParameters(), reasoningEffort: 'none' } }));
                const disabled = fixture.requests[1].body as Record<string, unknown>;
                assert.deepEqual(disabled.thinking, { type: 'disabled' });
                assert.equal(Object.hasOwn(disabled, 'output_config'), false);
                await collect(streamApi(connection(fixture.baseUrl, protocol), 'test', [{ role: 'user', content: 'hello' }], undefined,
                    { parameters: { ...defaultAgentParameters(), thinkingBudget: 1024 } }));
                assert.deepEqual((fixture.requests[2].body as Record<string, unknown>).thinking, { type: 'enabled', budget_tokens: 1024 });
            }
            await collect(streamApi(connection(fixture.baseUrl, protocol), 'test', [{ role: 'user', content: 'hello' }], undefined,
                { parameters: defaultAgentParameters() }));
            const defaults = fixture.requests.at(-1)!.body as Record<string, unknown>;
            for (const field of ['temperature', 'top_p', 'reasoning', 'reasoning_effort', 'thinking', 'output_config', 'stop', 'stop_sequences', 'instructions', 'system']) {
                assert.equal(Object.hasOwn(defaults, field), false, `${protocol} unexpectedly sent ${field}`);
            }
        } finally { await fixture.close(); }
    }
});

test('unsupported agent parameter combinations fail before contacting the service', async () => {
    const fixture = await startFixture(() => { throw new Error('unexpected request'); });
    try {
        const cases = [
            { protocol: 'openai-chat', patch: { thinkingBudget: 1024 }, error: /思考预算/ },
            { protocol: 'openai-responses', patch: { stop: ['END'] }, error: /停止序列/ },
            { protocol: 'anthropic', patch: { reasoningEffort: 'minimal' }, error: /不支持该思考强度/ },
            { protocol: 'anthropic', patch: { reasoningEffort: 'ultra' }, error: /不支持该思考强度/ },
            { protocol: 'anthropic', patch: { thinkingBudget: 4096 }, error: /必须小于/ },
            { protocol: 'anthropic', patch: { reasoningEffort: 'high', thinkingBudget: 1024 }, error: /不能同时设置/ },
            { protocol: 'anthropic', patch: { thinkingBudget: 1024, temperature: 0.5 }, error: /temperature/ },
        ] as const;
        for (const item of cases) await assert.rejects(collect(streamApi(connection(fixture.baseUrl, item.protocol), 'test', [], undefined,
            { parameters: { ...defaultAgentParameters(), ...item.patch, stop: 'stop' in item.patch ? [...item.patch.stop] : [] } })), item.error);
        assert.equal(fixture.requests.length, 0);
    } finally { await fixture.close(); }
});

test('per-run timeout and caller cancellation abort stalled requests', async () => {
    const fixture = await startFixture((_request, response) => { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders(); });
    try {
        const parameters = { ...defaultAgentParameters(), timeoutSeconds: 5 };
        const started = Date.now();
        await assert.rejects(collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'test', [], undefined, { parameters })), /超时/);
        assert.ok(Date.now() - started < 8000);
        const controller = new AbortController();
        const task = collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'test', [], controller.signal, { parameters }));
        setTimeout(() => controller.abort(), 20);
        await assert.rejects(task, /取消/);
    } finally { await fixture.close(); }
});

test('OpenAI Chat uses the configured path, bearer key, store:false, and incremental UTF-8/multiline SSE', async () => {
    const fixture = await startFixture(async (_request, response) => {
        const first = JSON.stringify({ choices: [{ delta: { content: '你好 🌏' }, finish_reason: null }] }, null, 2);
        const finish = JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] });
        await sendSse(
            response,
            `: ping\r\n\r\n${first.split('\n').map((line) => `data: ${line}\r\n`).join('')}\r\n`
                + sseEvent(finish)
                + sseEvent('[DONE]'),
            5,
        );
    });
    try {
        const messages: ApiMessage[] = [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: 'continue' },
        ];
        const output = await collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', messages));
        assert.equal(output, '你好 🌏');
        assert.equal(fixture.requests.length, 1);
        const request = fixture.requests[0];
        assert.equal(request.method, 'POST');
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal(request.headers.authorization, 'Bearer test-api-key');
        assert.equal(request.headers['content-type'], 'application/json');
        assert.deepEqual(request.body, {
            model: 'gpt-test',
            messages,
            stream: true,
            store: false,
        });
    } finally {
        await fixture.close();
    }
});

test('OpenAI Responses sends role context and emits text and refusal deltas until completed', async () => {
    const fixture = await startFixture(async (_request, response) => {
        await sendSse(
            response,
            sseEvent(JSON.stringify({ type: 'response.output_text.delta', delta: 'Hello ' }), 'response.output_text.delta')
                + sseEvent(JSON.stringify({ type: 'response.refusal.delta', delta: 'no.' }), 'response.refusal.delta')
                + sseEvent(JSON.stringify({ type: 'response.completed', response: { status: 'completed', output: [] } }), 'response.completed'),
            9,
        );
    });
    try {
        const messages: ApiMessage[] = [
            { role: 'user', content: 'Say hello' },
            { role: 'assistant', content: 'Earlier answer' },
        ];
        const output = await collect(streamApi(connection(fixture.baseUrl, 'openai-responses'), 'gpt-test', messages));
        assert.equal(output, 'Hello no.');
        const request = fixture.requests[0];
        assert.equal(request.url, '/v1/responses');
        assert.equal(request.headers.authorization, 'Bearer test-api-key');
        assert.deepEqual(request.body, {
            model: 'gpt-test',
            input: messages,
            stream: true,
            store: false,
        });
    } finally {
        await fixture.close();
    }
});

test('Anthropic maps messages, sends required headers and max_tokens, and ignores benign events', async () => {
    const fixture = await startFixture(async (_request, response) => {
        await sendSse(
            response,
            sseEvent('{"type":"ping"}', 'ping')
                + sseEvent('{"type":"future_keepalive"}', 'future_keepalive')
                + sseEvent('{"type":"message_start","message":{"id":"msg_1"}}', 'message_start')
                + sseEvent('{"type":"content_block_start","index":0,"content_block":{"type":"text","text":"先"}}', 'content_block_start')
                + sseEvent('{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}', 'content_block_delta')
                + sseEvent('{"type":"message_delta","delta":{"stop_reason":"end_turn"}}', 'message_delta')
                + sseEvent('{"type":"message_stop"}', 'message_stop'),
            7,
        );
    });
    try {
        const messages: ApiMessage[] = [
            { role: 'user', content: 'Hi' },
            { role: 'assistant', content: 'Hello' },
        ];
        const output = await collect(streamApi(connection(fixture.baseUrl, 'anthropic'), 'claude-test', messages));
        assert.equal(output, '先你好');
        const request = fixture.requests[0];
        assert.equal(request.url, '/v1/messages');
        assert.equal(request.headers['x-api-key'], 'test-api-key');
        assert.equal(request.headers['anthropic-version'], '2023-06-01');
        assert.deepEqual(request.body, {
            model: 'claude-test',
            max_tokens: 4_096,
            messages,
            stream: true,
        });
    } finally {
        await fixture.close();
    }
});

test('model discovery reads OpenAI IDs and all bounded Anthropic pages', async () => {
    const openAi = await startFixture(async (request, response) => {
        assert.equal(request.method, 'GET');
        assert.equal(request.url, '/v1/models');
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'gpt-a' }, { id: 'gpt-b' }] }));
    });
    const anthropic = await startFixture(async (request, response) => {
        const query = new URL(request.url, 'http://127.0.0.1').searchParams;
        assert.equal(query.get('limit'), null);
        const afterId = query.get('after_id');
        response.writeHead(200, { 'content-type': 'application/json' });
        if (afterId === null) {
            response.end(JSON.stringify({ data: [{ id: 'claude-a' }], has_more: true, last_id: 'claude-a' }));
        } else {
            assert.equal(afterId, 'claude-a');
            response.end(JSON.stringify({ data: [{ id: 'claude-b' }], has_more: false, last_id: 'claude-b' }));
        }
    });
    try {
        assert.deepEqual(await listApiModels(connection(openAi.baseUrl, 'openai-chat')), ['gpt-a', 'gpt-b']);
        assert.equal(openAi.requests[0].headers.authorization, 'Bearer test-api-key');
        assert.deepEqual(await listApiModels(connection(anthropic.baseUrl, 'anthropic')), ['claude-a', 'claude-b']);
        assert.equal(anthropic.requests.length, 2);
        assert.ok(anthropic.requests[1].url.includes('after_id=claude-a'));
        assert.equal(anthropic.requests[0].headers['anthropic-version'], '2023-06-01');
    } finally {
        await openAi.close();
        await anthropic.close();
    }
});

test('explicit connection test makes a bounded generation request and waits for terminal success', async () => {
    const fixture = await startFixture(async (_request, response) => {
        await sendSse(response, sseEvent(JSON.stringify({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }))
            + sseEvent('[DONE]'));
    });
    try {
        const result = await testApiConnection(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test');
        assert.equal(typeof result.text, 'string');
        assert(result.text.length > 0);
        assert(result.elapsedMs >= 0);
        const request = fixture.requests[0];
        assert.equal(request.url, '/v1/chat/completions');
        assert.equal((request.body as Record<string, unknown>).max_completion_tokens, 256);
        assert.deepEqual((request.body as Record<string, unknown>).messages, [
            { role: 'user', content: 'Reply with the single word OK.' },
        ]);
    } finally {
        await fixture.close();
    }
});

test('HTTP and in-band errors expose only a generic message and safe HTTP status', async () => {
    const httpFailure = await startFixture(async (_request, response) => {
        response.writeHead(401, { 'x-private-header': 'private-header-value' });
        response.end('private response body with test-api-key');
    });
    try {
        await assert.rejects(
            collect(streamApi(connection(httpFailure.baseUrl, 'openai-chat'), 'gpt-test', [])),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /HTTP 401/);
                assert.doesNotMatch(error.message, /private|test-api-key|authorization/i);
                return true;
            },
        );
    } finally {
        await httpFailure.close();
    }

    const streamFailure = await startFixture(async (_request, response) => {
        await sendSse(response, sseEvent('{"error":{"message":"private provider detail"}}') + sseEvent('[DONE]'));
    });
    try {
        await assert.rejects(
            collect(streamApi(connection(streamFailure.baseUrl, 'openai-chat'), 'gpt-test', [])),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /模型服务返回了错误/);
                assert.doesNotMatch(error.message, /private|test-api-key/);
                return true;
            },
        );
    } finally {
        await streamFailure.close();
    }
});

test('non-2xx streaming response bodies are aborted after the safe status error', async () => {
    let markClosed: () => void = () => undefined;
    const bodyClosed = new Promise<void>((resolve) => {
        markClosed = resolve;
    });
    const fixture = await startFixture(async (_request, response) => {
        response.once('close', markClosed);
        response.writeHead(401, { 'content-type': 'text/plain' });
        response.write('private error body that stays open');
        await bodyClosed;
    });
    try {
        await assert.rejects(
            collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [])),
            /HTTP 401/,
        );
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
            await Promise.race([
                bodyClosed,
                new Promise<never>((_resolve, reject) => {
                    closeTimer = setTimeout(() => reject(new Error('HTTP error body remained open')), 1_000);
                }),
            ]);
        } finally {
            if (closeTimer) {
                clearTimeout(closeTimer);
            }
        }
    } finally {
        await fixture.close();
    }
});

test('premature EOF, malformed JSON, and unsupported tool requests are rejected', async (context) => {
    await context.test('premature EOF', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent(JSON.stringify({ choices: [{ delta: { content: 'partial' } }] })));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [])),
                /提前结束/,
            );
        } finally {
            await fixture.close();
        }
    });

    await context.test('malformed JSON', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent('{not json}') + sseEvent('[DONE]'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [])),
                /sse\.json_decode/,
            );
        } finally {
            await fixture.close();
        }
    });

    await context.test('tool request', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent(JSON.stringify({
                choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1' }] }, finish_reason: null }],
            })) + sseEvent('[DONE]'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [])),
                /不支持的工具/,
            );
        } finally {
            await fixture.close();
        }
    });
});

test('output-limited and filtered terminal states are rejected as incomplete', async (context) => {
    await context.test('Chat Completions length finish reason', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent(JSON.stringify({
                choices: [{ delta: { content: 'partial text' }, finish_reason: 'length' }],
            })) + sseEvent('[DONE]'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [])),
                /未能完成/,
            );
        } finally {
            await fixture.close();
        }
    });

    await context.test('Responses completion with a non-completed status', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent(JSON.stringify({
                type: 'response.completed',
                response: { status: 'incomplete', output: [] },
            }), 'response.completed'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'openai-responses'), 'gpt-test', [])),
                /未能完成/,
            );
        } finally {
            await fixture.close();
        }
    });

    await context.test('Anthropic max_tokens stop reason', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response,
                sseEvent('{"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}', 'content_block_delta')
                    + sseEvent('{"type":"message_delta","delta":{"stop_reason":"max_tokens"}}', 'message_delta')
                    + sseEvent('{"type":"message_stop"}', 'message_stop'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'anthropic'), 'claude-test', [])),
                /未能完成/,
            );
        } finally {
            await fixture.close();
        }
    });
});

test('a terminal stream with no text or refusal cannot complete a chat turn', async (context) => {
    await context.test('Chat Completions', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent('[DONE]'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [])),
                /未能完成/,
            );
        } finally {
            await fixture.close();
        }
    });

    await context.test('Responses API', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent(JSON.stringify({
                type: 'response.completed',
                response: { status: 'completed', output: [] },
            }), 'response.completed'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'openai-responses'), 'gpt-test', [])),
                /未能完成/,
            );
        } finally {
            await fixture.close();
        }
    });

    await context.test('Anthropic Messages', async () => {
        const fixture = await startFixture(async (_request, response) => {
            await sendSse(response, sseEvent('{"type":"message_stop"}', 'message_stop'));
        });
        try {
            await assert.rejects(
                collect(streamApi(connection(fixture.baseUrl, 'anthropic'), 'claude-test', [])),
                /未能完成/,
            );
        } finally {
            await fixture.close();
        }
    });
});

test('caller cancellation stops a stalled SSE stream with a safe error', async () => {
    const fixture = await startFixture(async (_request, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(': connected\n\n');
        await new Promise<void>((resolve) => response.once('close', resolve));
    });
    const abort = new AbortController();
    try {
        const pending = collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [], abort.signal));
        await new Promise((resolve) => setTimeout(resolve, 40));
        abort.abort();
        await assert.rejects(pending, /请求已取消/);
    } finally {
        await fixture.close();
    }
});

test('redirects are rejected without following their Location header', async () => {
    const fixture = await startFixture(async (request, response) => {
        if (request.url === '/v1/chat/completions') {
            response.writeHead(302, { location: '/followed' });
            response.end('redirect body');
            return;
        }
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(sseEvent('[DONE]'));
    });
    try {
        await assert.rejects(
            collect(streamApi(connection(fixture.baseUrl, 'openai-chat'), 'gpt-test', [])),
            (error: unknown) => {
                assert.ok(error instanceof Error);
                assert.match(error.message, /无法连接/);
                assert.doesNotMatch(error.message, /followed|redirect body|location/i);
                return true;
            },
        );
        assert.equal(fixture.requests.length, 1);
        assert.equal(fixture.requests[0].url, '/v1/chat/completions');
    } finally {
        await fixture.close();
    }
});


test('model diagnostics distinguish response failures without recording secrets or raw payloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'uah-transport-logs-'));
    configureDiagnostics(directory);
    const cases = [
        { body: '<html>private-upstream-content</html>', type: 'text/html', reason: 'json.decode' },
        { body: JSON.stringify({ entries: ['private-upstream-content'] }), type: 'application/json', reason: 'models.data_array_expected' },
        { body: JSON.stringify({ data: Array.from({length:501}, (_,i) => ({id:'private-upstream-content-' + i})) }), type: 'application/json', reason: 'models.count_limit' },
        { body: JSON.stringify({ data: [{id: 'private-upstream-content'}, {id: 123}] }), type: 'application/json', reason: 'models.id_invalid' },
    ];
    const ids: string[] = [];
    for (const entry of cases) {
        const fixture = await startFixture((_request, response) => {
            response.writeHead(200, { 'content-type': entry.type });
            response.end(entry.body);
        });
        try {
            await assert.rejects(listApiModels(connection(fixture.baseUrl, 'openai-chat', 'private-api-secret')), (error: Error) => {
                assert(error.message.includes(entry.reason));
                const id = error.message.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/)?.[0];
                assert(id); ids.push(id); return true;
            });
        } finally { await fixture.close(); }
    }
    const source = await readFile(join(directory, 'logs', 'runtime.jsonl'), 'utf8');
    assert(!source.includes('private-upstream-content'));
    assert(!source.includes('private-api-secret'));
    const records = source.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(new Set(ids).size, cases.length);
    for (const [index, id] of ids.entries()) {
        const trace = records.filter(record => record.requestId === id);
        assert(trace.every(record => record.operation === 'models' && record.protocol === 'openai-chat'));
        assert.equal(trace[0].event, 'request.start');
        assert.equal(trace.at(-1).event, 'request.failed');
        assert.equal(trace.at(-1).fields.reason, cases[index].reason);
        assert(trace.some(record => record.event === 'http.response' && record.fields.status === 200));
    }
    assert(records.some(record => record.event === 'models.limit' && record.fields.count === 501));
    assert(records.some(record => record.event === 'models.item_invalid' && record.fields.index === 1));
});


test('Anthropic-compatible unpaged catalogues work while malformed pagination remains rejected', async () => {
    const cases = [
        { pages: [{ data: [{ id: 'local-model' }] }], expected: ['local-model'] },
        { pages: [{ data: [] }], expected: [] },
        { pages: [{ data: [{ id: 'a' }], has_more: true }], reason: 'cursor_invalid' },
        { pages: [{ data: [{ id: 'a' }], has_more: 'false' }], expected: ['a'] },
        { pages: [{ data: [{ id: 'a' }], last_id: 'a' }], expected: ['a'] },
        { pages: [{ data: [{ id: 'a' }], has_more: true, last_id: 'a' }, { data: [{ id: 'b' }] }], expected: ['a','b'] },
        { pages: ['a','b','a'].map(id => ({ data: [{ id }], has_more: true, last_id: id })), reason: 'cursor_repeated' },
        { pages: Array.from({length:10}, (_,i) => ({data:[{id:String(i)}],has_more:true,last_id:String(i)})), reason: 'page_limit' },
    ];
    for (const entry of cases) {
        let page = 0;
        const fixture = await startFixture((_request, response) => {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(entry.pages[page++]));
        });
        try {
            const result = listApiModels(connection(fixture.baseUrl, 'anthropic'));
            if (entry.reason) await assert.rejects(result, new RegExp('models.pagination.' + entry.reason));
            else assert.deepEqual(await result, entry.expected);
            assert.equal(page, entry.pages.length);
        } finally { await fixture.close(); }
    }
});


test('all protocols discover common catalogue envelopes and retain reported model capabilities', async () => {
    const item = { name: 'local-model', architecture: { input_modalities: ['text','image'], output_modalities: ['text'] }, context_length: 128000, top_provider: { max_completion_tokens: 8192 }, capabilities: { tools: false, thinking: { supported: true } } };
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
        for (const payload of [[item], {data:[item]}, {models:[item]}, {data:{models:[item]}}]) {
            const fixture = await startFixture((_request, response) => { response.writeHead(200, {'content-type':'application/json'}); response.end(JSON.stringify(payload)); });
            try {
                const result = await discoverApiModels(connection(fixture.baseUrl, protocol));
                assert.deepEqual(result, { models: ['local-model'], modelDetails: [{id:'local-model', imageInput:true,pdfInput:false,audioInput:false,videoInput:false,inputModalities:['text','image'], outputModalities:['text'], contextWindow:128000, maxOutputTokens:8192, tools:false, vision:true, reasoning:true}] });
            } finally { await fixture.close(); }
        }
    }
    const fixture = await startFixture((request, response) => {
        const cursor = new URL(request.url,'http://localhost').searchParams.get('cursor');
        response.writeHead(200, {'content-type':'application/json'});
        response.end(JSON.stringify(cursor ? {models:[{model:'b'}]} : {data:['a', ' a '],next_cursor:'next'}));
    });
    try { assert.deepEqual(await discoverApiModels(connection(fixture.baseUrl,'openai-responses')), {models:['a','b'],modelDetails:[]}); }
    finally {await fixture.close();}
});
