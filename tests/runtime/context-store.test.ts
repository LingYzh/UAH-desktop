import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore, RUNTIME_SCHEMA_VERSION } from '../../src/runtime/store';
import type { ContextEntry, ContextSurface } from '../../src/runtime/context/contracts';
import type { ArtifactReference, TranscriptEvent } from '../../src/shared/harness-contracts';

const effective = { runtimeId: 'api', modelId: 'context-model', agentId: 'context-agent', policyVersion: 1 };
const timestamp = '2026-10-04T00:00:00.000Z';

function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-context-store-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const store = new RuntimeStore(root);
    const session = { id: 'session', title: 'Context', directory: null, requested: effective, createdAt: timestamp };
    store.commit({ sessions: [session] });
    return { root, store, session };
}

function ref(marker: string): ArtifactReference {
    return {
        mediaType: 'text/plain', availability: 'external_reference_only', relativePath: null,
        sha256: null, byteLength: null, externalReference: `artifact:${marker}`, missingReason: 'fixture',
    };
}

function entry(id: string, ownerId: string, sourceRunId = `${ownerId}-run`): ContextEntry {
    return { id, sessionId: 'session', ownerId, kind: 'message', content: ref(id), sourceRunId };
}

function surface(ownerId: string, revision: number, entryIds: string[] = [], extra: Partial<ContextSurface> = {}): ContextSurface {
    return {
        schemaVersion: 2, sessionId: 'session', ownerId, revision, epoch: 0,
        routeKey: `${ownerId}:route`, entryIds, snapshotHashes: { cwd: 'hash-1' },
        instructionHash: 'instructions-1', toolManifestHash: 'tools-1', sourceFingerprint: 'source-1',
        lastRunId: `${ownerId}-run`, coverage: 'complete', ...extra,
    };
}

test('context surfaces use owner scoped CAS and preserve entry order across restart', t => {
    const f = fixture(t);
    try {
        const first = [entry('a', 'root'), entry('b', 'root')];
        f.store.commit({ contextUpdates: [{ expectedRevision: null, surface: surface('root', 1, ['b', 'a']), entries: first }] });
        assert.equal(f.store.readContextSurface('session', 'root')?.revision, 1);
        assert.deepEqual(f.store.readContextEntries('session', 'root', ['b', 'a']).map(item => item.id), ['b', 'a']);
        assert.deepEqual(f.store.readContextEntries('session', 'root', ['a', 'a']).map(item => item.id), ['a', 'a']);

        const sameEntry = entry('a', 'root');
        f.store.commit({ contextUpdates: [{ expectedRevision: 1, surface: surface('root', 2, ['b', 'a'], { epoch: 1, metadata: { reason: 'resume' } }), entries: [sameEntry] }] });
        assert.equal(f.store.readContextSurface('session', 'root')?.revision, 2);
        assert.deepEqual(f.store.readContextSurface('session', 'root')?.metadata, { reason: 'resume' });
        assert.throws(() => f.store.commit({ contextUpdates: [{ expectedRevision: 1, surface: surface('root', 2, ['b', 'a']), entries: [] }] }), /revision conflict/i);
        assert.equal(f.store.readContextSurface('session', 'root')?.revision, 2);

        f.store.close();
        const restarted = new RuntimeStore(f.root);
        try {
            assert.equal(restarted.readContextSurface('session', 'root')?.revision, 2);
            assert.deepEqual(restarted.readContextEntries('session', 'root', ['b', 'a']).map(item => item.id), ['b', 'a']);
        } finally { restarted.close(); }
    } finally {
        // The fixture cleanup owns the directory; close is idempotent for the assertion path.
        f.store.close();
    }
});

test('context updates are atomic with existing run and journal writes', t => {
    const f = fixture(t);
    try {
        const run = { id: 'run', sessionId: 'session', turnId: 'turn', createdAt: timestamp, sequence: 1, state: 'completed' as const,
            input: 'input', output: 'output', effective };
        const invalidJournal: TranscriptEvent = {
            schemaVersion: 1, eventId: 'event', sessionSeq: 2, timestamp, processEpochId: 'epoch',
            run: { sessionId: 'session', runId: 'run', rootRunId: 'run', turnId: 'turn', parentRunId: null },
            type: 'run.state', payload: { state: 'completed', reason: null },
        };
        assert.throws(() => f.store.commit({ runs: [run], contextUpdates: [{ expectedRevision: null, surface: surface('root', 1, ['a']), entries: [entry('a', 'root')] }], journal: [invalidJournal] }), /Journal sequence gap/);
        assert.equal(f.store.readRun('run'), undefined);
        assert.equal(f.store.readContextSurface('session', 'root'), undefined);
        assert.throws(() => f.store.readContextEntries('session', 'root', ['a']), /missing|owner/i);
    } finally { f.store.close(); }
});

test('entries remain immutable, and parent and child owners cannot cross-read', t => {
    const f = fixture(t);
    try {
        f.store.commit({ contextUpdates: [
            { expectedRevision: null, surface: surface('parent', 1, ['shared']), entries: [entry('shared', 'parent')] },
            { expectedRevision: null, surface: surface('child', 1, ['child-entry']), entries: [entry('child-entry', 'child')] },
        ] });
        assert.throws(() => f.store.readContextEntries('session', 'child', ['shared']), /owner/i);
        assert.deepEqual(f.store.readContextEntries('session', 'parent', ['shared']).map(item => item.ownerId), ['parent']);
        assert.throws(() => f.store.commit({ contextUpdates: [{ expectedRevision: 1, surface: surface('parent', 2, ['shared']), entries: [{ ...entry('shared', 'parent'), sourceRunId: 'forged-run' }] }] }), /identity conflict/i);
        assert.equal(f.store.readContextSurface('session', 'parent')?.revision, 1);
    } finally { f.store.close(); }
});

