import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { CodexAppServer, type CodexAppServerRunOptions, type NativeDynamicTool, type NativeUserQuestion } from '../../src/runtime/codex-app-server.js';
import { NATIVE_CODEX_ENDPOINT_ID, parseNativeCodexSettings, type NativeCodexSettings } from '../../src/shared/native-codex.js';

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'codex-app-server-fixture.mjs');

function settings(scenario: Record<string, unknown> = {}): NativeCodexSettings {
    return parseNativeCodexSettings({
        enabled: true,
        command: process.execPath,
        args: [fixturePath, JSON.stringify(scenario)],
        model: 'gpt-fixture',
        revision: 1,
    });
}

function options(overrides: Partial<CodexAppServerRunOptions> = {}): CodexAppServerRunOptions {
    return {
        input: '请完成这个测试任务。',
        cwd: process.cwd(),
        model: 'gpt-fixture',
        mode: 'manual',
        signal: new AbortController().signal,
        onText: () => undefined,
        onEvent: () => undefined,
        onThread: () => undefined,
        approve: async () => false,
        ...overrides,
    };
}

const echoTool: NativeDynamicTool = {
    name: 'echo',
    description: 'Return the supplied value.',
    inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
};

test('RPC errors preserve method, code and bounded diagnostic without credential fields', async () => {
    const client = new CodexAppServer(settings({ rejectMethod: 'thread/resume', rpcError: {
        code: -32001, message: 'rollout not found; Bearer fixture-token https://user:pass@host/path?token=fixture-query',
        data: { requestBody: 'PRIVATE DATA' },
    } }));
    try {
        await assert.rejects(client.run(options({ threadId: 'missing-thread' })), error => {
            const message = (error as Error).message;
            assert.match(message, /Codex 原生运行时拒绝了请求/);
            assert.match(message, /thread\/resume/);
            assert.match(message, /错误码：-32001/);
            assert.match(message, /rollout not found/);
            assert.doesNotMatch(message, /fixture-token|fixture-query|user:pass|PRIVATE DATA/);
            return true;
        });
    } finally { await dispose(client); }
    const oversized = new CodexAppServer(settings({ rejectMethod: 'thread/resume', rpcErrorRepeat: 12000, rpcError: { code: -1, message: 'x' } }));
    try {
        await assert.rejects(oversized.run(options({ threadId: 'missing-thread' })), error => {
            assert.ok((error as Error).message.length < 8300);
            assert.ok((error as Error).message.endsWith('…'));
            return true;
        });
    } finally { await dispose(oversized); }
});

function dynamicScenario(calls: Array<Record<string, unknown>>, overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return { dynamicInputMatch: 'PARENT_BRIDGE', dynamicCalls: calls, ...overrides };
}

function fixtureEvents(events: Array<{ method: string; params: unknown }>, method: string): unknown[] {
    return events.filter(event => event.method === method).map(event => event.params);
}

function recordedGoalRequests(recordFile: string): Array<{ method: string; params: Record<string, unknown> }> {
    return readFileSync(recordFile, 'utf8').split(/\r?\n/).filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .filter(record => record.direction === 'client' && typeof record.method === 'string' && record.method.startsWith('thread/goal/'))
        .map(record => ({ method: record.method as string, params: record.params as Record<string, unknown> }));
}

async function dispose(client: CodexAppServer): Promise<void> {
    await client.close().catch(() => undefined);
}

test('native settings validate exact fields and keep a disabled blank default', () => {
    assert.equal(NATIVE_CODEX_ENDPOINT_ID, 'native:codex');
    assert.deepEqual(parseNativeCodexSettings({ enabled: false, command: '', args: [], model: '', revision: 0 }), {
        enabled: false, command: '', args: [], model: '', revision: 0,
    });
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: '', args: [], model: '', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: false, command: '', args: ['ignored'], model: '', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: false, command: process.execPath, args: [], model: '', revision: 0, extra: true }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: 'C:\\Windows\\System32\\cmd.exe', args: [], model: 'gpt-fixture', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: 'C:\\tool\\codex.cmd', args: [], model: 'gpt-fixture', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: process.execPath, args: ['-c', 'dangerous'], model: 'gpt-fixture', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: process.execPath, args: ['app-server'], model: 'gpt-fixture', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: process.execPath, args: ['a'.repeat(8 * 1024 + 1)], model: 'gpt-fixture', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: process.execPath, args: Array(5).fill('a'.repeat(8 * 1024)), model: 'gpt-fixture', revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: process.execPath, args: [], model: 'm'.repeat(201), revision: 0 }));
    assert.throws(() => parseNativeCodexSettings({ enabled: true, command: `C:\\${'x'.repeat(2048)}.exe`, args: [], model: 'gpt-fixture', revision: 0 }));
});

test('probe performs initialize, model list, and account read without starting a model turn', async () => {
    const client = new CodexAppServer(settings());
    assert.equal(client.hasExited(), true);
    try {
        assert.deepEqual(await client.probe(), {
            version: 'Codex/0.156.1 fixture',
            models: [{ id: 'gpt-fixture', name: 'Fixture model' }],
            authenticated: false,
            accountType: null,
        });
        assert.equal(client.hasExited(), false);
    } finally {
        await client.close();
    }
    assert.equal(client.hasExited(), true);
});

