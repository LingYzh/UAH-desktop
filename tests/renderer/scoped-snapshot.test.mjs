import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { setTimeout as delay } from 'node:timers/promises';
import { useWorkspace } from '../../src/renderer/stores/workspace.js';
import { applyRunEvent, mergeRunSnapshot, overviewForSnapshot } from '../../src/renderer/run-events.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const run = (sessionId, id, state = 'completed') => ({ id, sessionId, turnId: id + '-turn', state, sequence: 1, input: id, output: '', activities: [],
    effective: { runtimeId: 'local-verification', agentId: 'fixed-' + sessionId }, createdAt: '2026-10-01T00:00:00Z' });
const session = id => ({ id, title: id, createdAt: id === 'a' ? '2026-10-02T00:00:00Z' : '2026-10-01T00:00:00Z',
    requested: { runtimeId: 'local-verification' }, initialConfig: { agentId: 'local-verification', selection: null, directory: null, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } } });
function view(server, sessionId) {
    const rootStates = {}; const latestStates = {}; const activeRunIds = [];
    for (const item of server.runs) {
        latestStates[item.sessionId] = { id: item.id, state: item.state };
        if (!item.parentRunId) rootStates[item.sessionId] = { id: item.id, state: item.state };
        if (['running', 'approval', 'cancelRequested', 'stopping'].includes(item.state)) activeRunIds.push(item.id);
    }
    return structuredClone({ ...server, viewSessionId: sessionId, overview: { rootStates, latestStates, activeRunIds },
        runs: server.runs.filter(item => item.sessionId === sessionId), approvals: server.approvals.filter(item => item.sessionId === sessionId), artifacts: server.artifacts.filter(item => item.sessionId === sessionId) });
}
async function fixture(t, intercept, records = [run('a', 'a-run'), run('b', 'b-run')]) {
    const server = { sessions: [session('a'), session('b')], runs: records, approvals: [], artifacts: [] }; const calls = []; let listener;
    globalThis.window = { uah: { onEvent(fn) { listener = fn; return () => { listener = undefined; }; },
        async command(command, selectedView) { calls.push({ command, view: selectedView }); return intercept?.(command, selectedView, server) ?? view(server, selectedView.sessionId); } } };
    setActivePinia(createPinia()); const workspace = useWorkspace(); t.after(() => workspace.dispose()); await workspace.initialize();
    return { workspace, server, calls, emit: event => listener(event), snapshots: () => calls.filter(item => item.command.type === 'snapshot') };
}
const stateEvent = record => ({ type: 'run-state', sessionId: record.sessionId, runId: record.id, turnId: record.turnId, sequence: record.sequence, payload: { run: structuredClone(record) } });

test('legacy full snapshots retain sidebar root states, last-any-run search states and global activity counts', () => {
    const snapshot = { runs: [run('a', 'a-root', 'running'), run('b', 'b-root', 'approval'), { ...run('a', 'a-child'), parentRunId: 'a-root' }] };
    assert.deepEqual(overviewForSnapshot(snapshot), { rootStates: { a: { id: 'a-root', state: 'running' }, b: { id: 'b-root', state: 'approval' } },
        latestStates: { a: { id: 'a-child', state: 'completed' }, b: { id: 'b-root', state: 'approval' } }, activeRunIds: ['a-root', 'b-root'] });
    const scoped = { ...snapshot, overview: { rootStates: { c: { id: 'c-run', state: 'failed' } }, latestStates: {}, activeRunIds: [] } };
    assert.equal(overviewForSnapshot(scoped), scoped.overview);
});

test('initialize loads a new-session overview without a session body until a history item is selected', async t => {
    const f = await fixture(t); assert.deepEqual(f.snapshots().map(call => call.view.sessionId), [null]);
    assert.equal(f.workspace.selectedId, null); assert.equal(f.workspace.snapshot.viewSessionId, null); assert.deepEqual(f.workspace.snapshot.runs, []);
    assert.equal(f.workspace.snapshot.sessions.length, 2); assert.equal(f.workspace.snapshot.overview.rootStates.b.id, 'b-run');
    await f.workspace.select('a'); assert.deepEqual(f.snapshots().map(call => call.view.sessionId), [null, 'a']);
    assert.equal(f.workspace.snapshot.viewSessionId, 'a'); assert.deepEqual(f.workspace.snapshot.runs.map(item => item.sessionId), ['a']);
    await f.workspace.select('b'); assert.equal(f.workspace.snapshot.viewSessionId, 'b'); assert.deepEqual(f.workspace.runs.map(item => item.id), ['b-run']);
    f.workspace.newSession(); await delay(10); assert.equal(f.workspace.snapshot.viewSessionId, null); assert.deepEqual(f.workspace.snapshot.runs, []);
});

