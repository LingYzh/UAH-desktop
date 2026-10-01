import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../../src/runtime/store';
import type { ApprovalRecord, ArtifactSnapshot, RunRecord, RuntimeEvent, SessionRecord } from '../../src/shared/contracts';
import type { TranscriptEvent } from '../../src/shared/harness-contracts';

const timestamp = '2026-10-01T00:00:00.000Z';
const effective = { runtimeId: 'api', modelId: 'fixture', agentId: 'default', policyVersion: 1 };
const session = (id: string): SessionRecord => ({ id, title: id, directory: null, requested: effective, createdAt: timestamp });
const run = (id: string, state: RunRecord['state'] = 'completed', sessionId = 'a'): RunRecord => ({ id, sessionId, turnId: id, state, input: id,
    output: 'unrelated durable body '.repeat(100), effective, sequence: 1, createdAt: timestamp });
const approval = (record: RunRecord, status: ApprovalRecord['status'] = 'pending'): ApprovalRecord => ({ runtimeId: 'api', sessionId: record.sessionId,
    runId: record.id, turnId: record.turnId, requestId: 'approval-' + record.id, policyVersion: 1, status, summary: 'fixture approval', path: 'fixture.txt', createdAt: timestamp });
const artifact = (id = 'artifact', content = 'durable artifact body'): ArtifactSnapshot => ({ id, sessionId: 'a', runId: 'terminal', turnId: 'terminal', path: 'fixture.txt',
    oldContent: null, newContent: content, hash: createHash('sha256').update(content).digest('hex'), createdAt: timestamp });
const manifest = (saved: ArtifactSnapshot, sequence = 1): RuntimeEvent => ({ type: 'artifact-created', runtimeId: 'api', sessionId: saved.sessionId, runId: saved.runId,
    turnId: saved.turnId, sequence, payload: { artifact: saved } });
function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync(join(tmpdir(), 'uah-recovery-snapshot-')); const store = new RuntimeStore(directory);
    const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    t.after(() => { db.close(); store.close(); const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir()));
        assert.ok(basename(target).startsWith('uah-recovery-snapshot-')); rmSync(target, { recursive: true, force: true }); });
    return { store, db };
}
function sameRejection(store: RuntimeStore, reason: RegExp) {
    const failure = (read: () => unknown) => { try { read(); assert.fail('Expected integrity rejection'); } catch (error) { assert.match((error as Error).message, reason); return error as Error; } };
    const full = failure(() => store.readSnapshot()); const recovery = failure(() => store.readRecoverySnapshot(new Set()));
    assert.equal(recovery.constructor, full.constructor); assert.equal(recovery.message, full.message);
}
function accepted(sessionId: string, runId: string, sessionSeq: number): TranscriptEvent {
    return { schemaVersion: 1, eventId: randomUUID(), sessionSeq, timestamp, processEpochId: randomUUID(),
        run: { sessionId, runId, rootRunId: runId, parentRunId: null, turnId: runId }, type: 'message.accepted',
        payload: { messageId: runId, revision: 1, role: 'user', content: { availability: 'external_reference_only', relativePath: null, sha256: null, byteLength: null,
            mediaType: 'text/plain', missingReason: 'fixture identity only', externalReference: 'fixture' } } };
}

test('recovery excludes 1000 terminal bodies and artifact contents while returning all sessions and approvals', t => {
    const { store } = fixture(t); const historical = Array.from({ length: 1000 }, (_, index) => run(String(index))); const saved = { ...artifact(), runId: '0', turnId: '0' };
    store.commit({ sessions: [session('a'), session('empty')], runs: historical, approvals: [approval(historical[0], 'approved')], artifacts: [saved], events: [manifest(saved)] });
    const original = (store as unknown as { readRows(table: string): unknown[] }).readRows.bind(store);
    t.mock.method(store as unknown as { readRows(table: string): unknown[] }, 'readRows', (table: string) => {
        assert.ok(['sessions', 'approvals'].includes(table), 'recovery must not read historical run/artifact body arrays'); return original(table);
    });
    const snapshot = store.readRecoverySnapshot(new Set()); assert.equal(snapshot.sessions.length, 2); assert.equal(snapshot.approvals.length, 1);
    assert.deepEqual(snapshot.runs, []); assert.deepEqual(snapshot.artifacts, []); assert.equal(JSON.stringify(snapshot).includes('unrelated durable body'), false);
});

