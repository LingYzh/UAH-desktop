import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, open, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { executeWorkspaceTool, workspaceToolDefinitions } from '../../src/runtime/workspace-tools';
import type { PermissionMode } from '../../src/shared/permissions';
import type { ToolOutcome } from '../../src/shared/harness-contracts';
import { WindowsExecutionBackend } from '../../src/runtime/execution-backend';
import { managedCommand } from '../../src/runtime/managed-command';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'uah-tools-'));
    let backend: WindowsExecutionBackend | undefined;
    t.after(async () => { await backend?.close(); await rm(directory, { recursive: true, force: true }); });
    const controller = new AbortController();
    let approvals = 0;
    const context = { directory, permissionMode: 'manual' as PermissionMode, signal: controller.signal, approve: async (_summary: string, _path: string) => { approvals++; return true; },
        commandRunner: undefined as undefined | ((command: string, cwd: string, timeoutSeconds: number, outcome: ToolOutcome) => Promise<{ content: string; isError?: boolean }>) };
    if (process.platform === 'win32') context.commandRunner = (command, cwd, timeoutSeconds, outcome) => {
        backend ??= new WindowsExecutionBackend({ dataDirectory: path.join(directory, 'managed') });
        return managedCommand(backend, { executionId: randomUUID(), command, cwd, timeoutSeconds, signal: controller.signal,
            saveOutput: bytes => {
                const relativePath = `output-${randomUUID()}.bin`; writeFileSync(path.join(directory, relativePath), bytes);
                return { availability: 'present', relativePath, sha256: createHash('sha256').update(bytes).digest('hex'), byteLength: bytes.length, mediaType: 'application/octet-stream', missingReason: null };
            } }, outcome);
    };
    const run = (name: string, args: unknown) => executeWorkspaceTool({ id: 'test', name, arguments: JSON.stringify(args) }, context);
    return { directory, context, controller, run, approvals: () => approvals };
}

