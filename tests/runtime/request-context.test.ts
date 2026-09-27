import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { captureRequestContext, contextSummary } from '../../src/runtime/request-context';
import { parseContextQuery } from '../../src/shared/request-context';
import { Supervisor } from '../../src/runtime/supervisor';
import { RuntimeStore } from '../../src/runtime/store';
import { DatabaseSync } from 'node:sqlite';
import { assemblePrompt } from '../../src/runtime/prompt-assembler';
import type { ApiConnection } from '../../src/shared/endpoints';
import type { RunRecord } from '../../src/shared/contracts';

const base = { runId: 'fixture', round: 0, modelId: 'mock', protocol: 'openai-chat' as const, sections: [{ id: 'host.contract', content: 'system' }, { id: 'context.git', content: 'git fixture' }], messages: [{ role: 'user' as const, content: 'question' }], tools: [] };

test('context projection strips private state for all protocols and retains public calls/results', () => {
    for (const continuation of [
        [{ role: 'assistant', content: 'visible', reasoning_content: 'private-thinking', signature: 'private-signature', tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{"path":"file.txt"}' } }] }, { role: 'tool', tool_call_id: 'call', content: 'public-result' }],
        [{ type: 'reasoning', encrypted_content: 'private-thinking', summary: [{ text: 'private-signature' }] }, { type: 'function_call', call_id: 'call', name: 'read_file', arguments: '{}' }, { type: 'function_call_output', call_id: 'call', output: 'public-result' }],
        [{ role: 'assistant', content: [{ type: 'thinking', thinking: 'private-thinking', signature: 'private-signature' }, { type: 'tool_use', id: 'call', name: 'read_file', input: {} }] }, { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call', content: [{ type: 'text', text: 'public-result' }] }] }],
    ]) {
        const result = captureRequestContext({ ...base, continuation });
        assert.equal(result.omittedPrivateState, true);
        const text = JSON.stringify(result);
        assert.doesNotMatch(text, /private-thinking|private-signature/);
        assert.match(text, /read_file/);
        assert.match(text, /public-result/);
        assert.equal(result.capacity, undefined);
        assert.equal(result.usage, undefined);
        assert.equal(result.sections[0].content, 'system');
        assert.equal(result.sections[1].content, 'git fixture');
        assert.ok(contextSummary(result).sections.every(section => !('content' in section)));
    }
});

test('details bound stored content while estimates retain full visible lengths, without counting environment twice', () => {
    const detail = captureRequestContext({ ...base, capacity: 0, continuation: [{ role: 'user', content: 'a'.repeat(500_000) }] });
    assert.equal(detail.capacity, undefined);
    assert.ok(detail.sections.at(-1)!.truncated);
    assert.ok(detail.sections.at(-1)!.characters > 500_000);
    assert.ok(detail.sections.reduce((sum, section) => sum + section.content.length, 0) <= 240_000);
    assert.equal(detail.estimatedInputTokens, detail.sections.reduce((sum, section) => sum + section.estimatedTokens, 0));
    assert.ok(detail.sections.at(-1)!.estimatedTokens >= 125_000);
});

test('context bridge validates finite query and Git module follows supplied tool catalog', () => {
    assert.deepEqual(parseContextQuery({ runId: 'run' }), { runId: 'run' });
    for (const value of [null, {}, { runId: '' }, { runId: 'run', path: 'secret' }, Object.create({ runId: 'run' }), { get runId() { throw new Error('must not execute'); } }]) assert.throws(() => parseContextQuery(value), /无效的上下文查询/);
    const run = { id: 'run', effective: { modelId: 'model', permissionMode: 'plan' } } as RunRecord;
    const context = { GIT_STATUS_AND_TASK_CONTEXT: { branch: '<injected>' } };
    const present = assemblePrompt({ run, directory: null, tools: ['git_status'], context });
    const absent = assemblePrompt({ run, directory: null, tools: [], context });
    assert.ok(present.modules.some(module => module.id === 'workspace.git' && module.included));
    assert.ok(absent.modules.some(module => module.id === 'workspace.git' && !module.included));
    assert.match(absent.instructions, /\\u003cinjected\\u003e/);
    assert.equal(present.sections.map(section => section.content).join('\n\n'), present.instructions);
});

test('runtime v1 database upgrades context storage without modifying existing sessions', () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-context-'));
    let store = new RuntimeStore(root);
    const session = { id: 'legacy', title: 'existing', directory: null, createdAt: '2026-09-28', requested: { runtimeId: 'api', modelId: 'model', agentId: 'default', policyVersion: 1 } };
    store.commit({ sessions: [session] }); store.close();
    const database = new DatabaseSync(join(root, 'runtime.sqlite'));
    database.exec('DROP TABLE request_contexts; PRAGMA user_version = 1;'); database.close();
    try {
        store = new RuntimeStore(root);
        assert.deepEqual(store.readSnapshot().sessions, [session]);
        assert.equal(store.readRequestContext('nonexistent'), null);
    } finally {
        store.close();
        if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('uah-context-')) throw new Error('unsafe cleanup');
        rmSync(root, { recursive: true, force: true });
    }
});

test('Supervisor refreshes Git per request, persists latest usage and visible continuation, invalidates edited/deleted history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-context-'));
    const work = join(root, 'work'); mkdirSync(work);
    execFileSync('git', ['init', '-b', 'context-fixture', work], { windowsHide: true });
    writeFileSync(join(work, 'first.txt'), 'first');
    const connection: ApiConnection = { id: 'mock', name: 'Mock', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:1', apiKey: 'endpoint-key-never-display', models: ['mock'], modelDetails: [{ id: 'mock', contextWindow: 100_000 }], enabled: true, revision: 1 };
    const previous = globalThis.fetch;
    const requests: any[] = [];
    const data = join(root, 'data');
    let supervisor = new Supervisor({ dataDirectory: data, onEvent() {}, resolveConnection: async () => connection });
    const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
    globalThis.fetch = (async (_url, init) => {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        const first = requests.length === 1;
        if (first) writeFileSync(join(work, 'second.txt'), 'new during loop');
        const delta = first ? { tool_calls: [{ index: 0, id: 'git-call', type: 'function', function: { name: 'git_status', arguments: '{}' } }] } : { content: 'done' };
        const usage = requests.length <= 2 ? frame({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 100 } } }) : '';
        return new Response(frame({ choices: [{ delta, finish_reason: first ? 'tool_calls' : 'stop' }] }) + usage + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    async function finish() {
        for (let i = 0; i < 400; i++) {
            const snapshot = await supervisor.execute({ type: 'snapshot' });
            if (snapshot.runs.length && snapshot.runs.every(run => ['completed', 'failed', 'stopped'].includes(run.state))) return snapshot;
            await delay(10);
        }
        throw new Error('fixture did not finish');
    }
    try {
        const created = await supervisor.execute({ type: 'create-session', title: 'context', directory: work, selection: { endpointId: 'mock', modelId: 'mock' } });
        const sessionId = created.sessions[0].id;
        await supervisor.execute({ type: 'start-run', sessionId, input: 'Inspect Git' });
        const first = (await finish()).runs[0];
        assert.equal(first.state, 'completed', first.error);
        assert.equal(requests.length, 2);
        assert.doesNotMatch(requests[0].messages[0].content, /second.txt/);
        assert.match(requests[1].messages[0].content, /second.txt/);
        assert.ok(requests[0].tools.some((tool: any) => tool.function.name === 'git_diff'));
        let detail = supervisor.requestContext(first.id)!;
        assert.equal(detail.round, 1);
        assert.equal(detail.capacity, 100_000);
        assert.equal(detail.usage?.inputTokens, 1234);
        assert.match(detail.sections.find(section => section.id === 'history')!.content, /git-call|second.txt/);
        assert.doesNotMatch(JSON.stringify(detail), /endpoint-key-never-display/);
        assert.equal((first.requestContext as any).sections[0].content, undefined);
        await supervisor.shutdown();
        supervisor = new Supervisor({ dataDirectory: data, onEvent() {}, resolveConnection: async () => connection });
        detail = supervisor.requestContext(first.id)!;
        assert.equal(detail.usage?.cachedInputTokens, 100);
        await supervisor.execute({ type: 'start-run', sessionId, input: 'next without usage' });
        const second = (await finish()).runs.at(-1)!;
        assert.equal(second.requestContext?.usage, undefined);
        assert.ok(second.requestContext!.estimatedInputTokens > 0);
        await supervisor.execute({ type: 'edit-reply', runId: first.id, output: 'edited' });
        assert.equal(supervisor.requestContext(first.id), null);
        assert.equal(supervisor.requestContext(second.id), null);
        await supervisor.execute({ type: 'start-run', sessionId, input: 'after edit' });
        const third = (await finish()).runs.at(-1)!;
        assert.match(supervisor.requestContext(third.id)!.sections.at(-1)!.content, /edited/);
        await supervisor.execute({ type: 'delete-reply', runId: first.id });
        assert.equal(supervisor.requestContext(third.id), null);
    } finally {
        globalThis.fetch = previous;
        await supervisor.shutdown();
        if (dirname(resolve(root)) !== resolve(tmpdir()) || !basename(root).startsWith('uah-context-')) throw new Error('unsafe cleanup');
        rmSync(root, { recursive: true, force: true });
    }
});
