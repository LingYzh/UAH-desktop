import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { defaultAgentSettings } from '../../src/shared/agents';
import { defaultModelParameters } from '../../src/shared/model-parameters';
import type { ApiConnection } from '../../src/shared/endpoints';
import { validateTranscript, replayTranscript } from '../../src/runtime/transcript-offline';
import type { RunRecord, RuntimeEvent } from '../../src/shared/contracts';
import type { InvocationIdentity, TranscriptEvent } from '../../src/shared/harness-contracts';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function answer(response: ServerResponse, write = false) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = write ? { tool_calls: [{ index: 0, id: 'saved-write', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'saved.txt', content: 'ONE SAVED EFFECT', expectedContent: null }) } }] } : { content: 'RECOVERY FINAL' };
    response.end(frame({ choices: [{ index: 0, delta, finish_reason: write ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
}
function deferred() { let done!: () => void; const promise = new Promise<void>(resolveDone => { done = resolveDone; }); return { promise, done }; }
type Body = { messages: Array<{ role: string; content?: unknown }> };
async function fixture(t: { after(fn: () => Promise<void>): void }, respond: (response: ServerResponse, index: number) => void = (response, index) => answer(response, index === 1)) {
    const root = mkdtempSync(join(tmpdir(), 'uah-recovery-loop-'));
    const project = join(root, 'project'); mkdirSync(project);
    const data = join(root, 'data');
    const requests: Body[] = []; const errors: unknown[] = []; const events: RuntimeEvent[] = [];
    const listeners = new Set<() => void>(); const settings = defaultAgentSettings();
    let connectionHook: (() => Promise<void>) | undefined;
    const server = createServer(async (request, response) => {
        try {
            const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
            requests.push(JSON.parse(Buffer.concat(chunks).toString())); respond(response, requests.length);
        } catch (error) { errors.push(error); response.destroy(); }
    });
    for (let attempt = 0; attempt < 32; attempt++) {
        try {
            await new Promise<void>((listening, failed) => {
                const onError = (error: Error) => { server.off('listening', onReady); failed(error); };
                const onReady = () => { server.off('error', onError); listening(); };
                server.once('error', onError); server.once('listening', onReady); server.listen(randomInt(20000, 60000), '127.0.0.1');
            }); break;
        } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const connection: ApiConnection = { id: 'fixture', name: 'Recovery fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'LOCAL_RECOVERY_SECRET', models: ['fixture-model'], enabled: true, revision: 1, modelDetails: [{ id: 'fixture-model', tools: true }] };
    const create = () => new Supervisor({ dataDirectory: data, delayMs: 0, taskBudget: { maxRequests: 1, monotonicNow: () => 100 },
        onEvent: event => { events.push(event); for (const listener of [...listeners]) listener(); }, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async id => { await connectionHook?.(); assert.equal(id, connection.id); return structuredClone(connection); },
    });
    let supervisor = create();
    t.after(async () => {
        await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(closed => server.close(() => closed()));
        assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-recovery-loop-')); rmSync(target, { recursive: true, force: true });
    });
    const created = await supervisor.execute({ type: 'create-session', title: 'Recovery fixture', directory: project, agentId: 'default', selection: { endpointId: 'fixture', modelId: 'fixture-model' }, controls: { permissionMode: 'auto', reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    const terminal = (id: string) => new Promise<RunRecord>((done, failed) => {
        const timer = setTimeout(() => { listeners.delete(check); failed(new Error(`Recovery terminal deadline: ${id}`)); }, 15000);
        const check = () => {
            const event = events.findLast(event => event.type === 'run-state' && event.runId === id && ['completed', 'failed', 'stopped'].includes(event.payload.run.state));
            if (event?.type === 'run-state') { clearTimeout(timer); listeners.delete(check); done(event.payload.run); }
        }; listeners.add(check); check();
    });
    const store = <T>(action: (store: RuntimeStore) => T) => { const database = new RuntimeStore(data); try { return action(database); } finally { database.close(); } };
    const restart = async (edit?: (database: RuntimeStore) => void) => { await supervisor.shutdown(); if (edit) store(edit); events.length = 0; supervisor = create(); };
    const start = async () => { const reply = await supervisor.execute({ type: 'start-run', sessionId, input: 'Write the fixture once, then finish.' }); return reply.runs.filter(run => run.sessionId === sessionId).at(-1)!; };
    const stopped = async () => { const result = await terminal((await start()).id); assert.equal(result.harnessState, 'suspended_budget'); await restart(); return store(database => database.readRun(result.id))!; };
    const journal = () => store(database => database.readJournal(sessionId, 0, 10000));
    const controls = async (permissionMode: 'auto' | 'readonly' | 'plan') => {
        const session = (await supervisor.execute({ type: 'snapshot' })).sessions.find(item => item.id === sessionId)!;
        await supervisor.execute({ type: 'set-session-controls', sessionId, controls: { permissionMode, reasoningEffort: 'default' }, revision: session.controlsRevision ?? 0 });
    };
    return { get supervisor() { return supervisor; }, root, project, requests, settings, connection, sessionId, store, restart, start, stopped, terminal, journal, controls,
        setConnectionHook: (hook?: () => Promise<void>) => { connectionHook = hook; } };
}

test('budget recovery creates a new identity, retains cumulative charges and never replays saved tools', async t => {
    const f = await fixture(t); const source = await f.stopped(); const before = structuredClone(source);
    const review = await f.supervisor.recoveryReview(f.sessionId, source.id);
    assert.equal(review.canResume, true, review.reasons.join(';')); assert.equal(review.canReconcile, false);
    const reply = await f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'Finish using saved evidence.' });
    const resumed = reply.runs.find(run => run.resumeOfRunId === source.id)!; assert.ok(resumed); assert.notEqual(resumed.id, source.id);
    const completed = await f.terminal(resumed.id); assert.equal(completed.state, 'completed', completed.error);
    assert.equal(f.requests.length, 2); assert.equal(readFileSync(join(f.project, 'saved.txt'), 'utf8'), 'ONE SAVED EFFECT');
    const budget = completed.budgetState as Record<string, unknown>;
    assert.equal(budget.requestsUsed, 2); assert.equal(budget.toolsUsed, 1);
    assert.ok((budget.tokensCharged as number) >= (source.budgetState as Record<string, number>).tokensCharged);
    assert.equal((budget.limits as Record<string, number>).maxRequests, 2);
    assert.deepEqual(f.store(database => database.readRun(source.id)), before);
    assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 1);
    assert.equal(f.journal().filter(event => event.type === 'tool.result').length, 1);
    const artifact = f.store(database => database.readSessionSnapshot(f.sessionId)).artifacts[0]; assert.ok(artifact);
    const historyEvidence = f.requests[1].messages.filter(message => message.role !== 'system').map(message => JSON.stringify(message.content)).join('\n');
    for (const evidence of ['Persisted file snapshot:', 'saved.txt', artifact.id, artifact.hash, source.id, 'The write happened', 'Partial assistant output is not a completed answer']) assert.ok(historyEvidence.includes(evidence), evidence);
    for (const mode of ['full', 'share'] as const) {
        const destination = join(f.root, mode); f.supervisor.journalExport(f.sessionId, destination, mode);
        assert.ok(validateTranscript(destination).eventCount > 0);
        assert.equal(replayTranscript(destination).runs.find(run => run.runId === resumed.id)?.resumeOfRunId, source.id);
    }
});

test('legacy estimated-token suspension resumes without a token grant or replaying tools', async t => {
    const f = await fixture(t); const source = await f.stopped();
    const budget = structuredClone(source.budgetState) as { tokensCharged: number; estimatedTokensExceeded: boolean; limits: { maxEstimatedTokens: number | null } };
    budget.tokensCharged = 5_000_000; budget.estimatedTokensExceeded = true; budget.limits.maxEstimatedTokens = 4_000_000;
    await f.restart(database => database.commit({ runs: [{ ...source, budgetState: budget, budgetStopCode: 'estimated_tokens', stopReason: '已达到估算用量限制。' }] }));
    const review = await f.supervisor.recoveryReview(f.sessionId, source.id);
    assert.equal(review.canResume, true, review.reasons.join(';'));
    assert.equal(review.grant.maxEstimatedTokens, null);
    const reply = await f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'Finish using saved evidence.' });
    const resumed = reply.runs.find(run => run.resumeOfRunId === source.id)!;
    const completed = await f.terminal(resumed.id);
    assert.equal(completed.state, 'completed', completed.error);
    const current = completed.budgetState as typeof budget;
    assert.ok(current.tokensCharged >= 5_000_000);
    assert.equal(current.limits.maxEstimatedTokens, null);
    assert.equal(current.estimatedTokensExceeded, false);
    assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 1);
    assert.equal(f.requests.length, 2);
});

test('file drift requires an explicit no-HTTP reconciliation and fresh permissions after connection await', async t => {
    const f = await fixture(t); const source = await f.stopped(); const review = await f.supervisor.recoveryReview(f.sessionId, source.id);
    writeFileSync(join(f.project, 'saved.txt'), 'EXTERNAL CHANGE');
    await assert.rejects(f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'continue' }), /变化|核对/);
    assert.equal(f.requests.length, 1);
    const drift = await f.supervisor.recoveryReview(f.sessionId, source.id);
    assert.equal(drift.canResume, false); assert.equal(drift.canReconcile, true); assert.ok(drift.resources.some(resource => resource.status === 'changed'));
    await f.supervisor.execute({ type: 'reconcile-run', runId: source.id, fingerprint: drift.fingerprint, note: 'I inspected the changed file; do not replay the old write.' });
    assert.equal(f.requests.length, 1); assert.equal(f.journal().filter(event => event.type === 'tool.result').length, 1);
    await f.restart(); const checked = await f.supervisor.recoveryReview(f.sessionId, source.id); assert.equal(checked.canResume, true);
    const instructions = f.settings.profiles[0].instructions;
    f.settings.profiles[0].instructions += '\nChanged current settings.';
    await assert.rejects(f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: checked.fingerprint, input: 'continue' }), /变化|核对/);
    assert.equal(f.requests.length, 1); f.settings.profiles[0].instructions = instructions;
    const entered = deferred(); const release = deferred(); f.setConnectionHook(async () => { entered.done(); await release.promise; });
    const resume = f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: checked.fingerprint, input: 'continue' });
    // Attach the rejection handler before releasing the asynchronous connection boundary.
    const rejected = assert.rejects(resume, /变化|核对/);
    await entered.promise; await f.controls('readonly'); release.done(); await rejected;
    assert.equal(f.requests.length, 1); assert.equal(f.store(database => database.readSessionRuns(f.sessionId)).length, 1);
    f.setConnectionHook(); const current = await f.supervisor.recoveryReview(f.sessionId, source.id);
    assert.notEqual(current.fingerprint, checked.fingerprint);
    const reply = await f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: current.fingerprint, input: 'Finish without edits.' });
    const completed = await f.terminal(reply.runs.find(run => run.resumeOfRunId === source.id)!.id);
    assert.equal(completed.effective.permissionMode, 'readonly'); assert.equal(completed.state, 'completed');
    assert.equal(readFileSync(join(f.project, 'saved.txt'), 'utf8'), 'EXTERNAL CHANGE');
    for (const mode of ['full', 'share'] as const) { const destination = join(f.root, mode); f.supervisor.journalExport(f.sessionId, destination, mode); validateTranscript(destination); assert.equal(replayTranscript(destination).recoveryReviews.length, 1); }
});