test('probe maps model metadata to request model IDs, preserves defaults and directory order, and never starts a thread or turn', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-app-server-model-probe-'));
    const recordFile = join(directory, 'requests.jsonl');
    mkdirSync(directory, { recursive: true });
    const models = [
        { id: 'catalog-alpha', model: 'request-alpha', displayName: 'Alpha', isDefault: false },
        { id: 'catalog-beta', model: 'request-beta', displayName: 'Beta', isDefault: true },
        { id: 'catalog-gamma', model: 'request-gamma', displayName: 'Gamma' },
    ];
    const client = new CodexAppServer(settings({ models, recordFile }));
    try {
        const probe = await client.probe();
        assert.deepEqual(probe.models, [
            { id: 'request-alpha', name: 'Alpha', isDefault: false },
            { id: 'request-beta', name: 'Beta', isDefault: true },
            { id: 'request-gamma', name: 'Gamma' },
        ]);
    } finally {
        await dispose(client);
    }

    try {
        const requests = readFileSync(recordFile, 'utf8').split(/\r?\n/).filter(Boolean)
            .map(line => JSON.parse(line) as Record<string, unknown>)
            .filter(record => record.direction === 'client')
            .map(record => record.method);
        assert.ok(requests.includes('model/list'));
        assert.ok(requests.includes('account/read'));
        assert.deepEqual(requests.filter(method => ['thread/start', 'turn/start'].includes(String(method))), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('probe accepts an empty model catalog and an unauthenticated account', async () => {
    const client = new CodexAppServer(settings({ emptyModels: true, account: null }));
    try {
        const result = await client.probe();
        assert.deepEqual(result.models, []);
        assert.equal(result.authenticated, false);
        assert.equal(result.accountType, null);
    } finally {
        await client.close();
    }
});

test('probe is available while disabled before a model is selected, but run remains disabled', async () => {
    const disabled = parseNativeCodexSettings({
        enabled: false,
        command: process.execPath,
        args: [fixturePath, '{}'],
        model: '',
        revision: 1,
    });
    const client = new CodexAppServer(disabled);
    try {
        const result = await client.probe();
        assert.equal(result.version, 'Codex/0.156.1 fixture');
        assert.deepEqual(result.models, [{ id: 'gpt-fixture', name: 'Fixture model' }]);
        await assert.rejects(client.run(options()), /Native Codex is disabled/);
    } finally {
        await client.close();
    }
});

test('probe rejects an account response that omits the schema field', async () => {
    const client = new CodexAppServer(settings({ omitAccount: true }));
    try {
        await assert.rejects(client.probe(), /account\/read returned an invalid response/);
    } finally {
        await dispose(client);
    }
});

test('run keeps JSONL fragments, Chinese UTF-8, thread association, event order, and per-turn usage', async () => {
    const client = new CodexAppServer(settings({ wrongThreadDelta: true, wrongTurnDelta: true }));
    const callbacks: string[] = [];
    try {
        const result = await client.run(options({
            config: { mcp_servers: {} },
            developerInstructions: '只传给这个 thread。',
            reasoningEffort: 'high',
            onEvent: method => { callbacks.push(`event:${method}`); },
            onText: text => { callbacks.push(`text:${text}`); },
        }));
        assert.deepEqual(result, {
            threadId: 'thread-fixture', turnId: 'turn-fixture', status: 'completed',
            usage: { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 },
        });
        assert.ok(callbacks.indexOf('event:item/agentMessage/delta') < callbacks.indexOf('text:你好，native。'));
        assert.deepEqual(callbacks.filter(value => value.startsWith('text:')), ['text:你好，native。']);
    } finally {
        await client.close();
    }
});

test('resume buffers old usage received between turn/start request and response, then drops the unmatched turn', async () => {
    const client = new CodexAppServer(settings({ resumeStaleUsageAfterResponse: true, resumeMatchingEarlyUsage: true }));
    const usageEvents: Array<Record<string, unknown>> = [];
    try {
        const result = await client.run(options({
            threadId: 'thread-fixture',
            onEvent: (method, params) => {
                if (method === 'thread/tokenUsage/updated' && params && typeof params === 'object') {
                    usageEvents.push(params as Record<string, unknown>);
                }
            },
        }));
        assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 7, cachedInputTokens: 3 });
        assert.deepEqual(usageEvents.map(event => event.turnId), ['turn-fixture', 'turn-fixture']);
        assert.deepEqual((usageEvents[0].tokenUsage as Record<string, unknown>).last, {
            inputTokens: 22, outputTokens: 33, cachedInputTokens: 44,
        });
    } finally {
        await client.close();
    }
});

test('token usage accepts only nonnegative safe integer counts', async () => {
    const client = new CodexAppServer(settings({ usageLast: { inputTokens: 2.5, outputTokens: Number.MAX_SAFE_INTEGER + 1, cachedInputTokens: 3 } }));
    try {
        const result = await client.run(options());
        assert.deepEqual(result.usage, { cachedInputTokens: 3 });
    } finally {
        await client.close();
    }
});

test('thread config and developer instructions are sent only through the thread request', async () => {
    const client = new CodexAppServer(settings());
    const events: Array<{ method: string; params: unknown }> = [];
    try {
        await client.run(options({
            config: { model_reasoning_effort: 'high' },
            developerInstructions: 'per-thread instructions',
            onEvent: (method, params) => { events.push({ method, params }); },
        }));
        const threadRequest = events.find(event => event.method === 'fixture/threadRequest')?.params as Record<string, unknown> | undefined;
        const turnRequest = events.find(event => event.method === 'fixture/turnRequest')?.params as Record<string, unknown> | undefined;
        assert.deepEqual(threadRequest?.config, { model_reasoning_effort: 'high' });
        assert.equal(threadRequest?.developerInstructions, 'per-thread instructions');
        assert.equal(Object.hasOwn(turnRequest ?? {}, 'config'), false);
        assert.equal(Object.hasOwn(turnRequest ?? {}, 'developerInstructions'), false);
    } finally {
        await client.close();
    }
});

test('readonly and plan keep MCP config and use their native permission policies', async (t) => {
    await t.test('readonly starts with MCP config preserved', async () => {
        const config = { mcp_servers: { extension: { enabled: true } } };
        const client = new CodexAppServer(settings({ effectiveConfig: { mcp_servers: { inherited: { command: 'node' } } } }));
        const events: Array<{ method: string; params: unknown }> = [];
        try {
            await client.run(options({ mode: 'readonly', config, onEvent: (method, params) => { events.push({ method, params }); } }));
            const threadRequest = fixtureEvents(events, 'fixture/threadRequest')[0] as Record<string, unknown>;
            const turnRequest = fixtureEvents(events, 'fixture/turnRequest')[0] as Record<string, unknown>;
            assert.deepEqual(threadRequest.config, config);
            assert.equal(threadRequest.sandbox, 'read-only');
            assert.equal(threadRequest.approvalPolicy, 'never');
            assert.deepEqual(turnRequest.sandboxPolicy, { type: 'readOnly', networkAccess: false });
            assert.equal(turnRequest.approvalPolicy, 'never');
        } finally {
            await client.close();
        }
    });
    await t.test('legacy plan permission mode is workspace-write with on-request approval', async () => {
        const config = { mcp_servers: { extension: { enabled: true } } };
        const client = new CodexAppServer(settings({ planDeltas: ['Plan alpha', ' plan beta'] }));
        const events: Array<{ method: string; params: unknown }> = [];
        const text: string[] = [];
        try {
            await client.run(options({
                mode: 'plan',
                collaborationMode: 'plan',
                config,
                onEvent: (method, params) => { events.push({ method, params }); },
                onText: delta => { text.push(delta); },
            }));
            const threadRequest = fixtureEvents(events, 'fixture/threadRequest')[0] as Record<string, unknown>;
            const turnRequest = fixtureEvents(events, 'fixture/turnRequest')[0] as Record<string, unknown>;
            assert.deepEqual(threadRequest.config, config);
            assert.equal(threadRequest.sandbox, 'workspace-write');
            assert.equal(threadRequest.approvalPolicy, 'on-request');
            assert.deepEqual(turnRequest.sandboxPolicy, { type: 'workspaceWrite', writableRoots: [process.cwd()], networkAccess: false });
            assert.equal(turnRequest.approvalPolicy, 'on-request');
            assert.deepEqual(turnRequest.collaborationMode, {
                mode: 'plan',
                settings: { model: 'gpt-fixture', reasoning_effort: null, developer_instructions: null },
            });
            assert.deepEqual(text, ['Plan alpha', ' plan beta']);
            assert.equal(fixtureEvents(events, 'item/plan/delta').length, 2);
        } finally {
            await client.close();
        }
    });
});

test('bypass mode requests native danger-full-access with no approval prompts', async () => {
    const client = new CodexAppServer(settings({ approval: true, recordApproval: true }));
    const events: Array<{ method: string; params: unknown }> = [];
    let approveCalls = 0;
    try {
        await client.run(options({
            mode: 'bypass',
            approve: async () => { approveCalls += 1; return true; },
            onEvent: (method, params) => { events.push({ method, params }); },
        }));
        const threadRequest = fixtureEvents(events, 'fixture/threadRequest')[0] as Record<string, unknown>;
        const turnRequest = fixtureEvents(events, 'fixture/turnRequest')[0] as Record<string, unknown>;
        assert.equal(threadRequest.sandbox, 'danger-full-access');
        assert.equal(threadRequest.approvalPolicy, 'never');
        assert.deepEqual(turnRequest.sandboxPolicy, { type: 'dangerFullAccess' });
        assert.equal(turnRequest.approvalPolicy, 'never');
        assert.equal(approveCalls, 0);
        assert.deepEqual(fixtureEvents(events, 'fixture/approval'), [{ allowed: false, summary: 'Codex requests approval to run a command.' }]);
    } finally {
        await client.close();
    }
});

test('thread goal set and resume run a model turn and read back the final native goal', async () => {
    const client = new CodexAppServer(settings({
        goalCompletionStatus: 'complete',
        goalTokensPerTurn: 12,
        goalSecondsPerTurn: 3,
    }));
    const events: Array<{ method: string; params: unknown }> = [];
    const onEvent = (method: string, params: unknown) => { events.push({ method, params }); };
    try {
        const started = await client.run(options({
            input: 'Start the goal task.',
            goalCommand: { type: 'set', objective: 'Finish the fixture task', tokenBudget: 400 },
            onEvent,
        }));
        assert.equal(started.goal?.status, 'complete');
        assert.equal(started.goal?.tokenBudget, 400);
        assert.equal(started.goal?.tokensUsed, 12);
        assert.equal(started.goal?.timeUsedSeconds, 3);

        const resumed = await client.run(options({
            input: 'Continue the goal task.',
            threadId: started.threadId,
            goalCommand: { type: 'resume' },
            onEvent,
        }));
        assert.equal(resumed.threadId, started.threadId);
        assert.equal(resumed.turnId, 'turn-fixture');
        assert.equal(resumed.goal?.status, 'complete');
        const requests = fixtureEvents(events, 'fixture/goalRequest') as Array<{ method: string; params: Record<string, unknown> }>;
        assert.deepEqual(requests.map(request => request.method), [
            'thread/goal/set', 'thread/goal/get', 'thread/goal/set', 'thread/goal/get',
        ]);
        assert.deepEqual(requests[0].params, {
            threadId: started.threadId,
            objective: 'Finish the fixture task',
            status: 'active',
            tokenBudget: 400,
        });
        assert.deepEqual(requests[2].params, { threadId: started.threadId, status: 'active' });
        assert.equal(fixtureEvents(events, 'fixture/turnRequest').length, 2);
    } finally {
        await client.close();
    }
});

test('goal get, pause, and clear are native RPCs that do not start a model turn', async () => {
    const client = new CodexAppServer(settings());
    const events: Array<{ method: string; params: unknown }> = [];
    const summaries: string[] = [];
    const onEvent = (method: string, params: unknown) => { events.push({ method, params }); };
    const onText = (text: string) => { summaries.push(text); };
    try {
        const started = await client.run(options({
            goalCommand: { type: 'set', objective: 'Do the small task' },
            onEvent,
        }));
        assert.equal(started.goal?.tokenBudget, null);
        const setRequest = (fixtureEvents(events, 'fixture/goalRequest') as Array<{ method: string; params: Record<string, unknown> }>)[0];
        assert.deepEqual(setRequest.params, { threadId: started.threadId, objective: 'Do the small task', status: 'active' });

        const beforeDirectCommands = fixtureEvents(events, 'fixture/turnRequest').length;
        const read = await client.run(options({ threadId: started.threadId, goalCommand: { type: 'get' }, onEvent, onText }));
        const paused = await client.run(options({ threadId: started.threadId, goalCommand: { type: 'pause' }, onEvent, onText }));
        const cleared = await client.run(options({ threadId: started.threadId, goalCommand: { type: 'clear' }, onEvent, onText }));
        assert.equal(read.goal?.objective, 'Do the small task');
        assert.equal(paused.goal?.status, 'paused');
        assert.equal(cleared.goal, null);
        for (const result of [read, paused, cleared]) {
            assert.equal(Object.hasOwn(result, 'turnId'), false);
            assert.equal(Object.hasOwn(result, 'usage'), false);
        }
        assert.equal(fixtureEvents(events, 'fixture/turnRequest').length, beforeDirectCommands);
        assert.match(summaries[0], /目标状态/);
        assert.match(summaries[1], /目标已暂停/);
        assert.match(summaries[2], /目标已清除/);
    } finally {
        await client.close();
    }
});

test('pauseGoal only changes active goals and preserves completed goals', async t => {
    await t.test('active goals are paused once', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'codex-app-server-pause-goal-'));
        const recordFile = join(directory, 'requests.jsonl');
        const client = new CodexAppServer(settings({ recordFile }));
        const events: Array<{ method: string; params: unknown }> = [];
        const onEvent = (method: string, params: unknown) => { events.push({ method, params }); };
        try {
            const started = await client.run(options({ goalCommand: { type: 'set', objective: 'Pause me' }, onEvent }));
            assert.equal(started.goal?.status, 'active');
            assert.equal((await client.pauseGoal(started.threadId))?.status, 'paused');
            assert.equal((await client.pauseGoal(started.threadId))?.status, 'paused');
            const requests = recordedGoalRequests(recordFile);
            assert.deepEqual(requests.map(request => request.method), [
                'thread/goal/set', 'thread/goal/get', 'thread/goal/get', 'thread/goal/set', 'thread/goal/get',
            ]);
            assert.deepEqual(requests[3].params, { threadId: started.threadId, status: 'paused' });
        } finally {
            await client.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });

    await t.test('completed goals are read but not changed', async () => {
        const directory = mkdtempSync(join(tmpdir(), 'codex-app-server-pause-complete-goal-'));
        const recordFile = join(directory, 'requests.jsonl');
        const client = new CodexAppServer(settings({ goalCompletionStatus: 'complete', recordFile }));
        const events: Array<{ method: string; params: unknown }> = [];
        const onEvent = (method: string, params: unknown) => { events.push({ method, params }); };
        try {
            const started = await client.run(options({ goalCommand: { type: 'set', objective: 'Already done' }, onEvent }));
            assert.equal(started.goal?.status, 'complete');
            assert.equal((await client.pauseGoal(started.threadId))?.status, 'complete');
            const requests = recordedGoalRequests(recordFile);
            assert.deepEqual(requests.map(request => request.method), ['thread/goal/set', 'thread/goal/get', 'thread/goal/get']);
        } finally {
            await client.close();
            rmSync(directory, { recursive: true, force: true });
        }
    });
});