test('tool guidance documents every parameter and examples run against the real executor', async t => {
    const f = await fixture(t);
    await mkdir(path.join(f.directory, 'src'));
    await writeFile(path.join(f.directory, 'src', 'app.ts'), '// TODO fixture\n');
    for (const definition of workspaceToolDefinitions()) {
        assert.match(definition.description, /无目录会失败/);
        const example = JSON.parse(definition.description.split('示例：')[1]);
        const properties = definition.parameters.properties as Record<string, { description: string }>;
        for (const property of Object.values(properties)) assert.ok(property.description.length > 15);
        assert.ok(Object.keys(example).every(key => Object.hasOwn(properties, key)));
        const result = await f.run(definition.name, example);
        if (definition.name === 'run_command' && process.platform !== 'win32') assert.equal(result.isError, true);
        else assert.notEqual(result.isError, true, `${definition.name}: ${result.content}`);
    }
    const definitions = Object.fromEntries(workspaceToolDefinitions().map(value => [value.name, value]));
    assert.match(definitions.read_file.description, /UTF-16.*无截断标记|无截断标记.*UTF-16/);
    assert.match(definitions.write_file.description, /不是可回滚事务/);
    assert.match(definitions.run_command.description, /唯 bypass 无审批/);
    assert.equal(await readFile(path.join(f.directory, 'notes.txt'), 'utf8'), 'hello\n');
});
test('definitions and schema reject unknown, oversized and invalid arguments before approval', async t => {
    const f = await fixture(t);
    assert.equal(workspaceToolDefinitions().length, 7);
    for (const [name, args] of [['unknown', {}], ['write_file', { path: 'x', content: 'x' }], ['write_file', { path: 'x', content: 'x', expectedContent: null, secret: 'x' }], ['run_command', { command: 'x', timeoutSeconds: 121 }], ['run_command', { command: 'x'.repeat(8193) }], ['read_file', { path: 'x', offset: -1 }], ['search_files', { query: '' }], ['write_file', { path: 'x', content: 'x'.repeat(1024 * 1024 + 1), expectedContent: null }]] as const) assert.equal((await f.run(name, args)).isError, true);
    assert.equal(f.approvals(), 0);
});
test('workspace, traversal, reserved names and outside absolute paths are rejected', async t => {
    const f = await fixture(t);
    for (const bad of ['../escape', 'CON.txt', 'file:stream', 'x.', path.join(os.tmpdir(), 'outside-uah.txt')]) assert.equal((await f.run('write_file', { path: bad, content: 'x', expectedContent: null })).isError, true);
    f.context.directory = null as unknown as string;
    assert.equal((await f.run('list_directory', {})).isError, true);
    assert.equal(f.approvals(), 0);
});
test('permission modes, denied approval, conflict and artifact preconditions', async t => {
    const f = await fixture(t);
    const file = path.join(f.directory, 'a.txt'); await writeFile(file, 'before');
    for (const mode of ['readonly', 'plan'] as const) { f.context.permissionMode = mode; assert.equal((await f.run('write_file', { path: 'a.txt', content: 'after', expectedContent: 'before' })).isError, true); }
    f.context.permissionMode = 'manual'; f.context.approve = async () => false;
    assert.equal((await f.run('write_file', { path: 'a.txt', content: 'after', expectedContent: 'before' })).isError, true);
    f.context.approve = async () => true;
    assert.equal((await f.run('write_file', { path: 'a.txt', content: 'after', expectedContent: 'wrong' })).isError, true);
    assert.equal(await readFile(file, 'utf8'), 'before');
    let artifact: unknown;
    const result = await executeWorkspaceTool({ id: 'x', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'after', expectedContent: 'before' }) }, { ...f.context, onArtifact: change => { artifact = change; } });
    assert.equal(result.isError, undefined); assert.deepEqual(artifact, { path: file, oldContent: 'before', newContent: 'after' });
    assert.equal((await f.run('write_file', { path: 'a.txt', content: 'new', expectedContent: null })).isError, true);
    assert.equal((await f.run('write_file', { path: 'missing/child.txt', content: 'x', expectedContent: null })).isError, true);
});
test('approval revalidation detects changed content, symlinks and hardlinks', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'a.txt'); await writeFile(file, 'before');
    f.context.approve = async () => { await writeFile(file, 'concurrent'); return true; };
    assert.equal((await f.run('write_file', { path: 'a.txt', content: 'after', expectedContent: 'before' })).isError, true);
    assert.equal(await readFile(file, 'utf8'), 'concurrent');
    await link(file, path.join(f.directory, 'linked.txt'));
    assert.equal((await f.run('write_file', { path: 'linked.txt', content: 'after', expectedContent: 'concurrent' })).isError, true);
    try { await symlink(f.directory, path.join(f.directory, 'junction'), 'junction'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    assert.equal((await f.run('read_file', { path: 'junction/a.txt' })).isError, true);
});
test('reads, literal search, output bounds and cancellation', async t => {
    const f = await fixture(t); await writeFile(path.join(f.directory, 'a.txt'), 'abc\nliteral [x]\nend');
    assert.equal((await f.run('read_file', { path: 'a.txt', offset: 4, limit: 7 })).content, 'literal');
    assert.match((await f.run('search_files', { query: '[x]' })).content, /a.txt:2: literal \[x\]/);
    assert.match((await f.run('list_directory', {})).content, /file a.txt/);
    await writeFile(path.join(f.directory, 'large.txt'), 'x'.repeat(1024 * 1024 + 1));
    assert.equal((await f.run('read_file', { path: 'large.txt' })).isError, true);
    f.controller.abort(); assert.equal((await f.run('read_file', { path: 'a.txt' })).isError, true);
});
test('abort while approval is pending never writes a file', async t => {
    const f = await fixture(t);
    let release: ((value: boolean) => void) | undefined;
    let entered: (() => void) | undefined;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    f.context.approve = async () => { entered?.(); return new Promise<boolean>(resolve => { release = resolve; }); };
    const pending = f.run('write_file', { path: 'cancelled.txt', content: 'x', expectedContent: null });
    await waiting; f.controller.abort();
    assert.equal((await pending).isError, true); release?.(true);
    await assert.rejects(readFile(path.join(f.directory, 'cancelled.txt')));
});
test('applied edit reports snapshot failure explicitly and filesystem diagnostics include safe codes', async t => {
    const f = await fixture(t);
    const result = await executeWorkspaceTool({ id: 'snapshot', name: 'write_file', arguments: JSON.stringify({ path: 'applied.txt', content: 'already applied', expectedContent: null }) }, { ...f.context, onArtifact: () => { throw new Error('private snapshot details'); } });
    assert.equal(result.isError, true); assert.match(result.content, /snapshot persistence failed/); assert.match(result.content, /do not retry/);
    assert.equal(result.outcome.status, 'succeeded'); assert.equal(result.outcome.effectState, 'confirmed');
    assert.equal(result.outcome.recordingState, 'failed'); assert.equal(result.outcome.errorCode, 'RECORDING_FAILED');
    assert.equal(result.outcome.retryClass, 'reconcile_first');
    assert.equal(result.content.includes('private snapshot details'), false);
    assert.equal(await readFile(path.join(f.directory, 'applied.txt'), 'utf8'), 'already applied');
    const missing = await f.run('read_file', { path: 'missing.txt' });
    assert.equal(missing.isError, true); assert.match(missing.content, /ENOENT/);
    const existing = await f.run('write_file', { path: 'applied.txt', content: 'wrong', expectedContent: null });
    assert.equal(existing.isError, true); assert.match(existing.content, /write_file.*EEXIST/);
});
test('parallel sibling overwrites serialize expected-content checks so exactly one wins', async t => {
    const f = await fixture(t); await writeFile(path.join(f.directory, 'shared.txt'), 'old');
    f.context.permissionMode = 'accept-edits';
    const results = await Promise.all(['first', 'second'].map(content => f.run('write_file', { path: 'shared.txt', content, expectedContent: 'old' })));
    assert.equal(results.filter(result => !result.isError).length, 1);
    assert.equal(results.filter(result => result.isError && /Overwrite conflict/.test(result.content)).length, 1);
    assert.ok(['first', 'second'].includes(await readFile(path.join(f.directory, 'shared.txt'), 'utf8')));
});
test('cancelled sibling never writes and leaves the per-file queue usable', async t => {
    const f = await fixture(t); await writeFile(path.join(f.directory, 'shared.txt'), 'old');
    const cancelled = new AbortController();
    const sample = await open(path.join(f.directory, 'shared.txt'), 'r'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    let reachedSync!: () => void; let releaseSync!: () => void; let approved!: () => void;
    const syncing = new Promise<void>(resolve => { reachedSync = resolve; });
    const release = new Promise<void>(resolve => { releaseSync = resolve; });
    const approvalReached = new Promise<void>(resolve => { approved = resolve; });
    const originalSync = prototype.sync;
    t.mock.method(prototype, 'sync', async function(this: FileHandle) { reachedSync(); await release; return originalSync.call(this); });
    const call = (content: string, expectedContent: string) => ({ id: content, name: 'write_file', arguments: JSON.stringify({ path: 'shared.txt', content, expectedContent }) });
    const first = executeWorkspaceTool(call('first', 'old'), { ...f.context, permissionMode: 'accept-edits' });
    await syncing; // First writer owns the lock until its actual sync operation completes.
    const second = executeWorkspaceTool(call('cancelled', 'first'), { ...f.context, signal: cancelled.signal, approve: async () => { approved(); return true; } });
    await approvalReached;
    await new Promise<void>(resolve => setImmediate(resolve)); // Drain approval microtasks through queue insertion; no filesystem or timer race.
    cancelled.abort(); const two = await second; releaseSync(); const one = await first;
    t.mock.restoreAll();
    assert.equal(one.isError, undefined); assert.equal(two.isError, true); assert.match(two.content, /cancelled while waiting for another write/);
    assert.equal(await readFile(path.join(f.directory, 'shared.txt'), 'utf8'), 'first');
    assert.equal((await f.run('write_file', { path: 'shared.txt', content: 'third', expectedContent: 'first' })).isError, undefined);
});
test('commands deny readonly, always ask auto, warn explicitly, and run harmless approved commands', { skip: process.platform !== 'win32' }, async t => {
    const f = await fixture(t);
    f.context.permissionMode = 'readonly'; assert.equal((await f.run('run_command', { command: "Write-Output 'hello'" })).isError, true); assert.equal(f.approvals(), 0);
    f.context.permissionMode = 'auto'; let summary = '';
    f.context.approve = async value => { summary = value; return false; };
    assert.equal((await f.run('run_command', { command: "Write-Output 'hello'" })).isError, true);
    assert.match(summary, /UNSANDBOXED/); assert.match(summary, /outside the workspace/);
    f.context.approve = async () => true;
    const result = await f.run('run_command', { command: "Write-Output 'hello'", timeoutSeconds: 5 });
    assert.equal(result.isError, false); assert.match(result.content, /hello/); assert.match(result.content, /tree exited: true/);
    assert.equal(result.outcome.exitCode, 0); assert.equal(result.outcome.effectState, 'possible');
    assert.equal(result.outcome.recordingState, 'pending');
    const timeout = await f.run('run_command', { command: 'Start-Sleep -Seconds 10', timeoutSeconds: 1 });
    assert.equal(timeout.isError, true); assert.match(timeout.content, /timeout/);
    assert.equal(timeout.outcome.errorCode, 'COMMAND_TIMEOUT'); assert.equal(timeout.outcome.effectState, 'possible');
    const overflow = await f.run('run_command', { command: "Write-Output ('x' * 70000); Set-Content -LiteralPath preview-completed.txt -Value done", timeoutSeconds: 5 });
    assert.equal(overflow.isError, false); assert.ok(overflow.content.length < 66000); assert.match(overflow.content, /Preview truncated/);
    assert.equal(overflow.outcome.exitCode, 0); assert.equal(overflow.outcome.truncation.truncated, true);
    assert.ok(overflow.outcome.artifactRefs.some(ref => ref.byteLength! > 65536));
    assert.match(await readFile(path.join(f.directory, 'preview-completed.txt'), 'utf8'), /done/);
    const pending = f.run('run_command', { command: 'Start-Sleep -Seconds 10', timeoutSeconds: 5 });
    setTimeout(() => f.controller.abort(), 150);
    assert.equal((await pending).isError, true);
});

test('commands require an injected managed runner and never fall back to a direct shell', async t => {
    const f = await fixture(t); f.context.permissionMode = 'bypass'; f.context.commandRunner = undefined;
    const result = await f.run('run_command', { command: "Set-Content -LiteralPath forbidden-fallback.txt -Value unsafe" });
    assert.equal(result.outcome.errorCode, 'EXECUTION_BACKEND_UNAVAILABLE');
    assert.equal(result.outcome.effectState, 'not_started'); assert.equal(result.isError, true);
    await assert.rejects(readFile(path.join(f.directory, 'forbidden-fallback.txt')));
    const definition = workspaceToolDefinitions().find(tool => tool.name === 'run_command')!;
    assert.equal((definition.parameters.properties as Record<string, { maxLength?: number }>).command.maxLength, 8192);
    assert.match(definition.description, /EncodedCommand/); assert.match(definition.description, /不是 sandbox/);
    assert.match(definition.description, /预览截断不会停止/);
});

test('outcomes expose explicit state, UTF-8 resource hashes and process monotonic evidence', async t => {
    const f = await fixture(t);
    const sha = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
    await writeFile(path.join(f.directory, 'a.txt'), 'before');
    const read = await f.run('read_file', { path: 'a.txt' });
    assert.equal(read.outcome.status, 'succeeded'); assert.equal(read.outcome.effectState, 'not_started');
    assert.equal(read.outcome.retryClass, 'safe'); assert.equal(read.outcome.recordingState, 'pending');
    assert.equal(read.outcome.resources[0].beforeHash, sha('before'));
    const write = await executeWorkspaceTool({ id: 'write', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'after', expectedContent: 'before' }) }, { ...f.context, onArtifact: async () => {} });
    assert.equal(write.outcome.effectState, 'confirmed'); assert.equal(write.outcome.recordingState, 'durable');
    assert.equal(write.outcome.resources[0].beforeHash, sha('before')); assert.equal(write.outcome.resources[0].afterHash, sha('after'));
    assert.equal(read.outcome.time.processEpochId, write.outcome.time.processEpochId);
    assert.match(read.outcome.time.processEpochId, /^[a-f0-9-]{36}$/);
    assert.ok(write.outcome.time.durationMs! >= 0); assert.ok(write.outcome.time.finishedAt);
    const conflict = await f.run('write_file', { path: 'a.txt', content: 'x', expectedContent: 'before' });
    assert.equal(conflict.outcome.status, 'failed'); assert.equal(conflict.outcome.effectState, 'not_started');
    f.context.permissionMode = 'readonly';
    const denied = await f.run('write_file', { path: 'a.txt', content: 'x', expectedContent: 'after' });
    assert.equal(denied.outcome.status, 'denied'); assert.equal(denied.outcome.effectState, 'not_started');
    f.controller.abort();
    const cancelled = await f.run('read_file', { path: 'a.txt' });
    assert.equal(cancelled.outcome.status, 'cancelled'); assert.equal(cancelled.outcome.errorCode, 'CANCELLED');
    assert.equal(cancelled.outcome.effectState, 'not_started');
});

