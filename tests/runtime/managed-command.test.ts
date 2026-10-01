import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { WindowsExecutionBackend } from '../../src/runtime/execution-backend';
import { managedCommand } from '../../src/runtime/managed-command';
import { beginToolOutcome } from '../../src/runtime/tool-outcome';
import type { ArtifactReference } from '../../src/shared/harness-contracts';

async function fixture(t: { after(fn: () => Promise<void>): void }, missing = false) {
    const directory = await mkdtemp(path.join(tmpdir(), 'uah-managed-command-'));
    const backend = new WindowsExecutionBackend({ dataDirectory: path.join(directory, 'managed'),
        ...(missing ? { helperPath: path.join(directory, 'missing-helper.exe') } : {}) });
    t.after(async () => {
        await backend.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
        assert.ok(path.basename(directory).startsWith('uah-managed-command-'));
        await rm(directory, { recursive: true, force: true });
    });
    return { directory, backend };
}
const reference = (): ArtifactReference => ({ availability: 'external_reference_only', relativePath: null, sha256: null,
    byteLength: null, externalReference: 'fixture-only-output', mediaType: 'application/octet-stream', missingReason: 'test fixture' });

test('credential filtering capability failure remains not_started and never dispatches or exposes diagnostics', async () => {
    const outcome = beginToolOutcome().outcome;
    const secrets = ['private-test-credential'];
    let starts = 0;
    const backend = {
        ensureAvailable: async (received: readonly string[]) => {
            assert.equal(received, secrets);
            assert.equal(outcome.effectState, 'not_started');
            throw new Error(`credential filtering unavailable: ${secrets[0]}`);
        },
        start: async () => { starts++; throw new Error('must not start'); },
    } as unknown as WindowsExecutionBackend;
    const result = await managedCommand(backend, { executionId: randomUUID(), command: 'never dispatched',
        cwd: path.resolve('.'), timeoutSeconds: 5, signal: new AbortController().signal, redactSecrets: secrets, saveOutput: reference }, outcome);
    assert.equal(starts, 0); assert.equal(result.isError, true);
    assert.equal(outcome.effectState, 'not_started'); assert.equal(outcome.retryClass, 'safe');
    assert.equal(outcome.errorCode, 'EXECUTION_BACKEND_UNAVAILABLE');
    assert.equal(JSON.stringify({ result, outcome }).includes(secrets[0]), false);
});

test('managed command forwards credentials after admission and identifies filtered artifacts without claiming raw originals', async () => {
    const outcome = beginToolOutcome().outcome;
    const executionId = randomUUID(); const secrets = ['private-test-credential'];
    const filtered = Buffer.from('before [REDACTED] after'); const saved: Buffer[] = []; const calls: string[] = [];
    const state = { executionId, status: 'completed', reason: null, exitCode: 0, jobAssigned: true,
        activeProcesses: 0, treeExited: true, outputDrained: true, stdoutPath: 'fixture-stdout', stderrPath: 'fixture-stderr',
        stdoutBytes: filtered.length, stderrBytes: 0, elapsedMs: 1, outputRedacted: true };
    const backend = {
        ensureAvailable: async (received: readonly string[]) => { calls.push('available'); assert.equal(received, secrets); assert.equal(outcome.effectState, 'not_started'); },
        start: async (input: { redactSecrets: readonly string[] }) => {
            calls.push('start'); assert.equal(input.redactSecrets, secrets); assert.equal(outcome.effectState, 'possible'); return state;
        },
        poll: async (_id: string, stream: string) => {
            const bytes = stream === 'stdout' ? filtered : Buffer.alloc(0);
            return { executionId, stream, offset: 0, nextOffset: bytes.length, base64: bytes.toString('base64'), hasMore: false, snapshot: state };
        },
        release: async (id: string) => { calls.push('release'); assert.equal(id, executionId); },
    } as unknown as WindowsExecutionBackend;
    const result = await managedCommand(backend, { executionId, command: 'fixture only', cwd: path.resolve('.'),
        timeoutSeconds: 5, signal: new AbortController().signal, redactSecrets: secrets,
        saveOutput: bytes => { saved.push(Buffer.from(bytes)); return reference(); } }, outcome);
    assert.deepEqual(calls, ['available', 'start', 'release']);
    assert.equal(result.isError, false); assert.equal(outcome.executionEvidence?.outputRedacted, true);
    assert.match(result.content, /Credential-filtered stdout artifact/);
    assert.match(result.content, /Credential-filtered stderr artifact/);
    assert.match(result.content, /original output is not retained/);
    assert.doesNotMatch(result.content, /Raw (stdout|stderr) artifact/);
    assert.equal(result.content.includes(secrets[0]), false);
    assert.deepEqual(saved, [filtered, Buffer.alloc(0)]);
});

