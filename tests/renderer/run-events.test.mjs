import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { computed } from 'vue';
import { setTimeout as delay } from 'node:timers/promises';
import { applyRunEvent, mergeRunSnapshot } from '../../src/renderer/run-events.js';
import { useWorkspace } from '../../src/renderer/stores/workspace.js';

const makeRun = (sessionId = 'session', id = 'run') => ({ id, sessionId, turnId: 'turn', state: 'running', sequence: 1,
    input: 'user', output: '', activities: [], createdAt: '2026-10-01T00:00:00Z', effective: { runtimeId: 'api', agentId: 'agent' } });
const makeSnapshot = (runs = [makeRun()]) => ({ sessions: [...new Set(runs.map(run => run.sessionId))].map(id => ({ id, title: id, createdAt: '2026-10-01T00:00:00Z', requested: { runtimeId: 'api' } })), runs, approvals: [], artifacts: [] });
const delta = (sequence, text, offset, extra = {}) => ({ type: 'delta', runtimeId: 'api', sessionId: 'session', runId: 'run', turnId: 'turn', sequence,
    payload: { text, offset, activityId: 'text', activityOffset: offset, ...extra } });
const reasoning = (sequence, text, offset) => ({ type: 'activity-delta', runtimeId: 'api', sessionId: 'session', runId: 'run', turnId: 'turn', sequence,
    payload: { activityId: 'reasoning', kind: 'reasoning', title: 'Thinking', text, offset } });
const deferred = () => { let resolve; const promise = new Promise(finish => { resolve = finish; }); return { promise, resolve }; };

async function workspaceFixture(t, initial = makeSnapshot(), customCommand) {
    let listener; let snapshots = 0; let server = structuredClone(initial);
    globalThis.window = { uah: {
        onEvent(callback) { listener = callback; return () => { listener = undefined; }; },
        async command(command) {
            if (command.type === 'snapshot') snapshots++;
            return customCommand ? customCommand(command, snapshots, server) : structuredClone(server);
        },
    } };
    setActivePinia(createPinia()); const workspace = useWorkspace();
    t.after(() => workspace.dispose());
    await workspace.initialize(); await workspace.select('session');
    return { workspace, emit: event => listener(event), snapshotCount: () => snapshots,
        setServer: value => { server = structuredClone(value); } };
}

test('multiple text/reasoning deltas update reactive output and real activities without snapshots; repeats are ignored', async t => {
    const f = await workspaceFixture(t);
    const output = computed(() => f.workspace.runs[0].output);
    f.emit(delta(2, 'A\ud83d\ude00', 0));
    f.emit(reasoning(3, 'thought', 0));
    f.emit(reasoning(4, ' more', 7));
    f.emit(delta(5, 'B', 3, { activityId: 'text-second', activityOffset: 0 }));
    f.emit(delta(5, 'B', 3, { activityId: 'text-second', activityOffset: 0 }));
    assert.equal(output.value, 'A\ud83d\ude00B');
    const run = f.workspace.runs[0];
    assert.equal(run.sequence, 5);
    assert.deepEqual(run.activities.map(activity => [activity.id, activity.kind, activity.content, activity.status]), [
        ['text', 'text', 'A\ud83d\ude00', 'completed'], ['reasoning', 'reasoning', 'thought more', 'running'], ['text-second', 'text', 'B', 'completed'],
    ]);
    await delay(10); assert.equal(f.snapshotCount(), 1);
});

test('offset mismatch is atomic, sequence gaps refresh once, and repaired duplicate events do not append', async t => {
    const f = await workspaceFixture(t);
    f.emit(delta(2, 'bad', 0, { activityOffset: 8 }));
    assert.equal(f.workspace.runs[0].output, ''); assert.equal(f.workspace.runs[0].sequence, 1);
    const repaired = makeSnapshot([{ ...makeRun(), sequence: 4, output: 'fixed', activities: [{ id: 'text', kind: 'text', title: '', content: 'fixed', status: 'completed' }] }]);
    f.setServer(repaired);
    f.emit(delta(4, 'missing events', 0)); f.emit(delta(4, 'missing events', 0));
    await delay(10); assert.equal(f.snapshotCount(), 2);
    assert.equal(f.workspace.runs[0].output, 'fixed');
    f.emit(delta(4, 'missing events', 0)); await delay(10); assert.equal(f.snapshotCount(), 2);
});

test('events update the owning session even after navigation, with no cross-session ID contamination', async t => {
    const f = await workspaceFixture(t, makeSnapshot([makeRun(), makeRun('other', 'other-run')]));
    f.workspace.select('other');
    f.emit(delta(2, 'background text', 0));
    assert.equal(f.workspace.selectedId, 'other'); assert.equal(f.workspace.runs[0].output, '');
    assert.equal(f.workspace.snapshot.runs.find(run => run.id === 'run').output, 'background text');
    const before = f.workspace.snapshot.runs.find(run => run.id === 'run').sequence;
    f.emit({ ...delta(3, 'wrong scope', 15), sessionId: 'other' });
    assert.equal(f.workspace.snapshot.runs.find(run => run.id === 'run').sequence, before);
    await delay(10); assert.equal(f.snapshotCount(), 2);
});