function appendUnknown(database: RuntimeStore, source: RunRecord) {
    const intent = database.readJournal(source.sessionId, 0, 10000).find(event => event.type === 'request.intent'); assert.ok(intent?.type === 'request.intent');
    const identity: InvocationIdentity = { ...intent.payload.identity, invocationId: randomUUID(), toolCallId: randomUUID() };
    const event: TranscriptEvent = { schemaVersion: 1, eventId: randomUUID(), sessionSeq: database.journalWatermark(source.sessionId).durableSeq + 1,
        timestamp: new Date().toISOString(), processEpochId: randomUUID(), run: identity, type: 'tool.dispatch', payload: { identity, executionId: null, approvalId: null, toolName: 'unknown_recovery_tool' } };
    database.commit({ journal: [event] });
}

test('manual review clears only past unresolved dispatches, survives restart and fabricates no result', async t => {
    const f = await fixture(t); const source = await f.stopped();
    await f.restart(database => appendUnknown(database, source));
    const review = await f.supervisor.recoveryReview(f.sessionId, source.id);
    assert.equal(review.canResume, false); assert.equal(review.canReconcile, true); assert.deepEqual(review.uncertainRuns, [source.id]);
    await f.supervisor.execute({ type: 'reconcile-run', runId: source.id, fingerprint: review.fingerprint, note: 'External effects were checked manually.' });
    const reviewed = f.journal().find(event => event.type === 'recovery.reviewed'); assert.ok(reviewed?.type === 'recovery.reviewed'); assert.ok(reviewed.payload.throughSeq < reviewed.sessionSeq);
    assert.equal(f.requests.length, 1); assert.equal(f.journal().filter(event => event.type === 'tool.result').length, 1);
    await f.restart(); assert.equal((await f.supervisor.recoveryReview(f.sessionId, source.id)).canResume, true);
    assert.deepEqual([...f.store(database => database.readUnresolvedDispatchRuns())], []);
    await f.restart(database => appendUnknown(database, f.store(inner => inner.readRun(source.id))!));
    assert.deepEqual([...f.store(database => database.readUnresolvedDispatchRuns())], [source.id]);
    assert.equal((await f.supervisor.recoveryReview(f.sessionId, source.id)).canResume, false);
    assert.equal(f.journal().filter(event => event.type === 'tool.result').length, 1);
});

