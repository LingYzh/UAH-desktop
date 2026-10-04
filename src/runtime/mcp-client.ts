import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';
import type { JsonSchemaType } from '@modelcontextprotocol/sdk/validation';
import type { ToolDefinition } from '../shared/tool-protocol.js';
import type { ResolvedConnector } from '../shared/extensions.js';

const MAX_CONNECTIONS = 64;
const MAX_TOOLS = 200;
const MAX_TOOL_PAGES = 10;
const MAX_SCHEMA_BYTES = 32 * 1024;
const MAX_DESCRIPTION_CHARS = 2_000;
const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;
const MAX_RESULT_BYTES = 128 * 1024;
const MAX_REDACTION_SECRETS = 8_192;
const MAX_REDACTION_SECRET_BYTES = 16 * 1024 * 1024;
const RESULT_TRUNCATION = '\n[Result truncated at 128 KiB; MCP output range reads are not currently supported.]';
const TOOL_LIMIT_ERROR = 'The MCP server exceeded the tool listing limit.';
const LIST_ERROR = 'Failed to list MCP tools.';
const CONNECT_ERROR = 'Failed to connect to the MCP service.';
const DISABLED_ERROR = 'The MCP service is disabled.';
const CLOSED_ERROR = 'The MCP manager is closed.';
const COMMAND_ERROR = 'Windows batch launchers are unsupported; configure node.exe with the script path as an argument.';
const argumentSchemaValidator = new AjvJsonSchemaValidator();

type McpTool = {
    name: string;
    description?: string;
    inputSchema: Record<string, unknown>;
};

type McpClient = Client;
type McpTransport = StdioClientTransport | StreamableHTTPClientTransport;

interface ConnectorSession {
    config: ResolvedConnector;
    connectionRevision?: number;
    client?: McpClient;
    transport?: McpTransport;
    connecting?: boolean;
    state: 'connected' | 'error';
    tools: McpTool[];
    error?: string;
}

interface PublishedTool {
    connectorId: string;
    revision: number;
    remoteName: string;
    inputSchema: Record<string, unknown>;
}

interface OpenedSession {
    client: McpClient;
    transport: McpTransport;
    tools: McpTool[];
}

interface RefreshDeadline {
    signal: AbortSignal;
    timeout: (remainingMs: number) => number;
    dispose: () => void;
}