test('goal responses are validated and unsupported methods are explicit', async t => {
    for (const [scenario, command] of [
        [{ goalWrongThread: true }, { type: 'set', objective: 'wrong thread' }],
        [{ goalUnknownStatus: true }, { type: 'set', objective: 'unknown status' }],
        [{ goalInvalidCounter: true }, { type: 'set', objective: 'invalid counters' }],
    ] as const) {
        await t.test(`rejects malformed goal response ${JSON.stringify(scenario)}`, async () => {
            const client = new CodexAppServer(settings(scenario));
            try {
                await assert.rejects(client.run(options({ goalCommand: command })), /thread goal response is invalid/);
            } finally {
                await dispose(client);
            }
        });
    }
    await t.test('method-not-found reports the unsupported native method', async () => {
        const client = new CodexAppServer(settings({ unsupportedGoalMethod: 'thread/goal/get' }));
        try {
            await assert.rejects(client.run(options({ goalCommand: { type: 'get' } })), /does not support method \(thread\/goal\/get\)/);
        } finally {
            await dispose(client);
        }
    });
});

test('cancellation during a goal RPC never starts a model turn', async () => {
    const controller = new AbortController();
    const client = new CodexAppServer(settings({ goalResponseDelayMs: 100 }));
    const events: Array<{ method: string; params: unknown }> = [];
    const run = client.run(options({
        signal: controller.signal,
        goalCommand: { type: 'set', objective: 'Cancel before turn' },
        onEvent: (method, params) => { events.push({ method, params }); },
    }));
    const timer = setTimeout(() => controller.abort(), 20);
    try {
        await assert.rejects(run, error => error instanceof Error && error.name === 'AbortError');
        assert.equal(fixtureEvents(events, 'fixture/turnRequest').length, 0);
    } finally {
        clearTimeout(timer);
        await dispose(client);
    }
});

