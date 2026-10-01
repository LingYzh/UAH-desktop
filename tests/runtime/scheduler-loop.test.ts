import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { open, type FileHandle } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { ToolScheduler, type ToolResourceMode } from '../../src/runtime/tool-scheduler';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RuntimeEvent, Snapshot } from '../../src/shared/contracts';

function deferred<T = void>() {
    let resolveValue!: (value: T) => void;
    const promise = new Promise<T>(resolve => { resolveValue = resolve; });
    return { promise, resolve: resolveValue };
}
interface Body { messages: Array<{ role: string; content?: string }>; }
function answer(response: ServerResponse, calls: Array<{ name: string; args: unknown }> = []) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `call-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'Settled.' };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta }] })}\n\n` +
        `data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

async function fixture(t: { after(fn: () => Promise<void>): void }) {
    const root = mkdtempSync(join(tmpdir(), 'uah-scheduler-loop-')); const project = join(root, 'project'); mkdirSync(project);
    const childResponses = new Map<string, ServerResponse>(); const childrenReady = deferred();
    const errors: unknown[] = []; const listeners = new Set<() => void>();
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Body;
            const prompt = body.messages.filter(item => item.role === 'user').at(-1)?.content;
            const results = body.messages.filter(item => item.role === 'tool');
            if ((prompt === 'CHILD A' || prompt === 'CHILD B') && results.length === 0) {
                childResponses.set(prompt, response); if (childResponses.size === 2) childrenReady.resolve(); return;
            }
            if (prompt === 'ROOT' && results.length === 0) answer(response, ['CHILD A', 'CHILD B'].map(prompt => ({ name: 'spawn_agent', args: { prompt, agent: { type: 'inherit' }, context: { mode: 'none' } } })));
            else if (prompt === 'ROOT' && results.length === 2) answer(response, [{ name: 'wait_agents', args: { agentIds: results.map(item => JSON.parse(item.content!).agentId), timeoutMs: 60000 } }]);
            else answer(response);
        } catch (error) { errors.push(error); response.destroy(); }
    });
    await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const settings = defaultAgentSettings(); settings.subagents.enabled = true;
    const supervisor = new Supervisor({ dataDirectory: join(root, 'data'), delayMs: 0,
        onEvent: (_event: RuntimeEvent) => { for (const listener of listeners) listener(); }, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); if (!profile) throw new Error('Missing profile'); return profile; },
        resolveConnection: async id => ({ id, name: 'Local scheduler fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}`, apiKey: 'local-fixture', enabled: true, models: ['model'], revision: 1 }) });
    t.after(async () => {
        // Cancel only fixture-owned HTTP lifecycle handles before draining the runtime.
        for (const response of childResponses.values()) if (!response.writableEnded) response.destroy();
        server.closeAllConnections();
        await supervisor.shutdown(); await new Promise<void>(resolveClose => server.close(() => resolveClose()));
        assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-scheduler-loop-'));
        rmSync(target, { recursive: true, force: true });
    });
    const created = await supervisor.execute({ type: 'create-session', title: 'Scheduler fixture', directory: project,
        selection: { endpointId: 'fixture', modelId: 'model' }, controls: { permissionMode: 'accept-edits', reasoningEffort: 'default' }, agentId: 'default' });
    const sessionId = created.sessions[0].id;
    const snapshot = () => supervisor.execute({ type: 'snapshot' });
    const waitState = (predicate: (state: Snapshot) => boolean) => new Promise<Snapshot>((resolveState, reject) => {
        const timeout = setTimeout(() => { listeners.delete(inspect); reject(new Error('Scheduler fixture state deadline exceeded')); }, 8000);
        const inspect = () => { void snapshot().then(state => { if (predicate(state)) { clearTimeout(timeout); listeners.delete(inspect); resolveState(state); } }, reject); };
        listeners.add(inspect); inspect();
    });
    return { project, supervisor, sessionId, childResponses, childrenReady: childrenReady.promise, snapshot, waitState,
        start: () => supervisor.execute({ type: 'start-run', sessionId, input: 'ROOT' }) };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function observeScheduler(t: { mock: { method: (...args: any[]) => unknown } }, f: Fixture) {
    const original = ToolScheduler.prototype.acquire;
    const records: Array<{ mode: ToolResourceMode; granted: boolean; released: boolean; gateAtRelease?: boolean }> = [];
    const listeners = new Set<() => void>();
    t.mock.method(ToolScheduler.prototype, 'acquire', function(this: ToolScheduler, mode: ToolResourceMode, signal: AbortSignal) {
        const record = { mode, granted: false, released: false, gateAtRelease: false }; records.push(record);
        for (const listener of listeners) listener();
        return original.call(this, mode, signal).then(release => {
            record.granted = true;
            for (const listener of listeners) listener();
            return () => {
                record.gateAtRelease = (Reflect.get(f.supervisor, 'sessionNeedsReconciliation') as (id: string) => boolean).call(f.supervisor, f.sessionId);
                record.released = true; release();
                for (const listener of listeners) listener();
            };
        });
    });
    const waitCount = (count: number) => new Promise<void>((resolveCount, reject) => {
        const timer = setTimeout(() => { listeners.delete(inspect); reject(new Error('Resource acquisition deadline exceeded')); }, 8000);
        const inspect = () => { if (records.length >= count) { clearTimeout(timer); listeners.delete(inspect); resolveCount(); } };
        listeners.add(inspect); inspect();
    });
    return { records, waitCount };
}

