import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { createHash, randomInt } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { executeArtifactRead } from '../../src/runtime/artifact-tools';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RuntimeEvent } from '../../src/shared/contracts';
import type { ArtifactReference } from '../../src/shared/harness-contracts';

const CANARY = 'local-secret-canary';
interface Body { messages: Array<{ role: string; content?: string; tool_call_id?: string }> }
function answer(response: ServerResponse, calls: Array<{ name: string; args: unknown }> = []) {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = calls.length ? { tool_calls: calls.map((call, index) => ({ index, id: `privacy-${call.name}-${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } })) } : { content: 'Privacy fixture complete.' };
    response.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: calls.length ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
}

async function fixture(t: { after(fn: () => Promise<void>): void }, command: string, readBothModes: boolean) {
    const root = mkdtempSync(join(tmpdir(), 'uah-command-privacy-')); const project = join(root, 'project'); mkdirSync(project);
    const data = join(root, 'data'); const requests: Body[] = []; const errors: unknown[] = [];
    const events: RuntimeEvent[] = []; const listeners = new Set<() => void>();
    const server = createServer((request, response) => { void (async () => {
        const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()) as Body; requests.push(body);
        if (requests.length === 1) answer(response, [{ name: 'run_command', args: { command, timeoutSeconds: 10 } }]);
        else if (requests.length === 2 && readBothModes) {
            const preview = body.messages.find(message => message.role === 'tool')!.content!;
            const hashes = [...preview.matchAll(/sha256=([a-f0-9]{64})/g)].map(match => match[1]); assert.equal(hashes.length, 2);
            answer(response, hashes.flatMap(sha256 => ['utf8', 'base64'].map(encoding => ({ name: 'read_artifact_range', args: { sha256, encoding } }))));
        } else answer(response);
    })().catch(error => { errors.push(error); if (!response.headersSent) response.writeHead(500); response.end(); }); });
    for (let attempt = 0; attempt < 32; attempt++) {
        try { await new Promise<void>((ready, reject) => {
            const failed = (error: Error) => { server.off('listening', listening); reject(error); };
            const listening = () => { server.off('error', failed); ready(); };
            server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1');
        }); break; } catch (error) { if (!['EADDRINUSE', 'EACCES'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    const address = server.address(); assert.ok(address && typeof address !== 'string'); const settings = defaultAgentSettings();
    const supervisor = new Supervisor({ dataDirectory: data, delayMs: 0,
        onEvent: event => { events.push(event); for (const listener of [...listeners]) listener(); }, getAgentSettings: () => settings,
        resolveAgent: id => { const profile = settings.profiles.find(item => item.id === id); assert.ok(profile); return profile; },
        resolveConnection: async id => ({ id, name: 'Local privacy fixture', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${address.port}/v1`, apiKey: CANARY,
            models: ['fixture-model'], enabled: true, revision: 1, modelDetails: [{ id: 'fixture-model', tools: true }] }),
    });
    t.after(async () => {
        await supervisor.shutdown(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
        const target = resolve(root); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-command-privacy-'));
        rmSync(target, { recursive: true, force: true }); assert.deepEqual(errors, []);
    });
    const created = await supervisor.execute({ type: 'create-session', title: 'Command privacy fixture', directory: project, agentId: 'default',
        selection: { endpointId: 'fixture', modelId: 'fixture-model' }, controls: { permissionMode: 'bypass', reasoningEffort: 'default' } });
    const sessionId = created.sessions[0].id;
    const initial = await supervisor.execute({ type: 'start-run', sessionId, input: 'Execute the isolated privacy fixture command.' }); const runId = initial.runs.find(run => run.sessionId === sessionId)!.id;
    await new Promise<void>((done, reject) => {
        const timer = setTimeout(() => { listeners.delete(check); reject(new Error('Command privacy terminal deadline exceeded')); }, 20000);
        const check = () => { const event = events.findLast(event => event.type === 'run-state' && event.runId === runId && ['completed', 'failed', 'stopped'].includes(event.payload.run.state));
            if (event) { clearTimeout(timer); listeners.delete(check); done(); } };
        listeners.add(check); check();
    });
    const run = (await supervisor.execute({ type: 'snapshot' })).runs.find(run => run.id === runId)!; assert.equal(run.state, 'completed', run.error);
    const tool = run.activities!.find(activity => activity.tool?.name === 'run_command')!.tool!;
    assert.equal(tool.isError, false, tool.result); assert.equal(tool.outcome!.executionEvidence!.treeExited, true); assert.equal(tool.outcome!.executionEvidence!.outputDrained, true);
    const source = supervisor.journalSessionDirectory(sessionId); const refs = tool.outcome!.artifactRefs;
    const store = new RuntimeStore(data); let canonical; try { canonical = store.readJournal(sessionId, 0, 10000); } finally { store.close(); }
    const spool = join(data, 'executions', tool.outcome!.executionEvidence!.executionId);
    const read = (ref: ArtifactReference, encoding: 'utf8' | 'base64') => {
        const result = executeArtifactRead({ id: 'privacy-direct-read', name: 'read_artifact_range', arguments: JSON.stringify({ sha256: ref.sha256, encoding }) }, refs,
            item => readFileSync(join(source, item.relativePath!)), new AbortController().signal);
        assert.notEqual(result.isError, true, result.content); return JSON.parse(result.content) as { text?: string; base64?: string };
    };
    const exportBytes = (mode: 'full' | 'share') => { const destination = join(root, mode); supervisor.journalExport(sessionId, destination, mode); return refs.map(ref => readFileSync(join(destination, ref.relativePath!))); };
    const manifest = JSON.parse(readFileSync(join(source, 'manifest.json'), 'utf8')) as { captureCoverage: string };
    return { supervisor, requests, run, tool, refs, source, spool, canonical, read, exportBytes, manifest };
}

test('known connection credentials are filtered before command spool, public artifacts, reads and exports', { skip: process.platform !== 'win32' }, async t => {
    const command = "$s='local-secret-'+'canary'; [Console]::Out.WriteLine('stdout-safe:'+ $s +':tail'); [Console]::Error.WriteLine('stderr-safe:'+ $s +':tail')";
    assert.equal(command.includes(CANARY), false, 'the tool arguments must not themselves trigger credential redaction');
    const f = await fixture(t, command, true); assert.equal(f.requests.length, 3);
    assert.equal(f.tool.outcome!.executionEvidence!.outputRedacted, true); assert.equal(f.manifest.captureCoverage, 'partial');
    assert.ok(f.canonical.some(event => event.type === 'tool.result' && JSON.stringify(event.payload).includes('"outputRedacted":true')));
    for (const value of [f.tool.result, JSON.stringify(f.run), JSON.stringify(f.requests), JSON.stringify(f.canonical)]) assert.equal(value!.includes(CANARY), false);
    const expected = ['stdout-safe:', 'stderr-safe:'].map(prefix => Buffer.from(prefix + '*'.repeat(CANARY.length) + ':tail\r\n'));
    const sourceBytes = f.refs.map(ref => readFileSync(join(f.source, ref.relativePath!)));
    for (const [index, bytes] of sourceBytes.entries()) {
        assert.deepEqual(bytes, expected[index]); assert.equal(f.refs[index].sha256, createHash('sha256').update(bytes).digest('hex'));
        assert.equal(f.read(f.refs[index], 'utf8').text, bytes.toString('utf8'));
        assert.deepEqual(Buffer.from(f.read(f.refs[index], 'base64').base64!, 'base64'), bytes);
    }
    const rangeTools = f.run.activities!.filter(activity => activity.tool?.name === 'read_artifact_range'); assert.equal(rangeTools.length, 4);
    for (const activity of rangeTools) { assert.equal(activity.tool!.isError, false); const result = JSON.parse(activity.tool!.result!);
        if (result.base64) assert.equal(Buffer.from(result.base64, 'base64').includes(Buffer.from(CANARY)), false); }
    for (const mode of ['full', 'share'] as const) assert.deepEqual(f.exportBytes(mode), sourceBytes);
    const spoolBytes = () => ['stdout', 'stderr'].map(stream => readFileSync(join(f.spool, stream + '.bin')));
    assert.deepEqual(spoolBytes(), expected, 'confirmed release keeps only filtered spool bytes');
    await f.supervisor.shutdown(); assert.deepEqual(spoolBytes(), expected, 'shutdown does not leave an unfiltered raw copy');
});

test('configured credential filtering preserves unrelated binary output and complete capture when no secret matches', { skip: process.platform !== 'win32' }, async t => {
    const binary = Buffer.from([0, 255, 1, 128, 13, 10]);
    const f = await fixture(t, '[byte[]]$b=0,255,1,128,13,10; $o=[Console]::OpenStandardOutput(); $o.Write($b,0,$b.Length); $o.Flush(); [Console]::Error.WriteLine("safe stderr")', false);
    assert.equal(f.requests.length, 2); assert.notEqual(f.tool.outcome!.executionEvidence!.outputRedacted, true);
    assert.equal(f.manifest.captureCoverage, 'complete', 'filter configuration alone must not downgrade coverage');
    const expected = [binary, Buffer.from('safe stderr\r\n')];
    for (const [index, ref] of f.refs.entries()) {
        assert.deepEqual(readFileSync(join(f.source, ref.relativePath!)), expected[index]);
        assert.equal(ref.sha256, createHash('sha256').update(expected[index]).digest('hex'));
        assert.deepEqual(Buffer.from(f.read(ref, 'base64').base64!, 'base64'), expected[index]);
    }
    for (const mode of ['full', 'share'] as const) assert.deepEqual(f.exportBytes(mode), expected);
    await f.supervisor.shutdown();
    for (const [index, stream] of ['stdout', 'stderr'].entries()) assert.deepEqual(readFileSync(join(f.spool, stream + '.bin')), expected[index]);
});
