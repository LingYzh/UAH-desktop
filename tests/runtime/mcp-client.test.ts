import assert from 'node:assert/strict';
import { join } from 'node:path';
import test from 'node:test';
import { McpManager } from '../../src/runtime/mcp-client.js';
import type { ResolvedConnector } from '../../src/shared/extensions.js';
// @ts-expect-error The executable fixture stays JavaScript so the same file can run as a child process.
import * as fixtureModule from '../fixtures/mcp-fixture.mjs';

interface HttpFixture {
    url: string;
    requests: Array<{ method: string; url: string; authorization?: string }>;
    listCursors: Array<string | undefined>;
    methods: string[];
    errors: string[];
    close(): Promise<void>;
}

const { startHttpFixture, startRedirectFixture } = fixtureModule as unknown as {
    startHttpFixture(options?: Record<string, unknown>): Promise<HttpFixture>;
    startRedirectFixture(targetUrl: string): Promise<{
        url: string;
        requests: Array<{ method: string; authorization?: string }>;
        close(): Promise<void>;
    }>;
};

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'mcp-fixture.mjs');

function connector(overrides: Partial<ResolvedConnector> = {}): ResolvedConnector {
    return {
        id: 'fixture-connector', name: 'Local fixture', transport: 'http', command: '', args: [], url: '',
        enabled: true, revision: 1, hasSecrets: false, secrets: {}, ...overrides,
    };
}

function echoTool() {
    return {
        name: 'echo', description: 'Echo input.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false },
    };
}

test('MCP stdio transport performs the SDK handshake, lists tools, and calls through node.exe directly', async () => {
    const config = connector({
        transport: 'stdio', command: process.execPath,
        args: [fixturePath, 'stdio', JSON.stringify({ tools: [echoTool()] })],
        secrets: { MCP_FIXTURE_TOKEN: 'stdio-token' }, hasSecrets: true,
    });
    const manager = new McpManager(async () => [config]);
    try {
        await manager.refresh();
        const [definition] = manager.definitions();
        assert.ok(definition, JSON.stringify(manager.describe()));
        assert.match(definition.name, /^mcp_[A-Za-z0-9_-]+$/);
        assert.ok(definition.name.length <= 64);
        assert.deepEqual(definition.parameters, echoTool().inputSchema);
        assert.equal(manager.isTool(definition.name), true);
        assert.deepEqual(manager.secrets(), ['stdio-token']);
        let beforeDispatch = 0;
        const result = await manager.call(definition.name, { value: 'hello' }, new AbortController().signal, () => { beforeDispatch++; });
        assert.match(result.content, /hello/);
        assert.equal(result.isError, undefined);
        assert.equal(result.dispatched, true);
        assert.equal(beforeDispatch, 1);
        assert.deepEqual(manager.describe().map((item) => [item.state, item.tools]), [['connected', 1]]);
    } finally {
        await manager.close();
    }
});

test('HTTP transport maps secret headers, filters complete results, marks unsupported content, and bounds output', async () => {
    const secret = 'http-fixture-private-token';
    const fixture = await startHttpFixture({
        tools: [echoTool()],
        callTool: async (_name: string, args: Record<string, unknown>) => ({
            content: [
                { type: 'text', text: `value=${String(args.value)} token=${secret}` },
                { type: 'image', data: 'AA==', mimeType: 'image/png' },
                { type: 'resource', resource: { uri: 'file:///private', text: secret } },
            ],
            structuredContent: { token: secret, padding: 'x'.repeat(160 * 1024) },
        }),
    });
    const config = connector({ url: fixture.url, secrets: { authorization: `Bearer ${secret}` }, hasSecrets: true });
    const manager = new McpManager(async () => [config]);
    try {
        await manager.refresh();
        const definition = manager.definitions()[0];
        assert.ok(definition, JSON.stringify({ describe: manager.describe(), requests: fixture.requests, methods: fixture.methods, cursors: fixture.listCursors, errors: fixture.errors }));
        const result = await manager.call(definition.name, { value: 'http-ok' }, new AbortController().signal);
        assert.ok(fixture.requests.some((request) => request.method === 'POST' && request.authorization === `Bearer ${secret}`));
        assert.doesNotMatch(result.content, /http-fixture-private-token/);
        assert.match(result.content, /Unsupported image content omitted/);
        assert.match(result.content, /Unsupported resource content omitted/);
        assert.match(result.content, /Result truncated/);
        assert.ok(Buffer.byteLength(result.content, 'utf8') <= 128 * 1024);
        assert.equal(result.isError, undefined);
        assert.equal(result.dispatched, true);
        assert.equal(manager.describe()[0]?.name.includes(secret), false);
    } finally {
        await manager.close();
        await fixture.close();
    }
});

