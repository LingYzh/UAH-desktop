import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { WindowsExecutionBackend } from '../../src/runtime/execution-backend';

async function credentialBoundaryFixture(t: { after(fn: () => Promise<void>): void }, credentialFilter: boolean) {
    const directory = await mkdtemp(path.join(tmpdir(), 'uah-credential-boundary-'));
    // Replace only native transport/initialization: exercise the real Node admission,
    // ownership and evidence validators without launching or rebuilding a helper.
    const backend = Object.create(WindowsExecutionBackend.prototype) as WindowsExecutionBackend;
    for (const [key, value] of Object.entries({ dataDirectory: directory, ready: Promise.resolve(), closing: false,
        credentialFilter, evidence: new Map(), pending: new Map() })) Reflect.set(backend, key, value);
    const calls: Array<{ method: string; params: Record<string, any> }> = [];
    let flag: unknown = false;
    const snapshot = (id: string) => ({ executionId: id, status: 'completed', reason: null, exitCode: 0, jobAssigned: true,
        activeProcesses: 0, treeExited: true, outputDrained: true, stdoutBytes: 0, stderrBytes: 0, elapsedMs: 1,
        stdoutPath: path.join(directory, 'executions', id, 'stdout.bin'), stderrPath: path.join(directory, 'executions', id, 'stderr.bin'),
        ...(flag === undefined ? {} : { outputRedacted: flag }) });
    Reflect.set(backend, 'request', async (method: string, params: Record<string, any>) => {
        calls.push({ method, params });
        if (method === 'poll') return { executionId: params.executionId, stream: params.stream, offset: 0, nextOffset: 0,
            base64: '', hasMore: false, snapshot: snapshot(params.executionId) };
        return snapshot(params.executionId);
    });
    t.after(async () => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir()));
        assert.ok(path.basename(directory).startsWith('uah-credential-boundary-'));
        await rm(directory, { recursive: true, force: true });
    });
    return { backend, directory, calls, setFlag: (value: unknown) => { flag = value; } };
}

test('credential boundary rejects old helper capabilities before any start or ownership', async t => {
    const f = await credentialBoundaryFixture(t, false);
    await assert.rejects(f.backend.ensureAvailable(['known-secret']), /credential filtering is unavailable/);
    await assert.rejects(f.backend.start({ command: 'exit 0', cwd: f.directory, timeoutMs: 1000, redactSecrets: ['known-secret'] }), /credential filtering is unavailable/);
    assert.equal(f.calls.length, 0);
    assert.equal((Reflect.get(f.backend, 'evidence') as Map<string, unknown>).size, 0);
});

test('legacy backend provenance stays explicitly unknown without guessing old static shell versions', async t => {
    const f = await credentialBoundaryFixture(t, true);
    const metadata = f.backend.executionProvenance({ cwd: f.directory, timeoutMs: 1000 });
    assert.equal(metadata.shell, 'unknown'); assert.equal(metadata.shellVersion, 'unknown'); assert.equal(metadata.shellVersionSource, 'unknown');
    assert.equal(metadata.commandEncoding, 'unknown'); assert.equal(metadata.outputEncoding, 'unknown'); assert.equal(metadata.cwd, path.resolve(f.directory));
    assert.equal(metadata.commandArgumentCapture, 'omitted'); metadata.arguments.push('external mutation');
    assert.equal(f.backend.executionProvenance({ cwd: f.directory, timeoutMs: 1000 }).arguments.includes('external mutation'), false);
});

