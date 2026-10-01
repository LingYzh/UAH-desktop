import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { RunCache } from '../../src/runtime/run-cache';
import { beginToolOutcome } from '../../src/runtime/tool-outcome';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RunRecord, RuntimeEvent, SessionRecord } from '../../src/shared/contracts';

test('Supervisor keeps 1000 durable historical runs out of its resident cache while preserving old-run access, effects and Agent locking', async t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-run-cache-loop-')); const data = join(root, 'data'); const project = join(root, 'project'); mkdirSync(project);
    const timestamp = '2026-10-01T00:00:00.000Z'; const sessionId = randomUUID(); const foreignId = randomUUID();
    const effective = { runtimeId: 'api', modelId: 'fixture-model', endpointId: 'fixture', endpointRevision: 1, protocol: 'openai-chat' as const,
        agentId: 'default', agentInstructions: 'LOCKED_FIRST_INSTRUCTIONS', policyVersion: 1, permissionMode: 'auto' as const, allowDelegation: false };
    const sessions: SessionRecord[] = [sessionId, foreignId].map(id => ({ id, title: 'Cached history fixture', directory: project, requested: effective,
        createdAt: timestamp, controls: { permissionMode: 'auto', reasoningEffort: 'default' }, controlsRevision: 0 }));
    const historical: RunRecord[] = Array.from({ length: 1000 }, (_, index) => ({ id: randomUUID(), sessionId: index < 500 ? sessionId : foreignId,
        turnId: randomUUID(), state: 'completed', harnessState: 'completed', sequence: 1, createdAt: timestamp, finishedAt: timestamp,
        input: `historical task ${index}`, output: `historical answer ${index}`, effective: index === 0 ? effective : { ...effective, agentId: 'later-history-agent' } }));
    const outcome = beginToolOutcome().outcome; Object.assign(outcome, { status: 'succeeded', effectState: 'confirmed', recordingState: 'durable' });
    historical[0].activities = [{ id: randomUUID(), kind: 'tool', title: 'write_file', content: 'File written.', status: 'completed',
        tool: { name: 'write_file', arguments: { path: 'historical-effect.txt' }, result: 'File written.', outcome } }];
    historical[1].plan = { id: randomUUID(), content: 'historical plan', filePath: 'plan.md', hash: 'b'.repeat(64), createdAt: timestamp, status: 'approved' };
    historical[2].parentRunId = historical[0].id;
    const store = new RuntimeStore(data); store.commit({ sessions, runs: historical }); store.close();
    const requests: unknown[] = []; const errors: unknown[] = []; const events: RuntimeEvent[] = []; const listeners = new Set<() => void>();
    const server = createServer((request, response) => { void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); requests.push(JSON.parse(Buffer.concat(chunks).toString()));
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'cached history request complete' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
    })().catch(error => { errors.push(error); response.destroy(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, reject) => {
            const failed = (error: Error) => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); ready(); };
            server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1');
        }); break; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings();
    const supervisor = new Supervisor({ dataDirectory: data, delayMs: 0,
        onEvent: event => { events.push(event); for (const listener of [...listeners]) listener(); }, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async id => ({ id, name: 'Local cache fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`,
            apiKey: 'local-cache-fixture-key', models: ['fixture-model'], enabled: true, revision: 1, modelDetails: [{ id: 'fixture-model', tools: true }] }),
    });
    t.after(async () => { await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
        const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-run-cache-loop-'));
        rmSync(target, { recursive: true, force: true }); assert.deepEqual(errors, []); });
    const cache = (supervisor as unknown as { runs: RunCache }).runs;
    assert.equal(cache.residentCount(), 0, 'startup recovery scans must not retain ordinary completed history');
    const snapshot = await supervisor.execute({ type: 'snapshot' }); assert.equal(snapshot.runs.length, 1000); assert.equal(cache.residentCount(), 0, 'IPC snapshot remains full but does not populate runtime history cache');
    assert.deepEqual(cache.forSession(sessionId).map(run => run.id), historical.slice(0, 500).map(run => run.id)); assert.equal(cache.residentCount(), 0);
    assert.equal(cache.forSession(sessionId)[2].parentRunId, historical[0].id); assert.equal(cache.forSession(sessionId)[1].plan!.content, 'historical plan');
    assert.equal(cache.forSession(sessionId)[0].activities![0].tool!.outcome!.effectState, 'confirmed');
    await supervisor.execute({ type: 'edit-reply', runId: historical[0].id, output: 'edited oldest reply' });
    assert.equal(cache.get(historical[0].id)!.history!.editedOutput, 'edited oldest reply'); assert.ok(cache.residentCount() <= 128);
    await assert.rejects(supervisor.execute({ type: 'regenerate-run', runId: historical[499].id }), /文件更改|副作用/);
    await assert.rejects(supervisor.execute({ type: 'start-run', sessionId, input: 'Reject an Agent change.', agentId: 'later-history-agent' }), /主智能体已固定/);
    assert.equal(requests.length, 0, 'historical safety gates reject before any provider request');
    const initial = await supervisor.execute({ type: 'start-run', sessionId, input: 'Use the first Agent identity.', agentId: 'default' });
    const runId = initial.runs.findLast(run => run.sessionId === sessionId)!.id;
    const completed = await new Promise<RunRecord>((done, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Cache fixture terminal deadline exceeded')); }, 15000);
        const check = () => { const event = events.findLast(event => event.type === 'run-state' && event.runId === runId && ['completed', 'failed', 'stopped'].includes(event.payload.run.state));
            if (event?.type === 'run-state') { clearTimeout(timer); listeners.delete(check); done(event.payload.run); } }; listeners.add(check); check();
    });
    assert.equal(completed.state, 'completed', completed.error); assert.equal(completed.effective.agentId, 'default');
    assert.equal(completed.effective.agentInstructions, 'LOCKED_FIRST_INSTRUCTIONS'); assert.equal(requests.length, 1); assert.ok(cache.residentCount() <= 128);
    const persisted = new RuntimeStore(data); try {
        assert.equal(persisted.readRun(historical[0].id)!.history!.editedOutput, 'edited oldest reply');
        assert.equal(persisted.readSessionRuns(sessionId).length, 501); assert.equal(persisted.readSessionRuns(foreignId).length, 500);
    } finally { persisted.close(); }
});