test('sync and partial-write failures require reconciliation and record only observed hashes', async t => {
    const f = await fixture(t);
    const file = path.join(f.directory, 'a.txt');
    await writeFile(file, 'before');
    const sample = await open(file, 'r'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    const originalWrite = prototype.writeFile;
    for (const failurePoint of ['sync', 'partial'] as const) {
        await writeFile(file, 'before');
        if (failurePoint === 'sync') t.mock.method(prototype, 'sync', async () => { throw new Error('secret sync diagnostics'); });
        else t.mock.method(prototype, 'writeFile', async function(this: FileHandle) { await originalWrite.call(this, 'partial', 'utf8'); throw new Error('secret write diagnostics'); });
        const result = await executeWorkspaceTool({ id: 'fault', name: 'write_file', arguments: JSON.stringify({ path: 'a.txt', content: 'after', expectedContent: 'before' }) }, { ...f.context, onArtifact: () => { throw new Error('secret recording diagnostics'); } });
        t.mock.restoreAll();
        assert.equal(result.isError, true); assert.equal(result.outcome.status, 'failed');
        assert.equal(result.outcome.effectState, 'possible'); assert.equal(result.outcome.retryClass, 'reconcile_first');
        assert.equal(result.outcome.recordingState, 'failed'); assert.equal(result.outcome.errorCode, 'WRITE_FAILED');
        assert.ok(result.outcome.resources[0].afterHash); assert.equal(JSON.stringify(result).includes('secret'), false);
    }
});

test('close failure after sync preserves confirmed effect and snapshot failure stops unsafe retry', async t => {
    const f = await fixture(t);
    const file = path.join(f.directory, 'a.txt'); await writeFile(file, 'before');
    const sample = await open(file, 'r'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    const originalSync = prototype.sync;
    t.mock.method(prototype, 'sync', async function(this: FileHandle) {
        await originalSync.call(this);
        const close = this.close.bind(this);
        this.close = async () => { await close(); throw new Error('private close failure'); };
    });
    const result = await f.run('write_file', { path: 'a.txt', content: 'after', expectedContent: 'before' });
    t.mock.restoreAll();
    assert.equal(result.outcome.status, 'failed'); assert.equal(result.outcome.effectState, 'confirmed');
    assert.equal(result.outcome.recordingState, 'pending'); assert.equal(result.outcome.retryClass, 'reconcile_first');
    assert.equal(result.isError, true); assert.equal(await readFile(file, 'utf8'), 'after');
    assert.equal(JSON.stringify(result).includes('private close'), false);
});

test('cancelled wx creation reconciles only after owned empty-file cleanup is verified', async t => {
    const f = await fixture(t);
    const samplePath = path.join(f.directory, 'sample.txt'); await writeFile(samplePath, 'sample');
    const sample = await open(samplePath, 'r'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    const originalStat = prototype.stat;
    t.mock.method(prototype, 'stat', async function(this: FileHandle) { const stat = await originalStat.call(this); f.controller.abort(); return stat; });
    const result = await f.run('write_file', { path: 'cancelled.txt', content: 'x', expectedContent: null });
    t.mock.restoreAll();
    assert.equal(result.outcome.status, 'cancelled'); assert.equal(result.outcome.effectState, 'reconciled');
    assert.equal(result.outcome.retryClass, 'safe'); assert.equal(result.outcome.resources[0].afterHash, null);
    await assert.rejects(readFile(path.join(f.directory, 'cancelled.txt')));
});

test('failed owned-file inspection leaves wx effect possible rather than claiming no write', async t => {
    const f = await fixture(t);
    const samplePath = path.join(f.directory, 'sample.txt'); await writeFile(samplePath, 'sample');
    const sample = await open(samplePath, 'r'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    t.mock.method(prototype, 'stat', async () => { throw new Error('private inspection'); });
    const result = await f.run('write_file', { path: 'leftover.txt', content: 'x', expectedContent: null });
    t.mock.restoreAll();
    assert.equal(result.outcome.status, 'failed'); assert.equal(result.outcome.effectState, 'possible');
    assert.equal(result.outcome.retryClass, 'reconcile_first'); assert.equal(result.outcome.recordingState, 'pending');
    assert.equal(JSON.stringify(result).includes('private inspection'), false);
    assert.equal(await readFile(path.join(f.directory, 'leftover.txt'), 'utf8'), '');
});


const rawHash = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex');
test('range reads raw-hash UTF-8/BOM pages without splitting surrogate pairs and detects drift', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'range.txt');
    const raw = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('中😀Z\r\n尾')]);
    await writeFile(file, raw);
    const first = await f.run('read_file_range', { path: 'range.txt', limit: 2 });
    const page = JSON.parse(first.content);
    assert.equal(page.text, '中'); assert.equal(page.nextOffset, 1); assert.equal(page.offsetUnit, 'utf16');
    assert.equal(page.encoding, 'utf8-bom'); assert.equal(page.fileHash, rawHash(raw)); assert.equal(page.totalCharacters, 7);
    assert.equal(first.outcome.resources[0].hashKind, 'raw_bytes');
    const second = JSON.parse((await f.run('read_file_range', { path: 'range.txt', offset: 1, limit: 1, expectedHash: page.fileHash })).content);
    assert.equal(second.text, '😀'); assert.equal(second.nextOffset, 3);
    const tail = JSON.parse((await f.run('read_file_range', { path: 'range.txt', offset: 3, expectedHash: page.fileHash })).content);
    assert.equal(tail.text, 'Z\r\n尾'); assert.equal(tail.nextOffset, null); assert.equal(tail.truncated, false);
    for (const args of [{ offset: 1 }, { offset: 2, expectedHash: page.fileHash }, { offset: 8, expectedHash: page.fileHash }, { expectedHash: 'no' }]) {
        const result = await f.run('read_file_range', { path: 'range.txt', ...args });
        assert.equal(result.isError, true); assert.equal(result.outcome.effectState, 'not_started');
    }
    await writeFile(file, 'changed');
    assert.equal((await f.run('read_file_range', { path: 'range.txt', expectedHash: page.fileHash })).outcome.errorCode, 'READ_CONFLICT');
});