test('credential boundary rejects invalid configurations without dispatch or secret-bearing errors', async t => {
    const f = await credentialBoundaryFixture(t, true);
    const secret = 'private-marker';
    const invalidValues: unknown[] = [null, secret, [3], [''], [secret + '\n'], [secret + '\u007f'], [secret + '中文'],
        [secret.repeat(700)], Array(17).fill(secret), Array(5).fill('S'.repeat(8192))];
    for (const value of invalidValues) {
        for (const invoke of [() => f.backend.ensureAvailable(value as string[]),
            () => f.backend.start({ command: 'exit 0', cwd: f.directory, timeoutMs: 1000, redactSecrets: value as string[] })]) {
            await assert.rejects(invoke(), error => {
                assert.ok(error instanceof Error); assert.match(error.message, /credential filter limits/);
                assert.equal(error.message.includes(secret), false); return true;
            });
        }
    }
    assert.equal(f.calls.length, 0);
    assert.equal((Reflect.get(f.backend, 'evidence') as Map<string, unknown>).size, 0);
    await f.backend.ensureAvailable(Array(4).fill('S'.repeat(8192)));
    await f.backend.ensureAvailable(Array(16).fill('S'));
});

test('credential boundary requires boolean evidence on start and every subsequent snapshot API', async t => {
    for (const method of ['start', 'wait', 'cancel', 'poll', 'release']) {
        for (const bad of [undefined, 'true', null, 1]) {
            const f = await credentialBoundaryFixture(t, true);
            const id = randomUUID();
            if (method !== 'start') await f.backend.start({ executionId: id, command: 'exit 0', cwd: f.directory, timeoutMs: 1000, redactSecrets: ['secret'] });
            f.setFlag(bad);
            const operation = method === 'start' ? f.backend.start({ executionId: id, command: 'exit 0', cwd: f.directory, timeoutMs: 1000, redactSecrets: ['secret'] })
                : method === 'wait' ? f.backend.wait(id, 0) : method === 'cancel' ? f.backend.cancel(id)
                    : method === 'poll' ? f.backend.poll(id, 'stdout', 0, 1) : f.backend.release(id);
            await assert.rejects(operation, /invalid or uncorrelated evidence/);
            assert.ok(Reflect.get(f.backend, 'failure'), 'invalid evidence latches the backend failure');
            assert.ok((Reflect.get(f.backend, 'evidence') as Map<string, unknown>).has(id), 'unconfirmed evidence remains owned');
            const count = f.calls.length;
            await assert.rejects(f.backend.wait(id, 0), /invalid or uncorrelated evidence/);
            assert.equal(f.calls.length, count, 'fail closed prevents subsequent helper requests');
        }
    }
});

test('credential boundary accepts boolean true/false and no-secret legacy snapshots without flag', async t => {
    for (const flag of [false, true]) {
        const f = await credentialBoundaryFixture(t, true); f.setFlag(flag);
        const state = await f.backend.start({ command: 'exit 0', cwd: f.directory, timeoutMs: 1000, redactSecrets: ['known-secret'] });
        assert.equal(state.outputRedacted, flag);
        assert.deepEqual(f.calls[0].params.redactSecrets, ['known-secret']);
    }
    const old = await credentialBoundaryFixture(t, false); old.setFlag(undefined);
    const state = await old.backend.start({ command: 'exit 0', cwd: old.directory, timeoutMs: 1000 });
    assert.equal(state.outputRedacted, undefined);
    assert.equal((await old.backend.wait(state.executionId, 0)).outputRedacted, undefined);
    assert.equal((await old.backend.poll(state.executionId, 'stdout', 0, 1)).snapshot.outputRedacted, undefined);
});

test('credential boundary rejects missing filtering evidence in shutdown certificates', async t => {
    const f = await credentialBoundaryFixture(t, true);
    const started = await f.backend.start({ command: 'exit 0', cwd: f.directory, timeoutMs: 1000, redactSecrets: ['known-secret'] });
    const { outputRedacted: _flag, ...missingFlag } = started;
    // Lifecycle-owned fake transport emits a shutdown certificate; there is no process.
    Reflect.set(f.backend, 'child', { stdin: { end() {}, destroy() {} }, exitCode: 0, killed: true });
    Reflect.set(f.backend, 'closed', Promise.resolve());
    Reflect.set(f.backend, 'request', async () => ({ status: 'shutdown', executions: [missingFlag] }));
    await assert.rejects(f.backend.close(), /invalid or uncorrelated evidence/);
    assert.ok((Reflect.get(f.backend, 'evidence') as Map<string, unknown>).has(started.executionId));
});