test('managed command retains no-secret compatibility with legacy snapshots lacking redaction flag', async () => {
    const outcome = beginToolOutcome().outcome; const executionId = randomUUID();
    const state = { executionId, status: 'completed', reason: null, exitCode: 0, jobAssigned: true,
        activeProcesses: 0, treeExited: true, outputDrained: true, stdoutBytes: 0, stderrBytes: 0, elapsedMs: 1 };
    const backend = {
        ensureAvailable: async (secrets: unknown) => { assert.equal(secrets, undefined); },
        start: async (input: object) => { assert.equal(Object.hasOwn(input, 'redactSecrets'), false); return state; },
        poll: async () => ({ base64: '', nextOffset: 0, hasMore: false, snapshot: state }), release: async () => {},
    } as unknown as WindowsExecutionBackend;
    const result = await managedCommand(backend, { executionId, command: 'fixture', cwd: path.resolve('.'),
        timeoutSeconds: 5, signal: new AbortController().signal, saveOutput: reference }, outcome);
    assert.equal(result.isError, false); assert.equal(outcome.executionEvidence?.outputRedacted, undefined);
    assert.equal(outcome.executionEvidence?.provenance?.shellVersion, 'unknown');
    assert.equal(outcome.executionEvidence?.provenance?.commandArgumentCapture, 'omitted');
    assert.match(result.content, /Raw stdout artifact/); assert.doesNotMatch(result.content, /Credential-filtered/);
});

test('lost start acknowledgment retains filtered invocation provenance without recording a second command channel', async () => {
    const outcome = beginToolOutcome().outcome; const secret = 'local-provenance-secret'; const executionId = randomUUID();
    const cwd = path.resolve('fixture-' + secret); const command = `Write-Output '${secret}'`; let starts = 0;
    const backend = { ensureAvailable: async () => {}, executionProvenance: (input: { cwd: string; timeoutMs: number }) => ({
        shell: 'C:/Windows/powershell.exe', shellVersion: '10.0.12345.1', shellVersionSource: 'executable_file_version',
        arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '[command recorded in tool invocation]'],
        commandEncoding: 'utf16le-base64', outputEncoding: 'raw_bytes_command_specific', commandArgumentCapture: 'omitted',
        cwd: input.cwd, timeoutMs: input.timeoutMs, maxOutputBytes: 16777216, redacted: false }),
        start: async (input: { command: string }) => { starts++; assert.equal(input.command, command); throw new Error('lost acknowledgment'); },
    } as unknown as WindowsExecutionBackend;
    const result = await managedCommand(backend, { executionId, cwd, command, timeoutSeconds: 7, signal: new AbortController().signal, redactSecrets: [secret], saveOutput: reference }, outcome);
    assert.equal(starts, 1); assert.equal(result.isError, true); assert.equal(outcome.errorCode, 'EXECUTION_UNCONFIRMED'); assert.equal(outcome.effectState, 'possible');
    assert.equal(outcome.executionEvidence?.treeExited, false); assert.equal(outcome.executionEvidence?.outputDrained, false);
    const metadata = outcome.executionEvidence!.provenance!; assert.equal(metadata.timeoutMs, 7000); assert.equal(metadata.maxOutputBytes, 16777216);
    assert.equal(metadata.redacted, true); assert.match(metadata.cwd, /\[REDACTED\]/); assert.equal(metadata.shellVersionSource, 'executable_file_version');
    assert.equal(metadata.arguments.at(-1), '[command recorded in tool invocation]'); assert.equal(metadata.commandArgumentCapture, 'omitted');
    assert.equal(JSON.stringify({ outcome, result }).includes(secret), false); assert.equal(JSON.stringify(outcome).includes(Buffer.from(command, 'utf16le').toString('base64')), false);
    assert.equal(Object.hasOwn(metadata, 'command'), false);
});