test('range supports 16 MiB, rejects unsupported bytes and limits, and observes cancellation', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'range.txt');
    await writeFile(file, '界'.repeat(400000));
    const result = await f.run('read_file_range', { path: 'range.txt', offset: 0, limit: 65536 });
    assert.equal(JSON.parse(result.content).text.length, 65536);
    assert.equal((await f.run('read_file', { path: 'range.txt' })).isError, true);
    for (const bytes of [Buffer.from([0xff, 0xfe, 0x61, 0]), Buffer.from([0xfe, 0xff, 0, 0x61]), Buffer.from([0xd6, 0xd0])]) {
        await writeFile(file, bytes);
        assert.equal((await f.run('read_file_range', { path: 'range.txt' })).outcome.errorCode, 'UNSUPPORTED_ENCODING');
    }
    const maximum = Buffer.alloc(16 * 1024 * 1024, 65);
    await writeFile(file, maximum);
    const boundary = JSON.parse((await f.run('read_file_range', { path: 'range.txt', offset: maximum.length, expectedHash: rawHash(maximum) })).content);
    assert.equal(boundary.totalCharacters, maximum.length); assert.equal(boundary.text, ''); assert.equal(boundary.nextOffset, null);
    await writeFile(file, Buffer.alloc(16 * 1024 * 1024 + 1, 65));
    assert.equal((await f.run('read_file_range', { path: 'range.txt' })).isError, true);
    for (const args of [{ offset: 16777217 }, { limit: 65537 }, { offset: 1.5 }, { limit: 0 }]) assert.equal((await f.run('read_file_range', { path: 'range.txt', ...args })).isError, true);
    f.controller.abort(); assert.equal((await f.run('read_file_range', { path: 'range.txt' })).outcome.status, 'cancelled');
});

