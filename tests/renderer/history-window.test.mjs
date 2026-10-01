import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { setTimeout as delay } from 'node:timers/promises';
import { useWorkspace } from '../../src/renderer/stores/workspace.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const run = (sessionId, number) => ({ id: `${sessionId}-${number}`, sessionId, turnId: `${sessionId}-${number}-turn`, state: 'completed', sequence: 1,
    input: `task ${number}`, output: `reply ${number}`, activities: [], createdAt: '2026-10-01T00:00:00Z', effective: { runtimeId: 'local-verification', agentId: `fixed-${sessionId}` } });
const session = id => ({ id, title: id, createdAt: id === 'a' ? '2026-10-02T00:00:00Z' : '2026-10-01T00:00:00Z', requested: { runtimeId: 'local-verification' },
    initialConfig: { agentId: 'local-verification', selection: null, directory: null, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } } });
function snapshot(server, selectedView) {
    const { sessionId, turnLimit } = selectedView;
    const records = server.runs.filter(item => item.sessionId === sessionId);
    const roots = records.filter(item => !item.parentRunId);
    const rootIds = (turnLimit === undefined ? roots : roots.slice(-turnLimit)).map(item => item.id);
    const dependencies = [roots[0]?.id, roots[1]?.id, `${sessionId}-child`];
    const rootStates = {}; const latestStates = {};
    for (const item of server.runs) {
        latestStates[item.sessionId] = { id: item.id, state: item.state };
        if (!item.parentRunId) rootStates[item.sessionId] = { id: item.id, state: item.state };
    }
    return structuredClone({ sessions: server.sessions, runs: records.filter(item => turnLimit === undefined || rootIds.includes(item.id) || dependencies.includes(item.id)),
        approvals: [], artifacts: turnLimit === undefined ? server.artifacts.filter(item => item.sessionId === sessionId) : [], viewSessionId: sessionId,
        overview: { rootStates, latestStates, activeRunIds: [] },
        ...(turnLimit !== undefined ? { historyWindow: { total: roots.length, limit: turnLimit, rootIds, hasFileChanges: server.artifacts.some(item => item.sessionId === sessionId) } } : {}) });
}
async function fixture(t, intercept) {
    const records = ['a', 'b'].flatMap(id => Array.from({ length: id === 'a' ? 120 : 70 }, (_, index) => run(id, index + 1)));
    records.push({ ...run('a', 'child'), parentRunId: 'a-1' });
    records.find(item => item.id === 'a-2').plan = { id: 'old-plan', status: 'proposed', content: 'saved plan' };
    const server = { sessions: [session('a'), session('b')], runs: records, artifacts: [{ id: 'old-change', sessionId: 'a', runId: 'a-3', path: 'old.txt', newContent: 'saved' }] };
    const calls = [];
    globalThis.window = { uah: { onEvent() { return () => {}; }, command(command, selectedView) {
        calls.push({ command, view: structuredClone(selectedView) });
        return intercept?.(command, selectedView, server) ?? Promise.resolve(snapshot(server, selectedView));
    } } };
    setActivePinia(createPinia()); const workspace = useWorkspace();
    t.after(() => workspace.dispose()); await workspace.initialize();
    return { workspace, server, calls };
}
async function settleWatch() { await nextTick(); await delay(0); }

test('initial 50-turn window excludes first-root, Plan and child dependencies from displayed runs', async t => {
    const { workspace, calls } = await fixture(t);
    assert.deepEqual(calls.map(item => item.view), [{ sessionId: null }, { sessionId: 'a', turnLimit: 50 }]);
    assert.equal(workspace.historyLimit, 50); assert.equal(workspace.historyTotal, 120);
    assert.equal(workspace.runs.length, 50); assert.equal(workspace.runs[0].id, 'a-71'); assert.equal(workspace.runs.at(-1).id, 'a-120');
    assert.ok(workspace.snapshot.runs.some(item => item.id === 'a-1'));
    assert.ok(workspace.snapshot.runs.some(item => item.id === 'a-2' && item.plan));
    assert.ok(workspace.snapshot.runs.some(item => item.parentRunId));
    assert.ok(workspace.runs.every(item => workspace.snapshot.historyWindow.rootIds.includes(item.id)));
    assert.equal(workspace.lockedAgent.agentId, 'fixed-a');
});

test('loadEarlier requests 100 turns and retains known file changes outside the visible window', async t => {
    const { workspace, calls } = await fixture(t);
    assert.equal(workspace.snapshot.artifacts.length, 0); assert.equal(workspace.snapshot.historyWindow.hasFileChanges, true);
    assert.equal(workspace.runs.some(item => item.id === 'a-3'), false);
    const pending = workspace.loadEarlier(); assert.equal(workspace.historyLoading, true); await pending;
    assert.equal(workspace.historyLoading, false); assert.equal(workspace.historyLimit, 100);
    assert.deepEqual(calls.at(-1).view, { sessionId: 'a', turnLimit: 100 });
    assert.equal(workspace.runs.length, 100); assert.equal(workspace.runs[0].id, 'a-21');
    assert.equal(workspace.snapshot.historyWindow.hasFileChanges, true);
});

