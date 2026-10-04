import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type {
    ApprovalRecord,
    ArtifactSnapshot,
    RunRecord,
    RuntimeEvent,
    SessionRecord,
    Snapshot,
} from '../shared/contracts.js';
import type { RequestContextDetail } from '../shared/request-context';
import type { ArtifactReference, JsonValue, TranscriptEvent } from '../shared/harness-contracts';
import type { WorkspaceOverview } from '../shared/snapshot-view';
import type { ContextEntry, ContextSurface, ContextUpdate } from './context/contracts';
import { sessionHasFileChanges } from '../shared/run-effects';
import { eraseSessionRows } from './session-purge-data';

export const RUNTIME_SCHEMA_VERSION = 4;
const SCHEMA_VERSION = RUNTIME_SCHEMA_VERSION;
const MAX_SESSIONS = 5_000;
const DEFAULT_MAX_RUNS = 100_000;
const DEFAULT_MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024;

export interface RuntimeStoreOptions {
    maxRuns?: number;
    maxDatabaseBytes?: number;
}

export interface RunPageCursor {
    createdAt: string;
    id: string;
}

export interface RunPageOptions {
    sessionId?: string;
    before?: RunPageCursor;
    limit?: number;
}

export interface HistoryCapacity {
    count: number;
    maxRuns: number;
    databaseBytes: number;
    maxDatabaseBytes: number;
}

function validateOptions(value: unknown, keys: readonly string[], name: string): asserts value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key)
            || !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'))) {
        throw new Error(`Invalid ${name} options`);
    }
}

function positiveInteger(value: unknown, name: string): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
        throw new Error(`Invalid ${name}: expected a positive safe integer`);
    }
    return value;
}

export interface StoreCommit {
    contexts?: RequestContextDetail[];
    clearContextSessions?: string[];
    sessions?: SessionRecord[];
    runs?: RunRecord[];
    approvals?: ApprovalRecord[];
    artifacts?: ArtifactSnapshot[];
    events?: RuntimeEvent[];
    journal?: TranscriptEvent[];
    contextUpdates?: ContextUpdate[];
}

function serialize(value: unknown): string {
    return JSON.stringify(value);
}

function parseRow<T>(json: string, table: string): T {
    try {
        return JSON.parse(json) as T;
    } catch (error) {
        throw new Error(`Cannot read persisted ${table} record`, { cause: error });
    }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function safeText(value: unknown, name: string, maximum = 4096): string {
    if (typeof value !== 'string' || value.length > maximum || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
        throw new Error(`Invalid ${name}`);
    }
    return value;
}

function safeString(value: unknown, name: string, maximum = 4096): string {
    const text = safeText(value, name, maximum);
    if (!text) throw new Error(`Invalid ${name}`);
    return text;
}

function assertJsonValue(value: unknown, name: string, depth = 0, seen = new Set<object>()): asserts value is JsonValue {
    if (depth > 32) throw new Error(`Invalid ${name}: JSON nesting is too deep`);
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) throw new Error(`Invalid ${name}: JSON numbers must be finite`);
        return;
    }
    if (typeof value !== 'object' || seen.has(value)) throw new Error(`Invalid ${name}: expected JSON value`);
    seen.add(value);
    if (Array.isArray(value)) {
        for (const item of value) assertJsonValue(item, name, depth + 1, seen);
    } else if (isPlainObject(value)) {
        for (const key of Reflect.ownKeys(value)) {
            if (typeof key !== 'string') throw new Error(`Invalid ${name}: JSON object keys must be strings`);
            safeString(key, `${name} key`, 1024);
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`Invalid ${name}: accessors are not allowed`);
            assertJsonValue(descriptor.value, name, depth + 1, seen);
        }
    } else {
        throw new Error(`Invalid ${name}: expected JSON value`);
    }
    seen.delete(value);
}