test('plan user-input requests preserve identity, await answers, and redact secret answers', async () => {
    const secretValue = 'fixture-secret-answer';
    const client = new CodexAppServer(settings({
        userInputBeforeTurnStartResponse: true,
        userInputRequest: {
            itemStarted: true,
            questions: [
                { id: 'choice', header: 'Choice', question: 'Pick one.', options: [{ label: 'A', description: 'Option A' }] },
                { id: 'secret', header: 'Private', question: 'Enter the private value.', isSecret: true },
            ],
        },
    }));
    const events: Array<{ method: string; params: unknown }> = [];
    const associations: Array<{ threadId: string; turnId?: string }> = [];
    let callbackQuestions: NativeUserQuestion[] = [];
    try {
        const result = await client.run(options({
            mode: 'plan',
            collaborationMode: 'plan',
            requestUserInput: async (questions, identity) => {
                callbackQuestions = questions;
                assert.deepEqual(identity, { threadId: 'thread-fixture', turnId: 'turn-fixture', itemId: 'item-user-input' });
                return { choice: { answers: ['A'] }, secret: { answers: [secretValue] } };
            },
            onEvent: (method, params) => { events.push({ method, params }); },
            onThread: (threadId, turnId) => { associations.push({ threadId, ...(turnId ? { turnId } : {}) }); },
        }));
        assert.equal(result.status, 'completed');
        assert.equal(callbackQuestions.length, 2);
        assert.deepEqual(callbackQuestions[0].options, [{ label: 'A', description: 'Option A' }]);
        const [response] = fixtureEvents(events, 'fixture/userInputResponse') as Array<{ result: { answers: Record<string, { answers: string[] }> } }>;
        assert.deepEqual(response.result.answers.choice, { answers: ['A'] });
        assert.deepEqual(response.result.answers.secret, { answers: ['[REDACTED]'] });
        assert.equal(JSON.stringify(events).includes(secretValue), false);
        assert.ok(associations.some(value => value.threadId === 'thread-fixture' && value.turnId === 'turn-fixture'));
    } finally {
        await client.close();
    }
});

