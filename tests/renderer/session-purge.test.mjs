import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { nextTick } from 'vue';
import { setTimeout as delay } from 'node:timers/promises';
import { useWorkspace } from '../../src/renderer/stores/workspace.js';

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const session = id => ({ id, title: id, createdAt: id === 'a' ? '2026-10-02T00:00:00Z' : '2026-10-01T00:00:00Z', requested: { runtimeId: 'local-verification' },
    initialConfig: { agentId: `default-${id}`, selection: null, directory: null, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } } });
const run = id => ({ id: `${id}-run`, sessionId: id, turnId: `${id}-turn`, state: 'completed', sequence: 1, input: 'Saved input', output: 'Deleted private reply', activities: [], createdAt: '2026-10-01T00:00:00Z', effective: { runtimeId: 'local-verification', agentId: `fixed-${id}` } });
function snapshot(server, selectedView) {
    const rows = server.runs.filter(item => item.sessionId === selectedView.sessionId);
    return structuredClone({ sessions: server.sessions, runs: rows, approvals: [], artifacts: [], viewSessionId: selectedView.sessionId,
        pendingSessionPurges: server.pending, overview: { rootStates: {}, latestStates: {}, activeRunIds: [] },
        ...(selectedView.turnLimit !== undefined ? { historyWindow: { total: rows.length, limit: selectedView.turnLimit, rootIds: rows.map(item => item.id), hasFileChanges: false } } : {}) });
}
async function fixture(t, { journal, command, pending = [] } = {}) {
    const server = { sessions: [session('a'), session('b')], runs: [], pending: [...pending] }; const calls = [];
    const remove = id => { server.sessions = server.sessions.filter(item => item.id !== id); server.runs = server.runs.filter(item => item.sessionId !== id); };
    globalThis.window = { uah: { onEvent() { return () => {}; }, command(value, selectedView) {
        calls.push({ kind: 'command', value: structuredClone(value), view: structuredClone(selectedView) });
        return command?.(value, selectedView, server) ?? Promise.resolve(snapshot(server, selectedView));
    }, journal(value) {
        calls.push({ kind: 'journal', value: structuredClone(value) });
        if (journal) return journal(value, server, remove);
        remove(value.sessionId); server.pending = server.pending.filter(id => id !== value.sessionId);
        return Promise.resolve({ sessionId: value.sessionId, completed: true });
    } } };
    setActivePinia(createPinia()); const workspace = useWorkspace(); t.after(() => workspace.dispose()); await workspace.initialize();
    return { workspace, server, calls, remove };
}
async function seedOverrides(workspace) {
    workspace.currentInput = 'Target unsent private draft'; workspace.currentModel = 'target-model-override'; workspace.currentAgent = 'target-agent-override';
    await workspace.select('b'); workspace.currentInput = 'Other draft'; workspace.currentModel = 'other-model-override'; workspace.currentAgent = 'other-agent-override';
    await workspace.select('a'); assert.equal(workspace.currentModel, 'target-model-override'); assert.equal(workspace.currentAgent, 'target-agent-override');
}
async function assertTargetOverridesRemoved(f) {
    // Reusing the identity in this isolated backend fixture makes otherwise private
    // sessionModels/sessionAgents observable through their public computed setters.
    f.server.sessions.push(session('a')); await f.workspace.select('a');
    assert.equal(f.workspace.currentInput, ''); assert.equal(f.workspace.currentModel, 'local-verification'); assert.equal(f.workspace.currentAgent, 'default-a');
    await f.workspace.select('b'); assert.equal(f.workspace.currentInput, 'Other draft'); assert.equal(f.workspace.currentModel, 'other-model-override'); assert.equal(f.workspace.currentAgent, 'other-agent-override');
}

test('confirmed purge clears target drafts, model and Agent overrides and selected state while retaining another session preferences', async t => {
    const f = await fixture(t); await seedOverrides(f.workspace); f.workspace.panel.open = true; f.workspace.draft.input = 'Stale global draft';
    const result = await f.workspace.purgeSession('a', 'review-fingerprint'); assert.equal(result.completed, true); assert.equal(f.workspace.busy, false);
    assert.deepEqual(f.calls.find(item => item.kind === 'journal').value, { action: 'purge-confirm', sessionId: 'a', fingerprint: 'review-fingerprint', confirmation: '永久删除' });
    assert.equal(f.workspace.selectedId, null); assert.equal(f.workspace.selected, undefined); assert.equal(f.workspace.panel.open, false);
    assert.equal(Object.hasOwn(f.workspace.inputs, 'a'), false); assert.equal(f.workspace.draft.input, ''); assert.equal(f.workspace.historyLimit, 50);
    assert.equal(f.workspace.snapshot.sessions.some(item => item.id === 'a'), false); await assertTargetOverridesRemoved(f);
});