test('patch sequential unique edits preserve raw BOM, CRLF and multibyte bytes with decoded snapshots', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'patch.txt');
    const before = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('甲\r\nunique\r\n😀')]);
    const after = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('甲\r\n终\r\n😀')]);
    await writeFile(file, before); let snapshot: { oldContent: string | null; newContent: string } | undefined;
    const result = await executeWorkspaceTool({ id: 'patch', name: 'apply_patch', arguments: JSON.stringify({ path: 'patch.txt', expectedHash: rawHash(before).toUpperCase(), edits: [{ oldText: 'unique', newText: 'next' }, { oldText: 'next', newText: '终' }] }) }, { ...f.context, onArtifact: change => { snapshot = change; } });
    assert.equal(result.isError, undefined); assert.deepEqual(await readFile(file), after);
    assert.equal(snapshot?.oldContent, before.subarray(3).toString()); assert.equal(snapshot?.newContent, after.subarray(3).toString());
    assert.equal(result.outcome.effectState, 'confirmed'); assert.equal(result.outcome.recordingState, 'durable');
    assert.equal(result.outcome.resources[0].hashKind, 'raw_bytes'); assert.equal(result.outcome.resources[0].beforeHash, rawHash(before)); assert.equal(result.outcome.resources[0].afterHash, rawHash(after));
});

