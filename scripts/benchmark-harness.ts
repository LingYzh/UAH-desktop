/** D00 current-store baseline. No network, executors, Electron or user databases. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import { join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore, type StoreCommit } from '../src/runtime/store.js';
import type { RunActivity, RunRecord, RuntimeEvent, SessionRecord } from '../src/shared/contracts.js';

const repeats = Number(process.argv[2] ?? 3);
assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 10, 'repeat count must be 1..10');
const artifacts = resolve('artifacts');
mkdirSync(artifacts, { recursive: true });
const root = mkdtempSync(join(artifacts, 'harness-d00-'));
const timestamp = '2026-10-01T00:00:00.000Z';
const config = { runtimeId: 'api', modelId: 'fixture', agentId: 'api-text', policyVersion: 1 };
const memory = () => ({ ...process.memoryUsage() });
const size = (path: string) => existsSync(path) ? statSync(path).size : 0;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function distribution(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    const percentile = (p: number) => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? 0;
    return { count: values.length, totalMs: values.reduce((a, b) => a + b, 0), p50Ms: percentile(.5), p95Ms: percentile(.95), maxMs: sorted.at(-1) ?? 0 };
}
function newRun(sessionId: string): RunRecord {
    return { id: randomUUID(), sessionId, turnId: randomUUID(), state: 'running', input: 'isolated fixture', output: '', effective: config, sequence: 0, createdAt: timestamp };
}
function event(run: RunRecord, type: 'delta' | 'run-state', payload: unknown): RuntimeEvent {
    return { runtimeId: run.effective.runtimeId, sessionId: run.sessionId, runId: run.id, turnId: run.turnId, sequence: run.sequence, type, payload } as RuntimeEvent;
}

class Trial {
    readonly directory: string;
    readonly store: RuntimeStore;
    readonly session: SessionRecord;
    readonly commitMs: number[] = [];
    readonly stepMs: number[] = [];
    readonly snapshotMs: number[] = [];
    readonly startMemory = memory();
    readonly peakMemory = { ...this.startMemory };
    serializedBytes = 0;
    peakMainBytes = 0;
    peakWalBytes = 0;
    readonly started = performance.now();
    constructor(readonly name: string) {
        this.directory = join(root, name);
        this.store = new RuntimeStore(this.directory);
        this.session = { id: randomUUID(), title: name, directory: null, requested: config, createdAt: timestamp };
        this.commit({ sessions: [this.session] });
    }
    sample() {
        const current = memory();
        for (const key of Object.keys(current) as Array<keyof typeof current>) this.peakMemory[key] = Math.max(this.peakMemory[key], current[key]);
        this.peakMainBytes = Math.max(this.peakMainBytes, size(join(this.directory, 'runtime.sqlite')));
        this.peakWalBytes = Math.max(this.peakWalBytes, size(join(this.directory, 'runtime.sqlite-wal')));
    }
    commit(changes: StoreCommit) {
        const start = performance.now();
        this.store.commit(changes);
        this.commitMs.push(performance.now() - start);
        // Exact UTF-8 JSON payload sizes passed to the current store serializer.
        // This second serialization is accounting only, outside commit/step latency.
        for (const key of ['sessions', 'runs', 'approvals', 'artifacts', 'events', 'contexts'] as const) {
            for (const record of changes[key] ?? []) this.serializedBytes += bytes(record);
        }
    }
    state(run: RunRecord): RunRecord {
        const start = performance.now();
        const next = { ...run, sequence: run.sequence + 1 };
        const changes = { runs: [next], events: [event(next, 'run-state', { run: structuredClone(next) })] };
        // Exclude accounting from the shape+store latency.
        const commitStart = performance.now();
        this.store.commit(changes);
        const end = performance.now();
        this.commitMs.push(end - commitStart);
        this.stepMs.push(end - start);
        this.serializedBytes += bytes(next) + bytes(changes.events[0]);
        return next;
    }
    delta(run: RunRecord, text: string): RunRecord {
        const start = performance.now();
        // Mirrors Supervisor.appendDelta API branch, including the duplicate text view.
        const activities = structuredClone(run.activities || []);
        const previous = activities.at(-1);
        if (previous?.kind === 'text') previous.content += text;
        else activities.push({ id: randomUUID(), kind: 'text', title: '', content: text, status: 'completed' });
        const next = { ...run, output: run.output + text, activities, sequence: run.sequence + 1 };
        const deltaEvent = event(next, 'delta', { text });
        const commitStart = performance.now();
        this.store.commit({ runs: [next], events: [deltaEvent] });
        const end = performance.now();
        this.commitMs.push(end - commitStart);
        this.stepMs.push(end - start);
        this.serializedBytes += bytes(next) + bytes(deltaEvent);
        return next;
    }
    snapshot(expectedRuns: number) {
        for (let i = 0; i < 30; i++) {
            const start = performance.now();
            const snapshot = this.store.readSnapshot();
            this.snapshotMs.push(performance.now() - start);
            assert.equal(snapshot.runs.length, expectedRuns);
            this.sample();
        }
    }
    finish(extra: Record<string, unknown> = {}) {
        this.sample();
        const liveDisk = { mainBytes: size(join(this.directory, 'runtime.sqlite')), walBytes: size(join(this.directory, 'runtime.sqlite-wal')), shmBytes: size(join(this.directory, 'runtime.sqlite-shm')) };
        const elapsedMs = performance.now() - this.started;
        this.store.close();
        const db = new DatabaseSync(join(this.directory, 'runtime.sqlite'), { readOnly: true });
        const counts: Record<string, number> = {};
        let persistedJsonBytes = 0;
        for (const table of ['sessions', 'runs', 'events', 'approvals', 'artifacts', 'request_contexts']) {
            const row = db.prepare(`SELECT COUNT(*) AS count, COALESCE(SUM(length(CAST(data AS BLOB))), 0) AS bytes FROM ${table}`).get() as { count: number; bytes: number };
            counts[table] = Number(row.count);
            persistedJsonBytes += Number(row.bytes);
        }
        assert.equal(db.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok');
        db.close();
        const result = { name: this.name, dataDirectory: this.directory, successfulCommitTransactions: this.commitMs.length, schemaTransactionsExcluded: 1,
            serializedBytes: this.serializedBytes, persistedJsonBytes, counts, commit: distribution(this.commitMs), shapeAndCommit: distribution(this.stepMs), snapshot: distribution(this.snapshotMs),
            totalElapsedMsIncludingInstrumentationAndSnapshots: elapsedMs, memoryStart: this.startMemory, memorySampledPeak: this.peakMemory, memoryEnd: memory(),
            liveDisk, sampledPeakMainBytes: this.peakMainBytes, sampledPeakWalBytes: this.peakWalBytes, mainBytesAfterClose: size(join(this.directory, 'runtime.sqlite')), ...extra };
        writeFileSync(join(this.directory, 'timings.json'), JSON.stringify({ commitMs: this.commitMs, stepMs: this.stepMs, snapshotMs: this.snapshotMs }, null, 2), 'utf8');
        console.log(JSON.stringify({ name: this.name, transactions: result.successfulCommitTransactions, serializedBytes: result.serializedBytes, commitP95Ms: result.commit.p95Ms, snapshotP95Ms: result.snapshot.p95Ms }));
        return result;
    }
}

const results = [];
for (let repeat = 1; repeat <= repeats; repeat++) {
    const trial = new Trial(`delta-${repeat}`);
    let run = trial.state(newRun(trial.session.id));
    const delta = 'abcdefghijklmnopqrst';
    for (let i = 0; i < 5_000; i++) {
        run = trial.delta(run, delta);
        if (i % 100 === 0) trial.sample();
    }
    run = trial.state({ ...run, state: 'completed', finishedAt: timestamp });
    assert.equal(run.output, delta.repeat(5_000));
    assert.equal(run.activities?.[0].content, run.output);
    assert.equal(trial.store.readSnapshot().runs[0].output, run.output);
    trial.snapshot(1);
    results.push(trial.finish({ outputCharacters: run.output.length, deltaCharacters: delta.length, deltaCount: 5_000 }));
}

const tools = new Trial('multi-round-tool-results');
let toolRun = tools.state(newRun(tools.session.id));
for (let i = 0; i < 8; i++) {
    const args = JSON.stringify({ path: `fixture-${i}.txt` });
    const activity: RunActivity = { id: randomUUID(), kind: 'tool', title: 'read_file', content: args, status: 'running', tool: { name: 'read_file', arguments: { path: `fixture-${i}.txt` } } };
    toolRun = tools.state({ ...toolRun, activities: [...structuredClone(toolRun.activities || []), activity] });
    const result = 'x'.repeat(64_000);
    const completed = { ...activity, content: args + '\n\n' + result, status: 'completed' as const, tool: { ...activity.tool!, result, isError: false } };
    toolRun = tools.state({ ...toolRun, activities: toolRun.activities!.map(item => item.id === completed.id ? completed : structuredClone(item)) });
    toolRun = tools.delta(toolRun, `Round ${i} complete.\n`);
    tools.sample();
}
toolRun = tools.state({ ...toolRun, state: 'completed', finishedAt: timestamp });
tools.snapshot(1);
results.push(tools.finish({ rounds: 8, resultCharactersPerRound: 64_000, note: 'Store-shaped synthetic activity updates; no tool execution or provider continuation measured.' }));

const tree = new Trial('parent-child-snapshot');
let parent = tree.state(newRun(tree.session.id));
parent = tree.delta(parent, 'p'.repeat(64_000));
for (let i = 0; i < 32; i++) {
    let child = tree.state({ ...newRun(tree.session.id), parentRunId: parent.id, depth: 1, contextMessages: [{ role: 'user', content: 'c'.repeat(64_000) }] });
    child = tree.delta(child, 'r'.repeat(64_000));
    child = tree.state({ ...child, state: 'completed', finishedAt: timestamp });
    tree.sample();
}
parent = tree.state({ ...parent, state: 'completed', finishedAt: timestamp });
tree.snapshot(33);
results.push(tree.finish({ children: 32, childContextCharacters: 64_000, childOutputCharacters: 64_000, note: 'Synthetic persisted tree only; no scheduling, child delivery, concurrency or API requests measured.' }));

const history = new Trial('run-limit-500');
let permitted500th = false;
for (let i = 0; i < 500; i++) {
    history.store.assertCanCreateRun();
    if (i === 499) permitted500th = true;
    history.state({ ...newRun(history.session.id), state: 'completed', output: 'h'.repeat(1_000), finishedAt: timestamp });
    if (i % 10 === 0) history.sample();
}
let rejected501st = '';
try { history.store.assertCanCreateRun(); } catch (error) { rejected501st = String((error as Error).message); }
assert.equal(permitted500th, true);
assert.match(rejected501st, /Run history limit reached \(500\)/);
history.snapshot(500);
results.push(history.finish({ permitted500th, rejected501st, preservedRunsAfterRejection: 500 }));

// Imported/legacy-shape evidence: commit itself has no 500-row check.
const legacy = new Trial('existing-501-direct-commit');
for (let i = 0; i < 501; i++) {
    legacy.state({ ...newRun(legacy.session.id), state: 'completed', output: 'h'.repeat(1_000), finishedAt: timestamp });
    if (i % 10 === 0) legacy.sample();
}
legacy.snapshot(501);
results.push(legacy.finish({ note: 'Direct fixture commits deliberately bypass the Supervisor creation guard; this is read/retention evidence, not a supported 501st create-run.' }));

const sources = ['src/runtime/store.ts', 'src/runtime/supervisor.ts', 'src/shared/contracts.ts'].map(path => ({ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }));
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), root, repeats,
    environment: { node: process.version, platform: process.platform, arch: process.arch, osRelease: release(), cpu: cpus()[0]?.model, cpuCount: cpus().length, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), sources },
    method: { sqlite: 'Existing RuntimeStore: WAL, synchronous FULL, no pragma changes', memory: 'process.memoryUsage sampled every 100 deltas, every scenario round and every snapshot; cumulative process/GC, not isolated attribution', disk: 'File lengths before close and main file after close; sampled peak WAL is allocated length, not cumulative disk writes', latency: 'nearest-rank p50/p95; commit includes RuntimeStore serialization and SQL; shape+commit adds clone and construction, excludes byte accounting, delivery and IPC', total: 'Includes instrumentation, initialization and 30 snapshots; not pure workload time', transactions: 'One per successful Store.commit call; schema initialization transaction excluded', serialization: 'Sum of UTF-8 JSON bytes for individual records passed to current serializer; excludes SQL/index/pages and IPC bytes', captureWatermarks: 'Unavailable in current store; no durableSeq/exportedSeq simulated' }, results };
writeFileSync(join(root, 'summary.json'), JSON.stringify(report, null, 2), 'utf8');
console.log(`Evidence: ${join(root, 'summary.json')}`);