class McpConnectionFailure extends Error {
    constructor(message: string, readonly client?: McpClient, readonly transport?: McpTransport) {
        super(message);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeString(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function hash(value: string, length = 12): string {
    return createHash('sha256').update(value).digest('hex').slice(0, length);
}

function sanitizeToolPart(value: string): string {
    const normalized = value.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/^[_-]+|[_-]+$/g, '');
    return normalized.slice(0, 8) || 'x';
}

function redactText(value: string, secrets: readonly string[]): string {
    let result = value;
    for (const secret of secrets) {
        if (secret) result = result.replaceAll(secret, '[REDACTED]');
    }
    return result;
}

function redactValue(value: unknown, secrets: readonly string[]): unknown {
    if (typeof value === 'string') return redactText(value, secrets);
    if (Array.isArray(value)) return value.map((item) => redactValue(item, secrets));
    if (!isRecord(value)) return value;
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
        result[redactText(key, secrets)] = redactValue(entry, secrets);
    }
    return result;
}

function uniqueSecrets(connectors: readonly ResolvedConnector[]): string[] {
    return [...new Set(connectors.flatMap((connector) => Object.values(connector.secrets)))]
        .filter((secret) => secret.length > 0)
        .sort((left, right) => right.length - left.length);
}

function redactionVariants(values: Iterable<string>): string[] {
    const candidates = new Set<string>();
    for (const value of values) {
        if (!value) continue;
        candidates.add(value);
        const scheme = /^(?:bearer|basic|token|apikey)\s+(.+)$/i.exec(value);
        if (scheme?.[1]) candidates.add(scheme[1]);
    }
    return [...candidates].sort((left, right) => right.length - left.length);
}

function connectorToolName(connectorId: string, remoteName: string, secrets: readonly string[]): string {
    const safeId = redactText(connectorId, secrets);
    const safeRemoteName = redactText(remoteName, secrets);
    return `mcp_${sanitizeToolPart(safeId)}_${hash(safeId)}_${sanitizeToolPart(safeRemoteName)}_${hash(safeRemoteName)}`;
}

function ensureUniqueToolName(base: string, used: Set<string>): string {
    if (!used.has(base)) {
        used.add(base);
        return base;
    }
    for (let suffix = 2; ; suffix++) {
        const tail = `_${suffix}`;
        const candidate = `${base.slice(0, 64 - tail.length)}${tail}`;
        if (!used.has(candidate)) {
            used.add(candidate);
            return candidate;
        }
    }
}

function makeDeadline(): RefreshDeadline {
    const controller = new AbortController();
    const startedAt = Date.now();
    const timer = setTimeout(() => controller.abort(new Error('MCP connection timed out.')), CONNECT_TIMEOUT_MS);
    timer.unref?.();
    return {
        signal: controller.signal,
        timeout(remainingMs: number) {
            const remaining = CONNECT_TIMEOUT_MS - (Date.now() - startedAt);
            if (controller.signal.aborted || remaining <= 0) throw new Error('MCP connection timed out.');
            return Math.max(1, Math.min(remainingMs, remaining));
        },
        dispose() { clearTimeout(timer); },
    };
}

function makeTransport(config: ResolvedConnector): McpTransport {
    if (config.transport === 'stdio') {
        if (process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(config.command.trim())) {
            throw new Error(COMMAND_ERROR);
        }
        const environment: Record<string, string> = {};
        for (const [name, value] of Object.entries(config.secrets)) environment[name] = value;
        const transport = new StdioClientTransport({
            command: config.command,
            args: [...config.args],
            env: environment,
            stderr: 'pipe',
        });
        // Drain server stderr so a noisy process cannot block its stdio transport.
        transport.stderr?.on('data', () => undefined);
        transport.stderr?.on('error', () => undefined);
        return transport;
    }

    let url: URL;
    try {
        url = new URL(config.url);
    } catch {
        throw new Error('The MCP HTTP endpoint is invalid.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        throw new Error('The MCP HTTP endpoint is invalid.');
    }
    const fetchWithoutRedirects: typeof fetch = (input, init) => fetch(input, { ...init, redirect: 'error' });
    const transport = new StreamableHTTPClientTransport(url, {
        requestInit: { headers: config.secrets, redirect: 'error' },
        fetch: fetchWithoutRedirects,
        redirectPolicy: 'same-origin',
        reconnectionOptions: {
            initialReconnectionDelay: 250,
            maxReconnectionDelay: 500,
            reconnectionDelayGrowFactor: 1,
            maxRetries: 1,
        },
    });
    return transport;
}

async function listTools(client: McpClient, deadline: RefreshDeadline): Promise<McpTool[]> {
    const tools: McpTool[] = [];
    const names = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_TOOL_PAGES; page++) {
        const response = await client.listTools(cursor === undefined ? undefined : { cursor }, {
            signal: deadline.signal,
            timeout: deadline.timeout(CONNECT_TIMEOUT_MS),
            maxTotalTimeout: deadline.timeout(CONNECT_TIMEOUT_MS),
        });
        if (response.tools.length > MAX_TOOLS - tools.length) throw new Error(TOOL_LIMIT_ERROR);
        for (const tool of response.tools) {
            if (names.has(tool.name)) throw new Error('The MCP server returned duplicate tool names.');
            names.add(tool.name);
            tools.push(tool);
        }
        if (response.nextCursor === undefined) return tools;
        if (!response.nextCursor || cursors.has(response.nextCursor)) throw new Error('The MCP server returned invalid pagination.');
        cursors.add(response.nextCursor);
        cursor = response.nextCursor;
    }
    throw new Error(TOOL_LIMIT_ERROR);
}

async function closeClient(client: McpClient | undefined): Promise<void> {
    if (client) await client.close();
}

function resultBytes(text: string): number {
    return Buffer.byteLength(text, 'utf8');
}

function boundedResult(text: string): string {
    if (resultBytes(text) <= MAX_RESULT_BYTES) return text;
    const suffixBytes = resultBytes(RESULT_TRUNCATION);
    let prefix = Buffer.from(text, 'utf8').subarray(0, MAX_RESULT_BYTES - suffixBytes).toString('utf8');
    if (prefix.endsWith('\uFFFD')) prefix = prefix.slice(0, -1);
    return `${prefix}${RESULT_TRUNCATION}`;
}

function renderToolResult(value: unknown, secrets: readonly string[]): string {
    const result = isRecord(value) ? value : {};
    const segments: string[] = [];
    const contentItems = Array.isArray(result.content) ? result.content : [];
    for (const entry of contentItems) {
        if (!isRecord(entry) || typeof entry.type !== 'string') {
            segments.push('[Unsupported MCP content omitted.]');
            continue;
        }
        const item = entry;
        if (item.type === 'text') segments.push(typeof item.text === 'string' ? item.text : '[Invalid MCP text content omitted.]');
        else if (item.type === 'image') segments.push(`[Unsupported image content omitted${typeof item.mimeType === 'string' ? ` (${item.mimeType})` : ''}.]`);
        else if (item.type === 'audio' || item.type === 'resource') segments.push(`[Unsupported ${item.type} content omitted.]`);
        else if (item.type === 'resource_link') segments.push(`[Unsupported resource link omitted${typeof item.uri === 'string' ? ` (${item.uri})` : ''}.]`);
        else segments.push('[Unsupported MCP content omitted.]');
    }
    if (result.structuredContent !== undefined) {
        try { segments.push(`Structured content:\n${JSON.stringify(result.structuredContent)}`); }
        catch { segments.push('[Structured content could not be serialized.]'); }
    }
    if (segments.length === 0) segments.push('[MCP tool returned no content.]');
    return boundedResult(redactText(segments.join('\n\n'), secrets));
}

function safeToolDefinition(
    tool: McpTool,
    connectorId: string,
    revision: number,
    secrets: readonly string[],
    usedNames: Set<string>,
): { definition: ToolDefinition; published: PublishedTool } | undefined {
    const description = redactText(safeString(tool.description), secrets);
    if ([...description].length > MAX_DESCRIPTION_CHARS || !isRecord(tool.inputSchema)) return undefined;
    let schemaJson: string;
    try { schemaJson = JSON.stringify(tool.inputSchema); }
    catch { return undefined; }
    if (Buffer.byteLength(schemaJson, 'utf8') > MAX_SCHEMA_BYTES) return undefined;

    const parameters = redactValue(tool.inputSchema, secrets);
    if (!isRecord(parameters) || parameters.type !== 'object') return undefined;
    let safeSchemaJson: string;
    try { safeSchemaJson = JSON.stringify(parameters); }
    catch { return undefined; }
    if (Buffer.byteLength(safeSchemaJson, 'utf8') > MAX_SCHEMA_BYTES) return undefined;
    try { argumentSchemaValidator.getValidator(parameters as JsonSchemaType); }
    catch { return undefined; }

    const generated = ensureUniqueToolName(connectorToolName(connectorId, tool.name, secrets), usedNames);
    return {
        definition: {
            name: generated,
            description: description || `MCP tool ${generated}`,
            parameters,
        },
        published: { connectorId, revision, remoteName: tool.name, inputSchema: parameters },
    };
}

/** Owns official-SDK MCP clients and only publishes tools from enabled, current connector revisions. */
export class McpManager {
    private readonly sessions = new Map<string, ConnectorSession>();
    private readonly publishedTools = new Map<string, PublishedTool>();
    private toolDefinitions: ToolDefinition[] = [];
    private readonly publishedToolCounts = new Map<string, number>();
    private currentSecrets: string[] = [];
    private readonly knownSecrets = new Set<string>();
    private knownSecretBytes = 0;
    private redactionOverflow = false;
    private refreshPromise?: Promise<void>;
    private closePromise?: Promise<void>;
    private closed = false;