test('patch validates every edit before writing, cannot create, and rejects invalid schemas', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'patch.txt'); const text = 'aaa unique'; await writeFile(file, text);
    const cases = [
        { edits: [{ oldText: 'aa', newText: 'x' }] },
        { edits: [{ oldText: 'unique', newText: 'ok' }, { oldText: 'missing', newText: 'x' }] },
        { edits: [{ oldText: '', newText: 'x' }] }, { edits: [] },
        { edits: Array.from({ length: 33 }, () => ({ oldText: 'unique', newText: 'x' })) },
        { edits: [{ oldText: 'unique', newText: 'x', extra: true }] },
        { edits: [{ oldText: 'unique', newText: 'x'.repeat(1024 * 1024) }] },
        { edits: [{ oldText: 'unique', newText: '\ud800' }] },
        { expectedHash: '0'.repeat(64), edits: [{ oldText: 'unique', newText: 'x' }] },
    ];
    for (const args of cases) {
        const result = await f.run('apply_patch', { path: 'patch.txt', expectedHash: rawHash(text), ...args });
        assert.equal(result.isError, true); assert.equal(result.outcome.effectState, 'not_started'); assert.equal(await readFile(file, 'utf8'), text);
    }
    assert.equal((await f.run('apply_patch', { path: 'missing.txt', expectedHash: rawHash(''), edits: [{ oldText: 'x', newText: 'y' }] })).isError, true);
    await assert.rejects(readFile(path.join(f.directory, 'missing.txt')));
});