test('user-input server requests validate thread and turn identity without requiring an active item match', async t => {
    await t.test('an unrelated active item does not block a valid question request', async () => {
        const client = new CodexAppServer(settings({
            userInputRequest: { itemStarted: true, requestItemId: 'other-item' },
        }));
        const events: Array<{ method: string; params: unknown }> = [];
        let callbackCalls = 0;
        try {
            await client.run(options({
                requestUserInput: async (_questions, identity) => {
                    callbackCalls += 1;
                    assert.equal(identity.itemId, 'other-item');
                    return { choice: { answers: ['accepted'] } };
                },
                onEvent: (method, params) => { events.push({ method, params }); },
            }));
            const [response] = fixtureEvents(events, 'fixture/userInputResponse') as Array<{ error?: { code: number } }>;
            assert.equal(response.error, undefined);
            assert.equal(callbackCalls, 1);
        } finally {
            await dispose(client);
        }
    });

    await t.test('a mismatched thread identity is rejected without calling the callback', async () => {
        const client = new CodexAppServer(settings({ userInputRequest: { threadId: 'other-thread' } }));
        const events: Array<{ method: string; params: unknown }> = [];
        let callbackCalls = 0;
        try {
            await client.run(options({
                requestUserInput: async () => { callbackCalls += 1; return { choice: { answers: ['unexpected'] } }; },
                onEvent: (method, params) => { events.push({ method, params }); },
            }));
            const [response] = fixtureEvents(events, 'fixture/userInputResponse') as Array<{ error?: { code: number } }>;
            assert.equal(response.error?.code, -32602);
            assert.equal(callbackCalls, 0);
        } finally {
            await dispose(client);
        }
    });

    await t.test('abort releases a pending callback with empty answers', async () => {
        const controller = new AbortController();
        const client = new CodexAppServer(settings({ cancel: true, userInputRequest: {} }));
        const events: Array<{ method: string; params: unknown }> = [];
        try {
            await assert.rejects(client.run(options({
                signal: controller.signal,
                requestUserInput: async () => {
                    controller.abort();
                    return new Promise(() => undefined);
                },
                onEvent: (method, params) => { events.push({ method, params }); },
            })), error => error instanceof Error && error.name === 'AbortError');
            const [response] = fixtureEvents(events, 'fixture/userInputResponse') as Array<{ result: { answers: Record<string, unknown> } }>;
            assert.deepEqual(response.result.answers, {});
        } finally {
            await dispose(client);
        }
    });
});