test('WindowsExecutionBackend uses independent helper and byte evidence', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const build = spawnSync('dotnet', ['build', 'native/UAH.ExecutionHelper/UAH.ExecutionHelper.csproj', '-c', 'Release', '--nologo'], { encoding: 'utf8', windowsHide: true });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    await mkdir(path.resolve('artifacts'), { recursive: true });
    const directory = await mkdtemp(path.resolve('artifacts/execution-backend-'));
    const backend = new WindowsExecutionBackend({ dataDirectory: directory });
    t.after(() => backend.close());
    await t.test('starts large output and returns exact byte pages and confirmed exit', async () => {
        const executionId = randomUUID();
        const initial = await backend.start({ executionId, command: '$b=New-Object byte[] 190000; for($i=0;$i -lt $b.Length;$i++){$b[$i]=$i%251}; [Console]::OpenStandardOutput().Write($b,0,$b.Length); Start-Sleep -Milliseconds 300', cwd: directory, timeoutMs: 10000 });
        assert.equal(initial.executionId, executionId); assert.equal(initial.jobAssigned, true);
        const done = await backend.wait(executionId, 20000);
        assert.equal(done.status, 'completed'); assert.equal(done.treeExited, true); assert.equal(done.outputDrained, true); assert.equal(done.stdoutBytes, 190000);
        assert.equal(done.stdoutPath, path.join(directory, 'executions', executionId, 'stdout.bin'));
        const pages: Buffer[] = []; let offset = 0;
        while (offset < done.stdoutBytes) { const page = await backend.poll(executionId, 'stdout', offset, 65536); pages.push(Buffer.from(page.base64, 'base64')); offset = page.nextOffset; }
        const bytes = Buffer.concat(pages); assert.deepEqual(bytes, await readFile(done.stdoutPath));
        for (let i = 0; i < bytes.length; i++) assert.equal(bytes[i], i % 251);
        await assert.rejects(backend.poll(executionId, 'stdout', 0, 65537), /Invalid/);
        await assert.rejects(backend.start({ executionId, command: 'exit 0', cwd: directory, timeoutMs: 100 }), /fresh UUID/);
    });
    await t.test('cancels while wait is outstanding and receives tree certificate', async () => {
        const started = await backend.start({ command: 'Start-Sleep -Seconds 30', cwd: directory, timeoutMs: 60000 });
        const waiting = backend.wait(started.executionId, 30000); await delay(200);
        const cancelled = await backend.cancel(started.executionId); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.treeExited, true);
        assert.equal((await waiting).outputDrained, true);
        await assert.rejects(backend.cancel(randomUUID()), /not owned/);
    });
    await t.test('close cancels a live execution through shutdown and prevents reuse', async () => {
        const ownedDirectory = path.join(directory, 'close-data');
        const owned = new WindowsExecutionBackend({ dataDirectory: ownedDirectory });
        const started = await owned.start({ command: 'Start-Sleep -Seconds 30', cwd: directory, timeoutMs: 60000 }); assert.equal(started.status, 'running');
        await owned.close(); await owned.close();
        await assert.rejects(owned.wait(started.executionId, 0), /closing/);
    });
    await t.test('missing helper fails visibly with no direct shell fallback', async () => {
        const missing = new WindowsExecutionBackend({ dataDirectory: path.join(directory, 'missing'), helperPath: path.join(directory, 'does-not-exist.exe') });
        await assert.rejects(missing.start({ command: 'exit 0', cwd: directory, timeoutMs: 100 }), /unavailable/); await missing.close();
    });
    await t.test('owned helper crash rejects pending requests without fabricating tree exit', async () => {
        const crashing = new WindowsExecutionBackend({ dataDirectory: path.join(directory, 'crash-data') });
        await crashing.ensureAvailable();
        const started = await crashing.start({ command: 'Start-Sleep -Seconds 30', cwd: directory, timeoutMs: 60000 });
        const rejection = assert.rejects(crashing.wait(started.executionId, 30000), /exited/);
        await delay(100);
        // Test-only access to the exact ChildProcess instance created by this backend.
        // No PID discovery, process-name selection, or external process is involved.
        const child = Reflect.get(crashing, 'child') as { kill(): boolean }; child.kill();
        await rejection;
        await assert.rejects(crashing.close(), /exited/);
    });
    await t.test('artifact junctions are rejected before command dispatch', async () => {
        const target = path.join(directory, 'junction-target'); await mkdir(target);
        const junction = path.join(directory, 'junction-data'); await symlink(target, junction, 'junction');
        const linked = new WindowsExecutionBackend({ dataDirectory: junction });
        await assert.rejects(linked.start({ command: 'exit 0', cwd: directory, timeoutMs: 100 }), /links/); await linked.close();
    });
    await t.test('explicit release drops Node evidence only after terminal confirmation and keeps raw output', async () => {
        const releasing = new WindowsExecutionBackend({ dataDirectory: path.join(directory, 'release-data') });
        try {
            const live = await releasing.start({ command: "Write-Output 'retained'; Start-Sleep -Seconds 30", cwd: directory, timeoutMs: 60000 });
            await assert.rejects(releasing.release(live.executionId), /confirmed terminal/);
            await assert.rejects(releasing.release(randomUUID()), /not owned/);
            const terminal = await releasing.cancel(live.executionId); assert.equal(terminal.treeExited, true); assert.equal(terminal.outputDrained, true);
            const bytes = await readFile(terminal.stdoutPath);
            await releasing.release(live.executionId);
            assert.equal((Reflect.get(releasing, 'evidence') as Map<string, unknown>).size, 0);
            await assert.rejects(releasing.release(live.executionId), /not owned/);
            await assert.rejects(releasing.poll(live.executionId, 'stdout', 0, 1), /not owned/);
            await assert.rejects(releasing.wait(live.executionId, 0), /not owned/);
            assert.deepEqual(await readFile(terminal.stdoutPath), bytes);
            await assert.rejects(releasing.start({ executionId: live.executionId, command: 'exit 0', cwd: directory, timeoutMs: 1000 }), /EEXIST/);
        } finally { await releasing.close(); }
    });
});