test('session purge removes context entries and surfaces while retaining another session', t => {
    const f = fixture(t);
    try {
        f.store.commit({ sessions: [{ id: 'other', title: 'Other', directory: null, requested: effective, createdAt: timestamp }] });
        f.store.commit({ contextUpdates: [
            { expectedRevision: null, surface: surface('root', 1, ['a']), entries: [entry('a', 'root')] },
        ] });
        const otherEntry: ContextEntry = { ...entry('other-entry', 'other-owner'), sessionId: 'other' };
        const otherSurface: ContextSurface = { ...surface('other-owner', 1, ['other-entry']), sessionId: 'other', lastRunId: 'other-run' };
        f.store.commit({ contextUpdates: [{ expectedRevision: null, surface: otherSurface, entries: [otherEntry] }] });
        f.store.beginSessionPurge('session', { phase: 'context' });
        assert.equal(f.store.readContextSurface('session', 'root'), undefined);
        assert.throws(() => f.store.readContextEntries('session', 'root', ['a']), /missing|owner/i);
        const database = new DatabaseSync(join(f.root, 'runtime.sqlite'), { readOnly: true });
        try {
            assert.equal((database.prepare('SELECT COUNT(*) AS count FROM context_entries WHERE session_id = ?').get('session') as { count: number }).count, 0);
            assert.equal((database.prepare('SELECT COUNT(*) AS count FROM context_surfaces WHERE session_id = ?').get('session') as { count: number }).count, 0);
        } finally { database.close(); }
        assert.equal(f.store.readContextSurface('other', 'other-owner')?.revision, 1);
        assert.deepEqual(f.store.readContextEntries('other', 'other-owner', ['other-entry']).map(item => item.id), ['other-entry']);
    } finally { f.store.close(); }
});

test('v3 migration preserves canonical events and newer databases are refused', t => {
    const f = fixture(t);
    const filename = join(f.root, 'runtime.sqlite');
    f.store.close();
    const database = new DatabaseSync(filename);
    try {
        database.exec('DROP TABLE context_surfaces; DROP INDEX context_entries_scope; DROP TABLE context_entries; PRAGMA user_version = 3;');
        database.prepare('INSERT INTO canonical_events (event_id, session_id, session_seq, data) VALUES (?, ?, ?, ?)')
            .run('old-event', 'session', 1, JSON.stringify({ eventId: 'old-event', type: 'run.state', payload: {} }));
    } finally { database.close(); }
    const migrated = new RuntimeStore(f.root);
    try {
        assert.deepEqual(migrated.readJournal('session'), [{ eventId: 'old-event', type: 'run.state', payload: {} }]);
        assert.equal(migrated.readContextSurface('session', 'root'), undefined);
        const inspect = new DatabaseSync(filename, { readOnly: true });
        try { assert.equal((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, RUNTIME_SCHEMA_VERSION); } finally { inspect.close(); }
    } finally { migrated.close(); }

    const futureRoot = mkdtempSync(join(tmpdir(), 'uah-context-future-'));
    t.after(() => rmSync(futureRoot, { recursive: true, force: true }));
    const future = new DatabaseSync(join(futureRoot, 'runtime.sqlite'));
    future.exec('CREATE TABLE future_data (value TEXT); PRAGMA user_version = 99;'); future.close();
    assert.throws(() => new RuntimeStore(futureRoot), /newer than supported/);
});

test('failed v3 to v4 migration rolls back context DDL while retaining canonical events', t => {
    const f = fixture(t);
    const filename = join(f.root, 'runtime.sqlite');
    f.store.close();
    const database = new DatabaseSync(filename);
    database.exec(`DROP TABLE context_surfaces; DROP INDEX context_entries_scope; DROP TABLE context_entries;
        DROP INDEX runs_created_at; DROP INDEX runs_session_created_at; PRAGMA user_version = 3;
        INSERT INTO canonical_events (event_id, session_id, session_seq, data)
        VALUES ('migration-event', 'session', 1, '{"eventId":"migration-event","type":"run.state","payload":{}}');
        CREATE TABLE runs_session_created_at (preserve TEXT); INSERT INTO runs_session_created_at VALUES ('collision');`);
    database.close();

    assert.throws(() => new RuntimeStore(f.root), /runs_session_created_at|already exists/);
    const failed = new DatabaseSync(filename, { readOnly: true });
    try {
        assert.equal((failed.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
        assert.equal((failed.prepare('SELECT data FROM canonical_events WHERE event_id = ?').get('migration-event') as { data: string }).data,
            '{"eventId":"migration-event","type":"run.state","payload":{}}');
        assert.equal(failed.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('context_entries', 'context_surfaces')").all().length, 0);
        assert.equal((failed.prepare('SELECT preserve FROM runs_session_created_at').get() as { preserve: string }).preserve, 'collision');
        assert.equal(failed.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'runs_created_at'").get(), undefined);
    } finally { failed.close(); }

    const repair = new DatabaseSync(filename);
    repair.exec('DROP TABLE runs_session_created_at;'); repair.close();
    const migrated = new RuntimeStore(f.root);
    try {
        assert.deepEqual(migrated.readJournal('session'), [{ eventId: 'migration-event', type: 'run.state', payload: {} }]);
        const inspect = new DatabaseSync(filename, { readOnly: true });
        try {
            assert.equal((inspect.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, RUNTIME_SCHEMA_VERSION);
            assert.ok(inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_entries'").get());
            assert.ok(inspect.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'context_surfaces'").get());
        } finally { inspect.close(); }
    } finally { migrated.close(); }
});