test('readonly approval requests are denied without consulting the host callback', async () => {
    const client = new CodexAppServer(settings({ approval: true, recordApproval: true }));
    let approveCalls = 0;
    const recorded: unknown[] = [];
    try {
        const result = await client.run(options({
            mode: 'readonly',
            onEvent: (method, params) => { if (method === 'fixture/approval') recorded.push(params); },
            approve: async () => { approveCalls += 1; return true; },
        }));
        assert.equal(result.status, 'completed');
        assert.equal(approveCalls, 0);
        assert.deepEqual(recorded, [{ allowed: false, summary: 'Codex requests approval to run a command.' }]);
    } finally {
        await client.close();
    }
});

test('manual approval is awaited and maps to the actual command-approval response', async () => {
    const client = new CodexAppServer(settings({ approval: true, recordApproval: true }));
    let resolved = false;
    const recorded: unknown[] = [];
    try {
        const result = await client.run(options({
            approve: async (summary, resource) => {
                assert.match(summary, /echo fixture/);
                assert.equal(resource, process.cwd());
                await new Promise(resolve => setTimeout(resolve, 15));
                resolved = true;
                return true;
            },
            onEvent: (method, params) => { if (method === 'fixture/approval') recorded.push(params); },
        }));
        assert.equal(result.status, 'completed');
        assert.equal(resolved, true);
        assert.deepEqual(recorded, [{ allowed: true, summary: 'Codex requests approval to run a command.' }]);
    } finally {
        await client.close();
    }
});

test('unknown server requests are explicitly rejected and surfaced raw', async () => {
    const client = new CodexAppServer(settings({ unknownRequest: true }));
    const responseErrors: unknown[] = [];
    try {
        const result = await client.run(options({
            onEvent: (method, params) => { if (method === 'fixture/serverRequestResponse') responseErrors.push(params); },
        }));
        assert.equal(result.status, 'completed');
        assert.deepEqual(responseErrors, [{ error: { code: -32601, message: 'Unsupported server request.' } }]);
    } finally {
        await client.close();
    }
});

