import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ApplicationJournal } from '../../src/runtime/application-journal';
import { RuntimeStore } from '../../src/runtime/store';
import { validateTranscript } from '../../src/runtime/transcript-offline';
import type { ApiConnection, ApiProtocol } from '../../src/shared/endpoints';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { RunJournal } from '../../src/runtime/run-journal';
import { RequestJournal } from '../../src/runtime/request-journal';
import type { RunRecord } from '../../src/shared/contracts';

const secret = 'application-fixture-key-material';
const frame = (value: unknown, event?: string) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(value)}\n\n`;
const readEvents = (directory: string) => {
    const store = new RuntimeStore(path.join(directory, 'application-journal'));
    try { return store.readJournal('application', 0, 10000); } finally { store.close(); }
};
async function fixture(t: { after(fn: () => void | Promise<void>): void }, handler: (body: Record<string, unknown>, response: ServerResponse) => void) {
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-application-journal-'));
    const requests: Array<Record<string, unknown>> = [];
    const server = createServer((request, response) => {
        void (async () => {
            const bytes: Buffer[] = []; for await (const chunk of request) bytes.push(Buffer.from(chunk));
            const body = JSON.parse(Buffer.concat(bytes).toString()) as Record<string, unknown>; requests.push(body);
            handler(body, response);
        })().catch(() => { response.writeHead(500); response.end(); });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const journal = new ApplicationJournal(directory);
    t.after(async () => {
        journal.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
        const absolute = path.resolve(directory); assert.equal(path.dirname(absolute), path.resolve(tmpdir())); assert.ok(path.basename(absolute).startsWith('uah-application-journal-'));
        rmSync(absolute, { recursive: true, force: true });
    });
    const connection = (protocol: ApiProtocol): ApiConnection => ({ id: randomUUID(), name: 'Offline application', protocol, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, apiKey: secret, models: ['model', 'empty', 'long', 'tool', 'http-fail', 'slow'], enabled: true, revision: 1 });
    return { directory, requests, journal, connection };
}
function success(response: ServerResponse, protocol: ApiProtocol, text = 'OK') {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    if (protocol === 'openai-chat') response.end(frame({ choices: [{ index: 0, delta: { content: text }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } }) + 'data: [DONE]\n\n');
    else if (protocol === 'openai-responses') response.end(frame({ type: 'response.output_text.delta', output_index: 0, delta: text }, 'response.output_text.delta') + frame({ type: 'response.completed', response: { status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] }], usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } } }, 'response.completed'));
    else response.end(frame({ type: 'message_start', message: { id: 'application-msg', usage: { input_tokens: 12, output_tokens: 0 } } }, 'message_start') + frame({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }, 'content_block_start') + frame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } }, 'content_block_delta') + frame({ type: 'content_block_stop', index: 0 }, 'content_block_stop') + frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } }, 'message_delta') + frame({ type: 'message_stop' }, 'message_stop'));
}

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) test(`${protocol} connection probe records isolated application purpose and final capped payload`, async t => {
    const f = await fixture(t, (_body, response) => success(response, protocol));
    const result = await f.journal.testConnection(f.connection(protocol), 'model'); assert.equal(result.text, 'OK'); assert.ok(result.elapsedMs >= 0);
    assert.equal((f.journal as unknown as { runs: Map<string, unknown> }).runs.size, 0, 'settled probes do not accumulate in runtime memory');
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0].tools, undefined);
    assert.equal(f.requests[0][protocol === 'openai-chat' ? 'max_completion_tokens' : protocol === 'openai-responses' ? 'max_output_tokens' : 'max_tokens'], 256);
    const events = readEvents(f.directory);
    const usage = events.filter(event => event.type === 'usage.snapshot'); assert.ok(usage.length >= 2);
    for (const event of usage) { assert.equal(event.payload.usage.purpose, 'connection_test'); assert.deepEqual(event.payload.usage.scope, { kind: 'application' }); }
    assert.ok(usage.some(event => event.payload.usage.counters.inputTokens === 12 && event.payload.usage.counters.outputTokens === 3));
    assert.ok(events.some(event => event.type === 'request.intent')); assert.ok(events.some(event => event.type === 'provider.frame')); assert.ok(events.some(event => event.type === 'response.native'));
    assert.ok(events.some(event => event.type === 'message.accepted')); assert.equal(events.at(-1)?.type, 'run.state');
    assert.ok(events.every(event => event.run.sessionId === 'application'));
    f.journal.close();
    const partitions = readdirSync(path.join(f.directory, 'application-journal', 'sessions')); assert.equal(partitions.length, 1);
    const report = validateTranscript(path.join(f.directory, 'application-journal', 'sessions', partitions[0])); assert.ok(report.eventCount > 0);
    const visit = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) visit(full); else assert.equal(readFileSync(full).includes(Buffer.from(secret)), false, full); } }; visit(f.directory);
    const userStore = new RuntimeStore(f.directory); try { assert.equal(userStore.readSnapshot().sessions.length, 0); } finally { userStore.close(); }
});

test('application probe failure/cancellation keep unknown usage and do not retry', async t => {
    const f = await fixture(t, (body, response) => {
        if (body.model === 'http-fail') { response.writeHead(500); response.end('server failed'); }
        else if (body.model === 'slow') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.write(': waiting\n\n'); }
        else if (body.model === 'tool') { response.writeHead(200, { 'content-type': 'text/event-stream' }); response.end(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'forbidden-tool', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'); }
        else success(response, 'openai-chat', '');
    });
    await assert.rejects(f.journal.testConnection(f.connection('openai-chat'), 'http-fail'), /HTTP 500/);
    await assert.rejects(f.journal.testConnection(f.connection('openai-chat'), 'empty'), /no visible text|文本响应/);
    await assert.rejects(f.journal.testConnection(f.connection('openai-chat'), 'tool'));
    const controller = new AbortController(); const promise = f.journal.testConnection(f.connection('openai-chat'), 'slow', controller.signal);
    const cancelled = assert.rejects(promise);
    while (f.requests.length < 4) await delay(10);
    controller.abort(); await cancelled;
    assert.equal(f.requests.length, 4);
    const before = f.requests.length; const alreadyCancelled = new AbortController(); alreadyCancelled.abort();
    await assert.rejects(f.journal.testConnection(f.connection('openai-chat'), 'model', alreadyCancelled.signal)); assert.equal(f.requests.length, before);
    assert.equal((f.journal as unknown as { runs: Map<string, unknown> }).runs.size, 0, 'failed and cancelled probe bodies leave the active map');
    const events = readEvents(f.directory); const usage = events.filter(event => event.type === 'usage.snapshot');
    assert.equal(new Set(usage.map(event => event.payload.usage.attemptId)).size, 5);
    assert.ok(usage.every(event => event.payload.usage.scope.kind === 'application' && event.payload.usage.purpose === 'connection_test'));
    assert.ok(usage.some(event => event.payload.usage.counters.inputTokens === null));
    assert.ok(events.some(event => event.type === 'response.terminal' && event.payload.status === 'cancelled'));
});

test('application preview cap preserves full local transcript and removes echoed split keys', async t => {
    const f = await fixture(t, (_body, response) => {
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const text of ['X'.repeat(10000), secret.slice(0, 12), secret.slice(12)]) response.write(frame({ choices: [{ delta: { content: text }, finish_reason: null }] }));
        response.end(frame({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    });
    const result = await f.journal.testConnection(f.connection('openai-chat'), 'long'); assert.ok(result.text.startsWith('X'.repeat(8192))); assert.ok(result.text.includes('仅展示前 8192'));
    f.journal.close();
    const events = readEvents(f.directory); const deltas = events.filter(event => event.type === 'response.delta').map(event => event.payload.text).join('');
    assert.ok(deltas.length > 10000); assert.equal(deltas.includes(secret), false);
    const visit = (directory: string) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const full = path.join(directory, entry.name); if (entry.isDirectory()) visit(full); else { const bytes = readFileSync(full); assert.equal(bytes.includes(Buffer.from(secret)), false, full); assert.equal(bytes.includes(Buffer.from(secret.slice(0, 12))), false, full); } } }; visit(f.directory);
});

test('application recording failure prevents network send and latches future admission closed', async t => {
    const f = await fixture(t, (_body, response) => success(response, 'openai-chat'));
    t.mock.method(JournalArtifacts.prototype, 'save', () => { throw new Error('Fixture journal disk failure'); });
    await assert.rejects(f.journal.testConnection(f.connection('openai-chat'), 'model'), /disk failure/);
    await assert.rejects(f.journal.testConnection(f.connection('openai-chat'), 'model'), /recording is unavailable/);
    assert.equal(f.requests.length, 0);
    f.journal.close();
    const before = readEvents(f.directory);
    assert.ok(before.some(event => event.type === 'run.state' && event.payload.state === 'recording_failed'));
    const recovered = new ApplicationJournal(f.directory);
    try {
        await assert.rejects(recovered.testConnection(f.connection('openai-chat'), 'model'), /recording is unavailable/);
        assert.deepEqual(readEvents(f.directory), before, 'recording failure boundary is preserved after restart');
        assert.equal(f.requests.length, 0);
    } finally { recovered.close(); }
});

test('application restart settles an unfinished operation without changing request or usage facts', async t => {
    const f = await fixture(t, (_body, response) => success(response, 'openai-chat'));
    await f.journal.testConnection(f.connection('openai-chat'), 'model');
    f.journal.close();
    const directory = path.join(f.directory, 'application-journal');
    const store = new RuntimeStore(directory);
    const completed = store.readSnapshot().runs[0]; assert.equal(completed.harnessState, 'completed');
    const interrupted: RunRecord = { ...completed, id: randomUUID(), turnId: randomUUID(), state: 'running', harnessState: 'waiting_model',
        sequence: 7, input: 'Interrupted connection test', output: '', finishedAt: undefined };
    const runs = new Map([[completed.id, completed], [interrupted.id, interrupted]]);
    const journal = new RunJournal(store, directory, id => runs.get(id), () => { throw new Error('Fixture recording failed'); });
    const content = journal.artifactStore('application').save({ text: interrupted.input });
    journal.commit({ runs: [interrupted] }, [
        { run: journal.identity(interrupted), type: 'message.accepted', payload: { messageId: interrupted.turnId, revision: 1, role: 'user', content: content.ref }, timestamp: interrupted.createdAt },
        { run: journal.identity(interrupted), type: 'run.state', payload: { state: 'waiting_model', reason: null }, timestamp: interrupted.createdAt },
    ]);
    const request = new RequestJournal(journal, interrupted, { ...journal.identity(interrupted), requestId: randomUUID(), attemptId: randomUUID(), stepId: randomUUID() }, f.connection('openai-chat'), { purpose: 'connection_test', scope: { kind: 'application' } });
    await request.observer.prepared?.({ model: 'model', messages: [{ role: 'user', content: interrupted.input }] }, 'openai-chat');
    await request.observer.dispatch?.();
    journal.close(); store.close();
    const before = readEvents(f.directory); const sent = f.requests.length;
    const recovered = new ApplicationJournal(f.directory); recovered.close();
    const after = readEvents(f.directory);
    assert.deepEqual(after.slice(0, before.length), before, 'all original intent/usage/observed facts are unchanged');
    assert.equal(after.length, before.length + 1);
    const event = after.at(-1)!; assert.equal(event.type, 'run.state');
    assert.equal(event.run.runId, interrupted.id); assert.equal(event.sessionSeq, before.at(-1)!.sessionSeq + 1);
    if (event.type === 'run.state') { assert.equal(event.payload.state, 'cancelled'); assert.match(event.payload.reason!, /restart.*completion was not observed/); }
    assert.equal(after.filter(event => event.type === 'response.terminal' && event.run.runId === interrupted.id).length, 0, 'no provider terminal is fabricated');
    const inspect = new RuntimeStore(directory);
    try {
        const snapshot = inspect.readSnapshot(); const run = snapshot.runs.find(run => run.id === interrupted.id)!;
        assert.equal(run.state, 'stopped'); assert.equal(run.harnessState, 'cancelled'); assert.equal(run.sequence, 8); assert.ok(run.finishedAt); assert.match(run.stopReason!, /restart/);
        assert.deepEqual(snapshot.runs.find(run => run.id === completed.id), completed, 'completed operation remains unchanged');
    } finally { inspect.close(); }
    const secondRestart = new ApplicationJournal(f.directory); secondRestart.close();
    assert.deepEqual(readEvents(f.directory), after, 'recovery is idempotent'); assert.equal(f.requests.length, sent, 'restart performs no network request');
});