    constructor(private readonly resolve: () => Promise<ResolvedConnector[]>) {}

    async refresh(): Promise<void> {
        if (this.closed) return;
        if (this.refreshPromise) return this.refreshPromise;
        const refreshPromise = this.refreshInternal();
        this.refreshPromise = refreshPromise;
        try {
            await refreshPromise;
        } finally {
            if (this.refreshPromise === refreshPromise) this.refreshPromise = undefined;
        }
    }

    private async refreshInternal(): Promise<void> {
        let connectors: ResolvedConnector[];
        try {
            connectors = await this.resolve();
        } catch {
            this.disableAllTools('Connector settings could not be loaded.');
            return;
        }
        this.currentSecrets = uniqueSecrets(connectors);
        this.rememberSecrets(this.currentSecrets);
        if (this.closed) return;

        const current = new Map<string, ResolvedConnector>();
        for (const connector of connectors) {
            if (!current.has(connector.id)) current.set(connector.id, connector);
        }

        for (const [id, session] of [...this.sessions]) {
            const config = current.get(id);
            const unchanged = config?.enabled && config.revision === session.config.revision
                && (session.connectionRevision === undefined || session.connectionRevision === config.revision);
            if (unchanged) continue;
            this.removePublishedTools(id);
            session.tools = [];
            session.state = 'error';
            session.error = config?.enabled ? 'The connector changed; reconnecting.' : DISABLED_ERROR;
            try {
                await closeClient(session.client);
                session.client = undefined;
                session.transport = undefined;
                if (!config) this.sessions.delete(id);
                else {
                    session.config = config;
                    session.connectionRevision = undefined;
                }
            } catch {
                // Keep ownership of a transport whose SDK close did not finish; never open a replacement beside it.
                if (config) session.config = config;
                session.error = 'The previous MCP connection could not be closed.';
            }
        }
        this.rebuildDefinitions();
        if (this.closed) return;

        const enabled = [...current.values()].filter((connector) => connector.enabled).sort((left, right) => left.id.localeCompare(right.id));
        for (const connector of current.values()) {
            if (!connector.enabled) {
                const session = this.sessions.get(connector.id);
                if (session?.client) {
                    session.config = connector;
                    session.tools = [];
                    session.state = 'error';
                    session.error ??= DISABLED_ERROR;
                } else {
                    this.sessions.set(connector.id, { config: connector, state: 'error', tools: [], error: DISABLED_ERROR });
                }
            }
        }
        const eligible = enabled.slice(0, MAX_CONNECTIONS);
        for (const connector of enabled.slice(MAX_CONNECTIONS)) {
            const previous = this.sessions.get(connector.id);
            this.removePublishedTools(connector.id);
            if (previous?.client) {
                previous.tools = [];
                previous.state = 'error';
                previous.error = 'The MCP connection limit has been reached.';
                try {
                    await closeClient(previous.client);
                    previous.client = undefined;
                    previous.transport = undefined;
                    previous.connectionRevision = undefined;
                    previous.config = connector;
                } catch {
                    previous.error = 'The previous MCP connection could not be closed.';
                }
            } else {
                this.sessions.set(connector.id, {
                    config: connector, state: 'error', tools: [], error: 'The MCP connection limit has been reached.',
                });
            }
        }

        let next = 0;
        const workers = Array.from({ length: Math.min(8, eligible.length) }, async () => {
            while (next < eligible.length && !this.closed) {
                const connector = eligible[next++];
                if (!connector) return;
                await this.refreshConnector(connector);
            }
        });
        await Promise.all(workers);
        this.rebuildDefinitions();
    }

