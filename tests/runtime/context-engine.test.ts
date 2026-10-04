import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ContextEngine, contextRoute, contextSourceFingerprint } from '../../src/runtime/context/engine';
import { contextHash } from '../../src/runtime/context/projection';
import { RuntimeStore } from '../../src/runtime/store';
import { RunJournal } from '../../src/runtime/run-journal';
import type { RunRecord, SessionRecord, Snapshot } from '../../src/shared/contracts';
import type { ApiConnection, ApiProtocol } from '../../src/shared/endpoints';
import { defaultModelParameters } from '../../src/shared/model-parameters';

const timestamp = '2026-10-04T00:00:00.000Z';
const effective = { runtimeId: 'api', modelId: 'model-a', agentId: 'context-agent', policyVersion: 1 };

function session(id = 'session'): SessionRecord {
    return { id, title: 'Context engine fixture', directory: null, requested: effective, createdAt: timestamp };
}

function run(id: string, sessionId = 'session', parentRunId?: string, modelId = effective.modelId): RunRecord {
    return { id, sessionId, turnId: `${id}-turn`, state: 'completed', input: `input:${id}`, output: `output:${id}`,
        effective: { ...effective, modelId }, sequence: 1, createdAt: timestamp, ...(parentRunId ? { parentRunId, depth: 1 } : {}) };
}

function connection(overrides: Partial<ApiConnection> = {}): ApiConnection {
    return { id: 'fixture-endpoint', name: 'Fixture endpoint', protocol: 'openai-responses',
        baseUrl: 'https://api.example.invalid/v1', models: ['model-a', 'model-b'], enabled: true, revision: 1,
        apiKey: 'fixture-secret', ...overrides };
}

