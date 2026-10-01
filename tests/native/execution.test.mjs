import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const project = path.join(root, 'native/UAH.ExecutionHelper/UAH.ExecutionHelper.csproj');
const exe = path.join(root, 'native/UAH.ExecutionHelper/bin/Release/net10.0-windows/UAH.ExecutionHelper.exe');
const ps = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const quote = value => `'${value.replaceAll("'", "''")}'`;
const encoded = command => Buffer.from(command, 'utf16le').toString('base64');

class Client {
    constructor() {
        this.child = spawn(exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        this.pending = new Map(); this.buffer = ''; this.errors = '';
        this.child.stderr.on('data', bytes => { this.errors += bytes.toString(); });
        this.child.stdout.on('data', bytes => {
            this.buffer += bytes.toString();
            for (;;) {
                const at = this.buffer.indexOf('\n'); if (at < 0) break;
                const response = JSON.parse(this.buffer.slice(0, at)); this.buffer = this.buffer.slice(at + 1);
                const pending = this.pending.get(response.id); this.pending.delete(response.id);
                if (pending) pending.resolve(response);
            }
        });
        this.closed = new Promise(resolve => this.child.once('close', resolve));
        this.child.once('close', () => { for (const value of this.pending.values()) value.reject(new Error(`Helper exited: ${this.errors}`)); this.pending.clear(); });
    }
    raw(line, id) {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`IPC timeout ${id}`)); }, 35000);
            this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value); }, reject: error => { clearTimeout(timer); reject(error); } });
            this.child.stdin.write(`${line}\n`);
        });
    }
    request(method, params = {}) { const id = randomUUID(); return this.raw(JSON.stringify({ id, method, params }), id); }
    async ok(method, params = {}) { const response = await this.request(method, params); assert.equal(response.ok, true, JSON.stringify(response)); return response.result; }
    async stop() { if (this.child.exitCode === null && !this.child.killed) { await this.ok('shutdown'); } await this.closed; }
}