    private async refreshConnector(config: ResolvedConnector): Promise<void> {
        const existing = this.sessions.get(config.id);
        if (existing?.client && existing.connectionRevision !== config.revision) {
            try {
                await closeClient(existing.client);
                existing.client = undefined;
                existing.transport = undefined;
                existing.connectionRevision = undefined;
            } catch {
                existing.config = config;
                existing.tools = [];
                existing.state = 'error';
                existing.error = 'The previous MCP connection could not be closed.';
                return;
            }
        }
        if (existing?.client) {
            const deadline = makeDeadline();
            try {
                const tools = await listTools(existing.client, deadline);
                if (this.closed) return;
                existing.config = config;
                existing.tools = tools;
                existing.state = 'connected';
                existing.error = undefined;
                return;
            } catch (error) {
                existing.tools = [];
                existing.state = 'error';
                existing.error = error instanceof Error && error.message === TOOL_LIMIT_ERROR ? TOOL_LIMIT_ERROR : LIST_ERROR;
                this.removePublishedTools(config.id);
                try {
                    await closeClient(existing.client);
                    existing.client = undefined;
                    existing.transport = undefined;
                } catch {
                    existing.error = 'The MCP connection could not be closed after a listing failure.';
                }
            } finally {
                deadline.dispose();
            }
            if (this.closed) return;
        }

        if (this.closed) return;
        const liveConnections = [...this.sessions.values()].filter((session) => session.client !== undefined || session.connecting).length;
        if (liveConnections >= MAX_CONNECTIONS) {
            this.sessions.set(config.id, { config, state: 'error', tools: [], error: 'The MCP connection limit has been reached.' });
            return;
        }
        this.sessions.set(config.id, { config, state: 'error', tools: [], error: CONNECT_ERROR, connecting: true });
        try {
            const opened = await this.openAndList(config);
            if (this.closed) {
                try {
                    await closeClient(opened.client);
                    this.sessions.delete(config.id);
                } catch {
                    this.sessions.set(config.id, {
                        config, client: opened.client, transport: opened.transport,
                        connectionRevision: config.revision, state: 'error', tools: [],
                        error: 'The MCP connection could not be closed.',
                    });
                }
                return;
            }
            this.sessions.set(config.id, {
                config, client: opened.client, transport: opened.transport,
                connectionRevision: config.revision,
                state: 'connected', tools: opened.tools,
            });
        } catch (error) {
            const failure = error instanceof McpConnectionFailure ? error : undefined;
            const safeError = error instanceof Error && [COMMAND_ERROR, TOOL_LIMIT_ERROR, LIST_ERROR, CONNECT_ERROR].includes(error.message)
                ? error.message
                : CONNECT_ERROR;
            if (!this.closed || failure?.client) this.sessions.set(config.id, {
                config, state: 'error', tools: [], error: safeError,
                ...(failure?.client ? { client: failure.client, transport: failure.transport, connectionRevision: config.revision } : {}),
            });
        }
    }

