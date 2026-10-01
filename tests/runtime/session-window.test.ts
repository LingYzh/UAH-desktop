import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore } from '../../src/runtime/store';
import { beginToolOutcome } from '../../src/runtime/tool-outcome';
import type { ApprovalRecord, ArtifactSnapshot, RunRecord, RuntimeEvent, SessionRecord } from '../../src/shared/contracts';

const timestamp = '2026-10-02T00:00:00.000Z';
const effective = { runtimeId: 'api', modelId: 'fixture', agentId: 'default', policyVersion: 1 };
const session = (id = 'a'): SessionRecord => ({ id, title: id, directory: null, requested: effective, createdAt: timestamp });
const run = (id: string, sessionId = 'a'): RunRecord => ({ id, sessionId, turnId: id, state: 'completed', input: `INPUT-${id}`, output: `BODY-${id}`, effective, sequence: 1, createdAt: timestamp });
const child = (id: string, parentRunId: string, sessionId = 'a'): RunRecord => ({ ...run(id, sessionId), parentRunId });
const approval = (id: string, sessionId = 'a'): ApprovalRecord => ({ runtimeId: 'api', sessionId, runId: id, turnId: id, requestId: `approval-${id}`, policyVersion: 1, status: 'pending', summary: 'fixture', path: 'file', createdAt: timestamp });
const artifact = (id: string, content = `CONTENT-${id}`): ArtifactSnapshot => ({ id: `artifact-${id}`, sessionId: 'a', runId: id, turnId: id, path: `${id}.txt`, oldContent: null, newContent: content, hash: createHash('sha256').update(content).digest('hex'), createdAt: timestamp });
const manifest = (saved: ArtifactSnapshot, sequence = 2): RuntimeEvent => ({ runtimeId: 'api', sessionId: saved.sessionId, runId: saved.runId, turnId: saved.turnId, sequence, type: 'artifact-created', payload: { artifact: saved } });
function fixture(t: { after(fn: () => void): void }) {
    const directory = mkdtempSync(join(tmpdir(), 'uah-session-window-')); const store = new RuntimeStore(directory); const db = new DatabaseSync(join(directory, 'runtime.sqlite'));
    t.after(() => { db.close(); store.close(); const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-session-window-')); rmSync(target, { recursive: true, force: true }); });
    return { store, db };
}

test('1000 tied-time roots load the insertion-order tail and first-Agent dependency, then expand coherently', t => {
    const { store } = fixture(t); const records = Array.from({ length: 1000 }, (_, index) => run(`r-${String(index).padStart(4, '0')}`));
    store.commit({ sessions: [session(), session('foreign')], runs: [...records, run('foreign-latest', 'foreign')] });
    t.mock.method(store, 'readSessionSnapshot', () => { throw new Error('Window must not materialize full-session bodies'); });
    const first = store.readSessionWindow('a', 50);
    assert.deepEqual(first.historyWindow, { total: 1000, limit: 50, rootIds: records.slice(-50).map(item => item.id), hasFileChanges: false });
    assert.deepEqual(first.runs.map(item => item.id), [records[0].id, ...records.slice(-50).map(item => item.id)]);
    assert.equal(JSON.stringify(first).includes('BODY-r-0001'), false); assert.equal(JSON.stringify(first).includes('foreign-latest'), false);
    store.commit({ runs: [{ ...records[955], output: 'EDITED CURRENT BODY', sequence: 2 }, { ...records[980], history: { deleted: true } }] });
    const expanded = store.readSessionWindow('a', 100);
    assert.equal(expanded.historyWindow.total, 1000); assert.deepEqual(expanded.historyWindow.rootIds, records.slice(-100).map(item => item.id));
    assert.equal(expanded.runs.find(item => item.id === records[955].id)?.output, 'EDITED CURRENT BODY');
    assert.equal(expanded.runs.find(item => item.id === records[980].id)?.history?.deleted, true);
});

test('retry visibility is global and the window includes predecessor subtrees without counting them as roots', t => {
    const { store } = fixture(t);
    const records = [run('z-first'), run('a-old'), child('old-child', 'a-old'), run('middle'), { ...run('latest'), retryOfRunId: 'a-old' }, child('new-child', 'latest'), child('grandchild', 'new-child'),
        { ...run('foreign-retry', 'b'), retryOfRunId: 'middle' }, child('foreign-child', 'latest', 'b')];
    store.commit({ sessions: [session(), session('b')], runs: records });
    const snapshot = store.readSessionWindow('a', 1);
    assert.deepEqual(snapshot.historyWindow.rootIds, ['latest']); assert.equal(snapshot.historyWindow.total, 3);
    assert.deepEqual(snapshot.runs.map(item => item.id), ['z-first', 'a-old', 'old-child', 'latest', 'new-child', 'grandchild']);
    const expanded = store.readSessionWindow('a', 2); assert.deepEqual(expanded.historyWindow.rootIds, ['middle', 'latest']);
    assert.ok(expanded.runs.every(item => item.sessionId === 'a'));
});

test('active Plan, execution source, live ancestors and latest root context survive outside the chat tail', t => {
    const { store } = fixture(t);
    const plan = (executionRunId?: string) => ({ id: 'plan', content: 'plan', ...(executionRunId ? { executionRunId } : {}) }) as RunRecord['plan'];
    const records = [run('first'), { ...run('active-plan'), plan: plan() }, child('plan-child', 'active-plan'), run('live-parent'), child('live-middle', 'live-parent'),
        { ...child('live-grandchild', 'live-middle'), state: 'approval' as const }, { ...run('context-root'), requestContext: { requestId: 'fixture-context' } as RunRecord['requestContext'] },
        { ...run('execution-source'), plan: plan('latest-execution') }, run('unrelated'), run('latest-execution')];
    store.commit({ sessions: [{ ...session(), activePlanRunId: 'active-plan' }], runs: records });
    const snapshot = store.readSessionWindow('a', 1);
    assert.deepEqual(snapshot.historyWindow.rootIds, ['latest-execution']); assert.equal(snapshot.historyWindow.total, 7);
    assert.deepEqual(snapshot.runs.map(item => item.id), records.filter(item => item.id !== 'unrelated').map(item => item.id));
});

test('recursive dependency cycles are finite and never cross session boundaries', t => {
    const { store } = fixture(t);
    const records = [run('first'), { ...child('cycle-a', 'cycle-b'), state: 'running' as const }, child('cycle-b', 'cycle-a'),
        { ...run('latest'), retryOfRunId: 'foreign-root' }, run('foreign-root', 'b'), child('foreign-child', 'cycle-a', 'b')];
    store.commit({ sessions: [session(), session('b')], runs: records });
    assert.deepEqual(store.readSessionWindow('a', 1).runs.map(item => item.id), ['first', 'cycle-a', 'cycle-b', 'latest']);
});

test('approvals and artifacts belong only to selected dependencies and verification ignores excluded evidence', t => {
    const { store, db } = fixture(t); const records = [run('first'), run('old'), run('latest'), child('child', 'latest')];
    const artifacts = ['old', 'latest', 'child'].map(id => artifact(id));
    store.commit({ sessions: [session()], runs: records, approvals: records.map(item => approval(item.id)), artifacts, events: artifacts.map(item => manifest(item)) });
    db.prepare('UPDATE artifacts SET data = ? WHERE id = ?').run(JSON.stringify({ ...artifacts[0], hash: '0'.repeat(64) }), artifacts[0].id);
    const selected = store.readSessionWindow('a', 1, true);
    assert.deepEqual(selected.approvals.map(item => item.runId), ['first', 'latest', 'child']);
    assert.deepEqual(selected.artifacts.map(item => item.runId), ['latest', 'child']); assert.equal(selected.historyWindow.hasFileChanges, true);
    assert.throws(() => store.readSessionSnapshot('a', true), /manifest mismatch/);
    assert.throws(() => store.readSessionWindow('a', 2, true), /manifest mismatch/);
});

for (const corruption of ['missing', 'changed', 'orphan', 'duplicate', 'hash']) test(`window verification preserves selected artifact rejection: ${corruption}`, t => {
    const { store, db } = fixture(t); const saved = artifact('latest');
    store.commit({ sessions: [session()], runs: [run('first'), run('latest')], artifacts: [saved], events: [manifest(saved)] });
    if (corruption === 'missing') db.exec('DELETE FROM artifacts');
    else if (corruption === 'orphan') db.exec('DELETE FROM events');
    else if (corruption === 'duplicate') store.commit({ events: [manifest({ ...saved, newContent: 'conflicting duplicate' }, 3)] });
    else {
        const altered = corruption === 'hash' ? { ...saved, hash: '0'.repeat(64) } : { ...saved, newContent: 'changed' };
        db.prepare('UPDATE artifacts SET data = ?').run(JSON.stringify(altered));
        if (corruption === 'hash') db.prepare('UPDATE events SET data = ?').run(JSON.stringify(manifest(altered)));
    }
    const failure = (read: () => unknown) => { try { read(); assert.fail('Expected verification failure'); } catch (error) { return (error as Error).message; } };
    assert.equal(failure(() => store.readSessionWindow('a', 1, true)), failure(() => store.readSessionSnapshot('a', true)));
});

test('window-wide effect summary catches excluded legacy and structured effects without adding their bodies', t => {
    const { store } = fixture(t); const outcome = beginToolOutcome().outcome; outcome.effectState = 'possible';
    const activity = { id: 'command', kind: 'tool' as const, title: 'run_command', content: '', status: 'failed' as const, tool: { name: 'run_command', arguments: {}, outcome } };
    store.commit({ sessions: [session()], runs: [run('first'), { ...run('excluded'), activities: [activity] }, run('latest')] });
    let selected = store.readSessionWindow('a', 1); assert.equal(selected.historyWindow.hasFileChanges, true); assert.equal(selected.runs.some(item => item.id === 'excluded'), false);
    store.commit({ runs: [{ ...run('excluded'), activities: [{ ...activity, tool: undefined, content: 'Exit code: 0\nUnsandboxed command: fixture', status: 'completed' }] }] });
    assert.equal(store.readSessionWindow('a', 1).historyWindow.hasFileChanges, true);
    const harmless = { ...outcome, effectState: 'not_started' as const };
    store.commit({ runs: [{ ...run('excluded'), activities: [{ ...activity, tool: { ...activity.tool, outcome: harmless } }] }] });
    selected = store.readSessionWindow('a', 1); assert.equal(selected.historyWindow.hasFileChanges, false);
    const saved = artifact('excluded'); store.commit({ artifacts: [saved] }); assert.equal(store.readSessionWindow('a', 1).historyWindow.hasFileChanges, true);
});

test('strict limits, empty sessions and closed store retain explicit boundary behavior', t => {
    const { store } = fixture(t); store.commit({ sessions: [session()] });
    for (const limit of [0, -1, 1.5, NaN, Infinity, 100001, Number.MAX_SAFE_INTEGER, '50', null]) assert.throws(() => store.readSessionWindow('a', limit as number), /Invalid/);
    for (const id of ['', null, 'a\n']) assert.throws(() => store.readSessionWindow(id as string, 50), /Invalid/);
    assert.throws(() => store.readSessionWindow('a', 50, 1 as never), /Invalid/);
    assert.deepEqual(store.readSessionWindow('missing', 100000, true), { sessions: [], runs: [], approvals: [], artifacts: [], historyWindow: { total: 0, limit: 100000, rootIds: [], hasFileChanges: false } });
    assert.deepEqual(store.readSessionWindow('a', 1).historyWindow.rootIds, []);
    store.close(); assert.throws(() => store.readSessionWindow('a', 50), /closed/);
});