test('D02 real Windows Job Object execution lifecycle', { skip: process.platform !== 'win32', timeout: 120000 }, async t => {
    const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '--nologo'], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(build.status, 0, build.stdout + build.stderr);
    const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(path.join(artifacts, 'native-execution-'));
    console.log(`Native execution evidence: ${directory}`);
    let ordinal = 0;
    const start = async (client, command, options = {}) => {
        const outputDirectory = path.join(directory, `output-${++ordinal}`); await mkdir(outputDirectory);
        return client.ok('start', { executionId: randomUUID(), command, cwd: directory, outputDirectory, timeoutMs: 15000, ...options });
    };
    const finish = async (client, executionId) => {
        const result = await client.ok('wait', { executionId, timeoutMs: 20000 });
        assert.equal(result.treeExited, true, JSON.stringify(result)); assert.equal(result.outputDrained, true);
        assert.equal(result.activeProcesses, 0); return result;
    };
    const client = new Client();
    t.after(async () => { await client.stop(); });
    await t.test('declares independent execution and unsupported console modes', async () => {
        const caps = await client.ok('capabilities'); assert.equal(caps.atomicJobAssignment, true); assert.equal(caps.processGroups, true);
        assert.equal(caps.interactive, false); assert.equal(caps.pty, false); assert.equal(caps.breakawayAllowed, false);
        assert.equal(caps.terminalRelease, true); assert.equal(caps.maxRetainedExecutions, 128);
        assert.equal(caps.shell, ps.replaceAll('/', '\\'));
        const actualVersion = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(`[System.Diagnostics.FileVersionInfo]::GetVersionInfo(${quote(caps.shell)}).FileVersion`)], { encoding: 'utf8', windowsHide: true });
        assert.equal(actualVersion.status, 0, actualVersion.stderr); assert.equal(caps.shellVersion, actualVersion.stdout.trim());
        assert.equal(caps.shellVersionSource, 'executable_file_version'); assert.equal(caps.commandEncoding, 'utf16le-base64');
        assert.equal(caps.outputEncoding, 'raw_bytes_command_specific'); assert.deepEqual(caps.shellArguments, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand']);
    });
    await t.test('explicit release rejects live/unknown items, frees capacity beyond 128 tasks, and retains raw files', async () => {
        const retained = new Client();
        try {
            const live = await start(retained, 'Start-Sleep -Seconds 30');
            assert.equal((await retained.request('release', { executionId: live.executionId })).error.code, 'execution_not_terminal');
            assert.equal((await retained.request('release', { executionId: randomUUID() })).error.code, 'unknown_execution');
            const cancelled = await retained.ok('cancel', { executionId: live.executionId }); assert.equal(cancelled.treeExited, true);
            const raw = await readFile(cancelled.stdoutPath);
            const released = await retained.ok('release', { executionId: live.executionId });
            assert.deepEqual(released, { executionId: live.executionId, status: 'released', rawOutputRetained: true });
            assert.equal((await retained.request('release', { executionId: live.executionId })).error.code, 'unknown_execution');
            assert.equal((await retained.request('wait', { executionId: live.executionId, timeoutMs: 0 })).error.code, 'unknown_execution');
            assert.deepEqual(await readFile(cancelled.stdoutPath), raw);
            for (let index = 0; index < 130; index++) {
                const started = await start(retained, "Write-Output 'retained-output'");
                const terminal = await finish(retained, started.executionId); assert.equal(terminal.status, 'completed');
                const bytes = await readFile(terminal.stdoutPath); assert.match(bytes.toString('utf8'), /retained-output/);
                await retained.ok('release', { executionId: started.executionId });
                assert.deepEqual(await readFile(terminal.stdoutPath), bytes);
            }
            const shutdown = await retained.ok('shutdown'); assert.deepEqual(shutdown.executions, []); await retained.closed;
        } finally { await retained.stop(); }
    });
    await t.test('raw stdout/stderr >64KiB paginate without terminating task', async () => {
        const result = await start(client, "$b=New-Object byte[] 180000; for($i=0;$i -lt $b.Length;$i++){$b[$i]=$i%251}; [Console]::OpenStandardOutput().Write($b,0,$b.Length); [Console]::OpenStandardError().Write($b,0,777); Start-Sleep -Milliseconds 300");
        const done = await finish(client, result.executionId); assert.equal(done.status, 'completed'); assert.equal(done.stdoutBytes, 180000); assert.ok(done.stderrBytes >= 777);
        let offset = 0; const pages = [];
        do { const page = await client.ok('poll', { executionId: result.executionId, stream: 'stdout', offset, limit: 65536 }); const bytes = Buffer.from(page.base64, 'base64'); assert.ok(bytes.length <= 65536); pages.push(bytes); offset = page.nextOffset; } while (offset < done.stdoutBytes);
        const output = Buffer.concat(pages); assert.equal(output.length, 180000);
        for (let i = 0; i < output.length; i++) assert.equal(output[i], i % 251);
        assert.deepEqual(await readFile(done.stdoutPath), output);
        const stderr = await readFile(done.stderrPath); assert.equal(stderr.length, done.stderrBytes);
        assert.ok(stderr.includes(output.subarray(0, 777)), 'stderr raw binary payload is preserved alongside PowerShell CLIXML');
        const errorPage = await client.ok('poll', { executionId: result.executionId, stream: 'stderr', offset: 0, limit: 65536 }); assert.deepEqual(Buffer.from(errorPage.base64, 'base64'), stderr);
    });
    await t.test('root exit does not complete while child and grandchild remain', async () => {
        const marker = path.join(directory, 'grandchild-done');
        const grandchild = `Start-Sleep -Seconds 3; [IO.File]::WriteAllText(${quote(marker)},'done')`;
        const child = `Start-Process -FilePath ${quote(ps)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(grandchild)}' -NoNewWindow; Start-Sleep -Milliseconds 300`;
        const result = await start(client, `Start-Process -FilePath ${quote(ps)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(child)}' -NoNewWindow`);
        await delay(1400);
        const running = await client.ok('wait', { executionId: result.executionId, timeoutMs: 0 }); assert.equal(running.status, 'running'); assert.equal(running.treeExited, false);
        const done = await finish(client, result.executionId); assert.equal(done.status, 'completed'); assert.equal(await readFile(marker, 'utf8'), 'done');
    });
    await t.test('cancel is handled while wait is pending and certifies tree exit', async () => {
        const child = 'Start-Sleep -Seconds 30';
        const result = await start(client, `Start-Process -FilePath ${quote(ps)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(child)}' -NoNewWindow; Start-Sleep -Seconds 30`, { timeoutMs: 60000 });
        const waiting = client.ok('wait', { executionId: result.executionId, timeoutMs: 30000 }); await delay(500);
        const cancelled = await client.ok('cancel', { executionId: result.executionId }); assert.equal(cancelled.status, 'cancelled'); assert.equal(cancelled.treeExited, true);
        assert.equal((await waiting).treeExited, true);
    });
    await t.test('timeout and combined disk cap terminate only the owned job', async () => {
        const timed = await start(client, 'Start-Sleep -Seconds 30', { timeoutMs: 300 }); assert.equal((await finish(client, timed.executionId)).status, 'timed_out');
        const capped = await start(client, '$b=New-Object byte[] 65536; while($true){[Console]::OpenStandardOutput().Write($b,0,$b.Length)}', { maxOutputBytes: 100000 });
        const done = await finish(client, capped.executionId); assert.equal(done.reason, 'output_limit'); assert.equal(done.stdoutBytes + done.stderrBytes, 100000); assert.equal((await stat(done.stdoutPath)).size + (await stat(done.stderrPath)).size, 100000);
    });
    await t.test('strict validation rejects duplicate, unknown and out-of-range inputs', async () => {
        for (const params of [{ stream: 'stdout', offset: -1, limit: 1 }, { stream: 'stdout', offset: 0, limit: 65537 }, { stream: 'other', offset: 0, limit: 1 }]) assert.equal((await client.request('poll', { executionId: randomUUID(), ...params })).ok, false);
        assert.equal((await client.request('wait', { executionId: randomUUID(), timeoutMs: 30001 })).ok, false);
        assert.equal((await client.request('capabilities', { extra: true })).error.code, 'invalid_request');
        const id = randomUUID(); assert.equal((await client.raw(`{"id":"${id}","method":"capabilities","method":"cancel","params":{}}`, id)).ok, false);
        const outputDirectory = path.join(directory, 'invalid-start'); await mkdir(outputDirectory);
        for (const timeoutMs of [0, 120001]) assert.equal((await client.request('start', { executionId: randomUUID(), command: 'exit 0', cwd: directory, outputDirectory, timeoutMs })).ok, false);
        assert.equal((await client.request('start', { executionId: randomUUID(), command: 'exit 0', cwd: '.', outputDirectory, timeoutMs: 1 })).ok, false);
        assert.equal((await client.request('start', { executionId: randomUUID(), command: 'exit 0', cwd: directory, outputDirectory, timeoutMs: 1, interactive: true })).ok, false);
    });
    await t.test('explicit breakaway request fails closed', async () => {
        const source = 'using System; using System.Text; using System.Runtime.InteropServices; public class Breakaway { [StructLayout(LayoutKind.Sequential)] public struct SI { public int cb; public IntPtr r,d,t; public int x,y,xs,ys,xc,yc,f,flags; public short show,res; public IntPtr r2,i,o,e; } [StructLayout(LayoutKind.Sequential)] public struct PI {public IntPtr p,t; public int pid,tid;} [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool CreateProcess(string app,StringBuilder cmd,IntPtr pa,IntPtr ta,bool inh,int flags,IntPtr env,string cwd,ref SI si,out PI pi); }';
        const command = `Add-Type -TypeDefinition ${quote(source)}; $si=New-Object Breakaway+SI; $si.cb=[Runtime.InteropServices.Marshal]::SizeOf($si); $pi=New-Object Breakaway+PI; $ok=[Breakaway]::CreateProcess(${quote(ps)},(New-Object Text.StringBuilder ${quote(`"${ps}" -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"`)}),[IntPtr]::Zero,[IntPtr]::Zero,$false,0x01000000,[IntPtr]::Zero,${quote(directory)},[ref]$si,[ref]$pi); if($ok){throw 'Unexpected breakaway success'}; [Console]::Write([Runtime.InteropServices.Marshal]::GetLastWin32Error())`;
        const result = await start(client, command); const done = await finish(client, result.executionId); assert.equal(done.status, 'completed'); assert.equal((await readFile(done.stdoutPath, 'utf8')).trim(), '5');
    });
    await t.test('inherited active-process restriction rejects creation without running command', async () => {
        const outputDirectory = path.join(directory, 'blocked-job'); await mkdir(outputDirectory);
        const marker = path.join(directory, 'must-not-execute');
        const request = JSON.stringify({ id: randomUUID(), method: 'start', params: { executionId: randomUUID(), command: `[IO.File]::WriteAllText(${quote(marker)},'unexpected')`, cwd: directory, outputDirectory, timeoutMs: 5000 } });
        // This fixture owns a Process object and a restrictive parent job. It assigns the
        // idle helper before sending any command; production creation remains atomic.
        const source = `using System; using System.Diagnostics; using System.Text; using System.Runtime.InteropServices; public class RestrictedHelper {
            [StructLayout(LayoutKind.Sequential)] public struct BL {public long p,j; public uint f; public UIntPtr min,max; public uint count; public UIntPtr aff; public uint pri,sch;}
            [StructLayout(LayoutKind.Sequential)] public struct IO {public ulong a,b,c,d,e,f;}
            [StructLayout(LayoutKind.Sequential)] public struct EL {public BL basic; public IO io; public UIntPtr a,b,c,d;}
            [DllImport("kernel32.dll",SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string n);
            [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr j,int k,ref EL i,int s);
            [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr j,IntPtr p);
            [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
            public static void Run(string exe,string request) {IntPtr job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero)throw new Exception("job"); Process child=null; try {var limits=new EL(); limits.basic.f=0x2008; limits.basic.count=1; if(!SetInformationJobObject(job,9,ref limits,Marshal.SizeOf(typeof(EL))))throw new Exception("limits"); var info=new ProcessStartInfo(exe); info.UseShellExecute=false; info.RedirectStandardInput=true; info.RedirectStandardOutput=true; info.RedirectStandardError=true; info.CreateNoWindow=true; child=Process.Start(info); if(!AssignProcessToJobObject(job,child.Handle))throw new Exception("assign"); child.StandardInput.WriteLine(Encoding.UTF8.GetString(Convert.FromBase64String(request))); Console.WriteLine(child.StandardOutput.ReadLine()); child.StandardInput.Close(); if(!child.WaitForExit(5000))throw new Exception("exit"); } finally {CloseHandle(job); if(child!=null)child.Dispose();} }
        }`;
        const command = `$ProgressPreference='SilentlyContinue'; Add-Type -TypeDefinition ${quote(source)}; [RestrictedHelper]::Run(${quote(exe)},'${Buffer.from(request).toString('base64')}')`;
        const fixture = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded(command)], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
        assert.equal(fixture.status, 0, fixture.stdout + fixture.stderr);
        const result = JSON.parse(fixture.stdout.trim()); assert.equal(result.ok, false); assert.equal(result.error.code, 'backend_error');
        await assert.rejects(stat(marker), { code: 'ENOENT' });
        assert.equal((await stat(path.join(outputDirectory, 'stdout.bin'))).size, 0);
    });
    for (const mode of ['eof', 'crash']) await t.test(`helper ${mode} closes noninherited job and stops descendants`, async () => {
        const isolated = new Client(); const marker = path.join(directory, `heartbeat-${mode}`);
        try {
            const heartbeat = `while($true){[IO.File]::AppendAllText(${quote(marker)},'x'); Start-Sleep -Milliseconds 50}`;
            await start(isolated, `Start-Process -FilePath ${quote(ps)} -ArgumentList '-NoProfile','-NonInteractive','-EncodedCommand','${encoded(heartbeat)}' -NoNewWindow; Start-Sleep -Seconds 30`, { timeoutMs: 60000 });
            for (let i = 0; i < 50; i++) { try { if ((await stat(marker)).size > 2) break; } catch {} await delay(100); }
            assert.ok((await stat(marker)).size > 2);
            if (mode === 'eof') isolated.child.stdin.end(); else isolated.child.kill();
            await isolated.closed; await delay(250);
            const length = (await stat(marker)).size; await delay(500); assert.equal((await stat(marker)).size, length);
        } finally { if (isolated.child.exitCode === null && !isolated.child.killed) { isolated.child.stdin.end(); await isolated.closed; } }
    });
});