test('pre-start structured rejections do not accumulate Node ownership evidence', { skip: process.platform !== 'win32', timeout: 30000 }, async t => {
    // Reuse the independently verified helper binary; this regression test does not build it.
    await mkdir(path.resolve('artifacts'), { recursive: true });
    const directory = await mkdtemp(path.resolve('artifacts/execution-rejected-'));
    const backend = new WindowsExecutionBackend({ dataDirectory: directory });
    t.after(() => backend.close());
    await backend.ensureAvailable();
    const evidence = Reflect.get(backend, 'evidence') as Map<string, unknown>;
    for (let index = 0; index < 40; index++) {
        const executionId = randomUUID();
        await assert.rejects(backend.start({ executionId, command: 'exit 0', cwd: path.join(directory, 'missing-cwd'), timeoutMs: 1000 }), /helper invalid_request/);
        assert.equal(evidence.size, 0, `rejection ${index} retained Node evidence`);
        assert.ok((await stat(path.join(directory, 'executions', executionId))).isDirectory(), 'dedicated artifact directory remains retained');
        await assert.rejects(backend.release(executionId), /not owned/);
    }
    const started = await backend.start({ command: "Write-Output 'valid after rejections'", cwd: directory, timeoutMs: 10000 });
    const terminal = await backend.wait(started.executionId, 20000);
    assert.equal(terminal.status, 'completed'); assert.equal(terminal.treeExited, true); assert.equal(evidence.size, 1);
    await backend.release(started.executionId);
    assert.equal(evidence.size, 0);
});

