import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { createHash, randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, unlinkSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { beginToolOutcome } from '../../src/runtime/tool-outcome';
import { validateTranscript, replayTranscript } from '../../src/runtime/transcript-offline';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RuntimeConfig, RunRecord, SessionRecord } from '../../src/shared/contracts';
import type { ArtifactReference } from '../../src/shared/harness-contracts';

interface Body { messages: Array<{ role: string; content?: string; tool_call_id?: string }>; }
const sessionDirectory = (data: string, sessionId: string) => join(data, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
function answer(response: ServerResponse, calls: Array<{ sha256: string; offset?: number; limit?: number }> = []) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((args, index) => ({ index, id: `artifact-call-${index}`, type: 'function', function: { name: 'read_artifact_range', arguments: JSON.stringify(args) } })) } : { content: 'Artifact fixture complete.' };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}
async function fixture(t: { after(fn: () => Promise<void>): void }, kind: 'isolation' | 'branch') {
    const root = mkdtempSync(join(tmpdir(), 'uah-artifact-loop-')); const project = join(root, 'project'); mkdirSync(project); const data = join(root, 'data');
    const requests: Body[] = []; const errors: unknown[] = []; let rounds = 0;
    let publicRef: ArtifactReference; let foreignRef: ArtifactReference; let restrictedRef: ArtifactReference; let laterRef: ArtifactReference;
    const expectedPage = 'SECOND_PAGE😀END';
    const server = createServer((request, response) => { void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body);
        if (++rounds === 1) answer(response, kind === 'isolation'
            ? [{ sha256: publicRef.sha256!, offset: 65536, limit: 64 }, { sha256: foreignRef.sha256! }, { sha256: restrictedRef.sha256! }]
            : [{ sha256: publicRef.sha256!, offset: 65536, limit: 64 }, { sha256: laterRef.sha256! }]);
        else {
            const results = body.messages.filter(message => message.role === 'tool'); assert.equal(results.length, kind === 'isolation' ? 3 : 2);
            assert.equal(JSON.parse(results[0].content!).text, expectedPage); assert.match(results[1].content!, /not authorized/);
            if (kind === 'isolation') assert.match(results[2].content!, /Restricted/);
            answer(response);
        }
    })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, reject) => { const failed = (error: Error) => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); ready(); }; server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; }
        catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string');
    const settings = defaultAgentSettings(); const endpoint = { id: 'fixture-endpoint', name: 'Local artifacts', protocol: 'openai-chat' as const, baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: 'artifact-local-key', enabled: true, revision: 1, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true }] };
    const config: RuntimeConfig = { runtimeId: 'api', modelId: 'fixture-model', agentId: 'default', policyVersion: 1, endpointId: endpoint.id, endpointRevision: 1, protocol: endpoint.protocol, permissionMode: 'readonly', agentInstructions: 'Artifact integration fixture', allowDelegation: false };
    const sourceId = randomUUID(); const foreignId = randomUUID();
    const sessions: SessionRecord[] = [sourceId, foreignId].map((id, index) => ({ id, title: `Artifact seed ${index}`, directory: project, requested: config, createdAt: new Date(1000 + index).toISOString(), controls: { permissionMode: 'readonly', reasoningEffort: 'default' }, controlsRevision: 0, initialConfig: { agentId: 'default', directory: project, selection: { endpointId: endpoint.id, modelId: 'fixture-model' }, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } } }));
    const sourceArtifacts = new JournalArtifacts(sessionDirectory(data, sourceId)); const foreignArtifacts = new JournalArtifacts(sessionDirectory(data, foreignId));
    publicRef = sourceArtifacts.saveBytes(Buffer.from('P'.repeat(65536) + expectedPage)); laterRef = sourceArtifacts.saveBytes(Buffer.from('LATER_OUTCOME_AFTER_BRANCH_CUTOFF'));
    restrictedRef = sourceArtifacts.save({ private: 'RESTRICTED_PAYLOAD_MUST_NEVER_BE_RETURNED' }, [], true).ref; foreignRef = foreignArtifacts.saveBytes(Buffer.from('OTHER_SESSION_PRIVATE_OUTPUT'));
    const seedRun = (sessionId: string, refs: ArtifactReference[], created: number): RunRecord => {
        const capture = beginToolOutcome(); capture.outcome.artifactRefs = refs; capture.finish({ content: 'Retained raw output references.' }); capture.outcome.recordingState = 'durable';
        return { id: randomUUID(), sessionId, turnId: randomUUID(), effective: config, createdAt: new Date(created).toISOString(), finishedAt: new Date(created + 1).toISOString(), state: 'completed', harnessState: 'completed', sequence: 2, input: `SEEDED OPERATION ${created}`, output: 'Seeded operation completed.', activities: [{ id: randomUUID(), kind: 'tool', title: 'run_command', content: 'Retained raw output references.', status: 'completed', tool: { name: 'run_command', arguments: { command: 'fixture seed only; never executed' }, result: 'Retained raw output references.', isError: false, outcome: capture.outcome } }] };
    };
    const cutoff = seedRun(sourceId, [publicRef, restrictedRef], 10000); const later = seedRun(sourceId, [laterRef], 20000); const foreign = seedRun(foreignId, [foreignRef], 30000);
    const store = new RuntimeStore(data); store.commit({ sessions, runs: [cutoff, later, foreign] }); store.close();
    const supervisor = new Supervisor({ dataDirectory: data, delayMs: 0, onEvent: () => {}, getAgentSettings: () => settings, resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; }, resolveConnection: async () => endpoint });
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); assert.deepEqual(errors, []); const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-artifact-loop-')); rmSync(target, { recursive: true, force: true }); });
    const start = async (sessionId: string) => {
        const initial = await supervisor.execute({ type: 'start-run', sessionId, input: 'READ ARTIFACT FIXTURE' }); const id = initial.runs.findLast(run => run.sessionId === sessionId)!.id;
        for (let attempt = 0; attempt < 800; attempt++) { const snapshot = await supervisor.execute({ type: 'snapshot' }); const run = snapshot.runs.find(run => run.id === id)!; if (['completed', 'failed', 'stopped'].includes(run.state)) { assert.equal(run.state, 'completed', run.error); return run; } await delay(10); }
        throw new Error('Artifact fixture run timed out');
    };
    return { root, data, project, sourceId, cutoff, publicRef, foreignRef, restrictedRef, laterRef, requests, supervisor, start, expectedPage };
}