    private async openAndList(config: ResolvedConnector): Promise<OpenedSession> {
        const transport = makeTransport(config);
        const client = new Client({ name: 'UAH', version: '0.1.0' }, { capabilities: {} });
        // SDK transport errors can contain URLs or server-provided strings, so consume without logging.
        client.onerror = () => undefined;
        const deadline = makeDeadline();
        let connected = false;
        try {
            await client.connect(transport, {
                signal: deadline.signal,
                timeout: deadline.timeout(CONNECT_TIMEOUT_MS),
                maxTotalTimeout: deadline.timeout(CONNECT_TIMEOUT_MS),
            });
            connected = true;
            let tools: McpTool[];
            try {
                tools = await listTools(client, deadline);
            } catch (error) {
                if (error instanceof Error && error.message === TOOL_LIMIT_ERROR) throw error;
                throw new Error(LIST_ERROR, { cause: error });
            }
            return { client, transport, tools };
        } catch (error) {
            try { await closeClient(client); } catch {
                throw new McpConnectionFailure(CONNECT_ERROR, client, transport);
            }
            if (error instanceof Error && error.message === TOOL_LIMIT_ERROR) throw error;
            if (error instanceof Error && error.message === COMMAND_ERROR) throw error;
            if (error instanceof Error && error.message === LIST_ERROR) throw error;
            throw new Error(connected ? LIST_ERROR : CONNECT_ERROR, { cause: error });
        } finally {
            deadline.dispose();
        }
    }

    private disableAllTools(error: string): void {
        for (const session of this.sessions.values()) {
            session.tools = [];
            session.state = 'error';
            session.error = error;
        }
        this.publishedTools.clear();
        this.toolDefinitions = [];
    }

    private rememberSecrets(values: Iterable<string>): void {
        for (const secret of values) {
            if (!secret || this.knownSecrets.has(secret)) continue;
            const bytes = Buffer.byteLength(secret, 'utf8');
            if (this.knownSecrets.size >= MAX_REDACTION_SECRETS || this.knownSecretBytes + bytes > MAX_REDACTION_SECRET_BYTES) {
                this.redactionOverflow = true;
                continue;
            }
            this.knownSecrets.add(secret);
            this.knownSecretBytes += bytes;
        }
    }