async function blockWrite(t: { mock: { method: (...args: any[]) => unknown } }, project: string) {
    const sample = await open(join(project, 'prototype.txt'), 'w'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    const original = prototype.writeFile; const entered = deferred(); const resume = deferred();
    t.mock.method(prototype, 'writeFile', async function(this: FileHandle, value: Parameters<FileHandle['writeFile']>[0], options: Parameters<FileHandle['writeFile']>[1]) {
        if (value === 'FIRST WRITE') { entered.resolve(); await resume.promise; }
        return original.call(this, value, options);
    });
    return { entered: entered.promise, resume: () => resume.resolve() };
}
const writeCall = (path: string, content: string) => [{ name: 'write_file', args: { path, content, expectedContent: null } }];
const parentWaiting = (state: Snapshot) => state.runs.some(run => !run.parentRunId && run.activities?.some(activity => activity.title === 'wait_agents' && activity.status === 'running'));
const allTerminal = (state: Snapshot) => state.runs.length === 3 && state.runs.every(run => ['completed', 'failed', 'stopped'].includes(run.state));

test('different child files share one writer and parent wait_agents holds no resource lease', { timeout: 15000 }, async t => {
    const f = await fixture(t); const scheduler = observeScheduler(t, f); const first = await blockWrite(t, f.project);
    try {
        await f.start(); await f.childrenReady;
        answer(f.childResponses.get('CHILD A')!, writeCall('first.txt', 'FIRST WRITE')); await first.entered;
        answer(f.childResponses.get('CHILD B')!, writeCall('second.txt', 'SECOND WRITE')); await scheduler.waitCount(2);
        await f.waitState(parentWaiting);
        assert.deepEqual(scheduler.records.map(item => [item.mode, item.granted]), [['write', true], ['write', false]]);
        assert.equal(existsSync(join(f.project, 'second.txt')), false, 'queued writer cannot even create a different file');
        first.resume(); const done = await f.waitState(allTerminal);
        assert.ok(done.runs.every(run => run.state === 'completed'));
        assert.equal(readFileSync(join(f.project, 'first.txt'), 'utf8'), 'FIRST WRITE'); assert.equal(readFileSync(join(f.project, 'second.txt'), 'utf8'), 'SECOND WRITE');
        assert.equal(scheduler.records.length, 2, 'spawn/wait host tools never acquire resource leases');
        assert.ok(scheduler.records.every(item => item.released));
    } finally { first.resume(); }
});

test('reader lease excludes a child writer until the read and result recording settle', { timeout: 15000 }, async t => {
    const f = await fixture(t); const scheduler = observeScheduler(t, f); const text = 'CONTROLLED READER'; writeFileSync(join(f.project, 'read.txt'), text);
    const sample = await open(join(f.project, 'read.txt'), 'r'); const prototype = Object.getPrototypeOf(sample) as FileHandle; await sample.close();
    const original = prototype.read; const entered = deferred(); const resume = deferred();
    t.mock.method(prototype, 'read', async function(this: FileHandle, ...args: any[]) {
        const result = await Reflect.apply(original, this, args);
        if (result.buffer?.subarray(0, result.bytesRead).toString('utf8') === text) { entered.resolve(); await resume.promise; }
        return result;
    });
    try {
        await f.start(); await f.childrenReady;
        answer(f.childResponses.get('CHILD A')!, [{ name: 'read_file', args: { path: 'read.txt' } }]); await entered.promise;
        answer(f.childResponses.get('CHILD B')!, writeCall('writer.txt', 'WRITE AFTER READ')); await scheduler.waitCount(2);
        assert.deepEqual(scheduler.records.map(item => [item.mode, item.granted]), [['read', true], ['write', false]]);
        assert.equal(existsSync(join(f.project, 'writer.txt')), false);
        resume.resolve(); await f.waitState(allTerminal);
        assert.equal(readFileSync(join(f.project, 'writer.txt'), 'utf8'), 'WRITE AFTER READ');
    } finally { resume.resolve(); }
});

test('stopping a queued child writer removes its request without filesystem execution', { timeout: 15000 }, async t => {
    const f = await fixture(t); const scheduler = observeScheduler(t, f); const first = await blockWrite(t, f.project);
    try {
        await f.start(); await f.childrenReady;
        answer(f.childResponses.get('CHILD A')!, writeCall('first.txt', 'FIRST WRITE')); await first.entered;
        answer(f.childResponses.get('CHILD B')!, writeCall('stopped.txt', 'MUST NOT WRITE')); await scheduler.waitCount(2);
        const state = await f.snapshot(); const child = state.runs.find(run => run.input === 'CHILD B')!;
        await f.supervisor.execute({ type: 'stop-run', runId: child.id });
        assert.equal(scheduler.records[1].granted, false); assert.equal(existsSync(join(f.project, 'stopped.txt')), false);
        first.resume(); const done = await f.waitState(allTerminal);
        assert.equal(done.runs.find(run => run.id === child.id)!.state, 'stopped');
        assert.equal(existsSync(join(f.project, 'stopped.txt')), false); assert.equal(scheduler.records[1].granted, false);
    } finally { first.resume(); }
});

test('failed first writer artifact recording closes session gate before lease release and blocks queued writer', { timeout: 15000 }, async t => {
    const originalCommit = RuntimeStore.prototype.commit;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.artifacts?.length) throw new Error('private fixture persistence failure');
        return originalCommit.call(this, changes);
    });
    const f = await fixture(t); const scheduler = observeScheduler(t, f); const first = await blockWrite(t, f.project);
    try {
        await f.start(); await f.childrenReady;
        answer(f.childResponses.get('CHILD A')!, writeCall('first.txt', 'FIRST WRITE')); await first.entered;
        answer(f.childResponses.get('CHILD B')!, writeCall('blocked.txt', 'MUST NOT WRITE')); await scheduler.waitCount(2);
        assert.equal(scheduler.records[1].granted, false); first.resume();
        const done = await f.waitState(allTerminal);
        assert.equal(readFileSync(join(f.project, 'first.txt'), 'utf8'), 'FIRST WRITE');
        assert.equal(existsSync(join(f.project, 'blocked.txt')), false);
        assert.equal(scheduler.records[0].gateAtRelease, true, 'recording_failed gate must precede first lease release');
        assert.ok(done.runs.some(run => run.input === 'CHILD A' && run.harnessState === 'recording_failed'));
        const second = done.runs.find(run => run.input === 'CHILD B')!;
        assert.equal(second.activities?.find(activity => activity.title === 'write_file')?.tool?.outcome?.effectState, 'not_started');
        assert.ok(scheduler.records.filter(item => item.granted).every(item => item.released), 'failure must release every granted resource lease');
        const resourceQueue = Reflect.get(f.supervisor, 'toolScheduler');
        assert.equal(Reflect.get(resourceQueue, 'queue').length, 0);
        assert.equal(Reflect.get(resourceQueue, 'readers'), 0);
        assert.equal(Reflect.get(resourceQueue, 'writer'), false);
        assert.equal(JSON.stringify(done).includes('private fixture persistence failure'), false);
    } finally { first.resume(); }
});
