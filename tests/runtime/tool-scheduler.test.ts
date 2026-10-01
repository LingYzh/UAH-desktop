import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile, readFile, rm, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ToolScheduler } from '../../src/runtime/tool-scheduler';
import { executeWorkspaceTool } from '../../src/runtime/workspace-tools';
import type { PermissionMode } from '../../src/shared/permissions';

const signal = () => new AbortController().signal;
const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('scheduler bounds readers at four and repeated release never creates spare capacity', async () => {
    const scheduler = new ToolScheduler();
    const readers = await Promise.all(Array.from({ length: 4 }, () => scheduler.acquire('read', signal())));
    let fifthGranted = false; let sixthGranted = false;
    const fifth = scheduler.acquire('read', signal()).then(release => { fifthGranted = true; return release; });
    const sixth = scheduler.acquire('read', signal()).then(release => { sixthGranted = true; return release; });
    await turn(); assert.equal(fifthGranted, false);
    readers[0](); readers[0]();
    const releaseFifth = await fifth;
    await turn(); assert.equal(sixthGranted, false);
    releaseFifth(); const releaseSixth = await sixth;
    readers.slice(1).forEach(release => release()); releaseSixth(); releaseSixth();
    const writer = await scheduler.acquire('write', signal()); writer(); writer();
});

test('writer is exclusive and later readers cannot bypass an earlier queued writer', async () => {
    const scheduler = new ToolScheduler(); const log: string[] = [];
    const first = await scheduler.acquire('read', signal());
    const writer = scheduler.acquire('write', signal()).then(release => { log.push('writer'); return release; });
    const reader = scheduler.acquire('read', signal()).then(release => { log.push('reader'); return release; });
    const lastWriter = scheduler.acquire('write', signal()).then(release => { log.push('last-writer'); return release; });
    await turn(); assert.deepEqual(log, []);
    first(); const releaseWriter = await writer;
    await turn(); assert.deepEqual(log, ['writer']);
    releaseWriter(); const releaseReader = await reader;
    await turn(); assert.deepEqual(log, ['writer', 'reader']);
    releaseReader(); (await lastWriter)();
    assert.deepEqual(log, ['writer', 'reader', 'last-writer']);
});

test('FIFO reader group ahead of writer runs together before following readers', async () => {
    const scheduler = new ToolScheduler(2); const log: string[] = [];
    const initial = await scheduler.acquire('write', signal());
    const queued = ['read', 'read', 'write', 'read'].map((mode, index) => scheduler.acquire(mode as 'read' | 'write', signal())
        .then(release => { log.push(String(index)); return release; }));
    initial(); const a = await queued[0]; const b = await queued[1];
    assert.deepEqual(log, ['0', '1']);
    a(); await turn(); assert.deepEqual(log, ['0', '1']);
    b(); const c = await queued[2]; assert.deepEqual(log, ['0', '1', '2']);
    c(); (await queued[3])(); assert.deepEqual(log, ['0', '1', '2', '3']);
});

test('queued abort removes immediately and granted abort never releases ownership', async () => {
    const scheduler = new ToolScheduler(2);
    const owner = new AbortController(); const first = await scheduler.acquire('read', owner.signal);
    const queued = new AbortController();
    const rejection = assert.rejects(scheduler.acquire('write', queued.signal), { name: 'AbortError' });
    let readerGranted = false;
    const reader = scheduler.acquire('read', signal()).then(release => { readerGranted = true; return release; });
    await turn(); assert.equal(readerGranted, false);
    queued.abort(); await rejection; const second = await reader;
    owner.abort(); let writerGranted = false;
    const writer = scheduler.acquire('write', signal()).then(release => { writerGranted = true; return release; });
    second(); await turn(); assert.equal(writerGranted, false);
    first(); (await writer)();
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(scheduler.acquire('read', cancelled.signal), { name: 'AbortError' });
    (await scheduler.acquire('write', signal()))();
});

test('scheduler rejects invalid bounds and modes', async () => {
    for (const maximum of [0, -1, 1.5, NaN, Infinity]) assert.throws(() => new ToolScheduler(maximum), /positive safe integer/);
    await assert.rejects(new ToolScheduler().acquire('other' as 'read', signal()), /Invalid/);
});

async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const root = path.resolve(tmpdir()); const directory = await mkdtemp(path.join(root, 'uah-scheduler-'));
    t.after(async () => { const target = path.resolve(directory); assert.ok(target.startsWith(root + path.sep) && target !== root); await rm(target, { recursive: true, force: true }); });
    const controller = new AbortController();
    const context = { directory, permissionMode: 'manual' as PermissionMode, signal: controller.signal, approve: async () => true };
    const call = (name: string, args: unknown) => ({ id: name, name, arguments: JSON.stringify(args) });
    return { directory, controller, context, call };
}