test('recording failure, Plan, child and non-latest sources cannot resume', async t => {
    const f = await fixture(t); const source = await f.stopped();
    for (const patch of [{ harnessState: 'recording_failed' as const }, { parentRunId: 'other-root' }]) {
        await f.restart(database => database.commit({ runs: [{ ...source, ...patch }] }));
        const review = await f.supervisor.recoveryReview(f.sessionId, source.id); assert.equal(review.canResume, false); assert.equal(review.canReconcile, false); assert.ok(review.reasons.length > 0);
        await assert.rejects(f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'continue' }));
    }
    await f.restart(database => database.commit({ runs: [source] })); await f.controls('plan');
    const plan = await f.supervisor.recoveryReview(f.sessionId, source.id); assert.equal(plan.canResume, false); assert.ok(plan.reasons.some(reason => reason.includes('计划')));
    await f.controls('auto');
    await f.restart(database => database.commit({ runs: [{ ...source, id: randomUUID(), turnId: randomUUID(), createdAt: new Date().toISOString() }] }));
    const older = await f.supervisor.recoveryReview(f.sessionId, source.id); assert.equal(older.canResume, false); assert.ok(older.reasons.some(reason => reason.includes('最后')));
    assert.equal(f.requests.length, 1);
});

test('an active request rejects recovery without sending an extra HTTP request', async t => {
    const received = deferred(); let pending: ServerResponse | undefined;
    const f = await fixture(t, response => { pending = response; received.done(); }); const run = await f.start(); await received.promise;
    const review = await f.supervisor.recoveryReview(f.sessionId, run.id); assert.equal(review.canResume, false); assert.equal(review.canReconcile, false); assert.ok(review.reasons.some(reason => reason.includes('停止')));
    await assert.rejects(f.supervisor.execute({ type: 'resume-run', runId: run.id, fingerprint: review.fingerprint, input: 'continue' }));
    assert.equal(f.requests.length, 1); answer(pending!); await f.terminal(run.id);
});