    private redactionSecrets(extra: Iterable<string> = []): string[] {
        return redactionVariants([...this.knownSecrets, ...extra]);
    }

    private removePublishedTools(connectorId: string): void {
        for (const [name, published] of this.publishedTools) {
            if (published.connectorId === connectorId) this.publishedTools.delete(name);
        }
    }

    private rebuildDefinitions(): void {
        this.publishedTools.clear();
        this.publishedToolCounts.clear();
        const usedNames = new Set<string>();
        const definitions: ToolDefinition[] = [];
        if (this.redactionOverflow) {
            this.toolDefinitions = [];
            for (const session of this.sessions.values()) {
                if (session.state === 'connected') {
                    session.error = 'MCP secret redaction capacity was reached; tool publication is disabled.';
                }
            }
            return;
        }
        const sessions = [...this.sessions.values()].filter((session) => session.state === 'connected' && session.config.enabled)
            .sort((left, right) => left.config.id.localeCompare(right.config.id));
        for (const session of sessions) {
            const tools = [...session.tools].sort((left, right) => left.name.localeCompare(right.name));
            let publishedCount = 0;
            let schemaLimited = false;
            let globalLimited = false;
            for (const tool of tools) {
                if (definitions.length >= MAX_TOOLS) {
                    globalLimited = true;
                    break;
                }
                const safe = safeToolDefinition(tool, session.config.id, session.config.revision, this.redactionSecrets(this.currentSecrets), usedNames);
                if (!safe) {
                    schemaLimited = true;
                    continue;
                }
                definitions.push(safe.definition);
                this.publishedTools.set(safe.definition.name, safe.published);
                publishedCount++;
            }
            this.publishedToolCounts.set(session.config.id, publishedCount);
            const diagnostics = [
                ...(schemaLimited ? ['One or more MCP tools exceeded the schema (32 KiB) or description (2,000 character) limit, or had an invalid schema.'] : []),
                ...(globalLimited ? ['The global MCP tool publication limit (200) was reached; some tools are unavailable.'] : []),
            ];
            session.error = diagnostics.length > 0 ? diagnostics.join(' ') : undefined;
        }
        this.toolDefinitions = definitions;
    }

    definitions(): ToolDefinition[] {
        return this.toolDefinitions.map((definition) => structuredClone(definition));
    }

    describe(): Array<{ id: string; name: string; state: 'connected' | 'error'; tools: number; error?: string }> {
        return [...this.sessions.values()].map((session) => ({
            id: redactText(session.config.id, this.currentSecrets),
            name: redactText(session.config.name, this.currentSecrets),
            state: session.state,
            tools: session.state === 'connected' ? (this.publishedToolCounts.get(session.config.id) ?? 0) : 0,
            ...(session.error ? { error: redactText(session.error, this.currentSecrets) } : {}),
        }));
    }

    isTool(name: string): boolean {
        return this.publishedTools.has(name);
    }