test('Supervisor artifact reader pages current-session output and rejects foreign/restricted evidence', async t => {
    const f = await fixture(t, 'isolation'); const run = await f.start(f.sourceId); assert.equal(f.requests.length, 2);
    const results = run.activities!.filter(activity => activity.tool?.name === 'read_artifact_range'); assert.equal(results.length, 3);
    assert.equal(JSON.parse(results[0].tool!.result!).text, f.expectedPage); assert.equal(results[0].tool!.isError, false);
    assert.equal(results[1].tool!.isError, true); assert.equal(results[2].tool!.isError, true);
    assert.equal(JSON.stringify(f.requests).includes('OTHER_SESSION_PRIVATE_OUTPUT'), false); assert.equal(JSON.stringify(f.requests).includes('RESTRICTED_PAYLOAD_MUST_NEVER_BE_RETURNED'), false);
});
test('branch copies authorized raw artifacts independently, excludes later outcomes, and exports replayable first-run evidence', async t => {
    const f = await fixture(t, 'branch'); const before = await f.supervisor.execute({ type: 'snapshot' });
    const created = await f.supervisor.execute({ type: 'create-session', title: 'Artifact branch', directory: f.project, agentId: 'default', selection: { endpointId: 'fixture-endpoint', modelId: 'fixture-model' }, controls: { permissionMode: 'readonly', reasoningEffort: 'default' }, branchFromRunId: f.cutoff.id });
    const branch = created.sessions.find(session => !before.sessions.some(prior => prior.id === session.id))!; assert.ok(branch);
    assert.deepEqual(branch.branchArtifacts?.map(ref => ref.sha256), [f.publicRef.sha256]); assert.equal(branch.branchArtifacts?.some(ref => ref.sha256 === f.laterRef.sha256 || ref.sha256 === f.restrictedRef.sha256), false);
    assert.ok(f.publicRef.availability === 'present'); const sourceFile = join(sessionDirectory(f.data, f.sourceId), f.publicRef.relativePath); const branchFile = join(sessionDirectory(f.data, branch.id), branch.branchArtifacts![0].relativePath!);
    assert.ok(existsSync(sourceFile) && existsSync(branchFile)); assert.notEqual(sourceFile, branchFile); unlinkSync(sourceFile); assert.equal(existsSync(sourceFile), false); assert.ok(existsSync(branchFile));
    const run = await f.start(branch.id); assert.equal(f.requests.length, 2); assert.equal(JSON.parse(run.activities![0].tool!.result!).text, f.expectedPage);
    const destination = join(f.root, 'branch-full-export'); const report = f.supervisor.journalExport(branch.id, destination, 'full');
    assert.equal(report.artifactCount, report.presentArtifacts); const validated = validateTranscript(destination); assert.equal(validated.artifactCount, validated.presentArtifacts);
    const replay = replayTranscript(destination); assert.ok(replay.runs.some(item => item.runId === run.id && item.state === 'completed')); assert.equal(replay.branches.length, 1);
    const transcript = readFileSync(join(destination, 'transcript.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
    const inherited = transcript.find(event => event.type === 'history.branch'); assert.ok(inherited); assert.deepEqual(inherited.payload.artifacts.map((ref: ArtifactReference) => ref.sha256), [f.publicRef.sha256]);
    assert.equal(JSON.stringify(f.requests).includes('LATER_OUTCOME_AFTER_BRANCH_CUTOFF'), false);
});