test('recovery returns nonterminal, terminal-pending and uncertain runs in insertion order, including children', t => {
    const { store } = fixture(t); const pending = run('pending-terminal', 'failed'); const uncertain = run('uncertain-terminal', 'stopped');
    const child = { ...run('child-running', 'running', 'b'), parentRunId: 'root' };
    const records = [run('irrelevant'), uncertain, run('root', 'running'), pending, child, run('awaiting', 'approval'), run('cancel', 'cancelRequested'), run('stopping', 'stopping'), run('approved-terminal')];
    store.commit({ sessions: [session('a'), session('b')], runs: records, approvals: [approval(pending), approval(records.at(-1)!, 'approved')] });
    store.commit({ runs: [{ ...uncertain, output: 'updated uncertain body' }] });
    const snapshot = store.readRecoverySnapshot(new Set([uncertain.id, 'missing-id']));
    assert.deepEqual(snapshot.runs.map(record => record.id), ['uncertain-terminal', 'root', 'pending-terminal', 'child-running', 'awaiting', 'cancel', 'stopping']);
    assert.equal(snapshot.runs[0].output, 'updated uncertain body'); assert.equal(snapshot.runs[3].parentRunId, 'root'); assert.equal(snapshot.approvals.length, 2);
});

for (const mutation of ['missing snapshot', 'changed hash', 'changed content', 'orphan snapshot', 'consistent bad hash', 'duplicate contradiction']) {
    test(`recovery preserves full snapshot rejection: ${mutation}`, t => {
        const { store, db } = fixture(t); const saved = artifact(); store.commit({ sessions: [session('a')], runs: [run('terminal')], artifacts: [saved], events: [manifest(saved)] });
        let reason: RegExp;
        if (mutation === 'missing snapshot') { db.exec('DELETE FROM artifacts'); reason = /snapshot is missing/; }
        else if (mutation === 'orphan snapshot') { db.exec('DELETE FROM events'); reason = /no event manifest/; }
        else if (mutation === 'duplicate contradiction') { store.commit({ events: [manifest({ ...saved, newContent: 'contradictory repeated manifest' }, 2)] }); reason = /manifest mismatch/; }
        else {
            const changed = mutation === 'changed content' ? { ...saved, newContent: 'changed body' } : { ...saved, hash: '0'.repeat(64) };
            db.prepare('UPDATE artifacts SET data = ? WHERE id = ?').run(JSON.stringify(changed), saved.id);
            if (mutation === 'consistent bad hash') { db.prepare('UPDATE events SET data = ?').run(JSON.stringify(manifest(changed))); reason = /integrity check failed/; }
            else reason = /manifest mismatch/;
        }
        sameRejection(store, reason);
    });
}

test('duplicate matching manifests are checked and JSON artifact identity uses the same last-record mapping as full snapshots', t => {
    const { store, db } = fixture(t); const first = artifact('first', 'first body'); const second = artifact('second', 'second body');
    store.commit({ sessions: [session('a')], runs: [run('terminal')], artifacts: [first, second] });
    // SQL IDs remain distinct; the old verifier maps the JSON identities in row order.
    const duplicate = { ...second, id: first.id }; db.prepare('UPDATE artifacts SET data = ? WHERE id = ?').run(JSON.stringify(duplicate), second.id);
    store.commit({ events: [manifest(duplicate), manifest(duplicate, 2)] });
    assert.equal(store.readSnapshot().artifacts.length, 2); assert.deepEqual(store.readRecoverySnapshot(new Set()).artifacts, []);
    store.commit({ events: [manifest(first, 3)] }); sameRejection(store, /manifest mismatch/);
});