test('workspace acquires after approval and never acquires for permission denial', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'file.txt'); await writeFile(file, 'before');
    let approveEntered!: () => void; const entered = new Promise<void>(resolve => { approveEntered = resolve; });
    let approve!: (value: boolean) => void;
    const modes: string[] = [];
    const context = { ...f.context, approve: async () => { approveEntered(); return new Promise<boolean>(resolve => { approve = resolve; }); },
        acquireResource: async (mode: 'read' | 'write') => { modes.push(mode); } };
    const pending = executeWorkspaceTool(f.call('write_file', { path: 'file.txt', content: 'after', expectedContent: 'before' }), context);
    await entered; assert.deepEqual(modes, []); approve(true);
    assert.equal((await pending).isError, undefined); assert.deepEqual(modes, ['write']);
    context.permissionMode = 'readonly';
    assert.equal((await executeWorkspaceTool(f.call('write_file', { path: 'file.txt', content: 'denied', expectedContent: 'after' }), context)).outcome.status, 'denied');
    assert.deepEqual(modes, ['write']);
    context.permissionMode = 'manual'; context.approve = async () => false;
    assert.equal((await executeWorkspaceTool(f.call('run_command', { command: 'ignored' }), context)).outcome.status, 'denied');
    assert.deepEqual(modes, ['write']);
});

test('workspace readers use read leases and unknown command effects use write leases', async t => {
    const f = await fixture(t); await writeFile(path.join(f.directory, 'file.txt'), 'text');
    const modes: string[] = [];
    const context = { ...f.context, acquireResource: async (mode: 'read' | 'write') => { modes.push(mode); },
        commandRunner: async () => ({ content: 'stub completed' }) };
    for (const [name, args] of [['read_file', { path: 'file.txt' }], ['read_file_range', { path: 'file.txt' }], ['list_directory', {}], ['search_files', { query: 'text' }], ['run_command', { command: 'unknown effects' }]] as const) {
        assert.equal((await executeWorkspaceTool(f.call(name, args), context)).isError, undefined);
    }
    assert.deepEqual(modes, ['read', 'read', 'read', 'read', 'write']);
});

test('lease acquisition revalidates target identity and expected content before writes', async t => {
    const f = await fixture(t); const file = path.join(f.directory, 'file.txt'); await writeFile(file, 'before');
    const args = { path: 'file.txt', content: 'after', expectedContent: 'before' };
    const drifted = await executeWorkspaceTool(f.call('write_file', args), { ...f.context, acquireResource: async () => { await writeFile(file, 'drift'); } });
    assert.equal(drifted.outcome.errorCode, 'WRITE_CONFLICT'); assert.equal(drifted.outcome.effectState, 'not_started');
    assert.equal(await readFile(file, 'utf8'), 'drift');
    let dispatched = false;
    const linked = await executeWorkspaceTool(f.call('write_file', { ...args, expectedContent: 'drift' }), { ...f.context,
        acquireResource: async () => { await link(file, path.join(f.directory, 'other.txt')); }, beforeDispatch: () => { dispatched = true; } });
    assert.equal(linked.isError, true); assert.equal(dispatched, false); assert.equal(await readFile(file, 'utf8'), 'drift');
});

test('cancel during queued workspace acquisition has no effect and host retains granted lease through recording', async t => {
    const f = await fixture(t); const scheduler = new ToolScheduler(); const held = await scheduler.acquire('write', signal());
    let entered!: () => void; const waiting = new Promise<void>(resolve => { entered = resolve; });
    const queued = executeWorkspaceTool(f.call('write_file', { path: 'new.txt', content: 'x', expectedContent: null }), { ...f.context,
        acquireResource: async mode => { entered(); await scheduler.acquire(mode, f.controller.signal); } });
    await waiting; f.controller.abort(); const cancelled = await queued;
    assert.equal(cancelled.outcome.status, 'cancelled'); assert.equal(cancelled.outcome.effectState, 'not_started');
    await assert.rejects(readFile(path.join(f.directory, 'new.txt')), /ENOENT/); held();
    let lease!: () => void;
    const result = await executeWorkspaceTool(f.call('write_file', { path: 'new.txt', content: 'x', expectedContent: null }), { ...f.context, signal: signal(),
        acquireResource: async mode => { lease = await scheduler.acquire(mode, signal()); }, onArtifact: () => { throw new Error('recording failed'); } });
    assert.equal(result.outcome.recordingState, 'failed');
    let nextGranted = false;
    const next = scheduler.acquire('write', signal()).then(release => { nextGranted = true; return release; });
    await turn(); assert.equal(nextGranted, false, 'workspace must leave global lease to its host');
    lease(); (await next)();
});