test('MCP tool error results and JSON-RPC server errors stay marked and do not expose credentials', async () => {
    const secret = 'server-error-secret';
    const fixture = await startHttpFixture({
        tools: [echoTool()],
        callError: `raw MCP server failure containing ${secret}`,
    });
    const config = connector({ url: fixture.url, secrets: { authorization: secret } });
    const manager = new McpManager(async () => [config]);
    try {
        await manager.refresh();
        const definition = manager.definitions()[0];
        assert.ok(definition, JSON.stringify({ describe: manager.describe(), requests: fixture.requests, errors: fixture.errors }));
        const result = await manager.call(definition.name, { value: 'x' }, new AbortController().signal);
        assert.equal(result.isError, true);
        assert.equal(result.dispatched, true);
        assert.doesNotMatch(result.content, /server-error-secret/);
        assert.doesNotMatch(JSON.stringify(manager.describe()), /server-error-secret/);
    } finally {
        await manager.close();
        await fixture.close();
    }

    const resultFixture = await startHttpFixture({
        tools: [echoTool()],
        callTool: async () => ({ isError: true, content: [{ type: 'text', text: `tool failure ${secret}` }] }),
    });
    const resultManager = new McpManager(async () => [connector({ url: resultFixture.url, secrets: { authorization: secret } })]);
    try {
        await resultManager.refresh();
        const definition = resultManager.definitions()[0];
        assert.ok(definition, JSON.stringify({ describe: resultManager.describe(), requests: resultFixture.requests, errors: resultFixture.errors }));
        const result = await resultManager.call(definition.name, { value: 'x' }, new AbortController().signal);
        assert.equal(result.isError, true);
        assert.equal(result.dispatched, true);
        assert.doesNotMatch(result.content, /server-error-secret/);
    } finally {
        await resultManager.close();
        await resultFixture.close();
    }
});

test('an in-flight response is scrubbed with credentials discovered by a concurrent refresh', async () => {
    const newlyConfiguredSecret = 'new-connector-response-secret';
    let releaseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { releaseResponse = resolve; });
    let signalCallStarted!: () => void;
    const callStarted = new Promise<void>((resolve) => { signalCallStarted = resolve; });
    const firstFixture = await startHttpFixture({
        tools: [echoTool()],
        onCall() { signalCallStarted(); },
        async callTool() {
            await responseGate;
            return { content: [{ type: 'text', text: `response contained ${newlyConfiguredSecret}` }] };
        },
    });
    const secondFixture = await startHttpFixture({ tools: [echoTool()] });
    const firstConfig = connector({ id: 'first', name: 'First', url: firstFixture.url, secrets: { authorization: 'first-connector-secret' } });
    const secondConfig = connector({ id: 'second', name: 'Second', url: secondFixture.url, secrets: { authorization: newlyConfiguredSecret } });
    let configs = [firstConfig];
    const manager = new McpManager(async () => configs);
    try {
        await manager.refresh();
        const definition = manager.definitions()[0];
        assert.ok(definition);
        const pendingCall = manager.call(definition.name, { value: 'wait' }, new AbortController().signal);
        await callStarted;
        configs = [firstConfig, secondConfig];
        await manager.refresh();
        releaseResponse();
        const result = await pendingCall;
        assert.equal(result.dispatched, true);
        assert.doesNotMatch(result.content, new RegExp(newlyConfiguredSecret));
        assert.match(result.content, /\[REDACTED\]/);
    } finally {
        releaseResponse();
        await manager.close();
        await firstFixture.close();
        await secondFixture.close();
    }
});

