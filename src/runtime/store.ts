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

const SCHEMA_VERSION = 2;
const MAX_SESSIONS = 5_000;
const MAX_RUNS = 500;

export interface StoreCommit {
    contexts?: RequestContextDetail[];
    clearContextSessions?: string[];
    sessions?: SessionRecord[];
    runs?: RunRecord[];
    approvals?: ApprovalRecord[];
    artifacts?: ArtifactSnapshot[];
    events?: RuntimeEvent[];
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

export class RuntimeStore {
    private readonly database: DatabaseSync;
    private closed = false;

    constructor(dataDirectory: string) {
        const directory = resolve(dataDirectory);
        mkdirSync(directory, { recursive: true });
        this.database = new DatabaseSync(resolve(directory, 'runtime.sqlite'));
        this.database.exec('PRAGMA foreign_keys = ON;');
        this.database.exec('PRAGMA journal_mode = WAL;');
        this.database.exec('PRAGMA synchronous = FULL;');
        this.initializeSchema();
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
        this.assertOpen();
        const row = this.database.prepare('SELECT COUNT(*) AS count FROM runs').get() as {
            count: number;
        };
        if (Number(row.count) >= MAX_RUNS) {
            throw new Error(`Run history limit reached (${MAX_RUNS}); existing history was preserved`);
        }
    }

    readSnapshot(): Snapshot {
        this.assertOpen();
        const sessions = this.readRows<SessionRecord>('sessions');
        const runs = this.readRows<RunRecord>('runs');
        const approvals = this.readRows<ApprovalRecord>('approvals');
        const artifacts = this.readRows<ArtifactSnapshot>('artifacts');
        const artifactEvents = this.database
            .prepare("SELECT data FROM events WHERE type = 'artifact-created' ORDER BY id ASC")
            .all() as Array<{ data: string }>;
        const manifests = artifactEvents.map((row) => parseRow<RuntimeEvent>(row.data, 'events'));
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

    private initializeSchema(): void {
        const row = this.database.prepare('PRAGMA user_version').get() as {
            user_version: number;
        };
        const currentVersion = Number(row.user_version);
        if (currentVersion > SCHEMA_VERSION) {
            throw new Error(
                `Runtime database schema ${currentVersion} is newer than supported schema ${SCHEMA_VERSION}`,
            );
        }
        if (currentVersion === SCHEMA_VERSION) {
            return;
        }

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
                CREATE INDEX runs_created_at ON runs(created_at, id);
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
            this.database.exec(`
                CREATE TABLE request_contexts (
                    run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
                    data TEXT NOT NULL
                );
                PRAGMA user_version = ${SCHEMA_VERSION};
            `);
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
