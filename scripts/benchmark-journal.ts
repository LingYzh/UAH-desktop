/** D03 real SQLite/JSONL and Windows Job cancellation evidence, isolated from user data. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { cpus, release } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import { RuntimeStore, type StoreCommit } from '../src/runtime/store';
import { RunJournal } from '../src/runtime/run-journal';
import { WindowsExecutionBackend } from '../src/runtime/execution-backend';
import type { RunRecord } from '../src/shared/contracts';

const repeats = Number(process.argv[2] ?? 3);
assert.ok(Number.isSafeInteger(repeats) && repeats >= 1 && repeats <= 10, 'Repeat count must be 1..10');
const artifacts = path.resolve('artifacts'); mkdirSync(artifacts, { recursive: true });
const root = mkdtempSync(path.join(artifacts, 'harness-d03-'));
const timestamp = new Date().toISOString();
const size = (file: string) => existsSync(file) ? statSync(file).size : 0;
const byteLength = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function distribution(values: number[]) {
    const sorted = [...values].sort((a, b) => a - b);
    return { count: values.length, totalMs: values.reduce((a, b) => a + b, 0), p50Ms: sorted[Math.max(0, Math.ceil(sorted.length * .5) - 1)] ?? 0,
        p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0, maxMs: sorted.at(-1) ?? 0 };
}
function directoryBytes(directory: string): number {
    if (!existsSync(directory)) return 0;
    return readdirSync(directory, { withFileTypes: true }).reduce((sum, entry) => sum + (entry.isDirectory()
        ? directoryBytes(path.join(directory, entry.name)) : statSync(path.join(directory, entry.name)).size), 0);
}

function storageTrial(repeat: number) {
    const directory = path.join(root, `delta-${repeat}`);
    const memoryStart = process.memoryUsage(); const memoryPeak = { ...memoryStart };
    let peakSqliteBytes = 0; let peakWalBytes = 0; let storeTransactions = 0; let exportWatermarkTransactions = 0;
    let recordSerializedBytes = 0; let canonicalSerializedBytes = 0; let accountingMs = 0;
    const storeCommitMs: number[] = []; const flushBatchMs: number[] = []; const snapshotCharacters: number[] = [];
    const started = performance.now();
    const store = new RuntimeStore(directory);
    const sample = () => {
        const memory = process.memoryUsage();
        for (const key of Object.keys(memory) as Array<keyof typeof memory>) memoryPeak[key] = Math.max(memoryPeak[key], memory[key]);
        peakSqliteBytes = Math.max(peakSqliteBytes, size(path.join(directory, 'runtime.sqlite')));
        peakWalBytes = Math.max(peakWalBytes, size(path.join(directory, 'runtime.sqlite-wal')));
    };
    const originalCommit = store.commit.bind(store);
    store.commit = (changes: StoreCommit) => {
        const begin = performance.now(); originalCommit(changes); storeCommitMs.push(performance.now() - begin); storeTransactions++;
        const counting = performance.now();
        for (const key of ['sessions', 'runs', 'approvals', 'artifacts', 'events', 'contexts'] as const) {
            for (const record of changes[key] ?? []) recordSerializedBytes += byteLength(record);
        }
        for (const event of changes.journal ?? []) canonicalSerializedBytes += byteLength(event);
        for (const run of changes.runs ?? []) snapshotCharacters.push(run.output.length);
        accountingMs += performance.now() - counting;
    };
    const originalExport = store.markExported.bind(store);
    store.markExported = (sessionId: string, seq: number) => { originalExport(sessionId, seq); exportWatermarkTransactions++; };
    const run: RunRecord = { id: randomUUID(), sessionId: randomUUID(), turnId: randomUUID(), state: 'running', input: 'isolated benchmark', output: '', sequence: 0,
        createdAt: timestamp, effective: { runtimeId: 'api', modelId: 'fixture', agentId: 'api-text', policyVersion: 1 },
        activities: [{ id: randomUUID(), kind: 'text', title: '', content: '', status: 'running' }] };
    const journal = new RunJournal(store, directory, id => id === run.id ? run : undefined, () => { throw new Error('Benchmark canonical journal failed'); });
    const originalFlush = journal.flush.bind(journal);
    journal.flush = () => {
        const commitsBefore = storeTransactions; const accountingBefore = accountingMs; const begin = performance.now();
        originalFlush();
        if (storeTransactions > commitsBefore) flushBatchMs.push(Math.max(0, performance.now() - begin - (accountingMs - accountingBefore)));
    };
    store.commit({ sessions: [{ id: run.sessionId, title: `D03 delta ${repeat}`, directory: null, requested: run.effective, createdAt: timestamp }], runs: [run] });
    journal.event(run, 'run.state', { state: 'waiting_model', reason: null }, { runs: [run] });
    const requestId = randomUUID(); const attemptId = randomUUID(); const chunk = 'abcdefghijklmnopqrst';
    for (let offset = 0; offset < 100_000; offset += chunk.length) {
        run.output += chunk; run.activities![0].content += chunk; run.sequence++;
        journal.delta(run, { requestId, attemptId, blockId: `${attemptId}:text`, offset, offsetUnit: 'utf16', text: chunk });
        if (offset % 2000 === 0) sample();
    }
    run.state = 'completed'; run.activities![0].status = 'completed'; run.finishedAt = new Date().toISOString();
    journal.event(run, 'response.terminal', { requestId, attemptId, status: 'completed', partial: false }, { runs: [run] });
    const events = []; let afterSeq = 0;
    for (;;) { const page = store.readJournal(run.sessionId, afterSeq, 1000); if (!page.length) break; events.push(...page); afterSeq = page.at(-1)!.sessionSeq; }
    const deltas = events.filter(event => event.type === 'response.delta');
    assert.equal(deltas.length, 5000); assert.equal(deltas.map(event => event.payload.text).join(''), run.output);
    for (const [index, event] of deltas.entries()) assert.equal(event.payload.offset, index * 20);
    assert.equal(store.readSnapshot().runs[0].output, chunk.repeat(5000));
    assert.equal(store.readSnapshot().runs[0].activities![0].content, run.output);
    const sessionDirectory = path.join(directory, 'sessions', createHash('sha256').update(JSON.stringify(run.sessionId)).digest('hex'));
    const jsonl = path.join(sessionDirectory, 'transcript.jsonl');
    assert.equal(readFileSync(jsonl, 'utf8'), events.map(event => JSON.stringify(event) + '\n').join(''));
    const watermark = store.journalWatermark(run.sessionId); assert.equal(watermark.durableSeq, watermark.exportedSeq);
    sample();
    const elapsedMsIncludingInstrumentation = performance.now() - started;
    const liveDisk = { sqliteBytes: size(path.join(directory, 'runtime.sqlite')), walBytes: size(path.join(directory, 'runtime.sqlite-wal')),
        shmBytes: size(path.join(directory, 'runtime.sqlite-shm')), jsonlBytes: size(jsonl), artifactBytes: directoryBytes(path.join(sessionDirectory, 'artifacts')),
        restrictedArtifactBytes: directoryBytes(path.join(sessionDirectory, 'restricted')), manifestBytes: size(path.join(sessionDirectory, 'manifest.json')) };
    journal.close(); store.close();
    const database = new DatabaseSync(path.join(directory, 'runtime.sqlite'), { readOnly: true });
    assert.equal(database.prepare('PRAGMA integrity_check').get()?.integrity_check, 'ok'); database.close();
    const result = { repeat, dataDirectory: directory, outputCharacters: run.output.length, deltaCharacters: 20, deltaCount: 5000,
        storeCommitTransactions: storeTransactions, exportWatermarkTransactions, measuredSuccessfulTransactions: storeTransactions + exportWatermarkTransactions,
        schemaInitializationTransactionsExcluded: 1, recordSerializedBytes, canonicalSerializedBytes, totalSerializedBytes: recordSerializedBytes + canonicalSerializedBytes,
        materializedRunSnapshots: snapshotCharacters.length, materializedOutputCharacters: snapshotCharacters.reduce((sum, length) => sum + length, 0),
        storeCommit: distribution(storeCommitMs), flushBatch: distribution(flushBatchMs), elapsedMsIncludingInstrumentation,
        memoryStart, memorySampledPeak: memoryPeak, memoryEnd: process.memoryUsage(), liveDisk, sampledPeakSqliteBytes: peakSqliteBytes,
        sampledPeakWalBytes: peakWalBytes, sqliteBytesAfterClose: size(path.join(directory, 'runtime.sqlite')), watermark };
    writeFileSync(path.join(directory, 'timings.json'), JSON.stringify({ storeCommitMs, flushBatchMs, snapshotCharacters }, null, 2), 'utf8');
    console.log(JSON.stringify({ repeat, transactions: result.measuredSuccessfulTransactions, serializedBytes: result.totalSerializedBytes,
        flushP95Ms: result.flushBatch.p95Ms, elapsedMs: elapsedMsIncludingInstrumentation }));
    return result;
}

async function cancellationTrials() {
    if (process.platform !== 'win32') return { availability: 'unavailable', reason: 'Windows Job backend requires Windows' };
    const directory = path.join(root, 'command-cancellation'); mkdirSync(directory);
    const backend = new WindowsExecutionBackend({ dataDirectory: directory });
    let ensureAvailableMs: number | undefined;
    const samples: Array<{ repeat: number; executionId: string; activeProcessesBeforeCancel: number; cancelToTreeExitedAndDrainedMs: number; stdoutBytes: number; stderrBytes: number }> = [];
    let closeOwnedMs: number | undefined;
    try {
        const warming = performance.now(); await backend.ensureAvailable(); ensureAvailableMs = performance.now() - warming;
        const childEncoded = Buffer.from('Start-Sleep -Seconds 60', 'utf16le').toString('base64');
        const command = `$exe = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'; Start-Process -FilePath $exe -ArgumentList '-NoProfile -NonInteractive -EncodedCommand ${childEncoded}' -WindowStyle Hidden; Write-Output 'child-started'; Start-Sleep -Seconds 60`;
        for (let repeat = 1; repeat <= 3; repeat++) {
            let state = await backend.start({ command, cwd: directory, timeoutMs: 120000 });
            const readyDeadline = performance.now() + 10000;
            while (!(state.activeProcesses >= 2 && state.stdoutBytes > 0)) {
                assert.equal(state.status, 'running'); assert.ok(performance.now() < readyDeadline, 'Child tree readiness was not observed');
                await delay(25); state = (await backend.poll(state.executionId, 'stdout', 0, 65536)).snapshot;
            }
            assert.match(Buffer.from((await backend.poll(state.executionId, 'stdout', 0, 65536)).base64, 'base64').toString('utf8'), /child-started/);
            const activeProcessesBeforeCancel = state.activeProcesses; const begin = performance.now();
            state = await backend.cancel(state.executionId);
            while (!state.treeExited || !state.outputDrained) state = await backend.wait(state.executionId, 1000);
            const cancelToTreeExitedAndDrainedMs = performance.now() - begin;
            assert.equal(state.status, 'cancelled'); assert.equal(state.activeProcesses, 0);
            samples.push({ repeat, executionId: state.executionId, activeProcessesBeforeCancel, cancelToTreeExitedAndDrainedMs, stdoutBytes: state.stdoutBytes, stderrBytes: state.stderrBytes });
        }
    } finally { const begin = performance.now(); await backend.close(); closeOwnedMs = performance.now() - begin; }
    return { availability: 'measured', dataDirectory: directory, ensureAvailableMs, closeOwnedMs, samples,
        cancellation: distribution(samples.map(sample => sample.cancelToTreeExitedAndDrainedMs)), outputArtifactBytes: directoryBytes(path.join(directory, 'executions')) };
}

const storage = [];
for (let repeat = 1; repeat <= repeats; repeat++) storage.push(storageTrial(repeat));
const cancellation = await cancellationTrials();
const hashes = Object.fromEntries(['scripts/benchmark-journal.ts', 'src/runtime/run-journal.ts', 'src/runtime/store.ts', 'src/runtime/transcript-writer.ts', 'src/runtime/execution-backend.ts',
    'native/UAH.ExecutionHelper/Execution.cs', 'native/UAH.ExecutionHelper/Native.cs', 'native/UAH.ExecutionHelper/Program.cs',
    'native/UAH.ExecutionHelper/bin/Release/net10.0-windows/UAH.ExecutionHelper.exe',
    'native/UAH.ExecutionHelper/bin/Release/net10.0-windows/UAH.ExecutionHelper.dll'].filter(file => existsSync(file)).map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const summary = { schemaVersion: 1, measuredAt: timestamp, evidenceDirectory: root, environment: { node: process.version, platform: process.platform, arch: process.arch,
    osRelease: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, gitHead: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() }, sourceHashes: hashes,
    storage, cancellation, measurementNotes: [
        'Store.commit transactions plus successful export watermark updates are counted; schema initialization is excluded. No system SQLite trace or physical disk I/O measurement.',
        'JSON serialization input bytes count records and canonical events separately; superseded snapshots are included. SQL pages, indexes and JSONL LF bytes are excluded.',
        'Flush batch latency includes canonical commit and synchronous JSONL/manifest projection, excluding the second JSON serialization used only for byte accounting. Terminal direct commit is in storeCommit but not flushBatch.',
        'Disk metrics are file lengths and sampled WAL maxima, not cumulative bytes written. Peak memory is sampled process memory, not isolated per-run or instantaneous peak.',
        'Elapsed includes initialization, accounting, assertions, snapshots and memory/file sampling; trials run sequentially in one process with no forced GC or machine isolation.',
        'Pure text trials create no payload artifacts; zero artifactBytes is expected and does not measure large provider/native/output artifact workloads.',
        'Cancellation starts after helper capability warmup and observed child tree readiness; it measures cancel request through confirmed Job tree exit plus output drain, not UI stop latency.',
    ] };
writeFileSync(path.join(root, 'summary.json'), JSON.stringify(summary, null, 2), 'utf8');
console.log(JSON.stringify({ evidence: path.join(root, 'summary.json'), cancellation }));