test('canonical recovery transaction failure creates no new run and sends no HTTP', async t => {
    const f = await fixture(t); const source = await f.stopped(); const review = await f.supervisor.recoveryReview(f.sessionId, source.id);
    const original = RuntimeStore.prototype.commit;
    const mock = t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => event.type === 'recovery.resumed')) throw new Error('isolated recovery transaction failure');
        return original.call(this, changes);
    });
    await assert.rejects(f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'continue' })); mock.mock.restore();
    assert.equal(f.requests.length, 1); assert.equal(f.store(database => database.readSessionRuns(f.sessionId)).length, 1);
    assert.equal(f.journal().filter(event => event.type === 'recovery.resumed').length, 0);
    assert.deepEqual(f.store(database => database.readRun(source.id)), source);
});

test('canonical reconciliation failure cannot clear an unresolved effect across restart', async t => {
    const f = await fixture(t); const source = await f.stopped(); await f.restart(database => appendUnknown(database, source));
    const review = await f.supervisor.recoveryReview(f.sessionId, source.id); assert.equal(review.canReconcile, true);
    const original = RuntimeStore.prototype.commit;
    const mock = t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => event.type === 'recovery.reviewed')) throw new Error('isolated reconciliation transaction failure');
        return original.call(this, changes);
    });
    await assert.rejects(f.supervisor.execute({ type: 'reconcile-run', runId: source.id, fingerprint: review.fingerprint, note: 'Manually checked.' })); mock.mock.restore();
    assert.equal(f.requests.length, 1); assert.equal(f.journal().filter(event => event.type === 'recovery.reviewed').length, 0);
    assert.deepEqual([...f.store(database => database.readUnresolvedDispatchRuns())], [source.id]);
    await f.restart(); const current = await f.supervisor.recoveryReview(f.sessionId, source.id);
    assert.equal(current.canResume, false); assert.equal(current.canReconcile, true); assert.deepEqual(current.uncertainRuns, [source.id]);
});