function canonicalJson(value: JsonValue): string {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
    if (typeof value === 'number') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(item => canonicalJson(item)).join(',')}]`;
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function validateArtifactReference(value: unknown, name: string): asserts value is ArtifactReference {
    if (!isPlainObject(value)) throw new Error(`Invalid ${name}`);
    const availability = value.availability;
    safeString(value.mediaType, `${name}.mediaType`, 256);
    if (availability === 'present') {
        requireKeys(value, ['mediaType', 'availability', 'relativePath', 'sha256', 'byteLength', 'missingReason'], name);
        const relativePath = safeString(value.relativePath, `${name}.relativePath`, 4096);
        if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
            throw new Error(`Invalid ${name}.relativePath`);
        }
        if (typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256)) throw new Error(`Invalid ${name}.sha256`);
        if (typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0) throw new Error(`Invalid ${name}.byteLength`);
        if (value.missingReason !== null) throw new Error(`Invalid ${name}.missingReason`);
    } else if (availability === 'missing') {
        requireKeys(value, ['mediaType', 'availability', 'relativePath', 'sha256', 'byteLength', 'missingReason'], name);
        const relativePath = safeString(value.relativePath, `${name}.relativePath`, 4096);
        if (/^(?:[A-Za-z]:[\\/]|[\\/])/.test(relativePath) || relativePath.split(/[\\/]/).includes('..')) {
            throw new Error(`Invalid ${name}.relativePath`);
        }
        if (value.sha256 !== null && (typeof value.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(value.sha256))) throw new Error(`Invalid ${name}.sha256`);
        if (value.byteLength !== null && (typeof value.byteLength !== 'number' || !Number.isSafeInteger(value.byteLength) || value.byteLength < 0)) throw new Error(`Invalid ${name}.byteLength`);
        safeString(value.missingReason, `${name}.missingReason`, 4096);
    } else if (availability === 'external_reference_only') {
        requireKeys(value, ['mediaType', 'availability', 'relativePath', 'sha256', 'byteLength', 'externalReference', 'missingReason'], name);
        if (value.relativePath !== null || value.sha256 !== null || value.byteLength !== null) throw new Error(`Invalid ${name}`);
        safeString(value.externalReference, `${name}.externalReference`, 4096);
        safeString(value.missingReason, `${name}.missingReason`, 4096);
    } else {
        throw new Error(`Invalid ${name}.availability`);
    }
}

function requireKeys(value: Record<string, unknown>, keys: readonly string[], name: string, optionalKeys: readonly string[] = []): void {
    const allowed = new Set([...keys, ...optionalKeys]);
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowed.has(key)) throw new Error(`Invalid ${name} field: ${String(key)}`);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error(`Invalid ${name}.${key}: accessors are not allowed`);
    }
    for (const key of keys) if (!Object.hasOwn(value, key)) throw new Error(`Invalid ${name}.${key}`);
}

function validateContextEntry(value: unknown, name = 'context entry'): asserts value is ContextEntry {
    if (!isPlainObject(value)) throw new Error(`Invalid ${name}`);
    requireKeys(value, ['id', 'sessionId', 'ownerId', 'kind', 'content', 'sourceRunId'], name);
    safeString(value.id, `${name}.id`, 200);
    safeString(value.sessionId, `${name}.sessionId`, 200);
    safeString(value.ownerId, `${name}.ownerId`, 200);
    safeString(value.sourceRunId, `${name}.sourceRunId`, 200);
    if (!['message', 'runtime_snapshot', 'summary'].includes(value.kind as string)) throw new Error(`Invalid ${name}.kind`);
    validateArtifactReference(value.content, `${name}.content`);
}

function validateContextSurface(value: unknown, name = 'context surface'): asserts value is ContextSurface {
    if (!isPlainObject(value)) throw new Error(`Invalid ${name}`);
    const requiredKeys = ['schemaVersion', 'sessionId', 'ownerId', 'revision', 'epoch', 'routeKey', 'entryIds', 'snapshotHashes', 'instructionHash', 'toolManifestHash', 'sourceFingerprint', 'lastRunId', 'coverage'] as const;
    requireKeys(value, requiredKeys, name, ['metadata']);
    if (value.schemaVersion !== 2) throw new Error(`Invalid ${name}.schemaVersion`);
    safeString(value.sessionId, `${name}.sessionId`, 200);
    safeString(value.ownerId, `${name}.ownerId`, 200);
    if (typeof value.revision !== 'number' || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error(`Invalid ${name}.revision`);
    if (typeof value.epoch !== 'number' || !Number.isSafeInteger(value.epoch) || value.epoch < 0) throw new Error(`Invalid ${name}.epoch`);
    safeString(value.routeKey, `${name}.routeKey`);
    if (!Array.isArray(value.entryIds) || value.entryIds.some(id => typeof id !== 'string' || !id || id.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(id))) throw new Error(`Invalid ${name}.entryIds`);
    if (new Set(value.entryIds).size !== value.entryIds.length) throw new Error(`Invalid ${name}.entryIds: duplicate entry`);
    if (!isPlainObject(value.snapshotHashes) || Object.entries(value.snapshotHashes).some(([key, hash]) => {
        try { safeString(key, `${name}.snapshotHashes key`, 1024); safeString(hash, `${name}.snapshotHashes value`, 4096); return false; } catch { return true; }
    })) throw new Error(`Invalid ${name}.snapshotHashes`);
    safeText(value.instructionHash, `${name}.instructionHash`);
    safeText(value.toolManifestHash, `${name}.toolManifestHash`);
    safeString(value.sourceFingerprint, `${name}.sourceFingerprint`);
    safeString(value.lastRunId, `${name}.lastRunId`, 200);
    if (value.coverage !== 'complete' && value.coverage !== 'partial') throw new Error(`Invalid ${name}.coverage`);
    if (Object.hasOwn(value, 'metadata')) {
        if (value.metadata === undefined) throw new Error(`Invalid ${name}.metadata`);
        assertJsonValue(value.metadata, `${name}.metadata`);
    }
}

function validateContextUpdate(value: unknown, name = 'context update'): asserts value is ContextUpdate {
    if (!isPlainObject(value)) throw new Error(`Invalid ${name}`);
    requireKeys(value, ['expectedRevision', 'surface', 'entries'], name);
    if (value.expectedRevision !== null && (typeof value.expectedRevision !== 'number' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1)) {
        throw new Error(`Invalid ${name}.expectedRevision`);
    }
    validateContextSurface(value.surface, `${name}.surface`);
    if (!Array.isArray(value.entries)) throw new Error(`Invalid ${name}.entries`);
    for (let index = 0; index < value.entries.length; index++) validateContextEntry(value.entries[index], `${name}.entries[${index}]`);
    for (const entry of value.entries) {
        if (entry.sessionId !== value.surface.sessionId || entry.ownerId !== value.surface.ownerId) throw new Error('Context entry scope does not match surface owner');
    }
}

interface ContextEntryRow {
    id: string;
    session_id: string;
    owner_id: string;
    kind: string;
    content: string;
    source_run_id: string;
}

interface ContextSurfaceRow {
    schema_version: number;
    session_id: string;
    owner_id: string;
    revision: number;
    epoch: number;
    route_key: string;
    entry_ids: string;
    snapshot_hashes: string;
    instruction_hash: string;
    tool_manifest_hash: string;
    source_fingerprint: string;
    last_run_id: string;
    coverage: string;
    metadata: string | null;
}

function entryFromRow(row: ContextEntryRow): ContextEntry {
    return {
        id: row.id,
        sessionId: row.session_id,
        ownerId: row.owner_id,
        kind: row.kind as ContextEntry['kind'],
        content: parseRow<ArtifactReference>(row.content, 'context_entries'),
        sourceRunId: row.source_run_id,
    };
}

function surfaceFromRow(row: ContextSurfaceRow): ContextSurface {
    let entryIds: unknown;
    let snapshotHashes: unknown;
    try {
        entryIds = JSON.parse(row.entry_ids);
        snapshotHashes = JSON.parse(row.snapshot_hashes);
    } catch (error) {
        throw new Error('Cannot read persisted context_surfaces record', { cause: error });
    }
    const surface: ContextSurface = {
        schemaVersion: Number(row.schema_version) as 2,
        sessionId: row.session_id,
        ownerId: row.owner_id,
        revision: Number(row.revision),
        epoch: Number(row.epoch),
        routeKey: row.route_key,
        entryIds: entryIds as string[],
        snapshotHashes: snapshotHashes as Record<string, string>,
        instructionHash: row.instruction_hash,
        toolManifestHash: row.tool_manifest_hash,
        sourceFingerprint: row.source_fingerprint,
        lastRunId: row.last_run_id,
        coverage: row.coverage as ContextSurface['coverage'],
    };
    if (row.metadata !== null) surface.metadata = parseRow<JsonValue>(row.metadata, 'context_surfaces');
    return surface;
}

function contextEntryEqual(left: ContextEntry, right: ContextEntry): boolean {
    return left.id === right.id
        && left.sessionId === right.sessionId
        && left.ownerId === right.ownerId
        && left.kind === right.kind
        && left.sourceRunId === right.sourceRunId
        && canonicalJson(left.content as unknown as JsonValue) === canonicalJson(right.content as unknown as JsonValue);
}

export class RuntimeStore {
    private readonly database: DatabaseSync;
    private readonly maxRuns: number;
    private readonly maxDatabaseBytes: number;
    private closed = false;

    constructor(dataDirectory: string, options: RuntimeStoreOptions = {}) {
        validateOptions(options, ['maxRuns', 'maxDatabaseBytes'], 'runtime store');
        this.maxRuns = options.maxRuns === undefined ? DEFAULT_MAX_RUNS : positiveInteger(options.maxRuns, 'maxRuns');
        this.maxDatabaseBytes = options.maxDatabaseBytes === undefined ? DEFAULT_MAX_DATABASE_BYTES : positiveInteger(options.maxDatabaseBytes, 'maxDatabaseBytes');
        const directory = resolve(dataDirectory);
        mkdirSync(directory, { recursive: true });
        this.database = new DatabaseSync(resolve(directory, 'runtime.sqlite'));
        try {
            // Refuse newer databases before any connection configuration can persist changes.
            this.assertSupportedSchema();
            this.database.exec('PRAGMA foreign_keys = ON;');
            this.database.exec('PRAGMA journal_mode = WAL;');
            this.database.exec('PRAGMA synchronous = FULL;');
            this.initializeSchema();
        } catch (error) {
            this.database.close();
            throw error;
        }
    }

    assertCanCreateSession(): void {
        this.assertOpen();
        const row = this.database.prepare('SELECT COUNT(*) AS count FROM sessions').get() as {
            count: number;
        };
        if (Number(row.count) >= MAX_SESSIONS) {
            throw new Error(`Session history limit reached (${MAX_SESSIONS})`);
        }
    }

    assertCanCreateRun(): void {
        const capacity = this.historyCapacity();
        if (capacity.count >= capacity.maxRuns) {
            throw new Error(`Run history capacity quota reached (${capacity.maxRuns} runs); existing history was preserved`);
        }
        if (capacity.databaseBytes >= capacity.maxDatabaseBytes) {
            throw new Error(`Database capacity quota reached (${capacity.maxDatabaseBytes} bytes); existing history was preserved`);
        }
    }

    /** Logical SQLite allocation, including pages visible through WAL; excludes WAL/SHM file overhead. */
    historyCapacity(): HistoryCapacity {
        this.assertOpen();
        const row = this.database.prepare('SELECT COUNT(*) AS count FROM runs').get() as { count: number };
        const pages = this.database.prepare('PRAGMA page_count').get() as { page_count: number };
        const size = this.database.prepare('PRAGMA page_size').get() as { page_size: number };
        return { count: Number(row.count), maxRuns: this.maxRuns,
            databaseBytes: Number(pages.page_count) * Number(size.page_size), maxDatabaseBytes: this.maxDatabaseBytes };
    }

    readRunPage(options: RunPageOptions = {}): { runs: RunRecord[]; nextCursor: RunPageCursor | null } {
        this.assertOpen();
        validateOptions(options, ['sessionId', 'before', 'limit'], 'run page');
        if (options.sessionId !== undefined && (typeof options.sessionId !== 'string' || !options.sessionId)) {
            throw new Error('Invalid run page sessionId');
        }
        const limit = options.limit === undefined ? 50 : positiveInteger(options.limit, 'run page limit');
        if (limit > 200) throw new Error('Invalid run page limit: maximum is 200');
        const clauses: string[] = [];
        const parameters: Array<string | number> = [];
        if (options.sessionId !== undefined) {
            clauses.push('session_id = ?');
            parameters.push(options.sessionId);
        }
        if (options.before !== undefined) {
            validateOptions(options.before, ['createdAt', 'id'], 'run page cursor');
            if (typeof options.before.createdAt !== 'string' || !options.before.createdAt
                || typeof options.before.id !== 'string' || !options.before.id) {
                throw new Error('Invalid run page cursor');
            }
            clauses.push('(created_at, id) < (?, ?)');
            parameters.push(options.before.createdAt, options.before.id);
        }
        parameters.push(limit + 1);
        const rows = this.database.prepare(`SELECT id, created_at, data FROM runs
            ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
            ORDER BY created_at DESC, id DESC LIMIT ?`).all(...parameters) as Array<{ id: string; created_at: string; data: string }>;
        const page = rows.slice(0, limit);
        const last = page.at(-1);
        return { runs: page.map((row) => parseRow<RunRecord>(row.data, 'runs')),
            nextCursor: rows.length > limit && last ? { createdAt: last.created_at, id: last.id } : null };
    }

    /** Point lookup; callers retain current in-memory execution state separately. */
    readRun(runId: string): RunRecord | undefined {
        this.assertOpen();
        if (typeof runId !== 'string' || !runId || runId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(runId)) throw new Error('Invalid run identity');
        const row = this.database.prepare('SELECT data FROM runs WHERE id = ?').get(runId) as { data: string } | undefined;
        return row ? parseRow<RunRecord>(row.data, 'runs') : undefined;
    }

    readSessionRuns(sessionId: string): RunRecord[] {
        this.assertOpen();
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(sessionId)) throw new Error('Invalid session identity');
        const rows = this.database.prepare('SELECT data FROM runs WHERE session_id = ? ORDER BY rowid ASC').all(sessionId) as Array<{ data: string }>;
        return rows.map(row => parseRow<RunRecord>(row.data, 'runs'));
    }

    /** Read the current active surface for one independent owner lineage. */
    readContextSurface(sessionId: string, ownerId: string): ContextSurface | undefined {
        this.assertOpen();
        safeString(sessionId, 'context sessionId', 200);
        safeString(ownerId, 'context ownerId', 200);
        const row = this.database.prepare(`SELECT schema_version, session_id, owner_id, revision, epoch, route_key,
                entry_ids, snapshot_hashes, instruction_hash, tool_manifest_hash, source_fingerprint,
                last_run_id, coverage, metadata
            FROM context_surfaces WHERE session_id = ? AND owner_id = ?`).get(sessionId, ownerId) as ContextSurfaceRow | undefined;
        if (!row) return undefined;
        const surface = surfaceFromRow(row);
        validateContextSurface(surface);
        if (surface.entryIds.length) this.readContextEntries(sessionId, ownerId, surface.entryIds);
        return surface;
    }

    /**
     * Read entries in caller order. A missing ID and an ID belonging to another
     * session/owner are both errors so callers cannot accidentally widen scope.
     */
    readContextEntries(sessionId: string, ownerId: string, ids: readonly string[]): ContextEntry[] {
        this.assertOpen();
        safeString(sessionId, 'context sessionId', 200);
        safeString(ownerId, 'context ownerId', 200);
        if (!Array.isArray(ids)) throw new Error('Invalid context entry IDs');
        for (const id of ids) safeString(id, 'context entry ID', 200);
        if (!ids.length) return [];
        const placeholders = ids.map(() => '?').join(', ');
        const rows = this.database.prepare(`SELECT id, session_id, owner_id, kind, content, source_run_id
            FROM context_entries WHERE id IN (${placeholders})`).all(...ids) as unknown as ContextEntryRow[];
        const byId = new Map<string, ContextEntry>();
        for (const row of rows) {
            const entry = entryFromRow(row);
            validateContextEntry(entry);
            byId.set(entry.id, entry);
        }
        return ids.map(id => {
            const entry = byId.get(id);
            if (!entry || entry.sessionId !== sessionId || entry.ownerId !== ownerId) {
                throw new Error(`Context entry is missing or belongs to a different owner: ${id}`);
            }
            return entry;
        });
    }

    /** Session-scoped history projection; does not verify artifact hashes or event manifests. */
    readSessionSnapshot(sessionId: string, verifyArtifacts = false): Snapshot {
        this.assertOpen();
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(sessionId)) {
            throw new Error('Invalid session snapshot sessionId');
        }
        const read = <T>(sql: string, table: string, ...parameters: string[]): T[] => {
            const rows = this.database.prepare(sql).all(...parameters) as Array<{ data: string }>;
            return rows.map(row => parseRow<T>(row.data, table));
        };
        const snapshot: Snapshot = {
            sessions: read<SessionRecord>('SELECT data FROM sessions WHERE id = ? ORDER BY rowid ASC', 'sessions', sessionId),
            runs: read<RunRecord>('SELECT data FROM runs WHERE session_id = ? ORDER BY rowid ASC', 'runs', sessionId),
            approvals: read<ApprovalRecord>('SELECT data FROM approvals WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?) ORDER BY rowid ASC', 'approvals', sessionId),
            artifacts: read<ArtifactSnapshot>('SELECT data FROM artifacts WHERE session_id = ? AND run_id IN (SELECT id FROM runs WHERE session_id = ?) ORDER BY rowid ASC', 'artifacts', sessionId, sessionId),
        };
        if (!verifyArtifacts) return snapshot;
        const rows = this.database.prepare("SELECT data FROM events WHERE session_id = ? AND type = 'artifact-created' ORDER BY id ASC").all(sessionId) as Array<{ data: string }>;
        return this.verifyArtifactSnapshot(snapshot, rows.map(row => parseRow<RuntimeEvent>(row.data, 'events')));
    }

    /** Chat tail plus dependency closure; history/model queries remain full-session. */
    readSessionWindow(sessionId: string, limit: number, verifyArtifacts = false): Snapshot & { historyWindow: { total: number; limit: number; rootIds: string[]; hasFileChanges: boolean } } {
        this.assertOpen();
        if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 200 || /[\u0000-\u001f\u007f-\u009f]/.test(sessionId)) throw new Error('Invalid session window sessionId');
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100_000) throw new Error('Invalid session window limit');
        if (typeof verifyArtifacts !== 'boolean') throw new Error('Invalid session window verifyArtifacts');
        const identities = `WITH RECURSIVE
            scoped AS MATERIALIZED (
                SELECT rowid AS ordinal, id, state, json_extract(data, '$.parentRunId') AS parent,
                    json_extract(data, '$.retryOfRunId') AS retry,
                    json_extract(data, '$.plan.executionRunId') AS execution,
                    json_extract(data, '$.requestContext') IS NOT NULL AS has_context
                FROM runs WHERE session_id = ?1
            ), visible AS MATERIALIZED (
                SELECT * FROM scoped root WHERE parent IS NULL
                    AND NOT EXISTS (SELECT 1 FROM scoped retry WHERE retry.parent IS NULL AND retry.retry = root.id)
            ), tail AS MATERIALIZED (SELECT id, ordinal FROM visible ORDER BY ordinal DESC LIMIT ?2)`;
        const info = this.database.prepare(`${identities}
            SELECT (SELECT COUNT(*) FROM visible) AS total,
                (SELECT json_group_array(id) FROM (SELECT id FROM tail ORDER BY ordinal ASC)) AS roots`).get(sessionId, limit) as { total: number; roots: string };
        const rootIds = JSON.parse(info.roots) as string[];
        const rows = this.database.prepare(`${identities}, seeds(id) AS (
                SELECT id FROM tail UNION SELECT id FROM scoped WHERE state NOT IN ('completed', 'failed', 'stopped')
                UNION SELECT id FROM (SELECT id FROM scoped WHERE parent IS NULL ORDER BY ordinal ASC LIMIT 1)
                UNION SELECT id FROM (SELECT id FROM scoped WHERE parent IS NULL AND has_context ORDER BY ordinal DESC LIMIT 1)
                UNION SELECT scoped.id FROM scoped JOIN sessions ON sessions.id = ?1
                    AND scoped.id = json_extract(sessions.data, '$.activePlanRunId')
            ), edges(source, target) AS MATERIALIZED (
                SELECT parent, id FROM scoped WHERE parent IS NOT NULL
                UNION ALL SELECT id, parent FROM scoped WHERE parent IS NOT NULL
                UNION ALL SELECT id, retry FROM scoped WHERE retry IS NOT NULL
                UNION ALL SELECT execution, id FROM scoped WHERE execution IS NOT NULL
            ), selected(id) AS (
                SELECT id FROM seeds UNION
                SELECT related.id FROM selected JOIN edges ON edges.source = selected.id
                    JOIN scoped related ON related.id = edges.target
            ) SELECT runs.id, runs.data FROM runs JOIN selected ON selected.id = runs.id
                WHERE runs.session_id = ?1 ORDER BY runs.rowid ASC`).all(sessionId, limit) as Array<{ id: string; data: string }>;
        const runs = rows.map(row => parseRow<RunRecord>(row.data, 'runs'));
        const ids = JSON.stringify(rows.map(row => row.id));
        const sessionRows = this.database.prepare('SELECT data FROM sessions WHERE id = ?').all(sessionId) as Array<{ data: string }>;
        const approvalRows = this.database.prepare('SELECT data FROM approvals WHERE run_id IN (SELECT value FROM json_each(?)) ORDER BY rowid ASC').all(ids) as Array<{ data: string }>;
        const artifactRows = this.database.prepare('SELECT data FROM artifacts WHERE session_id = ? AND run_id IN (SELECT value FROM json_each(?)) ORDER BY rowid ASC').all(sessionId, ids) as Array<{ data: string }>;
        let hasFileChanges = !!this.database.prepare(`SELECT 1 FROM artifacts WHERE session_id = ?
            AND (json_type(data, '$.oldContent') IS NOT json_type(data, '$.newContent')
                OR json_extract(data, '$.oldContent') IS NOT json_extract(data, '$.newContent')) LIMIT 1`).get(sessionId);
        if (!hasFileChanges) {
            const activities = this.database.prepare(`SELECT activity.value AS data FROM runs,
                json_each(json_extract(runs.data, '$.activities')) activity WHERE runs.session_id = ?
                AND COALESCE(json_extract(activity.value, '$.tool.name'), json_extract(activity.value, '$.title'))
                    IN ('write_file', 'apply_patch', 'run_command')`).iterate(sessionId);
            for (const row of activities) {
                const activity = parseRow<NonNullable<RunRecord['activities']>[number]>(row.data as string, 'run activities');
                if (sessionHasFileChanges({ sessions: [], approvals: [], artifacts: [], runs: [{ sessionId, activities: [activity] } as RunRecord] }, sessionId)) { hasFileChanges = true; break; }
            }
        }
        const snapshot: Snapshot = { sessions: sessionRows.map(row => parseRow<SessionRecord>(row.data, 'sessions')), runs,
            approvals: approvalRows.map(row => parseRow<ApprovalRecord>(row.data, 'approvals')),
            artifacts: artifactRows.map(row => parseRow<ArtifactSnapshot>(row.data, 'artifacts')) };
        if (verifyArtifacts) {
            const manifests = this.database.prepare(`SELECT data FROM events WHERE session_id = ? AND type = 'artifact-created'
                AND run_id IN (SELECT value FROM json_each(?)) ORDER BY id ASC`).all(sessionId, ids) as Array<{ data: string }>;
            this.verifyArtifactSnapshot(snapshot, manifests.map(row => parseRow<RuntimeEvent>(row.data, 'events')));
        }
        return { ...snapshot, historyWindow: { total: Number(info.total), limit, rootIds, hasFileChanges } };
    }

    /** Small global status projection; run text, activities and Agent instructions stay in SQLite. */
    readOverview(): WorkspaceOverview {
        this.assertOpen();
        const states = (roots: boolean) => {
            const rows = this.database.prepare(`SELECT id, session_id, state FROM runs WHERE rowid IN
                (SELECT MAX(rowid) FROM runs ${roots ? "WHERE json_extract(data, '$.parentRunId') IS NULL" : ''} GROUP BY session_id)`)
                .all() as Array<{ id: string; session_id: string; state: RunRecord['state'] }>;
            return Object.fromEntries(rows.map(row => [row.session_id, { id: row.id, state: row.state }]));
        };
        const active = this.database.prepare("SELECT id FROM runs WHERE state NOT IN ('completed', 'failed', 'stopped') ORDER BY rowid ASC").all() as Array<{ id: string }>;
        return { rootStates: states(true), latestStates: states(false), activeRunIds: active.map(row => row.id) };
    }

    readSnapshot(options: { verifyArtifacts?: boolean } = {}): Snapshot {
        this.assertOpen();
        validateOptions(options, ['verifyArtifacts'], 'snapshot');
        if (options.verifyArtifacts !== undefined && typeof options.verifyArtifacts !== 'boolean') {
            throw new Error('Invalid snapshot verifyArtifacts');
        }
        const sessions = this.readRows<SessionRecord>('sessions');
        const runs = this.readRows<RunRecord>('runs');
        const approvals = this.readRows<ApprovalRecord>('approvals');
        const artifacts = this.readRows<ArtifactSnapshot>('artifacts');
        if (options.verifyArtifacts === false) return { sessions, runs, approvals, artifacts };
        const artifactEvents = this.database
            .prepare("SELECT data FROM events WHERE type = 'artifact-created' ORDER BY id ASC")
            .all() as Array<{ data: string }>;
        const manifests = artifactEvents.map((row) => parseRow<RuntimeEvent>(row.data, 'events'));
        return this.verifyArtifactSnapshot({ sessions, runs, approvals, artifacts }, manifests);
    }

    /** Startup projection: retain recovery candidates, stream every historical integrity check. */
    readRecoverySnapshot(uncertainRunIds: ReadonlySet<string>): Snapshot {
        this.assertOpen();
        const sessions = this.readRows<SessionRecord>('sessions');
        const approvals = this.readRows<ApprovalRecord>('approvals');
        const pendingRunIds = new Set(approvals.filter(approval => approval.status === 'pending').map(approval => approval.runId));
        const runs: RunRecord[] = [];
        // Parsing one record at a time also preserves readSnapshot's rejection of
        // malformed JSON in unrelated terminal history, without retaining its body.
        for (const row of this.database.prepare('SELECT data FROM runs ORDER BY rowid ASC').iterate()) {
            const run = parseRow<RunRecord>(row.data as string, 'runs');
            if (!['completed', 'failed', 'stopped'].includes(run.state) || pendingRunIds.has(run.id) || uncertainRunIds.has(run.id)) runs.push(run);
        }

        // Match the full snapshot verifier's JSON identity map (including its
        // last-record-wins behavior), but retain only identities and row locators.
        const artifactRows = new Map<string, string>();
        const artifactQuery = 'SELECT CAST(rowid AS TEXT) AS locator, data FROM artifacts ORDER BY rowid ASC';
        for (const row of this.database.prepare(artifactQuery).iterate()) {
            const artifact = parseRow<ArtifactSnapshot>(row.data as string, 'artifacts');
            artifactRows.set(artifact.id, row.locator as string);
        }
        const artifactByRow = this.database.prepare('SELECT data FROM artifacts WHERE rowid = ?');
        const expectedIds = new Set<string>();
        for (const row of this.database.prepare("SELECT data FROM events WHERE type = 'artifact-created' ORDER BY id ASC").iterate()) {
            const event = parseRow<RuntimeEvent>(row.data as string, 'events');
            if (event.type !== 'artifact-created') throw new Error('Artifact event history is malformed');
            const manifest = event.payload.artifact;
            expectedIds.add(manifest.id);
            const locator = artifactRows.get(manifest.id);
            const savedRow = locator === undefined ? undefined : artifactByRow.get(locator);
            if (!savedRow) throw new Error(`Artifact snapshot is missing: ${manifest.id}`);
            const saved = parseRow<ArtifactSnapshot>(savedRow.data as string, 'artifacts');
            // Every event is checked: duplicate IDs can carry contradictory evidence.
            if (saved.hash !== manifest.hash || saved.newContent !== manifest.newContent) throw new Error(`Artifact snapshot manifest mismatch: ${manifest.id}`);
        }
        for (const row of this.database.prepare(artifactQuery).iterate()) {
            const artifact = parseRow<ArtifactSnapshot>(row.data as string, 'artifacts');
            if (!expectedIds.has(artifact.id)) throw new Error(`Artifact snapshot has no event manifest: ${artifact.id}`);
            const actualHash = createHash('sha256').update(artifact.newContent, 'utf8').digest('hex');
            if (actualHash !== artifact.hash) throw new Error(`Artifact snapshot integrity check failed: ${artifact.id}`);
        }
        return { sessions, runs, approvals, artifacts: [] };
    }

    /** Legacy coverage identities only; empty sessions do not require a legacy marker. */
    readLegacyJournalSessionIds(): Set<string> {
        this.assertOpen();
        const invalid = this.database.prepare(`SELECT id FROM runs WHERE
            json_extract(data, '$.id') IS NOT id OR json_extract(data, '$.sessionId') IS NOT session_id LIMIT 1`).get();
        if (invalid) throw new Error('Invalid legacy run identity');
        const rows = this.database.prepare(`WITH accepted AS MATERIALIZED (
            SELECT DISTINCT session_id, json_extract(data, '$.run.runId') AS run_id FROM canonical_events
            WHERE json_extract(data, '$.type') = 'message.accepted'
        ) SELECT DISTINCT runs.session_id FROM runs JOIN sessions ON sessions.id = runs.session_id
            WHERE NOT EXISTS (SELECT 1 FROM accepted WHERE accepted.session_id = runs.session_id AND accepted.run_id = runs.id)`)
            .iterate();
        const sessions = new Set<string>();
        for (const row of rows) sessions.add(row.session_id as string);
        return sessions;
    }

    private verifyArtifactSnapshot(snapshot: Snapshot, manifests: RuntimeEvent[]): Snapshot {
        const { sessions, runs, approvals, artifacts } = snapshot;
        const snapshotsById = new Map(artifacts.map((artifact) => [artifact.id, artifact]));
        const expectedIds = new Set<string>();

        for (const event of manifests) {
            if (event.type !== 'artifact-created') {
                throw new Error('Artifact event history is malformed');
            }
            const manifest = event.payload.artifact;
            expectedIds.add(manifest.id);
            const saved = snapshotsById.get(manifest.id);
            if (!saved) {
                throw new Error(`Artifact snapshot is missing: ${manifest.id}`);
            }
            if (saved.hash !== manifest.hash || saved.newContent !== manifest.newContent) {
                throw new Error(`Artifact snapshot manifest mismatch: ${manifest.id}`);
            }
        }

        for (const artifact of artifacts) {
            if (!expectedIds.has(artifact.id)) {
                throw new Error(`Artifact snapshot has no event manifest: ${artifact.id}`);
            }
            const actualHash = createHash('sha256')
                .update(artifact.newContent, 'utf8')
                .digest('hex');
            if (actualHash !== artifact.hash) {
                throw new Error(`Artifact snapshot integrity check failed: ${artifact.id}`);
            }
        }

        return { sessions, runs, approvals, artifacts };
    }

    commit(changes: StoreCommit): void {
        this.assertOpen();
        this.database.exec('BEGIN IMMEDIATE;');
        try {
            for (const sessionId of changes.clearContextSessions ?? []) {
                this.database.prepare('DELETE FROM request_contexts WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)').run(sessionId);
            }
            for (const session of changes.sessions ?? []) {
                this.database
                    .prepare(
                        `INSERT INTO sessions (id, created_at, data)
                         VALUES (?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, data = excluded.data`,
                    )
                    .run(session.id, session.createdAt, serialize(session));
            }

            for (const run of changes.runs ?? []) {
                this.database
                    .prepare(
                        `INSERT INTO runs (id, session_id, created_at, state, sequence, data)
                         VALUES (?, ?, ?, ?, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET
                            session_id = excluded.session_id,
                            created_at = excluded.created_at,
                            state = excluded.state,
                            sequence = excluded.sequence,
                            data = excluded.data`,
                    )
                    .run(run.id, run.sessionId, run.createdAt, run.state, run.sequence, serialize(run));
            }

            for (const approval of changes.approvals ?? []) {
                this.database
                    .prepare(
                        `INSERT INTO approvals (request_id, run_id, status, data)
                         VALUES (?, ?, ?, ?)
                         ON CONFLICT(request_id) DO UPDATE SET
                            run_id = excluded.run_id,
                            status = excluded.status,
                            data = excluded.data`,
                    )
                    .run(approval.requestId, approval.runId, approval.status, serialize(approval));
            }

            for (const context of changes.contexts ?? []) {
                this.database.prepare('INSERT INTO request_contexts (run_id, data) VALUES (?, ?) ON CONFLICT(run_id) DO UPDATE SET data = excluded.data')
                    .run(context.runId, serialize(context));
            }

            for (const update of changes.contextUpdates ?? []) this.applyContextUpdate(update);

            for (const artifact of changes.artifacts ?? []) {
                this.database
                    .prepare(
                        `INSERT INTO artifacts (id, session_id, run_id, hash, data)
                         VALUES (?, ?, ?, ?, ?)`,
                    )
                    .run(artifact.id, artifact.sessionId, artifact.runId, artifact.hash, serialize(artifact));
            }

            for (const event of changes.events ?? []) {
                this.database
                    .prepare(
                        `INSERT INTO events
                            (runtime_id, session_id, run_id, turn_id, sequence, type, data)
                         VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    )
                    .run(
                        event.runtimeId,
                        event.sessionId,
                        event.runId,
                        event.turnId,
                        event.sequence,
                        event.type,
                        serialize(event),
                    );
            }

            for (const event of changes.journal ?? []) {
                this.validateJournalEvent(event);
                const expected = this.nextSessionSeq(event.run.sessionId);
                if (event.sessionSeq !== expected) {
                    throw new Error(`Journal sequence gap for ${event.run.sessionId}: expected ${expected}, received ${event.sessionSeq}`);
                }
                this.database.prepare(`INSERT INTO canonical_events
                    (event_id, session_id, session_seq, data) VALUES (?, ?, ?, ?)`)
                    .run(event.eventId, event.run.sessionId, event.sessionSeq, serialize(event));
            }

            this.database.exec('COMMIT;');
        } catch (error) {
            try {
                this.database.exec('ROLLBACK;');
            } catch {
                // Preserve the original write error.
            }
            throw error;
        }
    }

    beginSessionPurge(sessionId: string, intent: Record<string, unknown>): void {
        this.assertOpen();
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session identity');
        if (!intent || typeof intent !== 'object' || Array.isArray(intent)
            || ![Object.prototype, null].includes(Object.getPrototypeOf(intent))) throw new Error('Invalid session purge intent');
        const data = serialize(intent);
        const serialized = JSON.parse(data);
        if (!serialized || typeof serialized !== 'object' || Array.isArray(serialized)) throw new Error('Invalid session purge intent');
        this.database.exec('PRAGMA secure_delete = ON;');
        this.database.exec('BEGIN IMMEDIATE;');
        try {
            if (this.database.prepare('SELECT 1 FROM session_purges WHERE session_id = ?').get(sessionId)) throw new Error('Session purge already pending');
            if (!this.database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) throw new Error('Session does not exist');
            eraseSessionRows(this.database, sessionId);
            this.database.prepare('INSERT INTO session_purges (session_id, data) VALUES (?, ?)').run(sessionId, data);
            this.database.exec('COMMIT;');
        } catch (error) {
            try { this.database.exec('ROLLBACK;'); } catch { /* Preserve the original purge failure. */ }
            throw error;
        }
    }

    readSessionPurges(): Array<{ sessionId: string; intent: Record<string, unknown> }> {
        this.assertOpen();
        return (this.database.prepare('SELECT session_id, data FROM session_purges ORDER BY rowid').all() as Array<{ session_id: string; data: string }>)
            .map(row => ({ sessionId: row.session_id, intent: parseRow<Record<string, unknown>>(row.data, 'session_purges') }));
    }

    completeSessionPurge(sessionId: string): void {
        this.assertOpen();
        if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session identity');
        this.database.prepare('DELETE FROM session_purges WHERE session_id = ?').run(sessionId);
    }

    /** Flush logical deletion to the main file; this does not promise physical unrecoverability. */
    checkpointAfterPurge(): void {
        this.assertOpen();
        const row = this.database.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number };
        if (Number(row.busy) !== 0) throw new Error('Session purge checkpoint is busy');
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.database.close();
        this.closed = true;
    }

    readRequestContext(runId: string): RequestContextDetail | null {
        this.assertOpen();
        const row = this.database.prepare('SELECT data FROM request_contexts WHERE run_id = ?').get(runId) as { data: string } | undefined;
        return row ? parseRow<RequestContextDetail>(row.data, 'request_contexts') : null;
    }

    /** Synchronous owner only: read, assemble and commit without an asynchronous gap.
     * This does not reserve a number, so a failed transaction cannot leave a hole. */
    nextSessionSeq(sessionId: string): number {
        return this.journalWatermark(sessionId).durableSeq + 1;
    }

    /** Accounting projection reads no streamed text or request bodies into JavaScript. */
    readAccountingJournal(sessionId: string): TranscriptEvent[] {
        this.assertOpen();
        const rows = this.database.prepare(`SELECT data FROM canonical_events WHERE session_id = ?
            AND json_extract(data, '$.type') IN ('usage.snapshot', 'request.dispatch') ORDER BY session_seq ASC`)
            .all(sessionId) as Array<{ data: string }>;
        return rows.map(row => parseRow<TranscriptEvent>(row.data, 'canonical_events'));
    }

    readJournal(sessionId: string, afterSeq = 0, limit = 1000): TranscriptEvent[] {
        this.assertOpen();
        if (!Number.isSafeInteger(afterSeq) || afterSeq < 0 || !Number.isSafeInteger(limit) || limit < 1) {
            throw new Error('Invalid journal range');
        }
        const rows = this.database.prepare(`SELECT data FROM canonical_events
            WHERE session_id = ? AND session_seq > ? ORDER BY session_seq ASC LIMIT ?`)
            .all(sessionId, afterSeq, limit) as Array<{ data: string }>;
        return rows.map((row) => parseRow<TranscriptEvent>(row.data, 'canonical_events'));
    }

    /** Stream only recovery identities, never materialize request/response/tool-result bodies in JS. */
    readUnresolvedDispatchRuns(): Set<string> {
        this.assertOpen();
        const unresolved = new Map<string, { sessionId: string; runId: string; seq: number }>();
        const rows = this.database.prepare(`SELECT session_id, session_seq,
            json_extract(data, '$.type') AS type,
            json_extract(data, '$.run.runId') AS run_id,
            json_extract(data, '$.payload.runIds') AS reviewed_runs,
            json_extract(data, '$.payload.throughSeq') AS reviewed_through,
            CASE json_extract(data, '$.type') WHEN 'tool.dispatch'
                THEN json_extract(data, '$.payload.identity.invocationId')
                ELSE json_extract(data, '$.payload.invocationId') END AS invocation_id
            FROM canonical_events WHERE json_extract(data, '$.type') IN ('tool.dispatch', 'tool.result', 'recovery.reviewed')
            ORDER BY session_id, session_seq`).iterate();
        for (const row of rows) {
            if (row.type === 'recovery.reviewed') {
                const ids: unknown = typeof row.reviewed_runs === 'string' ? JSON.parse(row.reviewed_runs) : null;
                if (!Array.isArray(ids) || !ids.length || ids.some(id => typeof id !== 'string' || !id)
                    || typeof row.reviewed_through !== 'number' || !Number.isSafeInteger(row.reviewed_through)
                    || row.reviewed_through < 0 || row.reviewed_through >= Number(row.session_seq)) throw new Error('Invalid recovery review boundary');
                const reviewed = new Set(ids);
                for (const [key, dispatch] of unresolved) if (dispatch.sessionId === row.session_id && dispatch.seq <= row.reviewed_through && reviewed.has(dispatch.runId)) unresolved.delete(key);
                continue;
            }
            if (typeof row.session_id !== 'string' || !row.session_id || typeof row.run_id !== 'string' || !row.run_id
                || typeof row.invocation_id !== 'string' || !row.invocation_id) throw new Error('Invalid recovery invocation identity');
            const key = JSON.stringify([row.session_id, row.run_id, row.invocation_id]);
            if (row.type === 'tool.dispatch') unresolved.set(key, { runId: row.run_id, sessionId: row.session_id, seq: Number(row.session_seq) });
            else unresolved.delete(key);
        }
        return new Set([...unresolved.values()].map(item => item.runId));
    }

    /** Provider call IDs are safe for pruning only when their invocation identity is unambiguous. */
    readToolDispatchIdentities(sessionId: string): Array<{ invocationId: string; toolCallId: string }> {
        this.assertOpen();
        const rows = this.database.prepare(`SELECT
            json_extract(data, '$.payload.identity.invocationId') AS invocation_id,
            json_extract(data, '$.payload.identity.toolCallId') AS tool_call_id
            FROM canonical_events WHERE session_id = ? AND json_extract(data, '$.type') = 'tool.dispatch'
            ORDER BY session_seq ASC`).all(sessionId) as Array<{ invocation_id: unknown; tool_call_id: unknown }>;
        const identities: Array<{ invocationId: string; toolCallId: string }> = [];
        for (const row of rows) {
            if (typeof row.invocation_id !== 'string' || !row.invocation_id || typeof row.tool_call_id !== 'string' || !row.tool_call_id) {
                throw new Error('Invalid tool dispatch identity projection');
            }
            identities.push({ invocationId: row.invocation_id, toolCallId: row.tool_call_id });
        }
        return identities;
    }

    journalWatermark(sessionId: string): { durableSeq: number; exportedSeq: number } {
        this.assertOpen();
        const row = this.database.prepare(`SELECT
            COALESCE((SELECT MAX(session_seq) FROM canonical_events WHERE session_id = ?), 0) AS durable,
            COALESCE((SELECT exported_seq FROM journal_exports WHERE session_id = ?), 0) AS exported`)
            .get(sessionId, sessionId) as { durable: number; exported: number };
        return { durableSeq: Number(row.durable), exportedSeq: Number(row.exported) };
    }

    /** Outstanding JSONL UTF-8 bytes (including each LF), without parsing the journal. */
    journalBacklog(sessionId: string): { events: number; bytes: number } {
        this.assertOpen();
        const row = this.database.prepare(`SELECT COUNT(*) AS events,
            COALESCE(SUM(length(CAST(data AS BLOB)) + 1), 0) AS bytes FROM canonical_events
            WHERE session_id = ? AND session_seq >
                COALESCE((SELECT exported_seq FROM journal_exports WHERE session_id = ?), 0)`)
            .get(sessionId, sessionId) as { events: number; bytes: number };
        return { events: Number(row.events), bytes: Number(row.bytes) };
    }

    /** Call only after the projection's fsync has succeeded. */
    markExported(sessionId: string, seq: number): void {
        this.assertOpen();
        const { durableSeq, exportedSeq } = this.journalWatermark(sessionId);
        if (!Number.isSafeInteger(seq) || seq < exportedSeq || seq > durableSeq) {
            throw new Error(`Invalid exported journal watermark: ${seq} (exported ${exportedSeq}, durable ${durableSeq})`);
        }
        this.database.prepare(`INSERT INTO journal_exports (session_id, exported_seq) VALUES (?, ?)
            ON CONFLICT(session_id) DO UPDATE SET exported_seq = excluded.exported_seq`).run(sessionId, seq);
    }

    private applyContextUpdate(update: ContextUpdate): void {
        validateContextUpdate(update);
        const surface = update.surface;
        const { sessionId, ownerId } = surface;
        if (!this.database.prepare('SELECT 1 FROM sessions WHERE id = ?').get(sessionId)) {
            throw new Error(`Context session does not exist: ${sessionId}`);
        }

        const existingSurfaceRow = this.database.prepare(`SELECT schema_version, session_id, owner_id, revision, epoch, route_key,
                entry_ids, snapshot_hashes, instruction_hash, tool_manifest_hash, source_fingerprint,
                last_run_id, coverage, metadata
            FROM context_surfaces WHERE session_id = ? AND owner_id = ?`).get(sessionId, ownerId) as ContextSurfaceRow | undefined;
        const existingSurface = existingSurfaceRow ? surfaceFromRow(existingSurfaceRow) : undefined;
        if (existingSurface) validateContextSurface(existingSurface, 'persisted context surface');
        if (update.expectedRevision === null) {
            if (existingSurface) throw new Error(`Context surface revision conflict for ${sessionId}/${ownerId}`);
            if (surface.revision !== 1) throw new Error('Initial context surface revision must be 1');
        } else {
            if (!existingSurface || existingSurface.revision !== update.expectedRevision) {
                throw new Error(`Context surface revision conflict for ${sessionId}/${ownerId}`);
            }
            if (surface.revision !== update.expectedRevision + 1) {
                throw new Error('Context surface revision must advance by one');
            }
        }

        const entryById = new Map<string, ContextEntry>();
        for (const entry of update.entries) {
            const priorInBatch = entryById.get(entry.id);
            if (priorInBatch && !contextEntryEqual(priorInBatch, entry)) {
                throw new Error(`Context entry identity conflict: ${entry.id}`);
            }
            entryById.set(entry.id, entry);
            const row = this.database.prepare(`SELECT id, session_id, owner_id, kind, content, source_run_id
                FROM context_entries WHERE id = ?`).get(entry.id) as ContextEntryRow | undefined;
            if (row) {
                const persisted = entryFromRow(row);
                validateContextEntry(persisted, 'persisted context entry');
                if (!contextEntryEqual(persisted, entry)) throw new Error(`Context entry identity conflict: ${entry.id}`);
                continue;
            }
            this.database.prepare(`INSERT INTO context_entries
                (id, session_id, owner_id, kind, content, source_run_id) VALUES (?, ?, ?, ?, ?, ?)`)
                .run(entry.id, entry.sessionId, entry.ownerId, entry.kind, serialize(entry.content), entry.sourceRunId);
        }

        if (surface.entryIds.length) {
            const placeholders = surface.entryIds.map(() => '?').join(', ');
            const rows = this.database.prepare(`SELECT id, session_id, owner_id
                FROM context_entries WHERE id IN (${placeholders})`).all(...surface.entryIds) as Array<{ id: string; session_id: string; owner_id: string }>;
            const byId = new Map(rows.map(row => [row.id, row]));
            for (const id of surface.entryIds) {
                const row = byId.get(id);
                if (!row || row.session_id !== sessionId || row.owner_id !== ownerId) {
                    throw new Error(`Context surface entry is missing or belongs to a different owner: ${id}`);
                }
            }
        }

        const metadata = Object.hasOwn(surface, 'metadata') ? serialize(surface.metadata) : null;
        const values = [
            surface.schemaVersion,
            surface.sessionId,
            surface.ownerId,
            surface.revision,
            surface.epoch,
            surface.routeKey,
            serialize(surface.entryIds),
            serialize(surface.snapshotHashes),
            surface.instructionHash,
            surface.toolManifestHash,
            surface.sourceFingerprint,
            surface.lastRunId,
            surface.coverage,
            metadata,
        ] as const;
        if (!existingSurface) {
            this.database.prepare(`INSERT INTO context_surfaces
                (schema_version, session_id, owner_id, revision, epoch, route_key, entry_ids, snapshot_hashes,
                 instruction_hash, tool_manifest_hash, source_fingerprint, last_run_id, coverage, metadata)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(...values);
        } else {
            const result = this.database.prepare(`UPDATE context_surfaces SET
                    schema_version = ?, revision = ?, epoch = ?, route_key = ?, entry_ids = ?, snapshot_hashes = ?,
                    instruction_hash = ?, tool_manifest_hash = ?, source_fingerprint = ?, last_run_id = ?, coverage = ?, metadata = ?
                WHERE session_id = ? AND owner_id = ? AND revision = ?`)
                .run(surface.schemaVersion, surface.revision, surface.epoch, surface.routeKey, serialize(surface.entryIds), serialize(surface.snapshotHashes),
                    surface.instructionHash, surface.toolManifestHash, surface.sourceFingerprint, surface.lastRunId, surface.coverage, metadata,
                    sessionId, ownerId, update.expectedRevision);
            if (Number(result.changes) !== 1) throw new Error(`Context surface revision conflict for ${sessionId}/${ownerId}`);
        }
    }

    private validateJournalEvent(event: TranscriptEvent): void {
        if (event.schemaVersion !== 1 || !Number.isSafeInteger(event.sessionSeq) || event.sessionSeq < 1
            || typeof event.eventId !== 'string' || !event.eventId
            || typeof event.timestamp !== 'string' || !event.timestamp
            || typeof event.processEpochId !== 'string' || !event.processEpochId
            || typeof event.type !== 'string' || !event.type
            || !event.run || typeof event.run.sessionId !== 'string' || !event.run.sessionId
            || typeof event.run.runId !== 'string' || !event.run.runId
            || typeof event.run.rootRunId !== 'string' || !event.run.rootRunId
            || typeof event.run.turnId !== 'string' || !event.run.turnId
            || !(event.run.parentRunId === null || typeof event.run.parentRunId === 'string')
            || !event.payload || typeof event.payload !== 'object') {
            throw new Error('Invalid canonical journal event envelope');
        }
    }

    private assertSupportedSchema(): number {
        const row = this.database.prepare('PRAGMA user_version').get() as {
            user_version: number;
        };
        const currentVersion = Number(row.user_version);
        if (currentVersion > SCHEMA_VERSION) {
            throw new Error(
                `Runtime database schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}`,
            );
        }
        return currentVersion;
    }

    private initializeSchema(): void {
        const currentVersion = this.assertSupportedSchema();

        this.database.exec('BEGIN EXCLUSIVE;');
        try {
            if (currentVersion === 0) this.database.exec(`
                CREATE TABLE sessions (
                    id TEXT PRIMARY KEY,
                    created_at TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE runs (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    created_at TEXT NOT NULL,
                    state TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE approvals (
                    request_id TEXT PRIMARY KEY,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    status TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE artifacts (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
                    hash TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE TABLE events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    runtime_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    run_id TEXT NOT NULL,
                    turn_id TEXT NOT NULL,
                    sequence INTEGER NOT NULL,
                    type TEXT NOT NULL,
                    data TEXT NOT NULL
                );
                CREATE UNIQUE INDEX events_run_sequence
                    ON events(run_id, sequence) WHERE run_id <> '';
            `);
            if (currentVersion < 2) this.database.exec(`
                CREATE TABLE request_contexts (
                    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
                    data TEXT NOT NULL
                );
            `);
            if (currentVersion < 3) this.database.exec(`
                CREATE TABLE canonical_events (
                    event_id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    session_seq INTEGER NOT NULL CHECK(session_seq > 0),
                    data TEXT NOT NULL,
                    UNIQUE(session_id, session_seq)
                );
                CREATE TABLE journal_exports (
                    session_id TEXT PRIMARY KEY,
                    exported_seq INTEGER NOT NULL CHECK(exported_seq >= 0)
                );
            `);
            if (currentVersion < 4) this.database.exec(`
                CREATE TABLE IF NOT EXISTS context_entries (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    owner_id TEXT NOT NULL,
                    kind TEXT NOT NULL CHECK(kind IN ('message', 'runtime_snapshot', 'summary')),
                    content TEXT NOT NULL,
                    source_run_id TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS context_entries_scope ON context_entries(session_id, owner_id, id);
                CREATE TABLE IF NOT EXISTS context_surfaces (
                    schema_version INTEGER NOT NULL CHECK(schema_version = 2),
                    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
                    owner_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision > 0),
                    epoch INTEGER NOT NULL CHECK(epoch >= 0),
                    route_key TEXT NOT NULL,
                    entry_ids TEXT NOT NULL,
                    snapshot_hashes TEXT NOT NULL,
                    instruction_hash TEXT NOT NULL,
                    tool_manifest_hash TEXT NOT NULL,
                    source_fingerprint TEXT NOT NULL,
                    last_run_id TEXT NOT NULL,
                    coverage TEXT NOT NULL CHECK(coverage IN ('complete', 'partial')),
                    metadata TEXT,
                    PRIMARY KEY(session_id, owner_id)
                );
                CREATE INDEX IF NOT EXISTS context_surfaces_owner ON context_surfaces(owner_id, session_id);
            `);
            // Additive index repair shares the same atomic boundary as schema upgrades.
            this.database.exec('CREATE TABLE IF NOT EXISTS session_purges (session_id TEXT PRIMARY KEY, data TEXT NOT NULL);');
            this.database.exec(`CREATE INDEX IF NOT EXISTS runs_created_at ON runs(created_at, id);
                CREATE INDEX IF NOT EXISTS runs_session_created_at ON runs(session_id, created_at, id);`);
            if (currentVersion < SCHEMA_VERSION) this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
            this.database.exec('COMMIT;');
        } catch (error) {
            try {
                this.database.exec('ROLLBACK;');
            } catch {
                // Preserve the original schema error.
            }
            throw error;
        }
    }

    private readRows<T>(table: 'sessions' | 'runs' | 'approvals' | 'artifacts'): T[] {
        const rows = this.database
            .prepare(`SELECT data FROM ${table} ORDER BY rowid ASC`)
            .all() as Array<{ data: string }>;
        return rows.map((row) => parseRow<T>(row.data, table));
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new Error('Runtime store is closed');
        }
    }
}