    async call(
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal,
        beforeDispatch?: () => void,
    ): Promise<{ content: string; isError?: boolean; dispatched: boolean }> {
        const published = this.publishedTools.get(name);
        if (!published) return { content: 'The MCP tool is unavailable.', isError: true, dispatched: false };
        if (this.closed) return { content: CLOSED_ERROR, isError: true, dispatched: false };
        if (this.redactionOverflow) return { content: 'MCP secret redaction capacity was reached; tool dispatch is disabled.', isError: true, dispatched: false };

        let connectors: ResolvedConnector[];
        try {
            connectors = await this.resolve();
            this.currentSecrets = uniqueSecrets(connectors);
            this.rememberSecrets(this.currentSecrets);
        } catch {
            return { content: 'Connector settings could not be loaded.', isError: true, dispatched: false };
        }
        if (this.closed) return { content: CLOSED_ERROR, isError: true, dispatched: false };
        if (this.redactionOverflow) {
            return { content: 'MCP secret redaction capacity was reached; tool dispatch is disabled.', isError: true, dispatched: false };
        }
        const config = connectors.find((connector) => connector.id === published.connectorId);
        const session = this.sessions.get(published.connectorId);
        if (!config?.enabled || config.revision !== published.revision || !session || session.config.revision !== published.revision
            || session.connectionRevision !== published.revision || session.state !== 'connected' || !session.client
            || !session.tools.some((tool) => tool.name === published.remoteName)) {
            return { content: 'The MCP tool is no longer available.', isError: true, dispatched: false };
        }
        const remoteTool = session.tools.find((tool) => tool.name === published.remoteName);
        if (!remoteTool) return { content: 'The MCP tool is no longer available.', isError: true, dispatched: false };
        if (signal.aborted) return { content: 'The MCP tool call was cancelled.', isError: true, dispatched: false };

        let safeArgs: Record<string, unknown>;
        try {
            const serializedArgs = JSON.stringify(args);
            if (serializedArgs === undefined || Buffer.byteLength(serializedArgs, 'utf8') > MAX_RESULT_BYTES) {
                return { content: 'MCP tool arguments exceed the 128 KiB limit.', isError: true, dispatched: false };
            }
            const clone = JSON.parse(serializedArgs) as unknown;
            if (!isRecord(clone)) return { content: 'MCP tool arguments must be an object.', isError: true, dispatched: false };
            safeArgs = clone;
        } catch {
            return { content: 'MCP tool arguments are invalid.', isError: true, dispatched: false };
        }

        try {
            const validator = argumentSchemaValidator.getValidator(published.inputSchema as JsonSchemaType);
            if (!validator(safeArgs).valid) return { content: 'MCP tool arguments do not match the advertised input schema.', isError: true, dispatched: false };
        } catch {
            return { content: 'The advertised MCP tool schema is invalid.', isError: true, dispatched: false };
        }
        if (signal.aborted) return { content: 'The MCP tool call was cancelled.', isError: true, dispatched: false };
        const callSecrets = this.redactionSecrets([
            ...Object.values(config.secrets), ...Object.values(session.config.secrets), ...this.currentSecrets,
        ]);
        beforeDispatch?.();

        try {
            const result = await session.client.callTool({ name: published.remoteName, arguments: safeArgs }, undefined, {
                signal,
                timeout: CALL_TIMEOUT_MS,
                maxTotalTimeout: CALL_TIMEOUT_MS,
            });
            const content = renderToolResult(result, this.redactionSecrets(callSecrets));
            return isRecord(result) && result.isError === true
                ? { content, isError: true, dispatched: true }
                : { content, dispatched: true };
        } catch {
            return signal.aborted
                ? { content: 'The MCP tool call was cancelled.', isError: true, dispatched: true }
                : { content: 'MCP tool call failed.', isError: true, dispatched: true };
        }
    }

    async test(id: string): Promise<{ id: string; name: string; state: 'connected' | 'error'; tools: number; error?: string }> {
        if (this.closed) return { id, name: id, state: 'error', tools: 0, error: CLOSED_ERROR };
        await this.refresh();
        const session = this.sessions.get(id);
        if (!session) return { id, name: id, state: 'error', tools: 0, error: 'The MCP service was not found.' };
        if (!session.config.enabled) {
            return { id, name: redactText(session.config.name, this.currentSecrets), state: 'error', tools: 0, error: DISABLED_ERROR };
        }
        return {
            id: redactText(session.config.id, this.currentSecrets),
            name: redactText(session.config.name, this.currentSecrets),
            state: session.state,
            tools: session.state === 'connected' ? (this.publishedToolCounts.get(session.config.id) ?? 0) : 0,
            ...(session.error ? { error: redactText(session.error, this.currentSecrets) } : {}),
        };
    }

    secrets(): string[] {
        return [...this.currentSecrets];
    }

    async close(): Promise<void> {
        if (this.closePromise) return this.closePromise;
        this.closed = true;
        this.publishedTools.clear();
        this.toolDefinitions = [];
        this.closePromise = this.closeInternal();
        return this.closePromise;
    }

    private async closeInternal(): Promise<void> {
        const refresh = this.refreshPromise;
        if (refresh) await refresh.catch(() => undefined);
        const sessions = [...this.sessions.values()];
        this.sessions.clear();
        const errors: unknown[] = [];
        for (const session of sessions) {
            try { await closeClient(session.client); }
            catch (error) { errors.push(error); }
        }
        if (errors.length > 0) throw new Error(`Failed to close ${errors.length} MCP connection(s).`);
    }
}
