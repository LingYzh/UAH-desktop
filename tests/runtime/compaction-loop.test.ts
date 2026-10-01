import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { validateTranscript, replayTranscript } from '../../src/runtime/transcript-offline';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RunRecord } from '../../src/shared/contracts';
import type { ArtifactReference, TranscriptEvent } from '../../src/shared/harness-contracts';

const oldOpaque = 'OLD_NATIVE_OPAQUE_' + 'O'.repeat(350000);
const currentOpaque = 'CURRENT_NATIVE_TAIL_' + 'T'.repeat(300000);
const currentUser = 'CURRENT USER EXACT\nPreserve this request and its tool evidence.';
const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
interface Body { messages: Array<{ role: string; content?: string; tool_call_id?: string; reasoning_content?: string; tool_calls?: unknown[] }>; }
function answer(response: ServerResponse, text: string, reasoning?: string, tool = false) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = { ...(text ? { content: text } : {}), ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tool ? { tool_calls: [{ index: 0, id: 'compaction-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'input.txt' }) } }] } : {}) };
    response.end(frame({ choices: [{ index: 0, delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
}
async function fixture(t: { after(fn: () => Promise<void>): void }, hugePublic = false) {
    const root = mkdtempSync(join(tmpdir(), 'uah-compaction-loop-')); const project = join(root, 'project'); mkdirSync(project); writeFileSync(join(project, 'input.txt'), 'REAL_CURRENT_TOOL_TAIL');
    const data = join(root, 'data'); const requests: Body[] = []; const errors: unknown[] = []; let capacity: number | undefined;
    const server = createServer((request, response) => { void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body);
        if (requests.length === 1) answer(response, 'SHORT PUBLIC FIRST REPLY', oldOpaque);
        else {
            const latest = [...body.messages].reverse().find(message => message.role === 'user' && !message.content?.startsWith('[UAH'))?.content;
            if (latest === currentUser && !body.messages.some(message => message.role === 'tool' && message.tool_call_id === 'compaction-read')) answer(response, '', currentOpaque, true);
            else answer(response, 'SHORT PUBLIC FINAL REPLY');
        }
    })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, reject) => { const failed = (error: Error) => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); ready(); }; server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings(); settings.profiles[0].instructions = 'Compaction transaction fixture';
    const options = { dataDirectory: data, delayMs: 0, onEvent: () => {}, getAgentSettings: () => settings,
        resolveAgent: (id: string) => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async (id: string) => ({ id, name: 'Local compaction', protocol: 'openai-chat' as const, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'compaction-fixture-key', enabled: true, revision: 1, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true, ...(capacity === undefined ? {} : { contextWindow: capacity }) }] }),
    };
    let supervisor = new Supervisor(options);
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-compaction-loop-')); rmSync(target, { recursive: true, force: true }); });
    const created = await supervisor.execute({ type: 'create-session', title: 'Compaction transaction', directory: project, agentId: 'default', selection: { endpointId: 'fixture-endpoint', modelId: 'fixture-model' }, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } }); const sessionId = created.sessions[0].id;
    const start = async (input: string): Promise<RunRecord> => {
        const initial = await supervisor.execute({ type: 'start-run', sessionId, input }); const id = initial.runs.findLast(run => run.sessionId === sessionId)!.id;
        for (let attempt = 0; attempt < 1000; attempt++) { const snapshot = await supervisor.execute({ type: 'snapshot' }); const run = snapshot.runs.find(run => run.id === id)!; if (['completed', 'failed', 'stopped'].includes(run.state)) return run; await delay(10); }
        throw new Error(`Compaction fixture timed out: ${input.slice(0, 80)}`);
    };
    const firstInput = hugePublic ? 'HUGE PUBLIC USER ' + 'U'.repeat(90000) : 'FIRST PUBLIC USER';
    const first = await start(firstInput); assert.equal(first.state, 'completed', first.error); assert.ok(first.modelFrame);
    const partition = join(data, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
    const artifacts = new JournalArtifacts(partition);
    const events = () => { const store = new RuntimeStore(data); try { return store.readJournal(sessionId, 0, 10000); } finally { store.close(); } };
    return { root, data, requests, first, firstInput, start, events, capacity: (value: number) => { capacity = value; },
        read: (ref: ArtifactReference) => artifacts.read(ref),
        project: () => supervisor.journalSessionDirectory(sessionId),
        export: (destination: string, mode: 'full' | 'share') => supervisor.journalExport(sessionId, destination, mode),
        restart: async () => { await supervisor.shutdown(); supervisor = new Supervisor(options); return supervisor.execute({ type: 'snapshot' }); },
    };
}

test('public compaction commits atomically while preserving current native tool tail and original artifacts', async t => {
    const f = await fixture(t); const oldBytes = f.read(f.first.modelFrame!.content); assert.ok(oldBytes.includes(Buffer.from('OLD_NATIVE_OPAQUE_')));
    const originalCommit = RuntimeStore.prototype.commit; let atomicPointerCommits = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        for (const event of changes.journal ?? []) if (event.type === 'context.compaction' && event.payload.stage === 'committed') {
            const pointer = changes.runs?.find(run => run.id === event.run.runId)?.contextState;
            assert.ok(pointer, 'committed compaction and active context pointer share one authority transaction');
            assert.equal(pointer.version, event.payload.nextVersion); assert.deepEqual(pointer.taskState, event.payload.taskState); atomicPointerCommits++;
        }
        return originalCommit.call(this, changes);
    });
    // The first known-capacity request fits. Its large native tool response then
    // exceeds capacity, forcing compaction with a real current tool-result tail.
    f.capacity(500000); const run = await f.start(currentUser); assert.equal(run.state, 'completed', run.error); assert.ok(run.contextState);
    assert.equal(f.requests.length, 3); const compacted = f.requests[2];
    assert.equal(JSON.stringify(compacted).includes('OLD_NATIVE_OPAQUE_'), false); assert.equal(JSON.stringify(compacted).includes('CURRENT_NATIVE_TAIL_'), true);
    assert.equal(compacted.messages.filter(message => message.role === 'user' && message.content === currentUser).length, 1);
    assert.equal(compacted.messages.filter(message => message.role === 'tool' && message.tool_call_id === 'compaction-read' && message.content === 'REAL_CURRENT_TOOL_TAIL').length, 1);
    assert.equal(run.activities?.filter(activity => activity.tool?.name === 'read_file').length, 1, 'historical compaction never repeats a tool');
    const stages = f.events().filter((event): event is Extract<TranscriptEvent, { type: 'context.compaction' }> => event.run.runId === run.id && event.type === 'context.compaction'); assert.deepEqual(stages.map(event => event.payload.stage), ['candidate', 'committed']);
    assert.equal(stages[0].payload.compactionId, stages[1].payload.compactionId); assert.deepEqual(run.contextState.taskState, stages[1].payload.taskState); assert.equal(run.contextState.version, stages[1].payload.nextVersion);
    assert.equal(atomicPointerCommits, 1);
    const state = JSON.parse(f.read(run.contextState.taskState).toString()) as Record<string, unknown>;
    for (const key of ['goal', 'constraints', 'plan', 'evidence', 'unknownEffects', 'childResults', 'previous', 'candidate']) assert.ok(Object.hasOwn(state, key), key);
    assert.equal(state.goal, currentUser);
    const previousRef = state.previous as ArtifactReference; const candidateRef = state.candidate as ArtifactReference; assert.ok(previousRef.relativePath?.startsWith('restricted/')); assert.ok(candidateRef.relativePath?.startsWith('restricted/'));
    const previous = JSON.parse(f.read(previousRef).toString()) as unknown[]; const candidate = JSON.parse(f.read(candidateRef).toString()) as unknown[];
    assert.deepEqual(candidate.slice(state.nextPrefixLength as number), previous.slice(state.previousPrefixLength as number), 'current user and entire native tail are byte-for-byte JSON-equivalent');
    assert.ok(JSON.stringify(previous).includes('OLD_NATIVE_OPAQUE_')); assert.equal(JSON.stringify(candidate).includes('OLD_NATIVE_OPAQUE_'), false);
    assert.deepEqual(f.read(f.first.modelFrame!.content), oldBytes);
    const local = validateTranscript(f.project()); assert.equal(local.artifactCount, local.presentArtifacts);
    for (const mode of ['full', 'share'] as const) {
        const destination = join(f.root, `compaction-${mode}`); f.export(destination, mode);
        const report = validateTranscript(destination); assert.ok(report.eventCount > 0); assert.ok(replayTranscript(destination).runs.some(item => item.runId === run.id && item.state === 'completed'));
        const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as { artifacts: ArtifactReference[]; captureCoverage: string; continuationCoverage: string };
        if (mode === 'full') {
            assert.equal(report.artifactCount, report.presentArtifacts);
            for (const ref of [previousRef, candidateRef, state.constraints as ArtifactReference]) assert.ok(manifest.artifacts.some(item => item.availability === 'present' && item.sha256 === ref.sha256 && item.relativePath === ref.relativePath), 'nested TaskState reference appears in full manifest');
        } else {
            assert.equal(report.partial, true); assert.equal(manifest.captureCoverage, 'partial'); assert.equal(manifest.continuationCoverage, 'unavailable');
            for (const ref of [previousRef, candidateRef, state.constraints as ArtifactReference]) assert.ok(manifest.artifacts.some(item => item.availability === 'missing' && item.sha256 === ref.sha256 && item.missingReason === 'share_redacted'), 'restricted TaskState window is explicitly unavailable in share');
        }
    }
    const restarted = await f.restart(); assert.deepEqual(restarted.runs.find(item => item.id === run.id)?.contextState, run.contextState);
    const followup = await f.start('AFTER RESTART PUBLIC TASK'); assert.equal(followup.state, 'completed', followup.error); assert.ok(JSON.stringify(f.requests.at(-1)).includes('SHORT PUBLIC FIRST REPLY')); assert.ok(JSON.stringify(f.requests.at(-1)).includes('SHORT PUBLIC FINAL REPLY'));
    assert.deepEqual(f.read(f.first.modelFrame!.content), oldBytes);
});
test('noncompressible public user history rolls back once and sends no affected request', async t => {
    const f = await fixture(t, true); const oldBytes = f.read(f.first.modelFrame!.content); f.capacity(50000); const count = f.requests.length;
    const run = await f.start('SHORT NEXT USER'); assert.equal(run.state, 'stopped', run.error); assert.equal(run.harnessState, 'suspended_budget'); assert.equal(run.budgetStopCode, 'context_capacity'); assert.match(run.stopReason!, /上下文容量/); assert.equal(run.contextState, undefined); assert.equal(f.requests.length, count);
    const stages = f.events().filter((event): event is Extract<TranscriptEvent, { type: 'context.compaction' }> => event.run.runId === run.id && event.type === 'context.compaction'); assert.deepEqual(stages.map(event => event.payload.stage), ['candidate', 'rolled_back']);
    const state = JSON.parse(f.read(stages[0].payload.taskState).toString()) as { candidate: ArtifactReference };
    assert.ok(JSON.stringify(JSON.parse(f.read(state.candidate).toString())).includes(f.firstInput), 'public user text is not chopped to fit');
    assert.equal(f.events().some(event => event.run.runId === run.id && (event.type === 'request.intent' || event.type === 'request.dispatch' || event.type === 'tool.dispatch')), false); assert.deepEqual(f.read(f.first.modelFrame!.content), oldBytes);
});
test('compaction commit failure cannot send or activate the candidate context pointer', async t => {
    const f = await fixture(t); const oldBytes = f.read(f.first.modelFrame!.content); f.capacity(120000); const count = f.requests.length; const original = RuntimeStore.prototype.commit; let failedCommits = 0;
    t.mock.method(RuntimeStore.prototype, 'commit', function(this: RuntimeStore, changes: Parameters<RuntimeStore['commit']>[0]) {
        if (changes.journal?.some(event => event.type === 'context.compaction' && event.payload.stage === 'committed')) { failedCommits++; throw new Error('Fixture compaction authority commit failure'); }
        return original.call(this, changes);
    });
    const run = await f.start('COMMIT FAILURE USER'); assert.equal(failedCommits, 1); assert.equal(run.state, 'failed'); assert.equal(run.harnessState, 'recording_failed'); assert.equal(run.contextState, undefined); assert.equal(f.requests.length, count);
    const events = f.events().filter(event => event.run.runId === run.id); const stages = events.filter(event => event.type === 'context.compaction'); assert.deepEqual(stages.map(event => event.payload.stage), ['candidate']);
    assert.equal(events.some(event => event.type === 'request.intent' || event.type === 'request.dispatch'), false); assert.deepEqual(f.read(f.first.modelFrame!.content), oldBytes);
    const store = new RuntimeStore(f.data); try { assert.equal(store.readSnapshot().runs.find(item => item.id === run.id)?.contextState, undefined); } finally { store.close(); }
});