function fixture(t: { after(fn: () => void): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-context-engine-'));
    const store = new RuntimeStore(root);
    const rootRun = run('root-run');
    const runs = new Map<string, RunRecord>([[rootRun.id, rootRun]]);
    store.commit({ sessions: [session()], runs: [rootRun] });
    const journal = new RunJournal(store, root, id => runs.get(id), () => {});
    t.after(() => { journal.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
    return { root, store, journal, runs, session: session(), rootRun };
}

function engine(f: ReturnType<typeof fixture>, runRecord: RunRecord, protocol: ApiProtocol, routeKey: string, source = 'source') {
    return new ContextEngine(f.store, f.journal, runRecord, protocol, routeKey, source);
}

test('owner-scoped surfaces survive restart without crossing primary and child lineages', t => {
    const f = fixture(t);
    const child = run('child-run', f.session.id, f.rootRun.id);
    f.runs.set(child.id, child);
    f.store.commit({ runs: [child] });

    const primaryHistory = [{ role: 'user', content: 'primary history' }];
    const childHistory = [{ role: 'user', content: 'child history' }];
    engine(f, f.rootRun, 'openai-chat', 'route-owner', 'owner-source').persist(primaryHistory, { sourceFingerprint: 'owner-source', reason: 'primary' });
    engine(f, child, 'openai-chat', 'route-owner', 'owner-source').persist(childHistory, { sourceFingerprint: 'owner-source', reason: 'child' });
    assert.equal(f.store.readContextSurface(f.session.id, 'primary')?.revision, 1);
    assert.equal(f.store.readContextSurface(f.session.id, `child:${child.id}`)?.revision, 1);

    f.journal.close(); f.store.close();
    const restartedStore = new RuntimeStore(f.root);
    const restartedJournal = new RunJournal(restartedStore, f.root, id => f.runs.get(id), () => {});
    try {
        const primary = new ContextEngine(restartedStore, restartedJournal, f.rootRun, 'openai-chat', 'route-owner', 'owner-source');
        const restoredChild = new ContextEngine(restartedStore, restartedJournal, child, 'openai-chat', 'route-owner', 'owner-source');
        assert.equal(primary.ownerId, 'primary');
        assert.equal(restoredChild.ownerId, `child:${child.id}`);
        assert.equal(primary.restored, true);
        assert.equal(restoredChild.restored, true);
        assert.deepEqual(primary.history, primaryHistory);
        assert.deepEqual(restoredChild.history, childHistory);
        assert.notDeepEqual(primary.history, restoredChild.history);
    } finally {
        restartedJournal.close(); restartedStore.close();
    }
});

test('runtime snapshots preserve ABA changes and reusable clear tombstones', t => {
    const f = fixture(t);
    const history = [{ role: 'user', content: 'stable history' }];
    const first = engine(f, f.rootRun, 'openai-chat', 'route-snapshot', 'snapshot-source');
    const a = first.snapshots([{ id: 'context.memory', content: 'A' }]);
    assert.equal(a.messages.length, 1);
    first.persist(history, { sourceFingerprint: 'snapshot-source', reason: 'initial', snapshotHashes: a.hashes });

    const second = engine(f, f.rootRun, 'openai-chat', 'route-snapshot', 'snapshot-source');
    assert.equal(second.restored, true);
    const b = second.snapshots([{ id: 'context.memory', content: 'B' }]);
    assert.equal(b.messages.length, 1);
    assert.match(String((b.messages[0] as { content: string }).content), /"content":"B"/);
    second.persist(history, { sourceFingerprint: 'snapshot-source', reason: 'changed', snapshotHashes: b.hashes });

    const third = engine(f, f.rootRun, 'openai-chat', 'route-snapshot', 'snapshot-source');
    const aba = third.snapshots([{ id: 'context.memory', content: 'A' }]);
    assert.equal(aba.messages.length, 1);
    assert.match(String((aba.messages[0] as { content: string }).content), /"content":"A"/);
    const cleared = third.snapshots([]);
    assert.equal(cleared.messages.length, 1);
    assert.match(String((cleared.messages[0] as { content: string }).content), /"content":null/);
    third.persist(history, { sourceFingerprint: 'snapshot-source', reason: 'clear', snapshotHashes: cleared.hashes });

    const afterClear = engine(f, f.rootRun, 'openai-chat', 'route-snapshot', 'snapshot-source');
    assert.deepEqual(afterClear.snapshots([]).messages, []);
    assert.equal(afterClear.snapshots([{ id: 'context.memory', content: 'A' }]).messages.length, 1);
});

test('route identity keeps same credential native data, portable changes remove opaque blocks, and missing artifacts fall back safely', t => {
    const f = fixture(t);
    const original = connection();
    const route = contextRoute(original, 'model-a');
    const nativeHistory = [
        { role: 'user', content: 'retain this request' },
        { type: 'reasoning', encrypted_content: 'opaque-provider-state', provider_extension: { private: true } },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'retain this answer' }], provider_extension: 'opaque' },
    ];
    engine(f, f.rootRun, 'openai-responses', route, 'route-source').persist(nativeHistory, {
        sourceFingerprint: 'route-source', reason: 'initial', instructionHash: 'instructions', toolManifestHash: 'tools',
    });

    const renamed = contextRoute({ ...original, name: 'Renamed', revision: 99 }, 'model-a');
    assert.equal(renamed, route);
    const native = engine(f, f.rootRun, 'openai-responses', renamed, 'route-source');
    assert.equal(native.restored, true);
    assert.equal(native.restoreReason, 'restored');
    assert.deepEqual(native.history, nativeHistory);

    for (const changedRoute of [
        contextRoute({ ...original, apiKey: 'changed-secret' }, 'model-a'),
        contextRoute(original, 'model-b'),
    ]) {
        const portable = engine(f, f.rootRun, 'openai-responses', changedRoute, 'route-source');
        assert.equal(portable.restored, true);
        assert.equal(portable.restoreReason, 'portable_replay');
        assert.doesNotMatch(JSON.stringify(portable.history), /opaque-provider-state|provider_extension/);
        assert.match(JSON.stringify(portable.history), /retain this request|retain this answer/);
    }

    const entryId = f.store.readContextSurface(f.session.id, 'primary')!.entryIds[0];
    const entry = f.store.readContextEntries(f.session.id, 'primary', [entryId])[0];
    unlinkSync(f.journal.artifactStore(f.session.id).verifiedPath(entry.content));
    const fallback = engine(f, f.rootRun, 'openai-responses', route, 'route-source');
    assert.equal(fallback.restored, false);
    assert.equal(fallback.restoreReason, 'artifact_unavailable');
    assert.deepEqual(fallback.history, []);
    assert.equal(fallback.snapshots([{ id: 'context.memory', content: 'safe fallback' }]).messages.length, 1);
});