test('real managed execution preserves capability-derived provenance through terminal output recording', { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); const outcome = beginToolOutcome().outcome;
    const result = await managedCommand(f.backend, { executionId: randomUUID(), command: "Write-Output 'PROVENANCE COMPLETE'", cwd: f.directory,
        timeoutSeconds: 5, signal: new AbortController().signal, saveOutput: reference }, outcome);
    assert.equal(result.isError, false, result.content); const metadata = outcome.executionEvidence!.provenance!;
    assert.equal(metadata.cwd, path.resolve(f.directory)); assert.equal(metadata.timeoutMs, 5000); assert.equal(metadata.maxOutputBytes, 16777216);
    assert.match(metadata.shell, /WindowsPowerShell.*powershell\.exe$/i); assert.notEqual(metadata.shellVersion, 'Windows PowerShell 5.1');
    assert.equal(metadata.shellVersionSource, metadata.shellVersion === 'unknown' ? 'unknown' : 'executable_file_version');
    assert.equal(metadata.commandEncoding, 'utf16le-base64'); assert.equal(metadata.outputEncoding, 'raw_bytes_command_specific');
    assert.deepEqual(metadata.arguments, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', '[command recorded in tool invocation]']);
    assert.equal(metadata.redacted, false); assert.equal(outcome.executionEvidence!.treeExited, true); assert.equal(outcome.executionEvidence!.outputDrained, true);
});

test('successful command exposes raw output hashes for artifact paging beyond its preview', { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); const outcome = beginToolOutcome().outcome; const saved: Buffer[] = [];
    const result = await managedCommand(f.backend, { executionId: randomUUID(), command: "[Console]::Out.Write(('Z' * 70000)); [Console]::Error.Write('stderr evidence')",
        cwd: f.directory, timeoutSeconds: 5, signal: new AbortController().signal,
        saveOutput: bytes => { saved.push(Buffer.from(bytes)); const sha256 = createHash('sha256').update(bytes).digest('hex'); return { availability: 'present', relativePath: `artifacts/${sha256}.bin`, sha256, byteLength: bytes.length, mediaType: 'application/octet-stream', missingReason: null }; } }, outcome);
    assert.equal(result.isError, false, result.content); assert.equal(outcome.exitCode, 0); assert.equal(outcome.artifactRefs.length, 2); assert.equal(outcome.truncation.truncated, true);
    assert.equal(saved[0].length, 70000); assert.equal(saved[1].toString(), 'stderr evidence');
    for (const [index, ref] of outcome.artifactRefs.entries()) {
        assert.equal(ref.sha256, createHash('sha256').update(saved[index]).digest('hex')); assert.equal(ref.byteLength, saved[index].length);
        assert.ok(result.content.includes(`sha256=${ref.sha256}; bytes=${ref.byteLength}`));
    }
    assert.match(result.content, /read_artifact_range/); assert.match(result.content, /Preview truncated/);
});