test('an explicit selection starts a session query while an event-triggered overview query remains pending', async t => {
    const server = { sessions: [session('a'), session('b')], runs: [run('a', 'a-run')], approvals: [], artifacts: [] };
    const endpointsEntered = deferred(); const endpointsGate = deferred(); const pendingStarted = deferred(); const overviewGate = deferred();
    const calls = []; let listener; let overviewQueries = 0;
    globalThis.window = { uah: {
        onEvent(fn) { listener = fn; return () => { listener = undefined; }; },
        endpoints() { endpointsEntered.resolve(); return endpointsGate.promise; },
        command(_command, selectedView) { calls.push(selectedView.sessionId);
            if (selectedView.sessionId === null && ++overviewQueries === 2) { pendingStarted.resolve(); return overviewGate.promise; }
            return Promise.resolve(view(server, selectedView.sessionId)); },
    } };
    setActivePinia(createPinia()); const workspace = useWorkspace(); t.after(() => workspace.dispose()); const initialized = workspace.initialize();
    await endpointsEntered.promise; listener({ type: 'session-created', sessionId: 'b', runId: '', sequence: 0, payload: {} }); await pendingStarted.promise;
    endpointsGate.resolve({ endpoints: [] }); await initialized;
    assert.deepEqual(calls, [null, null]); assert.equal(workspace.ready, true); assert.equal(workspace.selectedId, null);
    const selecting = workspace.select('a');
    assert.deepEqual(calls, [null, null, 'a']); await selecting;
    assert.equal(workspace.snapshot.viewSessionId, 'a'); assert.equal(workspace.runs[0].id, 'a-run');
    overviewGate.resolve(view(server, null)); await delay(10); assert.equal(workspace.snapshot.viewSessionId, 'a'); assert.equal(workspace.runs[0].id, 'a-run');
});

test('a late old-session refresh cannot overwrite a newer selection or temporarily unlock its Agent', async t => {
    const slow = deferred(); let hold = false;
    const f = await fixture(t, (command, selectedView) => hold && command.type === 'snapshot' && selectedView.sessionId === 'b' ? slow.promise : undefined);
    await f.workspace.select('a');
    hold = true; const pending = f.workspace.select('b'); assert.equal(f.workspace.agentLocked, true); assert.equal(f.workspace.configurationReady, false);
    const agent = f.workspace.currentAgent; f.workspace.currentAgent = 'unwanted-override'; assert.equal(f.workspace.currentAgent, agent);
    f.workspace.currentInput = 'Must not send while this view is loading'; await f.workspace.send();
    assert.equal(f.calls.some(call => call.command.type === 'start-run'), false);
    await f.workspace.select('a'); slow.resolve(view(f.server, 'b')); await pending;
    assert.equal(f.workspace.selectedId, 'a'); assert.equal(f.workspace.snapshot.viewSessionId, 'a'); assert.equal(f.workspace.runs[0].id, 'a-run');
    assert.equal(f.workspace.lockedAgent.agentId, 'fixed-a'); assert.equal(f.workspace.configurationReady, true);
});

test('a late mutation reply for the old session cannot replace the current session body', async t => {
    const slow = deferred(); const f = await fixture(t, command => command.type === 'edit-reply' ? slow.promise : undefined);
    await f.workspace.select('a');
    const pending = f.workspace.historyCommand({ type: 'edit-reply', runId: 'a-run', output: 'edited' }); await f.workspace.select('b');
    slow.resolve(view(f.server, 'a')); await pending; await delay(10);
    assert.equal(f.workspace.selectedId, 'b'); assert.equal(f.workspace.snapshot.viewSessionId, 'b'); assert.deepEqual(f.workspace.runs.map(item => item.id), ['b-run']);
    assert.equal(f.calls.find(call => call.command.type === 'edit-reply').view.sessionId, 'a');
});