test('D03 credential filter masks literal raw bytes before spool without changing lifecycle', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
    const build = spawnSync('dotnet', ['build', project, '-c', 'Release', '--nologo'], { cwd: root, encoding: 'utf8', windowsHide: true }); assert.equal(build.status, 0, build.stdout + build.stderr);
    const artifacts = path.join(root, 'artifacts'); await mkdir(artifacts, { recursive: true }); const directory = await mkdtemp(path.join(artifacts, 'native-credential-filter-')); console.log(`Credential filter evidence: ${directory}`);
    const client = new Client(); t.after(async () => { await client.stop(); }); let ordinal = 0;
    const start = async (command, options = {}) => { const outputDirectory = path.join(directory, `output-${++ordinal}`); await mkdir(outputDirectory); return client.ok('start', { executionId: randomUUID(), command, cwd: directory, outputDirectory, timeoutMs: 15000, ...options }); };
    const finish = async id => { const done = await client.ok('wait', { executionId: id, timeoutMs: 20000 }); assert.equal(done.treeExited, true); assert.equal(done.outputDrained, true); assert.equal(done.activeProcesses, 0); assert.equal((await stat(done.stdoutPath)).size, done.stdoutBytes); assert.equal((await stat(done.stderrPath)).size, done.stderrBytes); return done; };
    const mask = (bytes, secrets) => { const result = Buffer.from(bytes); const maskByte = secrets.some(secret => secret.includes('*')) ? 0 : 42; for (const secret of secrets) { const needle = Buffer.from(secret, 'ascii'); for (let at = bytes.indexOf(needle); at >= 0; at = bytes.indexOf(needle, at + 1)) result.fill(maskByte, at, at + needle.length); } return result; };
    assert.equal((await client.ok('capabilities')).credentialFilter, true);
    await t.test('stdout and stderr match across separate pipe reads and never persist the original credential', async () => {
        const key = 'SPLIT_API_CREDENTIAL_123456789'; const full = Buffer.from(`before/${key}/after`); const split = 7 + Math.floor(key.length / 2);
        const command = `$ProgressPreference='SilentlyContinue'; $o=[Console]::OpenStandardOutput(); $e=[Console]::OpenStandardError(); $b=[Convert]::FromBase64String('${full.toString('base64')}'); $o.Write($b,0,${split}); $o.Flush(); $e.Write($b,0,${split}); $e.Flush(); Start-Sleep -Milliseconds 200; $o.Write($b,${split},$b.Length-${split}); $e.Write($b,${split},$b.Length-${split})`;
        const started = await start(command, { redactSecrets: [key] }); const done = await finish(started.executionId); assert.equal(done.status, 'completed'); assert.equal(done.outputRedacted, true);
        for (const [stream, output] of [['stdout', done.stdoutPath], ['stderr', done.stderrPath]]) { const bytes = await readFile(output); assert.deepEqual(bytes, mask(full, [key])); assert.equal(bytes.includes(Buffer.from(key)), false); const page = await client.ok('poll', { executionId: started.executionId, stream, offset: 0, limit: 65536 }); assert.deepEqual(Buffer.from(page.base64, 'base64'), bytes); assert.equal(page.snapshot.outputRedacted, true); }
    });
    await t.test('overlapping matches, multiple patterns and regex-like literals use the union of full matches', async () => {
        const keys = ['ABA', 'BAB', 'AAAAA', 'AA', 'a$b[.]']; const bytes = Buffer.from('ZABABAZYAAAAAAAZa$b[.]Q');
        const started = await start(`[Console]::OpenStandardOutput().Write([Convert]::FromBase64String('${bytes.toString('base64')}'),0,${bytes.length})`, { redactSecrets: keys }); const done = await finish(started.executionId); assert.equal(done.status, 'completed'); assert.equal(done.outputRedacted, true); assert.deepEqual(await readFile(done.stdoutPath), mask(bytes, keys));
    });
    await t.test('maximum-length heavily overlapping keys remain bounded and mask every covered byte', async () => {
        const key = 'A'.repeat(8192); const started = await start("[Console]::Out.Write(('A' * 160000))", { redactSecrets: Array(8).fill(key) }); const done = await finish(started.executionId); assert.equal(done.status, 'completed'); assert.equal(done.stdoutBytes, 160000); assert.equal(done.outputRedacted, true); assert.deepEqual(await readFile(done.stdoutPath), Buffer.alloc(160000, 42));
    });
    await t.test('all-star and embedded-star credentials use uniform NUL masks without changing unmatched binary', async () => {
        const keys = ['***', 'A*B', 'AAA']; const bytes = Buffer.concat([Buffer.from([255, 0, 128]), Buffer.from('Z***|A*B|AAA|END')]);
        const started = await start(`[Console]::OpenStandardOutput().Write([Convert]::FromBase64String('${bytes.toString('base64')}'),0,${bytes.length})`, { redactSecrets: keys }); const done = await finish(started.executionId); assert.equal(done.status, 'completed'); assert.equal(done.outputRedacted, true); const output = await readFile(done.stdoutPath); assert.deepEqual(output, mask(bytes, keys));
        for (const key of keys) assert.equal(output.includes(Buffer.from(key, 'ascii')), false); assert.deepEqual(output.subarray(0, 3), bytes.subarray(0, 3));
    });
    await t.test('nonmatching binary bytes and incomplete trailing credentials remain byte-identical; absent filter stays compatible', async () => {
        const bytes = Buffer.concat([Buffer.from([0, 255, 128, 65, 66, 0]), Buffer.from('UNFINISHED_KEY_PREFIX')]);
        const command = `[Console]::OpenStandardOutput().Write([Convert]::FromBase64String('${bytes.toString('base64')}'),0,${bytes.length})`;
        for (const options of [{}, { redactSecrets: [] }, { redactSecrets: ['UNFINISHED_KEY_PREFIX_FULL_SECRET', 'unmatched key'] }]) { const started = await start(command, options); const done = await finish(started.executionId); assert.equal(done.status, 'completed'); assert.equal(done.outputRedacted, false); assert.deepEqual(await readFile(done.stdoutPath), bytes); }
    });
    await t.test('invalid credential configuration is rejected before process creation and errors never echo it', async () => {
        const marker = path.join(directory, 'invalid-credential-must-not-execute');
        for (const secrets of [null, 'not-array', [''], [42], ['PRIVATE_INVALID_KEY\n'], ['非ASCII密钥'], ['A'.repeat(8193)], Array(17).fill('key'), Array(9).fill('A'.repeat(8192))]) {
            const outputDirectory = path.join(directory, `invalid-${++ordinal}`); await mkdir(outputDirectory);
            const response = await client.request('start', { executionId: randomUUID(), command: `[IO.File]::WriteAllText(${quote(marker)},'bad')`, cwd: directory, outputDirectory, timeoutMs: 5000, redactSecrets: secrets });
            assert.equal(response.ok, false); assert.equal(response.error.code, 'invalid_request'); assert.equal(JSON.stringify(response).includes('PRIVATE_INVALID_KEY'), false); assert.deepEqual(await readdir(outputDirectory), []);
        }
        await assert.rejects(stat(marker), { code: 'ENOENT' });
    });
    await t.test('cancel drains the withheld tail and retains certified filtered spool length', async () => {
        const key = 'C'.repeat(8192); const started = await start("[Console]::Out.Write(('C' * 8192)); Start-Sleep -Seconds 30", { timeoutMs: 60000, redactSecrets: [key] });
        let observed; for (let i = 0; i < 100; i++) { observed = await client.ok('wait', { executionId: started.executionId, timeoutMs: 0 }); if (observed.outputRedacted) break; await delay(20); } assert.equal(observed.outputRedacted, true);
        const done = await client.ok('cancel', { executionId: started.executionId }); assert.equal(done.status, 'cancelled'); assert.equal(done.treeExited, true); assert.equal(done.outputDrained, true); assert.equal(done.stdoutBytes, 8192); assert.deepEqual(await readFile(done.stdoutPath), Buffer.alloc(8192, 42));
    });
    await t.test('raw quota counts pending filter tails and drain preserves exactly the accepted byte length', async () => {
        const key = 'A'.repeat(8192);
        for (const maxOutputBytes of [10000, 1000]) {
            const started = await start("[Console]::Out.Write(('A' * 100000)); Start-Sleep -Seconds 30", { redactSecrets: [key], maxOutputBytes }); const done = await finish(started.executionId);
            assert.equal(done.reason, 'output_limit'); assert.equal(done.stdoutBytes + done.stderrBytes, maxOutputBytes); assert.equal(done.outputRedacted, maxOutputBytes >= key.length); assert.deepEqual(await readFile(done.stdoutPath), Buffer.alloc(maxOutputBytes, maxOutputBytes >= key.length ? 42 : 65));
        }
    });
});