test('malformed persisted JSON in excluded history, artifact rows and manifests still rejects recovery', t => {
    const { store, db } = fixture(t); const saved = artifact();
    store.commit({ sessions: [session('a')], runs: [run('terminal')], approvals: [approval(run('terminal'), 'approved')], artifacts: [saved], events: [manifest(saved)] });
    for (const table of ['sessions', 'runs', 'approvals', 'artifacts', 'events']) {
        const original = (db.prepare(`SELECT data FROM ${table}`).get() as { data: string }).data; db.prepare(`UPDATE ${table} SET data = ?`).run('{broken');
        sameRejection(store, new RegExp(`Cannot read persisted ${table} record`)); db.prepare(`UPDATE ${table} SET data = ?`).run(original);
    }
    const event = manifest(saved); db.prepare('UPDATE events SET data = ?').run(JSON.stringify({ ...event, type: 'delta' }));
    sameRejection(store, /event history is malformed/);
});

test('legacy identity query covers mixed old/new sessions, ignores empty/unknown sessions and isolates canonical references by session', t => {
    const { store, db } = fixture(t);
    store.commit({ sessions: ['old', 'new', 'mixed', 'empty', 'foreign'].map(session),
        runs: [run('old-run', 'completed', 'old'), run('new-run', 'completed', 'new'), run('covered', 'completed', 'mixed'), run('uncovered', 'completed', 'mixed'), run('foreign-run', 'completed', 'foreign'), run('dangling', 'completed', 'foreign')],
        journal: [accepted('new', 'new-run', 1), accepted('mixed', 'covered', 1), accepted('foreign', 'old-run', 1), accepted('foreign', 'foreign-run', 2)] });
    // Only this isolated tampering fixture bypasses its own FK to model an orphan.
    db.exec('PRAGMA foreign_keys = OFF');
    db.prepare('UPDATE runs SET session_id = ?, data = ? WHERE id = ?').run('absent', JSON.stringify(run('dangling', 'completed', 'absent')), 'dangling');
    assert.deepEqual([...store.readLegacyJournalSessionIds()].sort(), ['mixed', 'old']);
    store.commit({ journal: [accepted('old', 'old-run', 1), accepted('mixed', 'uncovered', 2)] });
    assert.deepEqual([...store.readLegacyJournalSessionIds()], []);
});

test('legacy coverage materializes accepted identities once and rejects SQL/JSON run identity disagreement', t => {
    const { store, db } = fixture(t); store.commit({ sessions: [session('a')], runs: [run('terminal')], journal: [accepted('a', 'terminal', 1)] });
    const database = (store as unknown as { database: DatabaseSync }).database; const original = database.prepare.bind(database); let query = '';
    t.mock.method(database, 'prepare', (sql: string) => { if (sql.includes('WITH accepted')) query = sql; return original(sql); });
    assert.deepEqual([...store.readLegacyJournalSessionIds()], []); assert.match(query, /AS MATERIALIZED/); assert.match(query, /SELECT DISTINCT/);
    const details = (db.prepare('EXPLAIN QUERY PLAN ' + query).all() as Array<{ detail: string }>).map(row => row.detail);
    assert.ok(details.some(detail => /MATERIALIZE accepted/i.test(detail)), JSON.stringify(details));
    assert.equal(details.filter(detail => /SCAN canonical_events/i.test(detail)).length, 1, JSON.stringify(details));
    assert.ok(details.some(detail => /SEARCH accepted.*INDEX/i.test(detail)), JSON.stringify(details));
    for (const corrupted of [{ ...run('terminal'), id: 'different-json-id' }, { ...run('terminal'), sessionId: 'different-json-session' }]) {
        db.prepare('UPDATE runs SET data = ? WHERE id = ?').run(JSON.stringify(corrupted), 'terminal');
        assert.throws(() => store.readLegacyJournalSessionIds(), /Invalid legacy run identity/);
    }
});

test('recovery and legacy projections reject reads after store close', t => {
    const { store } = fixture(t); store.close();
    assert.throws(() => store.readRecoverySnapshot(new Set()), /closed/); assert.throws(() => store.readLegacyJournalSessionIds(), /closed/);
});