test('pagination is bounded to ten pages and two hundred tools, and SDK protocol validation rejects bad list messages', async () => {
    const tools = Array.from({ length: 200 }, (_, index) => ({ ...echoTool(), name: `tool_${index}` }));
    const fixture = await startHttpFixture({ tools, pageSize: 25 });
    const manager = new McpManager(async () => [connector({ url: fixture.url })]);
    try {
        await manager.refresh();
        assert.equal(manager.definitions().length, 200);
        assert.equal(fixture.listCursors.length, 8);
    } finally {
        await manager.close();
        await fixture.close();
    }

    const tooManyTools = await startHttpFixture({ tools: Array.from({ length: 201 }, (_, index) => ({ ...echoTool(), name: `tool_${index}` })), pageSize: 100 });
    const limitedManager = new McpManager(async () => [connector({ url: tooManyTools.url })]);
    try {
        await limitedManager.refresh();
        assert.deepEqual(limitedManager.definitions(), []);
        assert.equal(limitedManager.describe()[0]?.state, 'error');
        assert.equal(limitedManager.describe()[0]?.tools, 0);
    } finally {
        await limitedManager.close();
        await tooManyTools.close();
    }

    const badFixture = await startHttpFixture({ badListResponse: true });
    const badManager = new McpManager(async () => [connector({ url: badFixture.url })]);
    try {
        await badManager.refresh();
        assert.deepEqual(badManager.definitions(), []);
        assert.equal(badManager.describe()[0]?.state, 'error');
    } finally {
        await badManager.close();
        await badFixture.close();
    }
});

test('cancellation affects one call, while revision changes and disablement revoke stale tools before dispatch', async () => {
    let config = connector();
    let calls = 0;
    const controller = new AbortController();
    let cancelFirstCall = true;
    const fixture = await startHttpFixture({
        tools: [echoTool()], pageSize: 1, callDelayMs: 80,
        onCall() {
            calls++;
            if (cancelFirstCall) {
                cancelFirstCall = false;
                controller.abort();
            }
        },
    });
    config = connector({ url: fixture.url });
    const manager = new McpManager(async () => [config]);
    try {
        await manager.refresh();
        const definition = manager.definitions()[0];
        assert.ok(definition);

        const cancelled = await manager.call(definition.name, { value: 'cancel' }, controller.signal);
        assert.equal(cancelled.isError, true);
        assert.equal(cancelled.dispatched, true);
        assert.match(cancelled.content, /cancelled/i);

        await new Promise((resolve) => setTimeout(resolve, 100));
        const successful = await manager.call(definition.name, { value: 'still-open' }, new AbortController().signal);
        assert.match(successful.content, /still-open/);
        assert.equal(successful.dispatched, true);

        const callsBeforeRevision = calls;
        config = { ...config, revision: config.revision + 1 };
        const revoked = await manager.call(definition.name, { value: 'revoked' }, new AbortController().signal);
        assert.equal(revoked.isError, true);
        assert.equal(revoked.dispatched, false);
        assert.equal(calls, callsBeforeRevision);

        await manager.refresh();
        assert.equal(manager.describe()[0]?.state, 'connected');
        const callsBeforeDisable = calls;
        config = { ...config, enabled: false };
        const disabled = await manager.call(definition.name, { value: 'disabled' }, new AbortController().signal);
        assert.equal(disabled.isError, true);
        assert.equal(disabled.dispatched, false);
        assert.equal(calls, callsBeforeDisable);
        await manager.refresh();
        assert.deepEqual(manager.definitions(), []);
        assert.equal(manager.describe()[0]?.state, 'error');
    } finally {
        await manager.close();
        await fixture.close();
    }
});

test('HTTP authorization is not forwarded across redirects', async () => {
    const destination = await startHttpFixture({ tools: [echoTool()] });
    const redirect = await startRedirectFixture(destination.url);
    const secret = 'redirect-only-secret';
    const manager = new McpManager(async () => [connector({ url: redirect.url, secrets: { authorization: `Bearer ${secret}` } })]);
    try {
        await manager.refresh();
        assert.deepEqual(manager.definitions(), []);
        assert.equal(manager.describe()[0]?.state, 'error');
        assert.ok(redirect.requests.length > 0);
        assert.deepEqual(destination.requests, []);
        assert.doesNotMatch(JSON.stringify(manager.describe()), /redirect-only-secret/);
    } finally {
        await manager.close();
        await redirect.close();
        await destination.close();
    }
});

test('connector tests do not enable disabled services and close prevents later refreshes', async () => {
    const fixture = await startHttpFixture({ tools: [echoTool()] });
    let config: ResolvedConnector = connector({ url: fixture.url, enabled: false });
    const manager = new McpManager(async () => [config]);
    try {
        const disabled = await manager.test(config.id);
        assert.equal(disabled.state, 'error');
        assert.equal(disabled.tools, 0);
        assert.deepEqual(fixture.requests, []);
        await manager.close();
        config = { ...config, enabled: true, revision: config.revision + 1 };
        await manager.refresh();
        assert.deepEqual(manager.definitions(), []);
        const closedTest = await manager.test(config.id);
        assert.equal(closedTest.state, 'error');
    } finally {
        await manager.close();
        await fixture.close();
    }
});