test('patch shares approval, path revalidation, readonly and sibling locking protections', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'patch.txt'); const args = { path: 'patch.txt', expectedHash: rawHash('before'), edits: [{ oldText: 'before', newText: 'after' }] };
    await writeFile(file, 'before'); f.context.permissionMode = 'readonly';
    assert.equal((await f.run('apply_patch', args)).outcome.status, 'denied');
    f.context.permissionMode = 'manual'; f.context.approve = async () => false;
    assert.equal((await f.run('apply_patch', args)).outcome.status, 'denied');
    f.context.approve = async () => { await writeFile(file, 'drift'); return true; };
    assert.equal((await f.run('apply_patch', args)).outcome.errorCode, 'WRITE_CONFLICT'); assert.equal(await readFile(file, 'utf8'), 'drift');
    f.context.permissionMode = 'accept-edits'; await writeFile(file, 'before');
    const siblings = await Promise.all([f.run('apply_patch', args), f.run('write_file', { path: 'patch.txt', expectedContent: 'before', content: 'other' })]);
    assert.equal(siblings.filter(value => !value.isError).length, 1); assert.equal(siblings.filter(value => value.outcome.errorCode === 'WRITE_CONFLICT').length, 1);
    await link(file, path.join(f.directory, 'hard.txt'));
    assert.equal((await f.run('apply_patch', { ...args, path: 'hard.txt' })).outcome.effectState, 'not_started');
    try { await symlink(f.directory, path.join(f.directory, 'junction'), 'junction'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EPERM') return; throw error; }
    assert.equal((await f.run('read_file_range', { path: 'junction/patch.txt' })).isError, true);
    assert.equal((await f.run('apply_patch', { ...args, path: 'junction/patch.txt' })).isError, true);
});

