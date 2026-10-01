import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { RunCache } from '../../src/runtime/run-cache';
import { RuntimeStore } from '../../src/runtime/store';
import { beginToolOutcome } from '../../src/runtime/tool-outcome';
import type { RunRecord, SessionRecord } from '../../src/shared/contracts';

const timestamp = '2026-10-01T00:00:00.000Z';
const effective = { runtimeId: 'api', modelId: 'fixture-model', agentId: 'default', policyVersion: 1 };
const run = (id: string, sessionId = 'a'): RunRecord => ({ id, sessionId, turnId: id, state: 'completed', effective, sequence: 1, createdAt: timestamp, input: id, output: 'persisted' });
const session = (id: string): SessionRecord => ({ id, title: id, directory: null, requested: effective, createdAt: timestamp });

test('terminal LRU retains at most 128 records and reloads evicted runs by identity', () => {
    const saved = new Map(Array.from({ length: 1000 }, (_, index) => [String(index), run(String(index))])); const loads = new Map<string, number>();
    const cache = new RunCache(id => { loads.set(id, (loads.get(id) ?? 0) + 1); return structuredClone(saved.get(id)); }, id => [...saved.values()].filter(item => item.sessionId === id));
    for (let index = 0; index < 1000; index++) { assert.equal(cache.get(String(index))!.id, String(index)); assert.ok(cache.residentCount() <= 128); }
    assert.equal(cache.residentCount(), 128); assert.equal(cache.get('0')!.output, 'persisted'); assert.equal(loads.get('0'), 2);
    cache.get('873'); // Touching the eldest surviving record protects it from the next insert.
    saved.set('new', run('new')); cache.get('new'); cache.get('873'); assert.equal(loads.get('873'), 1);
    assert.equal(cache.get('absent'), undefined); assert.equal(cache.residentCount(), 128); assert.equal(cache.revision('a'), 0);
});

test('live and in-process recording failures survive terminal query churn', () => {
    const saved = new Map(Array.from({ length: 1000 }, (_, index) => [String(index), run(String(index))]));
    const cache = new RunCache(id => saved.get(id), id => [...saved.values()].filter(item => item.sessionId === id));
    const live = { ...run('live'), state: 'running' as const, output: 'buffered live evidence' };
    const failed = { ...run('failure'), state: 'failed' as const, harnessState: 'recording_failed' as const, output: 'only truthful memory view' };
    cache.set(live.id, live); cache.set(failed.id, failed);
    for (let index = 0; index < 1000; index++) cache.get(String(index));
    assert.equal(cache.residentCount(), 130); assert.equal(cache.get('live'), live); assert.equal(cache.get('failure'), failed);
    assert.equal(cache.revision('a'), 2); assert.equal(cache.forSession('a').find(item => item.id === 'failure'), failed);
    assert.equal(cache.residentCount(), 130, 'session queries do not retain all terminal records');
});

test('session queries preserve SQLite insertion order, root/child/plan/effect evidence and isolation without populating cache', t => {
    const directory = mkdtempSync(join(tmpdir(), 'uah-run-cache-')); const store = new RuntimeStore(directory);
    t.after(() => { store.close(); const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-run-cache-')); rmSync(target, { recursive: true, force: true }); });
    const root = run('root'); const child = { ...run('child'), parentRunId: root.id };
    const plan = { ...run('plan'), plan: { id: 'plan-version', content: 'plan evidence', filePath: 'plan.md', hash: 'a'.repeat(64), createdAt: timestamp, status: 'approved' as const } };
    const outcome = beginToolOutcome().outcome; Object.assign(outcome, { status: 'succeeded', effectState: 'confirmed', recordingState: 'durable' });
    const effect = { ...run('effect'), activities: [{ id: 'write-evidence', kind: 'tool' as const, title: 'write_file', content: 'File written.', status: 'completed' as const,
        tool: { name: 'write_file', arguments: { path: 'fixture.txt' }, result: 'File written.', outcome } }] };
    store.commit({ sessions: [session('a'), session('b')], runs: [root, run('foreign', 'b'), child, plan, effect] });
    const cache = new RunCache(id => store.readRun(id), id => store.readSessionRuns(id));
    const result = cache.forSession('a'); assert.deepEqual(result.map(item => item.id), ['root', 'child', 'plan', 'effect']);
    assert.deepEqual(result, [root, child, plan, effect]); assert.equal(cache.residentCount(), 0); assert.equal(cache.revision('a'), 0);
    assert.deepEqual(cache.forSession('b').map(item => item.id), ['foreign']); assert.deepEqual(cache.forSession('absent'), []);
    assert.equal(store.readRun('absent'), undefined); assert.equal(cache.residentCount(), 0);
});

test('overlay retains unflushed content and newly accepted runs without mixing other sessions', () => {
    const persisted = [run('old'), { ...run('live'), state: 'running' as const, output: 'disk prefix', sequence: 1 }];
    const cache = new RunCache(id => persisted.find(item => item.id === id), id => persisted.filter(item => item.sessionId === id));
    const buffered = { ...persisted[1], output: 'disk prefix + unflushed delta', sequence: 5 };
    cache.set('live', buffered); cache.set('new-live', { ...run('new-live'), state: 'running' }); cache.set('foreign-live', { ...run('foreign-live', 'b'), state: 'running' });
    const result = cache.forSession('a'); assert.deepEqual(result.map(item => item.id), ['old', 'live', 'new-live']); assert.equal(result[1], buffered);
    assert.equal(result[1].output, 'disk prefix + unflushed delta'); assert.equal(persisted[1].output, 'disk prefix');
    assert.deepEqual(cache.overlay(persisted, 'a'), result); assert.equal(cache.residentCount(), 3); assert.equal(cache.revision('a'), 2);
    assert.deepEqual(cache.forSession('b').map(item => item.id), ['foreign-live']);
});

test('reads and LRU eviction never change revisions while each set changes only its session revision', () => {
    const saved = [run('one'), run('two'), run('foreign', 'b')]; const cache = new RunCache(id => saved.find(item => item.id === id), id => saved.filter(item => item.sessionId === id), 1);
    for (const record of saved) cache.get(record.id); cache.has('one'); cache.forSession('a'); cache.overlay(saved);
    assert.equal(cache.revision('a'), 0); assert.equal(cache.revision('b'), 0);
    cache.set('one', { ...saved[0], output: 'changed' }); assert.equal(cache.revision('a'), 1);
    cache.get('two'); cache.get('one'); assert.equal(cache.revision('a'), 1);
    cache.set('foreign', { ...saved[2], output: 'changed' }); assert.equal(cache.revision('a'), 1); assert.equal(cache.revision('b'), 1);
    cache.set('one', saved[0]); assert.equal(cache.revision('a'), 2);
    assert.throws(() => cache.set('wrong-id', saved[0]), /identity mismatch/); assert.equal(cache.revision('a'), 2);
    assert.throws(() => new RunCache(() => undefined, () => [], 0), /Invalid terminal cache limit/);
});