test('native spawn_agent tool requests are rejected without UAH approval or dynamic-tool registration', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-app-server-native-tool-call-'));
    const requestMethod = 'item/tool/call';
    const requestParams = {
        threadId: 'thread-fixture', turnId: 'turn-fixture', callId: 'unsupported-spawn-call', tool: 'spawn_agent',
        arguments: { task: 'delegate this task', cwd: process.cwd() },
    };
    const scenario = {
        unknownRequest: true,
        recordFile: join(directory, 'requests.jsonl'),
        requestMethod,
        requestParams,
    };
    const client = new CodexAppServer(settings(scenario));
    let approvalCalls = 0;
    const events: Array<{ method: string; params: unknown }> = [];
    try {
        try {
            const first = await client.run(options({
                onEvent: (method, params) => { events.push({ method, params }); },
                approve: async () => { approvalCalls += 1; return true; },
            }));
            const second = await client.run(options({
                threadId: first.threadId,
                onEvent: (method, params) => { events.push({ method, params }); },
                approve: async () => { approvalCalls += 1; return true; },
            }));
            assert.equal(first.status, 'completed');
            assert.equal(second.status, 'completed');
            assert.equal(approvalCalls, 0);

            const requestMethods = events.filter(event => event.method === 'fixture/serverRequestResponse');
            assert.equal(requestMethods.length, 2);
            assert.deepEqual(requestMethods.map(event => event.params), [
                { error: { code: -32601, message: 'Unknown dynamic tool.' } },
                { error: { code: -32601, message: 'Unknown dynamic tool.' } },
            ]);
            assert.ok(events.some(event => event.method === requestMethod && JSON.stringify(event.params) === JSON.stringify(requestParams)));
        } finally {
            await dispose(client);
        }

        const raw = readFileSync(scenario.recordFile, 'utf8').split(/\r?\n/).filter(Boolean)
            .map(line => JSON.parse(line) as Record<string, unknown>);
        const nativeCall = raw.find(record => record.direction === 'server' && record.method === requestMethod);
        assert.ok(nativeCall);
        assert.deepEqual(nativeCall.params, requestParams);
        const rejectionResponses = raw.filter(record => record.direction === 'client-response');
        assert.equal(rejectionResponses.length, 2);
        assert.deepEqual(rejectionResponses.map(record => record.error), [
            { code: -32601, message: 'Unknown dynamic tool.' },
            { code: -32601, message: 'Unknown dynamic tool.' },
        ]);
        const threadRequests = raw.filter(record => record.direction === 'client' && ['thread/start', 'thread/resume'].includes(String(record.method)));
        assert.deepEqual(threadRequests.map(record => record.method), ['thread/start', 'thread/resume']);
        for (const request of threadRequests) {
            const params = request.params as Record<string, unknown>;
            assert.equal(Object.hasOwn(params, 'dynamicTools'), false);
            const serialized = JSON.stringify(params);
            assert.equal(serialized.includes('spawn_agent'), false);
            assert.equal(serialized.includes('wait_agents'), false);
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('dynamic tool definitions are registered on thread/start and omitted from thread/resume', async () => {
    const client = new CodexAppServer(settings());
    const events: Array<{ method: string; params: unknown }> = [];
    try {
        const first = await client.run(options({
            dynamicTools: [echoTool],
            callTool: async () => ({ content: 'unused' }),
            onEvent: (method, params) => { events.push({ method, params }); },
        }));
        await client.run(options({
            threadId: first.threadId,
            dynamicTools: [echoTool],
            callTool: async () => ({ content: 'unused' }),
            onEvent: (method, params) => { events.push({ method, params }); },
        }));

        const requests = fixtureEvents(events, 'fixture/threadRequest') as Array<Record<string, unknown>>;
        assert.deepEqual(requests.map(request => request.dynamicTools), [[{
            type: 'function', name: 'echo', description: 'Return the supplied value.', inputSchema: echoTool.inputSchema,
        }], undefined]);
    } finally {
        await client.close();
    }
});

test('dynamic tool calls bind early turn identity, match the schema, and drain before run returns', async () => {
    const client = new CodexAppServer(settings(dynamicScenario([
        { tool: 'echo', callId: 'echo-1', arguments: { value: 'hello' } },
    ], { dynamicCallsBeforeTurnStartResponse: true, completeBeforeDynamicResponses: true })));
    const events: Array<{ method: string; params: unknown }> = [];
    const order: string[] = [];
    let toolIdentity: unknown;
    try {
        const result = await client.run(options({
            input: 'PARENT_BRIDGE: call echo',
            dynamicTools: [echoTool],
            callTool: async (name, args, identity) => {
                order.push('tool-start');
                toolIdentity = { name, args, identity };
                await new Promise(resolve => setTimeout(resolve, 20));
                order.push('tool-finish');
                return { content: 'hello from callback' };
            },
            onEvent: (method, params) => {
                events.push({ method, params });
                if (method === 'fixture/dynamicToolResponse') order.push('server-response');
            },
            onThread: (_threadId, turnId) => { if (turnId) order.push('thread-turn'); },
        }));
        order.push('run-return');

        assert.equal(result.status, 'completed');
        assert.deepEqual(toolIdentity, {
            name: 'echo', args: { value: 'hello' },
            identity: { threadId: 'thread-fixture', turnId: 'turn-fixture', callId: 'echo-1' },
        });
        assert.ok(order.indexOf('tool-finish') < order.indexOf('run-return'));
    } finally {
        await client.close();
    }
});

test('dynamic calls deduplicate matching call IDs and reject conflicting reuse', async t => {
    await t.test('same arguments share the pending and completed result', async () => {
        const client = new CodexAppServer(settings(dynamicScenario([
            { tool: 'echo', callId: 'same-id', arguments: { value: 'same', nested: { a: 1, b: 2 } } },
            { tool: 'echo', callId: 'same-id', arguments: { nested: { b: 2, a: 1 }, value: 'same' } },
        ])));
        const events: Array<{ method: string; params: unknown }> = [];
        let calls = 0;
        try {
            await client.run(options({
                input: 'PARENT_BRIDGE: deduplicate',
                dynamicTools: [echoTool],
                callTool: async () => {
                    calls += 1;
                    await new Promise(resolve => setTimeout(resolve, 15));
                    return { content: 'shared result' };
                },
                onEvent: (method, params) => { events.push({ method, params }); },
            }));
            const responses = fixtureEvents(events, 'fixture/dynamicToolResponse') as Array<Record<string, unknown>>;
            assert.equal(calls, 1);
            assert.equal(responses.length, 2);
            assert.deepEqual(responses[0].result, responses[1].result);
            assert.deepEqual(responses[0].result, {
                contentItems: [{ type: 'inputText', text: 'shared result' }], success: true,
            });
        } finally {
            await client.close();
        }
    });

    await t.test('same call ID with different arguments is invalid parameters', async () => {
        const client = new CodexAppServer(settings(dynamicScenario([
            { tool: 'echo', callId: 'same-id', arguments: { value: 'first' } },
            { tool: 'echo', callId: 'same-id', arguments: { value: 'second' } },
        ])));
        const events: Array<{ method: string; params: unknown }> = [];
        let calls = 0;
        try {
            await client.run(options({
                input: 'PARENT_BRIDGE: conflicting IDs',
                dynamicTools: [echoTool],
                callTool: async () => { calls += 1; return { content: 'first result' }; },
                onEvent: (method, params) => { events.push({ method, params }); },
            }));
            const responses = fixtureEvents(events, 'fixture/dynamicToolResponse') as Array<Record<string, unknown>>;
            assert.equal(calls, 1);
            assert.equal(responses.length, 2);
            assert.equal((responses[1].error as Record<string, unknown>).code, -32602);
        } finally {
            await client.close();
        }
    });
});

test('dynamic calls reject unknown tools and mismatched thread or turn identities', async () => {
    const client = new CodexAppServer(settings(dynamicScenario([
        { tool: 'missing', callId: 'unknown-tool', arguments: {} },
        { tool: 'echo', callId: 'wrong-thread', threadId: 'other-thread', arguments: {} },
        { tool: 'echo', callId: 'wrong-turn', turnId: 'old-turn', arguments: {} },
    ])));
    const events: Array<{ method: string; params: unknown }> = [];
    let calls = 0;
    try {
        await client.run(options({
            input: 'PARENT_BRIDGE: reject invalid calls',
            dynamicTools: [echoTool],
            callTool: async () => { calls += 1; return { content: 'should not dispatch' }; },
            onEvent: (method, params) => { events.push({ method, params }); },
        }));
        const responses = fixtureEvents(events, 'fixture/dynamicToolResponse') as Array<Record<string, unknown>>;
        assert.equal(calls, 0);
        assert.deepEqual(responses.map(response => (response.error as Record<string, unknown>)?.code), [-32601, -32602, -32602]);
    } finally {
        await client.close();
    }
});

test('dynamic callback failures and unavailable handlers return generic schema results', async t => {
    await t.test('callback exceptions do not expose their contents', async () => {
        const client = new CodexAppServer(settings(dynamicScenario([
            { tool: 'echo', callId: 'throwing', arguments: { value: 'secret' } },
        ])));
        const events: Array<{ method: string; params: unknown }> = [];
        try {
            await client.run(options({
                input: 'PARENT_BRIDGE: callback error',
                dynamicTools: [echoTool],
                callTool: async () => { throw new Error('credential should not escape'); },
                onEvent: (method, params) => { events.push({ method, params }); },
            }));
            const [response] = fixtureEvents(events, 'fixture/dynamicToolResponse') as Array<Record<string, unknown>>;
            const result = response.result as Record<string, unknown>;
            assert.equal(result.success, false);
            assert.equal((result.contentItems as Array<Record<string, unknown>>)[0].text, 'The dynamic tool call could not be completed.');
            assert.equal(JSON.stringify(response).includes('credential'), false);
        } finally {
            await client.close();
        }
    });

    await t.test('registered tools fail closed when no callback is installed', async () => {
        const client = new CodexAppServer(settings(dynamicScenario([
            { tool: 'echo', callId: 'unavailable', arguments: { value: 'secret' } },
        ])));
        const events: Array<{ method: string; params: unknown }> = [];
        try {
            await client.run(options({
                input: 'PARENT_BRIDGE: no callback',
                dynamicTools: [echoTool],
                onEvent: (method, params) => { events.push({ method, params }); },
            }));
            const [response] = fixtureEvents(events, 'fixture/dynamicToolResponse') as Array<Record<string, unknown>>;
            assert.deepEqual(response.result, {
                contentItems: [{ type: 'inputText', text: 'The dynamic tool call could not be completed.' }], success: false,
            });
        } finally {
            await client.close();
        }
    });
});

test('dynamic tool output is truncated within 128 KiB and abort releases a pending call', async t => {
    await t.test('large output has an explicit UTF-8-safe truncation marker', async () => {
        const client = new CodexAppServer(settings(dynamicScenario([
            { tool: 'echo', callId: 'large-output', arguments: {} },
        ])));
        const events: Array<{ method: string; params: unknown }> = [];
        try {
            await client.run(options({
                input: 'PARENT_BRIDGE: large output',
                dynamicTools: [echoTool],
                callTool: async () => ({ content: '中'.repeat(60_000) }),
                onEvent: (method, params) => { events.push({ method, params }); },
            }));
            const [response] = fixtureEvents(events, 'fixture/dynamicToolResponse') as Array<Record<string, unknown>>;
            const result = response.result as { contentItems: Array<{ text: string }> };
            const text = result.contentItems[0].text;
            assert.ok(Buffer.byteLength(text, 'utf8') <= 128 * 1024);
            assert.ok(text.endsWith('[Output truncated: exceeded 128 KiB.]'));
        } finally {
            await client.close();
        }
    });

    await t.test('abort returns a failure response and the run rejects without waiting forever', async () => {
        const controller = new AbortController();
        const client = new CodexAppServer(settings(dynamicScenario([
            { tool: 'echo', callId: 'pending-call', arguments: {} },
        ], { cancel: true })));
        const events: Array<{ method: string; params: unknown }> = [];
        try {
            await assert.rejects(client.run(options({
                input: 'PARENT_BRIDGE: cancel pending tool',
                signal: controller.signal,
                dynamicTools: [echoTool],
                callTool: async () => {
                    controller.abort();
                    return new Promise(() => undefined);
                },
                onEvent: (method, params) => { events.push({ method, params }); },
            })), error => error instanceof Error && error.name === 'AbortError');
        } finally {
            await dispose(client);
        }
    });
});

test('abort interrupts the matching thread turn and rejects only after interrupted completion', async () => {
    const client = new CodexAppServer(settings({ cancel: true }));
    const controller = new AbortController();
    try {
        await assert.rejects(client.run(options({
            signal: controller.signal,
            onThread: (_threadId, turnId) => { if (turnId) controller.abort(); },
        })), error => error instanceof Error && error.name === 'AbortError');
    } finally {
        await client.close();
    }
});

test('EOF before turn/completed is an ordinary unconfirmed failure', async () => {
    const client = new CodexAppServer(settings({ eofOnTurnStart: true }));
    try {
        await assert.rejects(client.run(options()), error => error instanceof Error && error.name !== 'AbortError');
    } finally {
        await dispose(client);
    }
});

test('malformed JSON, unknown response IDs, and duplicate response IDs fail closed', async (t) => {
    await t.test('bad JSONL', async () => {
        const client = new CodexAppServer(settings({ badLine: true }));
        try {
            await assert.rejects(client.probe(), /invalid UTF-8 JSON/);
        } finally {
            await dispose(client);
        }
    });
    await t.test('unknown response ID', async () => {
        const client = new CodexAppServer(settings({ unknownResponse: true }));
        try {
            await assert.rejects(client.probe(), /unknown or duplicate id/);
        } finally {
            await dispose(client);
        }
    });
    await t.test('duplicate response ID', async () => {
        const client = new CodexAppServer(settings({ duplicateResponse: true }));
        try {
            await assert.rejects(client.probe(), /unknown or duplicate id/);
        } finally {
            await dispose(client);
        }
    });
});

test('a completed turn with an unknown terminal status is not returned as completed', async () => {
    const client = new CodexAppServer(settings({ unknownTerminal: true }));
    try {
        await assert.rejects(client.run(options()), /unknown terminal status/);
    } finally {
        await dispose(client);
    }
});