test('schema and size preflight failures do not invoke the durable dispatch callback', async () => {
    const fixture = await startHttpFixture({ tools: [echoTool()] });
    const manager = new McpManager(async () => [connector({ url: fixture.url })]);
    try {
        await manager.refresh();
        const definition = manager.definitions()[0];
        assert.ok(definition);
        let beforeDispatch = 0;
        const mismatch = await manager.call(definition.name, {}, new AbortController().signal, () => { beforeDispatch++; });
        assert.equal(mismatch.isError, true);
        assert.equal(mismatch.dispatched, false);
        const oversized = await manager.call(definition.name, { value: 'x'.repeat(128 * 1024) }, new AbortController().signal, () => { beforeDispatch++; });
        assert.equal(oversized.isError, true);
        assert.match(oversized.content, /128 KiB/);
        assert.equal(oversized.dispatched, false);
        assert.equal(beforeDispatch, 0);
        assert.equal(fixture.methods.includes('tools/call'), false);

        await assert.rejects(
            manager.call(definition.name, { value: 'valid' }, new AbortController().signal, () => { throw new Error('journal unavailable'); }),
            /journal unavailable/,
        );
        assert.equal(fixture.methods.includes('tools/call'), false);
    } finally {
        await manager.close();
        await fixture.close();
    }
});

test('tool schema and global publication limits are visible and publish at most two hundred tools', async () => {
    const firstTools = Array.from({ length: 150 }, (_, index) => ({ ...echoTool(), name: `first_${index}` }));
    firstTools[0] = { ...firstTools[0]!, description: 'x'.repeat(2_001) };
    const secondTools = Array.from({ length: 150 }, (_, index) => ({ ...echoTool(), name: `second_${index}` }));
    const first = await startHttpFixture({ tools: firstTools, pageSize: 100 });
    const second = await startHttpFixture({ tools: secondTools, pageSize: 100 });
    const manager = new McpManager(async () => [
        connector({ id: 'first', name: 'First', url: first.url }),
        connector({ id: 'second', name: 'Second', url: second.url }),
    ]);
    try {
        await manager.refresh();
        assert.equal(manager.definitions().length, 200);
        assert.equal(manager.describe().reduce((sum, service) => sum + service.tools, 0), 200);
        assert.match(manager.describe().find((service) => service.id === 'first')?.error ?? '', /description \(2,000 character\) limit/);
        assert.match(manager.describe().find((service) => service.id === 'second')?.error ?? '', /global MCP tool publication limit \(200\)/);
    } finally {
        await manager.close();
        await first.close();
        await second.close();
    }

    const oversizedSchema = {
        name: 'oversized', description: 'valid',
        inputSchema: { type: 'object', properties: { large: { type: 'string', description: 'x'.repeat(33 * 1024) } } },
    };
    const schemaFixture = await startHttpFixture({ tools: [oversizedSchema] });
    const schemaManager = new McpManager(async () => [connector({ url: schemaFixture.url })]);
    try {
        await schemaManager.refresh();
        assert.deepEqual(schemaManager.definitions(), []);
        assert.match(schemaManager.describe()[0]?.error ?? '', /schema \(32 KiB\)/);
    } finally {
        await schemaManager.close();
        await schemaFixture.close();
    }
});

test('list pagination stops after ten pages even when the server keeps returning cursors', async () => {
    const fixture = await startHttpFixture({ tools: Array.from({ length: 11 }, (_, index) => ({ ...echoTool(), name: `page_${index}` })), pageSize: 1 });
    const manager = new McpManager(async () => [connector({ url: fixture.url })]);
    try {
        await manager.refresh();
        assert.deepEqual(manager.definitions(), []);
        assert.equal(fixture.listCursors.length, 10);
        assert.match(manager.describe()[0]?.error ?? '', /listing limit/);
    } finally {
        await manager.close();
        await fixture.close();
    }
});

test('Windows batch launchers are rejected with the node.exe setup guidance', { skip: process.platform !== 'win32' }, async () => {
    const config = connector({ transport: 'stdio', command: 'C:\\fixture\\server.cmd', args: [] });
    const manager = new McpManager(async () => [config]);
    try {
        await manager.refresh();
        assert.deepEqual(manager.definitions(), []);
        assert.match(manager.describe()[0]?.error ?? '', /node\.exe/);
    } finally {
        await manager.close();
    }
});