test('a slow snapshot cannot roll back newer streamed run content, but server deletion remains authoritative', async t => {
    const slow = deferred(); const initial = makeSnapshot();
    const f = await workspaceFixture(t, initial, (command, count, server) => command.type === 'snapshot' && count === 2 ? slow.promise : structuredClone(server));
    f.emit({ type: 'session-created', sessionId: 'another', runId: '', sequence: 0, payload: {} });
    await delay(5); assert.equal(f.snapshotCount(), 2);
    f.emit(delta(2, 'one', 0)); f.emit(delta(3, 'two', 3));
    slow.resolve(structuredClone(initial)); await delay(5);
    assert.equal(f.workspace.runs[0].sequence, 3); assert.equal(f.workspace.runs[0].output, 'onetwo');
    f.setServer({ ...initial, runs: [] });
    f.emit({ type: 'artifact-created', sessionId: 'session', runId: 'run', sequence: 4, turnId: 'turn', payload: {} });
    await delay(10); assert.deepEqual(f.workspace.snapshot.runs, []);
});

test('terminal run-state replaces all streamed projections and updates active-run derivation immediately', async t => {
    const f = await workspaceFixture(t);
    f.emit(delta(2, 'answer', 0)); f.emit(reasoning(3, 'reasoning', 0));
    const terminal = { ...JSON.parse(JSON.stringify(f.workspace.runs[0])), sequence: 4, state: 'completed', output: 'final answer',
        activities: [{ id: 'reasoning', kind: 'reasoning', title: 'Thought', content: 'final reasoning', status: 'completed' }], finishedAt: '2026-10-01T01:00:00Z' };
    f.emit({ type: 'run-state', sessionId: 'session', runId: 'run', turnId: 'turn', sequence: 4, payload: { run: terminal } });
    assert.equal(f.workspace.runs[0].output, 'final answer'); assert.equal(f.workspace.runs[0].activities[0].status, 'completed');
    assert.equal(f.workspace.activeRun, undefined);
    f.emit(delta(3, 'old late data', 6)); await delay(10); assert.equal(f.snapshotCount(), 1);
    assert.equal(f.workspace.runs[0].output, 'final answer');
});

test('unknown run and approval/artifact events use fallback snapshots', async t => {
    const f = await workspaceFixture(t);
    f.emit({ ...delta(2, 'unknown', 0), runId: 'missing' }); await delay(10);
    f.emit({ type: 'approval-requested', sessionId: 'session', runId: 'run', turnId: 'turn', sequence: 2, payload: {} }); await delay(10);
    f.emit({ type: 'artifact-created', sessionId: 'session', runId: 'run', turnId: 'turn', sequence: 3, payload: {} }); await delay(10);
    assert.equal(f.snapshotCount(), 4);
});

test('malformed activity kind, wrong turn, stale/mismatched run-state and legacy API delta never partially mutate a run', () => {
    const snapshot = makeSnapshot();
    const invalid = [
        { ...reasoning(2, 'bad', 0), payload: { ...reasoning(2, 'bad', 0).payload, kind: 'tool' } },
        { ...delta(2, 'bad', 0), turnId: 'other-turn' },
        { type: 'run-state', sessionId: 'session', runId: 'run', turnId: 'turn', sequence: 2, payload: { run: { ...makeRun(), sequence: 3 } } },
        { ...delta(2, 'bad', 0), payload: { text: 'bad', offset: 0 } },
    ];
    for (const event of invalid) {
        assert.equal(applyRunEvent(snapshot, event), 'refresh');
        assert.equal(snapshot.runs[0].output, ''); assert.equal(snapshot.runs[0].sequence, 1); assert.deepEqual(snapshot.runs[0].activities, []);
    }
    const local = makeSnapshot([{ ...makeRun(), effective: { runtimeId: 'local-verification' } }]);
    assert.equal(applyRunEvent(local, { ...delta(2, 'local', 0), payload: { text: 'local', offset: 0 } }), 'applied');
    assert.equal(local.runs[0].output, 'local'); assert.deepEqual(local.runs[0].activities, []);
});

test('snapshot merge scopes new runs by session/run and honors incoming membership, metadata and same-sequence updates', () => {
    const current = makeSnapshot([{ ...makeRun(), sequence: 5, output: 'newest' }, { ...makeRun('other', 'removed'), sequence: 8 }]);
    const incoming = { ...makeSnapshot([{ ...makeRun(), sequence: 3, output: 'stale' }, makeRun('third', 'created')]), approvals: [{ requestId: 'approval' }] };
    const merged = mergeRunSnapshot(current, incoming);
    assert.equal(merged.runs[0].output, 'newest'); assert.deepEqual(merged.runs.map(run => run.id), ['run', 'created']);
    assert.deepEqual(merged.approvals, [{ requestId: 'approval' }]);
    const equal = mergeRunSnapshot(current, makeSnapshot([{ ...makeRun(), sequence: 5, output: 'edited', history: { deleted: true } }]));
    assert.equal(equal.runs[0].output, 'edited'); assert.equal(equal.runs[0].history.deleted, true);
});