test('policy hashes advance epoch and CAS failures leave surface and compaction journal atomic', t => {
    const f = fixture(t);
    const firstHistory = [{ role: 'user', content: 'before compaction' }];
    const secondHistory = [...firstHistory, { role: 'assistant', content: 'after compaction' }];
    const initial = engine(f, f.rootRun, 'openai-chat', 'route-atomic', 'atomic-source');
    const initialSurface = initial.persist(firstHistory, {
        sourceFingerprint: 'atomic-source', reason: 'initial', instructionHash: 'instruction-v1', toolManifestHash: 'tools-v1',
    });
    assert.equal(initialSurface.revision, 1);
    assert.equal(initialSurface.epoch, 0);

    const stale = engine(f, f.rootRun, 'openai-chat', 'route-atomic', 'atomic-source');
    const winner = engine(f, f.rootRun, 'openai-chat', 'route-atomic', 'atomic-source');
    const taskState = f.journal.saveContent(f.session.id, { state: 'compacted' }).ref;
    const compaction = { compactionId: 'compaction-1', stage: 'committed' as const, previousVersion: contextHash(firstHistory),
        nextVersion: contextHash(secondHistory), taskState };
    const committed = winner.persist(secondHistory, {
        sourceFingerprint: 'atomic-source', reason: 'compaction', instructionHash: 'instruction-v2', toolManifestHash: 'tools-v1', compaction,
    });
    assert.equal(committed.revision, 2);
    assert.equal(committed.epoch, 1);
    const beforeConflict = f.store.readJournal(f.session.id);
    assert.deepEqual(beforeConflict.map(event => event.type), ['context.surface', 'context.surface', 'context.compaction']);

    assert.throws(() => stale.persist(firstHistory, {
        sourceFingerprint: 'stale-source', reason: 'stale-compaction', compaction: { ...compaction, compactionId: 'compaction-stale' },
    }), /revision conflict/i);
    assert.deepEqual(f.store.readJournal(f.session.id), beforeConflict);
    assert.deepEqual(f.store.readContextSurface(f.session.id, 'primary'), committed);
});

test('branch source fingerprints change when the history window expands or inherited messages change', t => {
    const f = fixture(t);
    const branch = {
        ...f.session,
        id: 'branch-session',
        branchFromRunId: f.rootRun.id,
        branchMessages: [{ role: 'user' as const, content: 'inherited branch message' }],
    } satisfies SessionRecord;
    const previousA = run('branch-previous-a', branch.id);
    const previousB = run('branch-previous-b', branch.id);
    const current = run('branch-current', branch.id);
    const snapshot = {
        sessions: [f.session, branch],
        runs: [f.rootRun, previousA, previousB, current],
        approvals: [],
        artifacts: [],
    } satisfies Snapshot;
    const fingerprint = (historyTurns: number, source = branch) => contextSourceFingerprint({
        ...snapshot,
        sessions: snapshot.sessions.map(item => item.id === source.id ? source : item),
    }, {
        ...current,
        effective: { ...current.effective, modelParameters: { ...defaultModelParameters(), historyTurns } },
    });

    const narrow = fingerprint(1);
    const expanded = fingerprint(2);
    assert.notEqual(narrow, expanded, 'expanding historyTurns must invalidate the branch source fingerprint');

    const changedBranch = { ...branch, branchMessages: [{ role: 'user' as const, content: 'changed inherited branch message' }] };
    assert.notEqual(expanded, fingerprint(2, changedBranch), 'changing branchMessages must invalidate the branch source fingerprint');
});