test('lost start acknowledgement preserves unconfirmed ownership evidence', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    await mkdir(path.resolve('artifacts'), { recursive: true });
    const directory = await mkdtemp(path.resolve('artifacts/execution-lost-ack-'));
    const backend = new WindowsExecutionBackend({ dataDirectory: directory });
    await backend.ensureAvailable();
    const executionId = randomUUID();
    const originalReceive = Reflect.get(backend, 'receive') as (chunk: Buffer) => void;
    let lostAck = false;
    let responseBuffer = '';
    // Drop the actual helper's start certificate, then crash only the verified owned
    // ChildProcess. Its close signal rejects the outstanding start without a certificate.
    Reflect.set(backend, 'receive', (chunk: Buffer) => {
        responseBuffer += chunk.toString('utf8');
        for (;;) {
            const newline = responseBuffer.indexOf('\n'); if (newline < 0) return;
            const line = responseBuffer.slice(0, newline); responseBuffer = responseBuffer.slice(newline + 1);
            const response = JSON.parse(line);
            if (response.ok && response.result?.executionId === executionId) {
                lostAck = true;
                (Reflect.get(backend, 'child') as { kill(): boolean }).kill();
            } else originalReceive.call(backend, Buffer.from(line + '\n'));
        }
    });
    try {
        await assert.rejects(backend.start({ executionId, command: 'Start-Sleep -Seconds 30', cwd: directory, timeoutMs: 60000 }), /exited.*unconfirmed/);
        assert.equal(lostAck, true);
        const evidence = Reflect.get(backend, 'evidence') as Map<string, unknown>;
        assert.equal(evidence.size, 1); assert.ok(evidence.has(executionId));
        await assert.rejects(backend.release(executionId), /exited.*unconfirmed/);
        assert.ok(evidence.has(executionId), 'unknown tree state cannot be released');
    } finally { await assert.rejects(backend.close(), /exited.*unconfirmed/); }
});

test('structured backend_error and duplicate_execution retain ambiguous start evidence', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    await mkdir(path.resolve('artifacts'), { recursive: true });
    const directory = await mkdtemp(path.resolve('artifacts/execution-ambiguous-error-'));
    const backend = new WindowsExecutionBackend({ dataDirectory: directory });
    await backend.ensureAvailable();
    const originalRequest = Reflect.get(backend, 'request');
    // Inject correlated protocol error packets through the actual receive validator.
    // No command is dispatched; these responses model states that cannot certify
    // pre-start rejection (CreateProcess may have run, or a helper execution exists).
    try {
        for (const code of ['backend_error', 'duplicate_execution', 'unknown_execution']) {
            Reflect.set(backend, 'request', () => new Promise((resolve, reject) => {
                const id = randomUUID();
                const timer = setTimeout(() => reject(new Error('test response missing')), 1000);
                (Reflect.get(backend, 'pending') as Map<string, unknown>).set(id, { resolve, reject, timer });
                (Reflect.get(backend, 'receive') as (chunk: Buffer) => void).call(backend,
                    Buffer.from(JSON.stringify({ id, ok: false, error: { code, message: 'uncertain effects' } }) + '\n'));
            }));
            const executionId = randomUUID();
            await assert.rejects(backend.start({ executionId, command: 'exit 0', cwd: directory, timeoutMs: 1000 }), new RegExp(code));
            assert.ok((Reflect.get(backend, 'evidence') as Map<string, unknown>).has(executionId));
        }
        assert.equal((Reflect.get(backend, 'evidence') as Map<string, unknown>).size, 3);
    } finally { Reflect.set(backend, 'request', originalRequest); await backend.close(); }
});

test('unstructured rejection text cannot claim pre-start nonexecution', { skip: process.platform !== 'win32', timeout: 15000 }, async () => {
    await mkdir(path.resolve('artifacts'), { recursive: true });
    const directory = await mkdtemp(path.resolve('artifacts/execution-unknown-error-'));
    const backend = new WindowsExecutionBackend({ dataDirectory: directory });
    await backend.ensureAvailable();
    const originalRequest = Reflect.get(backend, 'request');
    const executionId = randomUUID();
    Reflect.set(backend, 'request', async () => { throw new Error('Execution helper invalid_request: unstructured text'); });
    try {
        await assert.rejects(backend.start({ executionId, command: 'exit 0', cwd: directory, timeoutMs: 1000 }), /unstructured text/);
        assert.ok((Reflect.get(backend, 'evidence') as Map<string, unknown>).has(executionId));
    } finally { Reflect.set(backend, 'request', originalRequest); await backend.close(); }
});