test('patch partial, sync, close and recording failures preserve effect evidence without private diagnostics', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'patch.txt'); await writeFile(file, 'before');
    const sample = await open(file, 'r'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    const originalWrite = prototype.writeFile; const originalSync = prototype.sync;
    for (const fault of ['partial', 'sync', 'close', 'recording'] as const) {
        await writeFile(file, 'before');
        if (fault === 'partial') t.mock.method(prototype, 'writeFile', async function(this: FileHandle) { await originalWrite.call(this, 'part', 'utf8'); throw new Error('private partial'); });
        if (fault === 'sync') t.mock.method(prototype, 'sync', async () => { throw new Error('private sync'); });
        if (fault === 'close') t.mock.method(prototype, 'sync', async function(this: FileHandle) { await originalSync.call(this); const close = this.close.bind(this); this.close = async () => { await close(); throw new Error('private close'); }; });
        const result = await executeWorkspaceTool({ id: 'patch', name: 'apply_patch', arguments: JSON.stringify({ path: 'patch.txt', expectedHash: rawHash('before'), edits: [{ oldText: 'before', newText: 'after' }] }) }, { ...f.context, onArtifact: () => { throw new Error('private snapshot'); } });
        t.mock.restoreAll();
        assert.equal(result.isError, true); assert.equal(result.outcome.recordingState, 'failed'); assert.equal(result.outcome.retryClass, 'reconcile_first');
        assert.equal(result.outcome.effectState, fault === 'partial' || fault === 'sync' ? 'possible' : 'confirmed');
        assert.equal(result.outcome.errorCode, fault === 'recording' ? 'RECORDING_FAILED' : 'WRITE_FAILED');
        assert.equal(result.outcome.status, fault === 'recording' ? 'succeeded' : 'failed');
        assert.equal(result.outcome.resources[0].afterHash, rawHash(await readFile(file))); assert.equal(JSON.stringify(result).includes('private'), false);
    }
});


test('patch rejects unsupported encoding, oversized input/output and pending-approval cancellation without creating effects', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'patch.txt');
    for (const bytes of [Buffer.from([0xff, 0xfe, 65, 0]), Buffer.from([0xd6, 0xd0]), Buffer.alloc(1024 * 1024 + 1, 65)]) {
        await writeFile(file, bytes);
        const result = await f.run('apply_patch', { path: 'patch.txt', expectedHash: rawHash(bytes), edits: [{ oldText: 'A', newText: 'B' }] });
        assert.equal(result.isError, true); assert.equal(result.outcome.effectState, 'not_started'); assert.deepEqual(await readFile(file), bytes);
    }
    const full = 'A' + 'z'.repeat(1024 * 1024 - 1); await writeFile(file, full);
    const overflow = await f.run('apply_patch', { path: 'patch.txt', expectedHash: rawHash(full), edits: [{ oldText: 'A', newText: 'BB' }] });
    assert.equal(overflow.outcome.effectState, 'not_started'); assert.equal(await readFile(file, 'utf8'), full);
    await writeFile(file, 'before');
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    let release!: (value: boolean) => void;
    f.context.approve = async () => { entered(); return new Promise(resolve => { release = resolve; }); };
    const pending = f.run('apply_patch', { path: 'patch.txt', expectedHash: rawHash('before'), edits: [{ oldText: 'before', newText: 'after' }] });
    await waiting; f.controller.abort(); const cancelled = await pending; release(true);
    assert.equal(cancelled.outcome.status, 'cancelled'); assert.equal(cancelled.outcome.effectState, 'not_started'); assert.equal(await readFile(file, 'utf8'), 'before');
});