test('a lost purge IPC response still clears deleted state after a fresh authoritative snapshot', async t => {
    const f = await fixture(t, { journal: async (value, _server, remove) => { remove(value.sessionId); throw new Error('Lost response after durable deletion'); } });
    await seedOverrides(f.workspace);
    await assert.rejects(f.workspace.purgeSession('a', 'fingerprint'), /Lost response/);
    assert.equal(f.workspace.busy, false); assert.equal(f.workspace.selectedId, null); assert.equal(Object.hasOwn(f.workspace.inputs, 'a'), false);
    assert.equal(f.workspace.snapshot.sessions.some(item => item.id === 'a'), false); await assertTargetOverridesRemoved(f);
});

test('selection generation rejects an old in-flight session snapshot after purge, so deleted conversation cannot reappear', async t => {
    const old = deferred(); let hold = false;
    const f = await fixture(t, { command: (_value, view) => hold && view.sessionId === 'a' ? old.promise : undefined });
    f.server.runs = [run('a')]; const stale = snapshot(f.server, { sessionId: 'a', turnLimit: 50 }); hold = true;
    const refreshing = f.workspace.select('a'); await nextTick();
    await f.workspace.purgeSession('a', 'fingerprint'); assert.equal(f.workspace.selectedId, null);
    old.resolve(stale); await refreshing; await delay(0);
    assert.equal(f.workspace.selectedId, null); assert.equal(f.workspace.snapshot.viewSessionId, null);
    assert.equal(f.workspace.snapshot.sessions.some(item => item.id === 'a'), false); assert.equal(f.workspace.snapshot.runs.some(item => item.sessionId === 'a'), false);
    assert.deepEqual(f.workspace.runs, []); assert.equal(f.workspace.busy, false);
});

test('pending snapshots remain visible, retry sends purge-retry and busy lasts through refresh until finally releases', async t => {
    const result = deferred(), refreshed = deferred(); let attempts = 0, holdFresh = false;
    const f = await fixture(t, { pending: ['deleted-session'], journal: async (value, server) => { attempts++; assert.equal(value.action, 'purge-retry'); const reply = await result.promise; if (reply.completed) server.pending = []; holdFresh = true; return reply; },
        command: () => { if (holdFresh) { holdFresh = false; return refreshed.promise; } } });
    assert.deepEqual(f.workspace.snapshot.pendingSessionPurges, ['deleted-session']);
    const retry = f.workspace.retryPurge('deleted-session'); assert.equal(f.workspace.busy, true);
    await assert.rejects(f.workspace.purgeSession('another'), /等待/); assert.equal(attempts, 1);
    result.resolve({ sessionId: 'deleted-session', completed: true }); await nextTick(); await delay(0);
    assert.equal(f.workspace.busy, true, 'refresh remains part of the guarded deletion operation');
    refreshed.resolve(snapshot(f.server, { sessionId: null })); await retry;
    assert.equal(f.workspace.busy, false); assert.deepEqual(f.workspace.snapshot.pendingSessionPurges, []);
});

test('failed pending cleanup exposes the error, retains pending and releases busy so a later retry can finish', async t => {
    let attempts = 0;
    const f = await fixture(t, { pending: ['deleted-session'], journal: async (_value, server) => { attempts++; if (attempts === 1) return { sessionId: 'deleted-session', completed: false, error: 'Backup is busy' }; server.pending = []; return { sessionId: 'deleted-session', completed: true }; } });
    await f.workspace.retryPurge('deleted-session'); assert.equal(f.workspace.error, 'Backup is busy'); assert.equal(f.workspace.busy, false);
    assert.deepEqual(f.workspace.snapshot.pendingSessionPurges, ['deleted-session']);
    await f.workspace.retryPurge('deleted-session'); assert.equal(attempts, 2); assert.equal(f.workspace.busy, false); assert.deepEqual(f.workspace.snapshot.pendingSessionPurges, []); assert.equal(f.workspace.error, '');
});

test('if purge did not delete the target, authoritative refresh preserves its selection, draft and overrides', async t => {
    const f = await fixture(t, { journal: async () => { throw new Error('Confirmation was rejected before deletion'); } }); await seedOverrides(f.workspace);
    await assert.rejects(f.workspace.purgeSession('a', 'stale'), /Confirmation was rejected/);
    assert.equal(f.workspace.busy, false); assert.equal(f.workspace.selectedId, 'a'); assert.equal(f.workspace.currentInput, 'Target unsent private draft');
    assert.equal(f.workspace.currentModel, 'target-model-override'); assert.equal(f.workspace.currentAgent, 'target-agent-override');
});

test('refresh failure after purge releases busy and reports the need to recheck durable deletion state', async t => {
    let fail = false;
    const f = await fixture(t, { journal: async (value, _server, remove) => { remove(value.sessionId); fail = true; return { sessionId: value.sessionId, completed: true }; }, command: () => fail ? Promise.reject(new Error('Snapshot IPC unavailable')) : undefined });
    const result = await f.workspace.purgeSession('a', 'fingerprint'); assert.equal(result.completed, true); assert.equal(f.workspace.busy, false);
    assert.match(f.workspace.error, /Snapshot IPC unavailable/); assert.match(f.workspace.error, /重启确认/);
});
