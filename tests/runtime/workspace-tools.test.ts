import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, rm, link, symlink, open, type FileHandle } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { executeWorkspaceTool, workspaceToolDefinitions } from '../../src/runtime/workspace-tools';
import type { PermissionMode } from '../../src/shared/permissions';

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'uah-tools-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const controller = new AbortController();
    let approvals = 0;
    const context = { directory, permissionMode: 'manual' as PermissionMode, signal: controller.signal, approve: async (_summary: string, _path: string) => { approvals++; return true; } };
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
    assert.equal(workspaceToolDefinitions().length, 5);
    for (const [name, args] of [['unknown', {}], ['write_file', { path: 'x', content: 'x' }], ['write_file', { path: 'x', content: 'x', expectedContent: null, secret: 'x' }], ['run_command', { command: 'x', timeoutSeconds: 121 }], ['read_file', { path: 'x', offset: -1 }], ['search_files', { query: '' }], ['write_file', { path: 'x', content: 'x'.repeat(1024 * 1024 + 1), expectedContent: null }]] as const) assert.equal((await f.run(name, args)).isError, true);
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
    assert.equal(result.isError, undefined); assert.match(result.content, /snapshot persistence failed/); assert.match(result.content, /do not retry/);
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
    assert.equal(result.isError, false); assert.match(result.content, /hello/); assert.match(result.content, /descendants may survive/);
    const timeout = await f.run('run_command', { command: 'Start-Sleep -Seconds 10', timeoutSeconds: 1 });
    assert.equal(timeout.isError, true); assert.match(timeout.content, /timeout/);
    const overflow = await f.run('run_command', { command: "Write-Output ('x' * 70000)", timeoutSeconds: 5 });
    assert.equal(overflow.isError, true); assert.ok(overflow.content.length < 66000); assert.match(overflow.content, /64 KiB/);
    const pending = f.run('run_command', { command: 'Start-Sleep -Seconds 10', timeoutSeconds: 5 });
    setTimeout(() => f.controller.abort(), 150);
    assert.equal((await pending).isError, true);
});
