import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

function makeServer(options = {}) {
    const server = new Server({ name: 'uah-mcp-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.onerror = (error) => options.onError?.(error);
    const tools = options.tools ?? [{
        name: 'echo',
        description: 'Return the supplied value.',
        inputSchema: { type: 'object', properties: { value: { type: 'string' } }, additionalProperties: false },
    }];
    server.setRequestHandler(ListToolsRequestSchema, async (request) => {
        const cursor = request.params?.cursor;
        options.onList?.(cursor);
        if (options.badListResponse) return { tools: [{ name: 42, inputSchema: { type: 'object' } }] };
        const pageSize = (options.pageSize ?? tools.length) || 1;
        const offset = cursor === undefined ? 0 : Number(cursor);
        const page = tools.slice(offset, offset + pageSize);
        const nextCursor = offset + page.length < tools.length ? String(offset + page.length) : undefined;
        return { tools: page, ...(nextCursor ? { nextCursor } : {}) };
    });
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = request.params.arguments ?? {};
        options.onCall?.(name, args);
        if (options.callDelayMs) await new Promise((resolve) => setTimeout(resolve, options.callDelayMs));
        if (options.callError) throw new Error(options.callError);
        if (options.callTool) return await options.callTool(name, args);
        return { content: [{ type: 'text', text: JSON.stringify({ name, args }) }] };
    });
    return server;
}

export async function startHttpFixture(options = {}) {
    const requests = [];
    const listCursors = [];
    const methods = [];
    const errors = [];
    const sessions = new Map();
    const allTransports = new Set();
    const httpServer = createHttpServer((request, response) => {
        const record = {
            method: request.method, url: request.url, authorization: request.headers.authorization,
            contentType: request.headers['content-type'], accept: request.headers.accept,
            protocolVersion: request.headers['mcp-protocol-version'], sessionId: request.headers['mcp-session-id'],
        };
        requests.push(record);
        void (async () => {
            const requestedSessionId = request.headers['mcp-session-id'];
            let transport = typeof requestedSessionId === 'string' ? sessions.get(requestedSessionId) : undefined;
            if (!transport) {
                const priorOnList = options.onList;
                const server = makeServer({
                    ...options,
                    onError(error) {
                        errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
                        options.onError?.(error);
                    },
                    onList(cursor) {
                        listCursors.push(cursor);
                        priorOnList?.(cursor);
                    },
                });
                transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true });
                allTransports.add(transport);
                await server.connect(transport);
                const onMessage = transport.onmessage;
                transport.onmessage = (message, extra) => {
                    if ('method' in message) methods.push(message.method);
                    onMessage?.(message, extra);
                };
            }
            await transport.handleRequest(request, response);
            if (transport.sessionId) sessions.set(transport.sessionId, transport);
        })().catch((error) => {
            errors.push(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
            response.destroy();
        });
    });
    await new Promise((resolve, reject) => {
        httpServer.once('error', reject);
        httpServer.listen(0, '127.0.0.1', resolve);
    });
    const address = httpServer.address();
    if (!address || typeof address === 'string') throw new Error('Fixture did not receive a TCP address.');
    return {
        url: `http://127.0.0.1:${address.port}/mcp`,
        requests,
        listCursors,
        methods,
        errors,
        async close() {
            await Promise.all([...allTransports].map((transport) => transport.close()));
            httpServer.closeAllConnections();
            if (httpServer.listening) {
                const closed = once(httpServer, 'close');
                httpServer.close();
                await closed;
            }
        },
    };
}

export async function startRedirectFixture(targetUrl) {
    const requests = [];
    const server = createHttpServer((request, response) => {
        requests.push({ method: request.method, authorization: request.headers.authorization });
        response.writeHead(302, { location: targetUrl });
        response.end();
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Redirect fixture did not receive a TCP address.');
    return {
        url: `http://127.0.0.1:${address.port}/redirect`,
        requests,
        async close() {
            server.closeAllConnections();
            if (server.listening) {
                const closed = once(server, 'close');
                server.close();
                await closed;
            }
        },
    };
}

async function runStdioFixture(options) {
    const server = makeServer(options);
    await server.connect(new StdioServerTransport());
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [mode, encodedOptions] = process.argv.slice(2);
    if (mode === 'stdio') {
        let options = {};
        try { if (encodedOptions) options = JSON.parse(encodedOptions); } catch { process.exitCode = 2; }
        if (process.exitCode !== 2) void runStdioFixture(options).catch(() => { process.exitCode = 3; });
    }
}