test('other-session token deltas are ignored while run-state and new-run events refresh overview', async t => {
    const f = await fixture(t, undefined, [run('a', 'a-run', 'running'), run('b', 'b-run', 'running')]);
    await f.workspace.select('a');
    for (let sequence = 2; sequence < 100; sequence++) f.emit({ type: 'delta', sessionId: 'b', runId: 'b-run', turnId: 'b-run-turn', sequence, payload: { text: 'foreign', offset: 0 } });
    await delay(10); assert.equal(f.snapshots().length, 2); assert.equal(f.workspace.runs[0].output, '');
    const completed = { ...f.server.runs[0], state: 'completed', sequence: 2 }; f.server.runs[0] = completed; f.emit(stateEvent(completed));
    assert.equal(f.workspace.snapshot.overview.rootStates.a.state, 'completed'); assert.equal(f.workspace.snapshot.overview.latestStates.a.state, 'completed');
    assert.deepEqual(f.workspace.snapshot.overview.activeRunIds, ['b-run']); assert.equal(f.workspace.activeRun, undefined);
    f.server.runs[1] = { ...f.server.runs[1], state: 'stopped', sequence: 2 }; f.emit(stateEvent(f.server.runs[1])); await delay(10);
    assert.equal(f.workspace.snapshot.overview.rootStates.b.state, 'stopped'); assert.deepEqual(f.workspace.snapshot.overview.activeRunIds, []);
    const created = run('a', 'a-new', 'running'); f.server.runs.push(created); f.emit(stateEvent(created)); await delay(10);
    assert.equal(f.workspace.snapshot.overview.rootStates.a.id, 'a-new'); assert.deepEqual(f.workspace.snapshot.overview.activeRunIds, ['a-new']);
    assert.equal(f.workspace.activeRun.id, 'a-new'); assert.equal(f.snapshots().length, 4);
});

test('a session created during navigation is still discovered without stealing the new selection', async t => {
    const created = deferred(); const f = await fixture(t, (command, selectedView, server) => {
        if (command.type === 'create-session') return created.promise;
        if (command.type === 'start-run') { server.runs.push(run(command.sessionId, 'new-session-run')); return view(server, selectedView.sessionId); }
    });
    f.workspace.newSession(); await delay(10); f.workspace.currentInput = 'new task'; f.workspace.draft.directoryChosen = true; f.workspace.draft.model = 'local-verification';
    const pending = f.workspace.send(); assert.equal(f.calls.at(-1).command.type, 'create-session'); await f.workspace.select('a');
    f.server.sessions.push(session('created')); created.resolve(view(f.server, null)); await pending; await delay(10);
    assert.equal(f.calls.find(call => call.command.type === 'start-run').command.sessionId, 'created');
    assert.equal(f.workspace.selectedId, 'a'); assert.equal(f.workspace.snapshot.viewSessionId, 'a'); assert.equal(f.workspace.runs[0].sessionId, 'a');
    assert.ok(f.workspace.snapshot.sessions.some(item => item.id === 'created'));
});

test('same-view merge retains newer streamed content and repairs its summary, while mismatched views are rejected', () => {
    const server = { sessions: [session('a'), session('b')], runs: [run('a', 'a-run', 'running')], approvals: [], artifacts: [] };
    const current = view(server, 'a'); const terminal = { ...current.runs[0], state: 'completed', sequence: 2, output: 'new output' };
    assert.equal(applyRunEvent(current, stateEvent(terminal)), 'applied'); const incoming = view(server, 'a');
    const merged = mergeRunSnapshot(current, incoming, 'a'); assert.equal(merged.runs[0].output, 'new output');
    assert.equal(merged.overview.rootStates.a.state, 'completed'); assert.deepEqual(merged.overview.activeRunIds, []);
    assert.equal(mergeRunSnapshot(merged, view(server, 'b'), 'a'), merged);
    assert.equal(applyRunEvent(view(server, null), { type: 'activity-delta', sessionId: 'a', runId: 'a-run', payload: {} }), 'ignored');
});