test('output artifact failure preserves known command completion and fails recording independently', { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    const outcome = beginToolOutcome().outcome;
    const executionId = randomUUID();
    const result = await managedCommand(f.backend, { executionId, command: "[IO.File]::WriteAllText('effect.txt','applied'); Write-Output 'safe output'",
        cwd: f.directory, timeoutSeconds: 5, signal: new AbortController().signal,
        saveOutput: () => { throw new Error('private disk diagnostic'); } }, outcome);
    assert.equal(result.isError, true); assert.equal(outcome.status, 'succeeded'); assert.equal(outcome.exitCode, 0);
    assert.equal(outcome.effectState, 'possible'); assert.equal(outcome.retryClass, 'reconcile_first');
    assert.equal(outcome.recordingState, 'failed'); assert.equal(outcome.errorCode, 'RECORDING_FAILED');
    assert.equal(JSON.stringify(result).includes('private disk'), false);
    assert.equal(await readFile(path.join(f.directory, 'effect.txt'), 'utf8'), 'applied');
    await assert.rejects(f.backend.wait(executionId, 0), /not owned/);
    assert.match(await readFile(path.join(f.directory, 'managed', 'executions', executionId, 'stdout.bin'), 'utf8'), /safe output/);
});

test('unconfirmed lifecycle has its own error and never pretends an output recording failure', { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); const outcome = beginToolOutcome().outcome;
    const originalWait = f.backend.wait.bind(f.backend);
    let releases = 0; const originalRelease = f.backend.release.bind(f.backend);
    t.mock.method(f.backend, 'release', async (id: string) => { releases++; return originalRelease(id); });
    t.mock.method(f.backend, 'wait', async (id: string, timeout: number) => ({ ...await originalWait(id, timeout), status: 'failed' as const, treeExited: false, outputDrained: false }));
    const result = await managedCommand(f.backend, { executionId: randomUUID(), command: 'Start-Sleep -Milliseconds 1000', cwd: f.directory,
        timeoutSeconds: 5, signal: new AbortController().signal, saveOutput: reference }, outcome);
    t.mock.restoreAll();
    assert.equal(result.isError, true); assert.equal(outcome.status, 'failed');
    assert.equal(outcome.errorCode, 'EXECUTION_UNCONFIRMED'); assert.equal(outcome.recordingState, 'pending');
    assert.equal(outcome.effectState, 'possible'); assert.equal(outcome.retryClass, 'reconcile_first');
    assert.ok(!result.content.includes('tree exited: true'));
    assert.equal(releases, 0);
});

test('missing helper fails before start with no direct shell fallback', { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t, true); const outcome = beginToolOutcome().outcome;
    const result = await managedCommand(f.backend, { executionId: randomUUID(), command: "[IO.File]::WriteAllText('forbidden.txt','bad')",
        cwd: f.directory, timeoutSeconds: 5, signal: new AbortController().signal, saveOutput: reference }, outcome);
    assert.equal(result.isError, true); assert.equal(outcome.errorCode, 'EXECUTION_BACKEND_UNAVAILABLE');
    assert.equal(outcome.effectState, 'not_started'); assert.equal(outcome.retryClass, 'safe');
    await assert.rejects(readFile(path.join(f.directory, 'forbidden.txt')));
});

test('pre-dispatch cancellation has no command effect', { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t); const outcome = beginToolOutcome().outcome; const controller = new AbortController(); controller.abort();
    const result = await managedCommand(f.backend, { executionId: randomUUID(), command: "[IO.File]::WriteAllText('cancelled.txt','bad')",
        cwd: f.directory, timeoutSeconds: 5, signal: controller.signal, saveOutput: reference }, outcome);
    assert.equal(result.isError, true); assert.equal(outcome.status, 'cancelled'); assert.equal(outcome.errorCode, 'CANCELLED');
    assert.equal(outcome.effectState, 'not_started'); await assert.rejects(readFile(path.join(f.directory, 'cancelled.txt')));
});
