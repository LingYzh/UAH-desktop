import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { backup, DatabaseSync } from 'node:sqlite';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { ApiConnection } from '../../src/shared/endpoints';
import type { RunRecord } from '../../src/shared/contracts';
import type { InvocationIdentity, TranscriptEvent } from '../../src/shared/harness-contracts';

const opaque = 'BRANCH_NATIVE_OPAQUE_CONTINUATION';
function answer(response: ServerResponse, index: number) {
    const output = index === 1 ? [{ type: 'function_call', id: 'write-item', call_id: 'write-call', name: 'write_file', arguments: JSON.stringify({ path: 'external.txt', content: 'USER WORKSPACE FILE', expectedContent: null }) }]
        : [{ type: 'reasoning', id: `reasoning-${index}`, summary: [], encrypted_content: opaque }, { type: 'message', id: `answer-${index}`, role: 'assistant', content: [{ type: 'output_text', text: `COMPLETED ${index}` }] }];
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output, usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 } } })}\n\n`);
}
async function fixture(t: { after(fn: () => Promise<void>): void }, respond = answer) {
    const root = mkdtempSync(join(tmpdir(), 'uah-purge-loop-')); const data = join(root, 'data'); const project = join(root, 'workspace'); mkdirSync(project);
    const requests: unknown[] = []; const errors: unknown[] = [];
    const server = createServer(async (request, response) => {
        try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8'))); respond(response, requests.length); }
        catch (error) { errors.push(error); response.destroy(); }
    });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, fail) => { const onError = (error: Error) => { server.off('listening', onReady); fail(error); }; const onReady = () => { server.off('error', onError); ready(); }; server.once('error', onError); server.once('listening', onReady); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings();
    const connection: ApiConnection = { id: 'fixture', name: 'Purge fixture', protocol: 'openai-responses', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'LOCAL_PURGE_SECRET', models: ['model'], enabled: true, revision: 1, modelDetails: [{ id: 'model', tools: true }] };
    const create = () => new Supervisor({ dataDirectory: data, delayMs: 0, onEvent: () => {}, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; }, resolveConnection: async () => structuredClone(connection) });
    let supervisor = create();
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.deepEqual(errors, []); const path = resolve(root); assert.equal(dirname(path), resolve(tmpdir())); assert.ok(basename(path).startsWith('uah-purge-loop-')); rmSync(path, { recursive: true, force: true }); });
    const createSession = async (branchFromRunId?: string) => {
        const before = new Set((await supervisor.execute({ type: 'snapshot' })).sessions.map(item => item.id));
        const result = await supervisor.execute({ type: 'create-session', title: branchFromRunId ? 'Independent branch' : 'Purge target', directory: project, agentId: 'default', selection: { endpointId: 'fixture', modelId: 'model' }, controls: { permissionMode: 'auto', reasoningEffort: 'default' }, ...(branchFromRunId ? { branchFromRunId } : {}) });
        return result.sessions.find(item => !before.has(item.id))!.id;
    };
    const sessionId = await createSession();
    const store = <T>(action: (db: RuntimeStore) => T) => { const db = new RuntimeStore(data); try { return action(db); } finally { db.close(); } };
    const complete = async (id = sessionId) => {
        const started = await supervisor.execute({ type: 'start-run', sessionId: id, input: 'Complete the requested task.' }); const runId = started.runs.filter(run => run.sessionId === id).at(-1)!.id;
        for (let attempt = 0; attempt < 1000; attempt++) {
            const run = (await supervisor.execute({ type: 'snapshot' })).runs.find(item => item.id === runId)!;
            if (['completed', 'failed', 'stopped'].includes(run.state)) { assert.equal(run.state, 'completed', run.error); return run; }
            await delay(10);
        }
        throw new Error('Purge SSE fixture terminal deadline');
    };
    const restart = async (edit?: (db: RuntimeStore) => void) => { await supervisor.shutdown(); if (edit) store(edit); supervisor = create(); };
    const partition = join(data, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
    const begin = () => { const review = supervisor.sessionPurgeReview(sessionId); assert.equal(review.canDelete, true, review.reasons.join(';')); supervisor.beginSessionPurge(sessionId, review.fingerprint); return review; };
    return { get supervisor() { return supervisor; }, root, data, project, requests, sessionId, partition, createSession, complete, store, restart, begin };
}

test('real SSE target purge removes canonical/context/display/owned evidence, preserves external files and independent native branch/export across restart', async t => {
    const f = await fixture(t); const original = await f.complete(); assert.equal(f.requests.length, 2);
    const branchId = await f.createSession(original.id); await f.complete(branchId);
    assert.equal(JSON.stringify(f.requests[2]).includes(opaque), true);
    const review = f.begin(); assert.equal(review.branchCount, 1);
    const pending = await f.supervisor.execute({ type: 'snapshot' }); assert.deepEqual(pending.pendingSessionPurges, [f.sessionId]);
    assert.equal(pending.sessions.some(item => item.id === f.sessionId), false); assert.equal(pending.runs.some(item => item.sessionId === f.sessionId), false);
    await assert.rejects(f.supervisor.execute({ type: 'start-run', sessionId: branchId, input: 'Must wait for browser cleanup.' }), /删除/);
    assert.equal(existsSync(join(f.partition, 'manifest.json')), true, 'logical deletion leaves explicit pending physical cleanup');
    assert.deepEqual(f.store(db => db.readJournal(f.sessionId)), []); assert.equal(f.store(db => db.readRequestContext(original.id)), null);
    assert.deepEqual(f.store(db => db.readSessionSnapshot(f.sessionId)), { sessions: [], runs: [], approvals: [], artifacts: [] });
    const result = f.supervisor.finishSessionPurge(f.sessionId); assert.equal(result.completed, true, result.error);
    assert.equal(existsSync(f.partition), false); assert.deepEqual(f.supervisor.pendingSessionPurges(), []);
    assert.equal(readFileSync(join(f.project, 'external.txt'), 'utf8'), 'USER WORKSPACE FILE');
    const exportResult = f.supervisor.journalExport(branchId, join(f.root, 'branch-export'), 'full'); assert.ok(exportResult);
    await f.restart(); assert.equal(existsSync(f.partition), false, 'restart must not recreate a deleted writer manifest');
    await f.complete(branchId); assert.ok(JSON.stringify(f.requests.at(-1)).includes(opaque), 'branch native continuation remains usable without its source session');
    assert.equal(existsSync(f.partition), false);
});

test('release unlocks other work but pending is durable and startup does not automatically finish cleanup', async t => {
    const f = await fixture(t); await f.complete(); f.begin(); f.supervisor.releaseSessionPurge(f.sessionId);
    const other = await f.createSession(); assert.ok(other); assert.deepEqual(f.supervisor.pendingSessionPurges(), [f.sessionId]);
    await f.restart(); assert.equal(existsSync(join(f.partition, 'manifest.json')), true);
    assert.deepEqual((await f.supervisor.execute({ type: 'snapshot' })).pendingSessionPurges, [f.sessionId]);
    assert.equal(f.requests.length, 2); assert.equal(f.supervisor.finishSessionPurge(f.sessionId).completed, true);
    assert.equal(existsSync(f.partition), false);
});

test('unlink failure retains pending intent and retry after restart finishes without restoring deleted canonical evidence', async t => {
    const f = await fixture(t); await f.complete(); f.begin();
    const original = fs.unlinkSync; const mock = t.mock.method(fs, 'unlinkSync', (path: Parameters<typeof fs.unlinkSync>[0]) => { if (String(path).startsWith(f.partition)) throw new Error('Injected owned unlink failure'); return original(path); }); syncBuiltinESMExports();
    try { const result = f.supervisor.finishSessionPurge(f.sessionId); assert.equal(result.completed, false); assert.match(result.error!, /Injected owned unlink failure/); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    await f.restart(); assert.deepEqual(f.supervisor.pendingSessionPurges(), [f.sessionId]); assert.deepEqual(f.store(db => db.readJournal(f.sessionId)), []);
    assert.equal(f.supervisor.finishSessionPurge(f.sessionId).completed, true); assert.equal(existsSync(f.partition), false);
    await f.restart(); assert.equal(existsSync(f.partition), false);
});

test('a junction substituted after logical deletion is refused, external files survive and restoring original directory enables retry', async t => {
    const f = await fixture(t); await f.complete(); f.begin(); const moved = join(f.root, 'original-partition'); renameSync(f.partition, moved); symlinkSync(f.project, f.partition, 'junction');
    const result = f.supervisor.finishSessionPurge(f.sessionId); assert.equal(result.completed, false); assert.match(result.error!, /link/);
    assert.equal(readFileSync(join(f.project, 'external.txt'), 'utf8'), 'USER WORKSPACE FILE');
    rmSync(f.partition); renameSync(moved, f.partition); await f.restart();
    assert.equal(f.supervisor.finishSessionPurge(f.sessionId).completed, true);
});

test('stale filesystem review fingerprints cannot logically delete the session', async t => {
    const f = await fixture(t); const run = await f.complete(); const review = f.supervisor.sessionPurgeReview(f.sessionId);
    writeFileSync(join(f.partition, 'appeared.txt'), 'Created after confirmation review');
    assert.throws(() => f.supervisor.beginSessionPurge(f.sessionId, review.fingerprint), /变化/);
    assert.ok(f.store(db => db.readRun(run.id))); assert.deepEqual(f.supervisor.pendingSessionPurges(), []);
    f.begin(); assert.equal(f.supervisor.finishSessionPurge(f.sessionId).completed, true);
});

test('active work, plan edits and persisted recording failure prevent review approval', async t => {
    let held: ServerResponse | undefined; const f = await fixture(t, (response, index) => { if (index === 1) held = response; else answer(response, index); });
    const started = await f.supervisor.execute({ type: 'start-run', sessionId: f.sessionId, input: 'Hold this request.' });
    for (let attempt = 0; !held && attempt < 100; attempt++) await delay(10);
    assert.ok(held); assert.equal(f.supervisor.sessionPurgeReview(f.sessionId).canDelete, false); answer(held, 2);
    let source: RunRecord | undefined;
    for (let attempt = 0; attempt < 500; attempt++) { source = (await f.supervisor.execute({ type: 'snapshot' })).runs.find(run => run.id === started.runs.at(-1)!.id); if (source?.state === 'completed') break; await delay(10); }
    assert.equal(source?.state, 'completed');
    const internals = f.supervisor as unknown as { planEdits: Set<string> }; internals.planEdits.add(f.sessionId);
    assert.equal(f.supervisor.sessionPurgeReview(f.sessionId).canDelete, false); internals.planEdits.delete(f.sessionId);
    await f.restart(db => db.commit({ runs: [{ ...source!, harnessState: 'recording_failed' }] }));
    const review = f.supervisor.sessionPurgeReview(f.sessionId); assert.equal(review.canDelete, false, 'persisted recording_failed cannot authorize output lifecycle');
});

test('execution spool needs result evidence matching both run and invocation, tree exit and output drain', async t => {
    const f = await fixture(t); const source = await f.complete(); const executionId = randomUUID();
    const identity: InvocationIdentity = f.store(db => { const event = db.readJournal(f.sessionId).find(item => item.type === 'request.intent'); assert.ok(event?.type === 'request.intent'); return { ...event.payload.identity, invocationId: randomUUID(), toolCallId: randomUUID() }; });
    const append = async (type: 'tool.dispatch' | 'tool.result', payload: unknown, runId = source.id) => f.restart(db => {
        const event = { schemaVersion: 1, eventId: randomUUID(), sessionSeq: db.nextSessionSeq(f.sessionId), timestamp: new Date().toISOString(), processEpochId: randomUUID(), run: { ...identity, runId }, type, payload } as TranscriptEvent;
        db.commit({ journal: [event] });
    });
    await append('tool.dispatch', { identity, executionId, approvalId: null, toolName: 'run_command' });
    const spool = join(f.data, 'executions', executionId); mkdirSync(spool, { recursive: true }); writeFileSync(join(spool, 'stdout.txt'), 'Retained command output');
    assert.equal(f.supervisor.sessionPurgeReview(f.sessionId).canDelete, false);
    const outcome = { toolName: 'run_command', effectState: 'confirmed', resources: [], artifactRefs: [], executionEvidence: { executionId, treeExited: true, outputDrained: true, terminationReason: null, stdoutBytes: 23, stderrBytes: 0 } };
    await append('tool.result', { invocationId: randomUUID(), outcome }); assert.equal(f.supervisor.sessionPurgeReview(f.sessionId).canDelete, false);
    await append('tool.result', { invocationId: identity.invocationId, outcome }, randomUUID()); assert.equal(f.supervisor.sessionPurgeReview(f.sessionId).canDelete, false);
    await append('tool.result', { invocationId: identity.invocationId, outcome: { ...outcome, executionEvidence: { ...outcome.executionEvidence, treeExited: false } } }); assert.equal(f.supervisor.sessionPurgeReview(f.sessionId).canDelete, false);
    await append('tool.result', { invocationId: identity.invocationId, outcome: { ...outcome, executionEvidence: { ...outcome.executionEvidence, outputDrained: false } } }); assert.equal(f.supervisor.sessionPurgeReview(f.sessionId).canDelete, false);
    await append('tool.result', { invocationId: identity.invocationId, outcome }); f.begin(); assert.equal(f.supervisor.finishSessionPurge(f.sessionId).completed, true); assert.equal(existsSync(spool), false);
});

for (const version of [1, 2] as const) test(`v${version} upgrade backup purge retains the branch and cannot resurrect the target on isolated restore`, async t => {
    const f = await fixture(t); const source = await f.complete(); const branch = await f.createSession(source.id); await f.complete(branch);
    const backupDirectory = join(f.data, 'upgrade-backups'); mkdirSync(backupDirectory); const path = join(backupDirectory, `runtime-v${version}-${randomUUID()}.sqlite`);
    const db = new DatabaseSync(join(f.data, 'runtime.sqlite'), { readOnly: true }); try { await backup(db, path); } finally { db.close(); }
    const old = new DatabaseSync(path); old.exec(`DROP TABLE canonical_events; DROP TABLE journal_exports; ${version === 1 ? 'DROP TABLE request_contexts;' : ''} PRAGMA user_version=${version}; PRAGMA journal_mode=DELETE;`); old.close();
    f.begin(); const lock = new DatabaseSync(path); lock.exec('BEGIN IMMEDIATE;');
    try { const result = f.supervisor.finishSessionPurge(f.sessionId); assert.equal(result.completed, false); assert.match(result.error!, /locked|busy/); }
    finally { lock.exec('ROLLBACK;'); lock.close(); }
    await f.restart(); assert.deepEqual(f.supervisor.pendingSessionPurges(), [f.sessionId]);
    assert.equal(f.supervisor.finishSessionPurge(f.sessionId).completed, true);
    const restore = join(f.root, 'restored-backup'); mkdirSync(restore); writeFileSync(join(restore, 'runtime.sqlite'), readFileSync(path)); const restored = new RuntimeStore(restore);
    try { const snapshot = restored.readSnapshot(); assert.equal(snapshot.sessions.some(item => item.id === f.sessionId), false); assert.equal(snapshot.runs.some(item => item.sessionId === f.sessionId), false); assert.ok(snapshot.sessions.some(item => item.id === branch)); assert.equal(restored.readSessionRuns(branch).length, 1); }
    finally { restored.close(); }
    assert.equal(existsSync(f.partition), false); assert.equal(readFileSync(join(f.project, 'external.txt'), 'utf8'), 'USER WORKSPACE FILE');
});