test('zero history window still sends the source goal, saved effect and explicit user review', async t => {
    const f = await fixture(t); f.connection.modelParameters = [{ id: 'fixture-model', parameters: { ...defaultModelParameters(), historyTurns: 0 } }];
    const source = await f.stopped(); writeFileSync(join(f.project, 'saved.txt'), 'REVIEWED EXTERNAL CHANGE');
    const drift = await f.supervisor.recoveryReview(f.sessionId, source.id); assert.equal(drift.canReconcile, true);
    const note = 'USER CHECKED THE CHANGED FILE AND RETAINED THE EXTERNAL VERSION';
    await f.supervisor.execute({ type: 'reconcile-run', runId: source.id, fingerprint: drift.fingerprint, note });
    await f.restart(); const review = await f.supervisor.recoveryReview(f.sessionId, source.id); assert.equal(review.canResume, true);
    const reply = await f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'Finish from the reviewed facts.' });
    const completed = await f.terminal(reply.runs.find(run => run.resumeOfRunId === source.id)!.id); assert.equal(completed.state, 'completed'); assert.equal(completed.effective.modelParameters?.historyTurns, 0, 'configured zero history remains the recovery boundary under test');
    const artifact = f.store(database => database.readSessionSnapshot(f.sessionId)).artifacts[0];
    const body = JSON.stringify(f.requests[1].messages);
    for (const evidence of [source.input, source.id, 'saved.txt', artifact.id, artifact.hash, note]) assert.ok(body.includes(evidence), `Missing recovery evidence: ${evidence}`);
    assert.equal(f.requests.length, 2); assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 1);
    assert.equal(readFileSync(join(f.project, 'saved.txt'), 'utf8'), 'REVIEWED EXTERNAL CHANGE');
});

test('same endpoint identity with changed revision or URL invalidates the reviewed grant before HTTP', async t => {
    const f = await fixture(t); const source = await f.stopped();
    let review = await f.supervisor.recoveryReview(f.sessionId, source.id); f.connection.revision++;
    await assert.rejects(f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'continue' }), /变化|核对/);
    assert.equal(f.requests.length, 1);
    review = await f.supervisor.recoveryReview(f.sessionId, source.id); f.connection.baseUrl += '/changed-public-config';
    await assert.rejects(f.supervisor.execute({ type: 'resume-run', runId: source.id, fingerprint: review.fingerprint, input: 'continue' }), /变化|核对/);
    assert.equal(f.requests.length, 1); assert.equal(f.store(database => database.readSessionRuns(f.sessionId)).length, 1);
});
