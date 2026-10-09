import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { join, resolve, dirname, basename } from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { ApiConnection } from '../../src/shared/endpoints';
import { parseCommand, type RunRecord, type RuntimeEvent } from '../../src/shared/contracts';
import { parseJournalQuery } from '../../src/shared/journal-view';
import type { TranscriptEvent, InvocationIdentity } from '../../src/shared/harness-contracts';
import { validateTranscript, replayTranscript } from '../../src/runtime/transcript-offline';

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
function answer(response: ServerResponse, write = false) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = write ? { tool_calls: [{ index: 0, id: 'write-once', type: 'function', function: { name: 'write_file',
        arguments: JSON.stringify({ path: 'accepted.txt', content: 'ONE VERIFIED FILE', expectedContent: null }) } }] } : { content: 'TASK EXECUTION COMPLETED' };
    response.end(frame({ choices: [{ index: 0, delta, finish_reason: write ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
}
function deferred() { let done!: () => void; const promise = new Promise<void>(resolveDone => { done = resolveDone; }); return { promise, done }; }
async function fixture(t: { after(fn: () => Promise<void>): void }, respond = (response: ServerResponse, index: number) => answer(response, index === 1)) {
    const root = mkdtempSync(join(tmpdir(), 'uah-goal-verification-')); const project = join(root, 'project'); mkdirSync(project); const data = join(root, 'data');
    const requests: unknown[] = [], errors: unknown[] = [], events: RuntimeEvent[] = []; const listeners = new Set<() => void>();
    const server = createServer(async (request, response) => {
        try { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(JSON.parse(Buffer.concat(chunks).toString())); respond(response, requests.length); }
        catch (error) { errors.push(error); response.destroy(); }
    });
    for (let attempt = 0; attempt < 32; attempt++) {
        try {
            await new Promise<void>((ready, failed) => {
                const onError = (error: Error) => { server.off('listening', onReady); failed(error); };
                const onReady = () => { server.off('error', onError); ready(); };
                server.once('error', onError); server.once('listening', onReady); server.listen(randomInt(20000, 60000), '127.0.0.1');
            }); break;
        } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings();
    const connection: ApiConnection = { id: 'fixture', name: 'Goal fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'LOCAL_GOAL_SECRET',
        models: ['fixture-model'], enabled: true, revision: 1, modelDetails: [{ id: 'fixture-model', tools: true }] };
    const create = () => new Supervisor({ dataDirectory: data, delayMs: 0,
        onEvent: event => { events.push(event); for (const listener of [...listeners]) listener(); }, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async id => { assert.equal(id, connection.id); return structuredClone(connection); } });
    let supervisor = create();
    t.after(async () => {
        await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(closed => server.close(() => closed())); assert.deepEqual(errors, []);
        const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-goal-verification-')); rmSync(target, { recursive: true, force: true });
    });
    const created = await supervisor.execute({ type: 'create-session', title: 'Goal fixture', directory: project, agentId: 'default',
        selection: { endpointId: 'fixture', modelId: 'fixture-model' }, controls: { permissionMode: 'auto', reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    const terminal = (id: string) => new Promise<RunRecord>((done, failed) => {
        const timer = setTimeout(() => { listeners.delete(check); failed(new Error(`Goal terminal deadline: ${id}`)); }, 15000);
        const check = () => { const event = events.findLast(event => event.type === 'run-state' && event.runId === id && ['completed', 'failed', 'stopped'].includes(event.payload.run.state));
            if (event?.type === 'run-state') { clearTimeout(timer); listeners.delete(check); done(event.payload.run); } };
        listeners.add(check); check();
    });
    const store = <T>(action: (database: RuntimeStore) => T) => { const database = new RuntimeStore(data); try { return action(database); } finally { database.close(); } };
    const restart = async (edit?: (database: RuntimeStore) => void) => { await supervisor.shutdown(); if (edit) store(edit); events.length = 0; supervisor = create(); };
    const start = async (input = 'Write accepted.txt once, then finish.') => {
        const reply = await supervisor.execute({ type: 'start-run', sessionId, input }); return reply.runs.filter(run => run.sessionId === sessionId && !run.parentRunId).at(-1)!;
    };
    const complete = async () => { const result = await terminal((await start()).id); assert.equal(result.state, 'completed', result.error); return result; };
    const journal = () => store(database => database.readJournal(sessionId, 0, 10000));
    const accept = async (runId: string, criteria = 'I inspected accepted.txt and confirmed the stated task.') => {
        const review = await supervisor.verificationReview(sessionId, runId); assert.equal(review.canVerify, true, review.reasons.join(';'));
        return supervisor.execute({ type: 'verify-goal', runId, fingerprint: review.fingerprint, criteria });
    };
    return { get supervisor() { return supervisor; }, root, project, requests, events, sessionId, store, restart, start, complete, terminal, journal, accept };
}

test('real SSE completion remains unverified until explicit no-HTTP human acceptance, which survives restart', async t => {
    const f = await fixture(t); const source = await f.complete(); assert.equal(f.requests.length, 2);
    const review = await f.supervisor.verificationReview(f.sessionId, source.id);
    assert.equal(review.status, 'unverified'); assert.equal(review.previous, null); assert.equal(review.canVerify, true);
    assert.equal(review.resources.length, 1); assert.equal(review.resources[0].status, 'matched');
    const beforeTools = f.journal().filter(event => event.type === 'tool.dispatch').length;
    const accepted = await f.accept(source.id); const run = accepted.runs.find(run => run.id === source.id)!;
    assert.equal(run.goalVerification?.method, 'user_review'); assert.ok(run.goalVerification?.criteria.includes('inspected'));
    assert.equal(run.state, 'completed'); assert.equal(f.requests.length, 2); assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, beforeTools);
    const event = f.journal().find(event => event.type === 'goal.verified'); assert.ok(event?.type === 'goal.verified');
    assert.equal(event.payload.method, 'user_review'); assert.equal(event.payload.verificationId, run.goalVerification?.id);
    const current = await f.supervisor.verificationReview(f.sessionId, source.id); assert.equal(current.status, 'current'); assert.equal(current.canVerify, true);
    const identity = current.previous!.id; await f.restart();
    const restored = await f.supervisor.verificationReview(f.sessionId, source.id);
    assert.equal(restored.status, 'current'); assert.equal(restored.previous?.id, identity); assert.equal(f.requests.length, 2);
    assert.equal(readFileSync(join(f.project, 'accepted.txt'), 'utf8'), 'ONE VERIFIED FILE');
});

test('external file changes make acceptance stale and reject an old review fingerprint without execution', async t => {
    const f = await fixture(t); const source = await f.complete(); await f.accept(source.id);
    const current = await f.supervisor.verificationReview(f.sessionId, source.id); writeFileSync(join(f.project, 'accepted.txt'), 'EXTERNAL CHANGE');
    const changed = await f.supervisor.verificationReview(f.sessionId, source.id);
    assert.equal(changed.status, 'stale'); assert.equal(changed.canVerify, false); assert.equal(changed.resources[0].status, 'changed'); assert.ok(changed.previous);
    await assert.rejects(f.supervisor.execute({ type: 'verify-goal', runId: source.id, fingerprint: current.fingerprint, criteria: 'old review' }), /变化|问题|刷新/);
    assert.equal(f.requests.length, 2); assert.equal(f.journal().filter(event => event.type === 'goal.verified').length, 1);
    await f.restart(); assert.equal((await f.supervisor.verificationReview(f.sessionId, source.id)).status, 'stale');
});

test('reply edits and a later task invalidate the previous acceptance scope', async t => {
    const f = await fixture(t); const source = await f.complete(); await f.accept(source.id);
    const current = await f.supervisor.verificationReview(f.sessionId, source.id);
    await f.supervisor.execute({ type: 'edit-reply', runId: source.id, output: 'Corrected public result' });
    const edited = await f.supervisor.verificationReview(f.sessionId, source.id); assert.equal(edited.status, 'stale'); assert.equal(edited.canVerify, true);
    await assert.rejects(f.supervisor.execute({ type: 'verify-goal', runId: source.id, fingerprint: current.fingerprint, criteria: 'old reply' }));
    await f.accept(source.id, 'I reviewed the corrected reply.'); assert.equal((await f.supervisor.verificationReview(f.sessionId, source.id)).status, 'current');
    const later = await f.terminal((await f.start('A new unrelated task.')).id); assert.equal(later.state, 'completed');
    const old = await f.supervisor.verificationReview(f.sessionId, source.id); assert.equal(old.status, 'stale'); assert.equal(old.canVerify, false);
    assert.equal((await f.supervisor.verificationReview(f.sessionId, later.id)).status, 'unverified');
    assert.equal(f.journal().filter(event => event.type === 'goal.verified').length, 2);
});

test('stopped, failed, deleted, Plan, child and recording-failed runs cannot pass acceptance', async t => {
    const f = await fixture(t); const source = await f.complete();
    const patches: Array<Partial<RunRecord>> = [{ state: 'stopped' }, { state: 'failed' }, { history: { deleted: true } },
        { plan: { id: 'fixture-plan', content: 'plan', hash: '0'.repeat(64), filePath: 'plan.md', status: 'proposed', createdAt: source.createdAt } },
        { parentRunId: 'missing-parent' }, { harnessState: 'recording_failed' }];
    for (const patch of patches) {
        await f.restart(database => database.commit({ runs: [{ ...source, ...patch }] }));
        const review = await f.supervisor.verificationReview(f.sessionId, source.id); assert.equal(review.canVerify, false); assert.ok(review.reasons.length);
        await assert.rejects(f.supervisor.execute({ type: 'verify-goal', runId: source.id, fingerprint: review.fingerprint, criteria: 'Cannot approve invalid state.' }));
    }
    assert.equal(f.requests.length, 2); assert.equal(f.journal().filter(event => event.type === 'goal.verified').length, 0);
});

test('an unpaired persisted dispatch prevents acceptance after restart', async t => {
    const f = await fixture(t); const source = await f.complete();
    await f.restart(database => {
        const intent = database.readJournal(f.sessionId, 0, 10000).find(event => event.type === 'request.intent'); assert.ok(intent?.type === 'request.intent');
        const identity: InvocationIdentity = { ...intent.payload.identity, invocationId: randomUUID(), toolCallId: randomUUID() };
        const event: TranscriptEvent = { schemaVersion: 1, eventId: randomUUID(), sessionSeq: database.journalWatermark(f.sessionId).durableSeq + 1,
            timestamp: new Date().toISOString(), processEpochId: randomUUID(), run: identity, type: 'tool.dispatch',
            payload: { identity, executionId: null, approvalId: null, toolName: 'unknown_external_effect' } };
        database.commit({ journal: [event] });
    });
    const review = await f.supervisor.verificationReview(f.sessionId, source.id); assert.equal(review.canVerify, false); assert.ok(review.reasons.some(reason => /副作用|记录/.test(reason)));
    await assert.rejects(f.supervisor.execute({ type: 'verify-goal', runId: source.id, fingerprint: review.fingerprint, criteria: 'Unknown effects.' }));
    assert.equal(f.requests.length, 2); assert.equal(f.journal().filter(event => event.type === 'goal.verified').length, 0);
});

test('command evidence preserves stored outcomes and marks only commands preceding later effects', async t => {
    const f = await fixture(t); const source = await f.complete();
    // Add explicit persisted fixture facts to test journal ordering; no command is executed.
    await f.restart(database => {
        const journal = database.readJournal(f.sessionId, 0, 10000);
        const intent = journal.find(event => event.type === 'request.intent'); assert.ok(intent?.type === 'request.intent');
        const write = journal.find(event => event.type === 'tool.result'); assert.ok(write?.type === 'tool.result');
        const firstId = randomUUID(), laterId = randomUUID(), finalId = randomUUID();
        const outcome = { ...structuredClone(write.payload.outcome), resources: [], effectState: 'confirmed' as const, exitCode: 0 };
        const activities = [...source.activities ?? [],
            { id: firstId, kind: 'tool' as const, title: 'run_command', status: 'completed' as const, content: 'recorded check', tool: { name: 'run_command', arguments: { command: 'recorded-check-before-write' }, result: 'STORED COMMAND RESULT', outcome } },
            { id: finalId, kind: 'tool' as const, title: 'run_command', status: 'completed' as const, content: 'recorded check', tool: { name: 'run_command', arguments: { command: 'recorded-check-after-write' }, result: 'STORED COMMAND RESULT', outcome } }];
        const firstSeq = database.journalWatermark(f.sessionId).durableSeq + 1;
        const facts: TranscriptEvent[] = [
            { invocationId: firstId, outcome }, { invocationId: laterId, outcome: write.payload.outcome }, { invocationId: finalId, outcome },
        ].map((payload, index) => ({ schemaVersion: 1, eventId: randomUUID(), sessionSeq: firstSeq + index, timestamp: new Date().toISOString(),
            processEpochId: randomUUID(), run: intent.payload.identity, type: 'tool.result', payload }));
        database.commit({ runs: [{ ...source, activities }], journal: facts });
    });
    const review = await f.supervisor.verificationReview(f.sessionId, source.id); assert.equal(review.canVerify, true, review.reasons.join(';'));
    assert.deepEqual(review.commands.map(item => [item.command, item.hasLaterEffects]), [['recorded-check-before-write', true], ['recorded-check-after-write', false]]);
    for (const command of review.commands) { assert.equal(command.outcome.exitCode, 0); assert.equal(command.outcome.recordingState, 'durable'); assert.equal(command.runId, source.id); }
    await f.accept(source.id); assert.equal(f.requests.length, 2);
    assert.equal(f.journal().filter(event => event.type === 'tool.dispatch').length, 1, 'human acceptance never dispatches stored commands');
});

test('an active request cannot be accepted and verification does not send another HTTP request', async t => {
    const entered = deferred(); let pending!: ServerResponse;
    const f = await fixture(t, response => { pending = response; entered.done(); }); const source = await f.start(); await entered.promise;
    const review = await f.supervisor.verificationReview(f.sessionId, source.id); assert.equal(review.canVerify, false);
    await assert.rejects(f.supervisor.execute({ type: 'verify-goal', runId: source.id, fingerprint: review.fingerprint, criteria: 'Still running.' }));
    assert.equal(f.requests.length, 1); answer(pending); await f.terminal(source.id);
});

test('canonical acceptance failure commits neither accepted state nor goal event', async t => {
    const f = await fixture(t); const source = await f.complete(); const review = await f.supervisor.verificationReview(f.sessionId, source.id);
    const before = f.store(database => database.readRun(source.id));
    const database = new DatabaseSync(join(f.root, 'data', 'runtime.sqlite'));
    try {
        // Fail the canonical insert after run/event writes have occurred in the same real transaction.
        database.exec(`CREATE TRIGGER reject_goal_acceptance BEFORE INSERT ON canonical_events
            WHEN json_extract(NEW.data, '$.type') = 'goal.verified'
            BEGIN SELECT RAISE(ABORT, 'isolated acceptance transaction failure'); END;`);
        await assert.rejects(f.supervisor.execute({ type: 'verify-goal', runId: source.id, fingerprint: review.fingerprint, criteria: 'Must not become accepted.' }));
    } finally { database.exec('DROP TRIGGER IF EXISTS reject_goal_acceptance'); database.close(); }
    assert.deepEqual(f.store(database => database.readRun(source.id)), before, 'the real SQLite transaction rolls back run changes');
    assert.equal(f.store(database => database.readRun(source.id))?.goalVerification, undefined);
    assert.equal(f.journal().filter(event => event.type === 'goal.verified').length, 0); assert.equal(f.requests.length, 2);
    assert.equal(f.events.some(event => event.type === 'run-state' && event.payload.run.goalVerification), false);
    await f.restart(); assert.equal((await f.supervisor.verificationReview(f.sessionId, source.id)).status, 'unverified');
});

test('full and share exports retain acceptance reference closure and mark offline freshness unknown', async t => {
    const f = await fixture(t); const source = await f.complete(); await f.accept(source.id);
    for (const mode of ['full', 'share'] as const) {
        const destination = join(f.root, `export-${mode}`); f.supervisor.journalExport(f.sessionId, destination, mode);
        const validation = validateTranscript(destination); assert.ok(validation.eventCount > 0);
        const replay = replayTranscript(destination); assert.equal(replay.goalVerifications.length, 1);
        const goal = replay.goalVerifications[0]; assert.equal(goal.runId, source.id); assert.equal(goal.method, 'user_review'); assert.equal(goal.freshness, 'not_checked_offline');
        assert.ok(goal.evidence && typeof goal.evidence === 'object'); const evidence = goal.evidence as Record<string, unknown>;
        assert.equal(evidence.method, 'user_review'); assert.ok(String(evidence.scope).includes('not an automatic goal proof'));
        assert.ok(Array.isArray(evidence.resources));
    }
    writeFileSync(join(f.project, 'accepted.txt'), 'NOW CHANGED');
    assert.equal((await f.supervisor.verificationReview(f.sessionId, source.id)).status, 'stale');
    assert.equal(replayTranscript(join(f.root, 'export-full')).goalVerifications[0].freshness, 'not_checked_offline');
});

test('verification IPC parsers reject extra fields, missing criteria and non-user-review caller evidence', () => {
    const command = { type: 'verify-goal', runId: 'run-1', fingerprint: 'a'.repeat(64), criteria: 'I checked the stated acceptance criteria.' };
    assert.deepEqual(parseCommand(command), command);
    for (const patch of [{ extra: true }, { method: 'automatic' }, { evidence: {} }, { fingerprint: 'bad' }, { criteria: '' }, { criteria: 'x'.repeat(4001) }]) assert.throws(() => parseCommand({ ...command, ...patch }));
    const { criteria, ...missing } = command; assert.throws(() => parseCommand(missing));
    const query = { action: 'verification', sessionId: 'session-1', runId: 'run-1' }; assert.deepEqual(parseJournalQuery(query), query);
    assert.throws(() => parseJournalQuery({ ...query, fingerprint: command.fingerprint })); assert.throws(() => parseJournalQuery({ action: 'verification', sessionId: 'session-1' }));
});