test('a late 50-turn refresh is discarded while the newer 100-turn window is loading', async t => {
    const old = deferred(), newer = deferred(); let hold = false;
    const f = await fixture(t, (_command, view) => hold && view.sessionId === 'a' ? (view.turnLimit === 50 ? old.promise : newer.promise) : undefined);
    hold = true; const refreshing = f.workspace.select('a'); const loading = f.workspace.loadEarlier();
    const stale = snapshot(f.server, { sessionId: 'a', turnLimit: 50 }); stale.runs.at(-1).output = 'stale window must not replace current state';
    old.resolve(stale); await settleWatch();
    assert.equal(f.workspace.historyLimit, 100); assert.equal(f.workspace.historyLoading, true);
    assert.equal(f.workspace.snapshot.runs.some(item => item.output.includes('stale window')), false);
    assert.deepEqual(f.calls.at(-1).view, { sessionId: 'a', turnLimit: 100 });
    newer.resolve(snapshot(f.server, { sessionId: 'a', turnLimit: 100 })); await Promise.all([refreshing, loading]);
    assert.equal(f.workspace.runs.length, 100); assert.equal(f.workspace.snapshot.historyWindow.limit, 100);
});

test('session switching resets limit and cancels pending earlier-page ownership', async t => {
    const old = deferred(); let hold = false;
    const f = await fixture(t, (_command, view) => hold && view.sessionId === 'a' && view.turnLimit === 100 ? old.promise : undefined);
    hold = true; const pending = f.workspace.loadEarlier(); assert.equal(f.workspace.historyLoading, true);
    await f.workspace.select('b');
    assert.equal(f.workspace.historyLimit, 50); assert.equal(f.workspace.historyLoading, false);
    assert.deepEqual(f.calls.at(-1).view, { sessionId: 'b', turnLimit: 50 });
    old.resolve(snapshot(f.server, { sessionId: 'a', turnLimit: 100 })); await pending;
    assert.equal(f.workspace.snapshot.viewSessionId, 'b'); assert.equal(f.workspace.runs.length, 50);
    assert.ok(f.workspace.runs.every(item => item.sessionId === 'b'));
    f.workspace.newSession(); await settleWatch();
    assert.equal(f.workspace.historyLimit, 50); assert.equal(f.workspace.selectedId, null);
    assert.deepEqual(f.calls.at(-1).view, { sessionId: null });
});

for (const tab of ['files', 'plans', 'agents']) {
    test(`${tab} panel waits for a full reply and closing reloads the bounded window`, async t => {
        const full = deferred(); let hold = false;
        const f = await fixture(t, (_command, view) => hold && view.sessionId === 'a' && !Object.hasOwn(view, 'turnLimit') ? full.promise : undefined);
        hold = true; f.workspace.panel.tab = tab; f.workspace.panel.open = true; await settleWatch();
        assert.deepEqual(f.calls.at(-1).view, { sessionId: 'a' }); assert.equal(f.workspace.historyPanelReady, false);
        full.resolve(snapshot(f.server, { sessionId: 'a' })); await settleWatch();
        assert.equal(f.workspace.historyPanelReady, true); assert.equal(f.workspace.snapshot.historyWindow, undefined);
        assert.equal(f.workspace.runs.length, 120); assert.equal(f.workspace.snapshot.artifacts.length, 1);
        f.workspace.panel.open = false; await settleWatch();
        assert.deepEqual(f.calls.at(-1).view, { sessionId: 'a', turnLimit: 50 });
        assert.equal(f.workspace.runs.length, 50); assert.equal(f.workspace.snapshot.historyWindow.hasFileChanges, true);
    });
}

test('a full panel reply arriving after close cannot replace the requested window', async t => {
    const full = deferred(), bounded = deferred(); let hold = false;
    const f = await fixture(t, (_command, view) => hold && view.sessionId === 'a' ? (Object.hasOwn(view, 'turnLimit') ? bounded.promise : full.promise) : undefined);
    hold = true; f.workspace.panel.open = true; await settleWatch();
    f.workspace.panel.open = false; await settleWatch();
    full.resolve(snapshot(f.server, { sessionId: 'a' })); await settleWatch();
    assert.equal(f.workspace.panel.open, false); assert.equal(f.workspace.runs.length, 50);
    assert.equal(f.workspace.historyPanelReady, false); assert.equal(f.workspace.snapshot.artifacts.length, 0);
    assert.deepEqual(f.calls.at(-1).view, { sessionId: 'a', turnLimit: 50 });
    bounded.resolve(snapshot(f.server, { sessionId: 'a', turnLimit: 50 })); await settleWatch();
    assert.equal(f.workspace.runs.length, 50); assert.equal(f.workspace.snapshot.historyWindow.limit, 50);
});

test('switching sessions while a full panel query is pending discards its reply', async t => {
    const full = deferred(); let hold = false;
    const f = await fixture(t, (_command, view) => hold && view.sessionId === 'a' && !Object.hasOwn(view, 'turnLimit') ? full.promise : undefined);
    hold = true; f.workspace.panel.open = true; await settleWatch();
    await f.workspace.select('b'); full.resolve(snapshot(f.server, { sessionId: 'a' })); await settleWatch();
    assert.equal(f.workspace.snapshot.viewSessionId, 'b'); assert.equal(f.workspace.historyLimit, 50);
    assert.equal(f.workspace.runs.length, 50); assert.equal(f.workspace.historyPanelReady, false);
    assert.equal(f.workspace.snapshot.artifacts.length, 0);
});
