import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { ApprovalIdentity, ApprovalRecord, RunRecord, Snapshot } from '../../src/shared/contracts.js';
import { defaultAgentSettings, type AgentSettings } from '../../src/shared/agents.js';
import { NATIVE_CODEX_ENDPOINT_ID } from '../../src/shared/native-codex.js';
import type { ExtensionRuntimeBundle } from '../../src/shared/extension-runtime.js';
import type { ResolvedConnector } from '../../src/shared/extensions.js';
import type { SessionControls } from '../../src/shared/session-controls.js';
import { Supervisor } from '../../src/runtime/supervisor.js';
import { validateTranscript, replayTranscript } from '../../src/runtime/transcript-offline.js';

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'codex-app-server-fixture.mjs');

interface NativeHarness {
    root: string;
    dataDirectory: string;
    projectDirectory: string;
    recordFile: string;
    supervisor: Supervisor;
    events: unknown[];
    bundle: ExtensionRuntimeBundle;
    setBundle(bundle: ExtensionRuntimeBundle): void;
    setAgentSettings(settings: AgentSettings | undefined): void;
}

function connector(id: string): ResolvedConnector {
    return {
        id, name: id, transport: 'stdio', command: process.execPath, args: [fixturePath], url: '',
        enabled: true, revision: 1, hasSecrets: false, secrets: {},
    };
}

function createHarness(scenario: Record<string, unknown> = {}): NativeHarness {
    const root = mkdtempSync(join(tmpdir(), 'uah-native-loop-test-'));
    const dataDirectory = join(root, 'data');
    const projectDirectory = join(root, 'project');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    const recordFile = join(root, 'app-server.jsonl');
    const defaultSettings = defaultAgentSettings();
    const disabledSettings = { ...defaultSettings, subagents: { ...defaultSettings.subagents, enabled: false } };
    const bundle: ExtensionRuntimeBundle = {
        connectors: [], skills: [],
        native: {
            enabled: true,
            command: process.execPath,
            args: [fixturePath, JSON.stringify({ ...scenario, recordFile })],
            model: 'gpt-fixture',
            revision: 1,
        },
    };
    const events: unknown[] = [];
    let currentBundle = bundle;
    let currentAgentSettings: AgentSettings = disabledSettings;
    const supervisor = new Supervisor({
        dataDirectory,
        resolveExtensions: async () => structuredClone(currentBundle),
        getAgentSettings: () => currentAgentSettings,
        onEvent: event => events.push(event),
        delayMs: 0,
    });
    return {
        root, dataDirectory, projectDirectory, recordFile, supervisor, events, bundle,
        setBundle(next) { currentBundle = next; },
        setAgentSettings(next) { currentAgentSettings = next ? structuredClone(next) : disabledSettings; },
    };
}

function cleanupHarness(harness: NativeHarness): void {
    const target = resolve(harness.root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-native-loop-test-')) {
        throw new Error(`Refusing to recursively remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

async function createNativeSession(harness: NativeHarness, controls?: SessionControls): Promise<string> {
    const snapshot = await harness.supervisor.execute({
        type: 'create-session',
        title: 'Native Codex fixture',
        directory: harness.projectDirectory,
        selection: { endpointId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture' },
        ...(controls ? { controls } : {}),
    });
    const session = snapshot.sessions.at(-1);
    assert.ok(session);
    assert.equal(session.requested.runtimeId, 'codex-native');
    return session.id;
}

async function waitForSnapshot(
    supervisor: Supervisor,
    predicate: (snapshot: Snapshot) => boolean,
    timeoutMs = 5_000,
): Promise<Snapshot> {
    const end = Date.now() + timeoutMs;
    let latest = await supervisor.execute({ type: 'snapshot' });
    while (!predicate(latest) && Date.now() < end) {
        await delay(10);
        latest = await supervisor.execute({ type: 'snapshot' });
    }
    assert.equal(predicate(latest), true, 'snapshot did not reach the expected state');
    return latest;
}

function getRun(snapshot: Snapshot, runId: string): RunRecord {
    const run = snapshot.runs.find(item => item.id === runId);
    assert.ok(run, `run ${runId} should exist`);
    return run;
}

async function startAndWait(
    supervisor: Supervisor,
    sessionId: string,
    input: string,
    expectedState: RunRecord['state'] = 'completed',
): Promise<RunRecord> {
    const started = await supervisor.execute({ type: 'start-run', sessionId, input });
    const run = started.runs.at(-1);
    assert.ok(run);
    const final = await waitForSnapshot(supervisor, snapshot => snapshot.runs.some(item => item.id === run.id && item.state === expectedState));
    return getRun(final, run.id);
}

async function waitForThreadReplacement(harness: NativeHarness, sessionId: string, input: string): Promise<{ runId: string; question: NonNullable<RunRecord['nativeQuestions']>[number] }> {
    const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input });
    const runId = started.runs.at(-1)!.id;
    const pending = await waitForSnapshot(harness.supervisor, snapshot => Boolean(snapshot.runs.find(run => run.id === runId)?.nativeQuestions?.some(item => item.id === 'question:thread-replacement' && item.status === 'pending')));
    const question = getRun(pending, runId).nativeQuestions!.find(item => item.id === 'question:thread-replacement')!;
    return { runId, question };
}

async function answerThreadReplacement(harness: NativeHarness, runId: string, questionId: string, answer: string): Promise<void> {
    await harness.supervisor.execute({
        type: 'answer-native-question', runId, questionId,
        answers: { 'confirm-thread-replacement': { answers: [answer] } },
    });
}

function records(harness: NativeHarness): Array<Record<string, unknown>> {
    try {
        return readFileSync(harness.recordFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

function exportedText(directory: string): string {
    return readdirSync(directory, { withFileTypes: true }).map(entry => {
        const path = join(directory, entry.name);
        return entry.isDirectory() ? exportedText(path) : readFileSync(path).toString('utf8');
    }).join('\n');
}

function approvalIdentity(approval: ApprovalRecord): ApprovalIdentity {
    return {
        runtimeId: approval.runtimeId,
        sessionId: approval.sessionId,
        runId: approval.runId,
        turnId: approval.turnId,
        requestId: approval.requestId,
        policyVersion: approval.policyVersion,
    };
}

test('Supervisor creates native sessions, persists native ids, and keeps only observed per-turn usage fields', async () => {
    const harness = createHarness({ usageLast: { inputTokens: 11, outputTokens: 7 } });
    try {
        const sessionId = await createNativeSession(harness);
        const run = await startAndWait(harness.supervisor, sessionId, 'Return one fixture response.');
        assert.equal(run.state, 'completed');
        assert.equal(run.native?.threadId, 'thread-fixture');
        assert.equal(run.native?.turnId, 'turn-fixture');
        assert.deepEqual(run.native?.usage, { inputTokens: 11, outputTokens: 7 });
        assert.equal(run.native?.revision, 1);
        assert.ok(run.native?.configFingerprint);
        assert.equal(Boolean(run.nativeQuestions?.some(item => item.id === 'question:thread-replacement')), false);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('native activity projections stream public summaries and command output without stale turns or secret fragments', async () => {
    const secret = 'API-SECRET-DO-NOT-LEAK';
    const harness = createHarness({
        nativeActivityEvents: {
            inputMatch: 'ACTIVITY_FIXTURE',
            wrongTurnReasoningDelta: 'stale private activity',
            reasoning: {
                summary: [`Planning with ${secret} then done.`],
                deltas: ['Planning with API-SEC', 'RET-DO-NOT-', 'LEAK then done.'],
                content: [{ type: 'reasoning_text', text: 'PRIVATE THOUGHT BODY' }],
                encrypted_content: 'ENCRYPTED REASONING BODY',
            },
            command: { command: 'echo fixture', cwd: 'D:/UAH', outputDeltas: [`output ${secret}`], aggregatedOutput: `output ${secret}`, exitCode: 0 },
            mcpToolCall: { server: 'docs', tool: 'search', arguments: { query: 'schema' }, resultText: 'Found two pages.' },
        },
    });
    harness.bundle.connectors.push({ ...connector('secret-source'), secrets: { api_key: secret }, hasSecrets: true });
    try {
        const sessionId = await createNativeSession(harness);
        const run = await startAndWait(harness.supervisor, sessionId, 'ACTIVITY_FIXTURE project native activity.');
        const byId = (id: string) => run.activities?.find(item => item.id === id);
        const reasoning = byId('native:item-reasoning-fixture');
        assert.equal(reasoning?.kind, 'reasoning');
        assert.equal(reasoning?.content, 'Planning with [REDACTED] then done.');
        assert.ok(!reasoning?.content.includes('PRIVATE'));
        assert.ok(!reasoning?.content.includes('ENCRYPTED'));
        assert.ok(!run.activities?.some(item => item.id === 'native:item-wrong-turn'));

        const command = byId('native:item-command-fixture');
        assert.equal(command?.tool?.name, 'native:commandExecution');
        assert.deepEqual(command?.tool?.arguments, { command: 'echo fixture', cwd: 'D:/UAH' });
        assert.equal(command?.tool?.result, 'output [REDACTED]\n退出代码：0');
        assert.equal(byId('native:item-mcp-fixture')?.tool?.result, 'Found two pages.');
        const reasoningDeltas = harness.events.map(event => event as any).filter(event => event?.type === 'activity-delta' && event.payload?.activityId === 'native:item-reasoning-fixture');
        assert.ok(reasoningDeltas.length > 0, 'the public reasoning summary should stream before completion');
        assert.ok(reasoningDeltas.every(event => !String(event.payload.text).includes(secret)));

        const journal = exportedText(harness.dataDirectory);
        assert.ok(!journal.includes(secret));
        assert.ok(!journal.includes('PRIVATE THOUGHT BODY'));
        assert.ok(!journal.includes('ENCRYPTED REASONING BODY'));
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('native regenerate is rejected and cannot create a second run', async () => {
    const harness = createHarness();
    try {
        const sessionId = await createNativeSession(harness);
        const run = await startAndWait(harness.supervisor, sessionId, 'Complete once.');
        await assert.rejects(harness.supervisor.execute({ type: 'regenerate-run', runId: run.id }), /原生运行时的工具记录覆盖不完整/);
        const snapshot = await harness.supervisor.execute({ type: 'snapshot' });
        assert.deepEqual(snapshot.runs.filter(item => item.sessionId === sessionId).map(item => item.id), [run.id]);
        assert.deepEqual(records(harness).filter(record => record.direction === 'client' && record.method === 'turn/start').length, 1);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('a model change resumes the same native thread and sends the selected model; export remains partial and recognizes native.event', async () => {
    const secret = 'Bearer bundle-http-secret-4731';
    const harness = createHarness({ textChunks: ['Prefix ', 'Bearer bundle-http-', 'secret-4731 suffix'] });
    try {
        const bundle = structuredClone(harness.bundle);
        bundle.connectors = [{
            id: 'http-secret', name: 'HTTP fixture', transport: 'http', command: '', args: [], url: 'https://fixture.invalid/mcp',
            enabled: true, revision: 1, hasSecrets: true, secrets: { Authorization: secret },
        }];
        harness.setBundle(bundle);
        const sessionId = await createNativeSession(harness);
        const first = await startAndWait(harness.supervisor, sessionId, 'First model turn.');
        assert.equal(first.output.includes(secret), false);

        const secondStart = await harness.supervisor.execute({
            type: 'start-run', sessionId, input: 'Use the changed model.',
            selection: { endpointId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-next' },
        });
        const second = secondStart.runs.at(-1);
        assert.ok(second);
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(item => item.id === second.id && item.state === 'completed'));
        const completed = getRun(final, second.id);
        assert.equal(completed.effective.modelId, 'gpt-next');
        assert.equal(Boolean(completed.nativeQuestions?.some(item => item.id === 'question:thread-replacement')), false);

        const requests = records(harness).filter(record => record.direction === 'client');
        const resume = requests.find(record => record.method === 'thread/resume');
        assert.ok(resume, 'the compatible native thread should be resumed');
        assert.equal((resume.params as Record<string, unknown>).model, 'gpt-next');
        const turnStarts = requests.filter(record => record.method === 'turn/start');
        assert.equal(turnStarts.length, 2);
        assert.equal((turnStarts.at(-1)!.params as Record<string, unknown>).model, 'gpt-next');

        const allRuns = final.runs.filter(item => item.sessionId === sessionId);
        assert.equal(allRuns[0].output.includes(secret), false);
        assert.equal(completed.output.includes(secret), false);
        const destination = join(harness.root, 'native-full-export');
        harness.supervisor.journalExport(sessionId, destination, 'full');
        const validation = validateTranscript(destination);
        assert.equal(validation.partial, true);
        assert.equal(validation.warnings.includes('unknown_event:native.event'), false);
        const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as { captureCoverage: string };
        assert.equal(manifest.captureCoverage, 'partial');
        const exported = exportedText(destination);
        assert.match(exported, /"type":"native\.event"/);
        assert.equal(exported.includes(secret), false, 'the exported transcript and artifacts must not contain the connector secret');
        assert.equal(replayTranscript(destination).replies.find(reply => reply.runId === completed.id)?.text, completed.output);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('Supervisor resumes permission changes but creates a new thread when extensions change', async () => {
    const harness = createHarness();
    try {
        const sessionId = await createNativeSession(harness);
        await startAndWait(harness.supervisor, sessionId, 'First fixture turn.');
        await startAndWait(harness.supervisor, sessionId, 'Second fixture turn.');

        await harness.supervisor.execute({
            type: 'set-session-controls', sessionId, revision: 0,
            controls: { permissionMode: 'readonly', reasoningEffort: 'default' },
        });
        await startAndWait(harness.supervisor, sessionId, 'Third fixture turn with a changed mode.');

        const changedBundle = structuredClone(harness.bundle);
        changedBundle.skills = [{ id: 'skill-b', name: 'Changed skill', description: 'different bundle', enabled: true, source: 'fixture', path: 'skills/changed/SKILL.md' }];
        harness.setBundle(changedBundle);
        const replacement = await waitForThreadReplacement(harness, sessionId, 'Fourth fixture turn with a changed extension bundle.');
        assert.equal(replacement.question.questions[0]?.id, 'confirm-thread-replacement');
        assert.match(replacement.question.questions[0]?.question ?? '', /thread-fixture/);
        assert.match(replacement.question.questions[0]?.question ?? '', /技能配置已经改变/);
        assert.deepEqual(replacement.question.questions[0]?.options?.map(option => option.label), ['新建线程并继续', '取消本次发送']);
        assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1,
            'the replacement thread must not start before the user approves');
        await answerThreadReplacement(harness, replacement.runId, replacement.question.id, '新建线程并继续');
        const completed = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(item => item.id === replacement.runId && item.state === 'completed'));
        assert.equal(getRun(completed, replacement.runId).native?.threadId, 'thread-fixture');

        const methods = records(harness)
            .filter(record => record.direction === 'client' && ['thread/start', 'thread/resume'].includes(String(record.method)))
            .map(record => record.method);
        assert.deepEqual(methods, ['thread/start', 'thread/resume', 'thread/resume', 'thread/start']);
        const destination = join(harness.root, 'thread-selection-export');
        harness.supervisor.journalExport(sessionId, destination, 'full');
        const exported = exportedText(destination);
        assert.match(exported, /uah\/thread-selection/);
        assert.match(exported, /tools-or-extensions-changed/);
        assert.match(exported, /no-previous-native-thread/);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('Supervisor routes manual native approval allow and reject decisions to app-server', async (t) => {
    await t.test('approve', async () => {
        const harness = createHarness({ approval: true });
        try {
            const sessionId = await createNativeSession(harness);
            const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Use an approved command.' });
            const run = started.runs.at(-1);
            assert.ok(run);
            const waiting = await waitForSnapshot(harness.supervisor, snapshot => snapshot.approvals.some(item => item.runId === run.id && item.status === 'pending'));
            const pending = waiting.approvals.find(item => item.runId === run.id && item.status === 'pending');
            assert.ok(pending);
            const resolved = await harness.supervisor.execute({ type: 'resolve-approval', identity: approvalIdentity(pending), decision: 'approve' });
            assert.equal(resolved.approvals.find(item => item.requestId === pending.requestId)?.status, 'approved');
            const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(item => item.id === run.id && item.state === 'completed'));
            assert.equal(getRun(final, run.id).state, 'completed');
            const response = records(harness).find(record => record.direction === 'client-response' && record.result && (record.result as Record<string, unknown>).decision === 'accept');
            assert.ok(response, 'app-server should receive the approved decision');
        } finally {
            await harness.supervisor.shutdown();
            cleanupHarness(harness);
        }
    });

    await t.test('reject', async () => {
        const harness = createHarness({ approval: true });
        try {
            const sessionId = await createNativeSession(harness);
            const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Use a rejected command.' });
            const run = started.runs.at(-1);
            assert.ok(run);
            const waiting = await waitForSnapshot(harness.supervisor, snapshot => snapshot.approvals.some(item => item.runId === run.id && item.status === 'pending'));
            const pending = waiting.approvals.find(item => item.runId === run.id && item.status === 'pending');
            assert.ok(pending);
            await harness.supervisor.execute({ type: 'resolve-approval', identity: approvalIdentity(pending), decision: 'reject' });
            const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(item => item.id === run.id && item.state === 'completed'));
            assert.equal(getRun(final, run.id).state, 'completed');
            assert.equal(final.approvals.find(item => item.requestId === pending.requestId)?.status, 'rejected');
            const response = records(harness).find(record => record.direction === 'client-response' && record.result && (record.result as Record<string, unknown>).decision === 'decline');
            assert.ok(response, 'app-server should receive the rejected decision');
        } finally {
            await harness.supervisor.shutdown();
            cleanupHarness(harness);
        }
    });
});

test('Supervisor stop waits for confirmed interrupted completion', async () => {
    const harness = createHarness({ cancel: true });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Stop this fixture turn.' });
        const run = started.runs.at(-1);
        assert.ok(run);
        await waitForSnapshot(harness.supervisor, snapshot => Boolean(snapshot.runs.find(item => item.id === run.id)?.native?.turnId));
        const stopped = await harness.supervisor.execute({ type: 'stop-run', runId: run.id, reason: 'Fixture cancellation test.' });
        const finalRun = getRun(stopped, run.id);
        assert.equal(finalRun.state, 'stopped');
        assert.notEqual(finalRun.harnessState, 'needs_reconciliation');
        assert.ok(records(harness).some(record => record.direction === 'client' && record.method === 'turn/interrupt'));
        assert.ok(records(harness).some(record => record.direction === 'server' && record.method === 'turn/completed'
            && (record.params as Record<string, unknown>)?.turn && ((record.params as Record<string, any>).turn.status === 'interrupted')));
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('failed native terminal status remains failed and needs reconciliation', async () => {
    const harness = createHarness({ initialStatus: 'failed' });
    try {
        const sessionId = await createNativeSession(harness);
        const failed = await startAndWait(harness.supervisor, sessionId, 'This fixture turn fails.', 'failed');
        assert.equal(failed.state, 'failed');
        assert.equal(failed.harnessState, 'needs_reconciliation');
        assert.match(failed.error ?? '', /turn failed/i);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('a new Supervisor marks an unfinished persisted native turn needs_reconciliation', async () => {
    const harness = createHarness({ hold: true });
    let recovered: Supervisor | undefined;
    let activeRunId: string | undefined;
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Leave this fixture turn unfinished.' });
        const run = started.runs.at(-1);
        assert.ok(run);
        activeRunId = run.id;
        await waitForSnapshot(harness.supervisor, snapshot => Boolean(snapshot.runs.find(item => item.id === run.id)?.native?.turnId));

        recovered = new Supervisor({
            dataDirectory: harness.dataDirectory,
            resolveExtensions: async () => structuredClone(harness.bundle),
            onEvent: () => undefined,
            delayMs: 0,
        });
        const restarted = await recovered.execute({ type: 'snapshot' });
        const recoveredRun = getRun(restarted, run.id);
        assert.equal(recoveredRun.state, 'stopped');
        assert.equal(recoveredRun.harnessState, 'needs_reconciliation');
        assert.match(recoveredRun.error ?? '', /没有持久结果|必须核对副作用/);
    } finally {
        if (activeRunId) await harness.supervisor.execute({ type: 'stop-run', runId: activeRunId }).catch(() => undefined);
        await harness.supervisor.shutdown().catch(() => undefined);
        await recovered?.shutdown().catch(() => undefined);
        cleanupHarness(harness);
    }
});


test('native plan command toggles collaboration mode without starting a model or changing permissions', async () => {
    const harness = createHarness();
    try {
        const sessionId = await createNativeSession(harness);
        const first = await startAndWait(harness.supervisor, sessionId, '/plan');
        assert.equal(first.state, 'completed');
        assert.match(first.output, /原生计划模式/);
        assert.equal(records(harness).filter(record => record.method === 'turn/start').length, 0);
        const planned = await startAndWait(harness.supervisor, sessionId, 'Plan the fixture work.');
        assert.equal(planned.effective.permissionMode, 'manual');
        assert.equal(planned.effective.nativeCollaborationMode, 'plan');
        const turn = records(harness).find(record => record.direction === 'client' && record.method === 'turn/start');
        assert.equal((turn?.params as any).collaborationMode.mode, 'plan');
        assert.equal((turn?.params as any).collaborationMode.settings.developer_instructions, null);
        await startAndWait(harness.supervisor, sessionId, '/plan off');
        await startAndWait(harness.supervisor, sessionId, 'Implement the fixture work.');
        const turns = records(harness).filter(record => record.direction === 'client' && record.method === 'turn/start');
        assert.equal((turns.at(-1)?.params as any).collaborationMode.mode, 'default');
        assert.equal(records(harness).filter(record => record.method === 'thread/resume').length, 1);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('native readonly keeps configured MCP while full access uses the native unrestricted sandbox', async () => {
    const harness = createHarness({ effectiveConfig: { mcp_servers: { inherited: { command: 'fixture' } } } });
    try {
        harness.bundle.connectors.push(connector('uah-mcp'));
        const sessionId = await createNativeSession(harness, { permissionMode: 'readonly', reasoningEffort: 'default' });
        await startAndWait(harness.supervisor, sessionId, 'Read with native MCP.');
        const started = records(harness).find(record => record.direction === 'client' && record.method === 'thread/start');
        assert.equal((started?.params as any).config.mcp_servers.uah_mcp.enabled, true);
        assert.equal((started?.params as any).sandbox, 'read-only');
        await harness.supervisor.execute({ type: 'set-session-controls', sessionId, revision: 0, controls: { permissionMode: 'bypass', reasoningEffort: 'default' } });
        await startAndWait(harness.supervisor, sessionId, 'Full access fixture.');
        const turns = records(harness).filter(record => record.direction === 'client' && record.method === 'turn/start');
        assert.equal((turns.at(-1)?.params as any).sandboxPolicy.type, 'dangerFullAccess');
        assert.equal((turns.at(-1)?.params as any).approvalPolicy, 'never');
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});


test('native question cards return user answers and expire after cancellation', async () => {
    const harness = createHarness({ userInputRequest: { reasoningItemStarted: true, questions: [{ id: 'scope', header: 'Scope', question: '选择范围', options: [{ label: 'A', description: '范围 A' }] }] } });
    try {
        const sessionId = await createNativeSession(harness);
        const start = await harness.supervisor.execute({ type: 'start-run', sessionId, input: '/plan Prepare fixture.' });
        const runId = start.runs.at(-1)!.id;
        const pending = await waitForSnapshot(harness.supervisor, state => Boolean(state.runs.find(run => run.id === runId)?.nativeQuestions?.some(item => item.status === 'pending')));
        const question = getRun(pending, runId).nativeQuestions![0]!;
        await assert.rejects(harness.supervisor.execute({ type: 'answer-native-question', runId, questionId: question.id, answers: {} }), /回答所有问题/);
        await harness.supervisor.execute({ type: 'answer-native-question', runId, questionId: question.id, answers: { scope: { answers: ['A'] } } });
        const complete = await waitForSnapshot(harness.supervisor, state => state.runs.some(run => run.id === runId && run.state === 'completed'));
        assert.equal(getRun(complete, runId).nativeQuestions?.[0]?.status, 'answered');
        await assert.rejects(harness.supervisor.execute({ type: 'answer-native-question', runId, questionId: question.id, answers: { scope: { answers: ['A'] } } }), /失效/);
        const second = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Ask again.' });
        const secondId = second.runs.at(-1)!.id;
        await waitForSnapshot(harness.supervisor, state => Boolean(state.runs.find(run => run.id === secondId)?.nativeQuestions?.some(item => item.status === 'pending')));
        await harness.supervisor.execute({ type: 'stop-run', runId: secondId });
        const stopped = await waitForSnapshot(harness.supervisor, state => state.runs.some(run => run.id === secondId && run.state === 'stopped'));
        assert.equal(getRun(stopped, secondId).nativeQuestions?.[0]?.status, 'cancelled');
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('native RPC diagnostics reach failed runs and exports with configured secrets removed', async () => {
    const secret = 'fixture-connector-private-value';
    const harness = createHarness({ rejectMethod: 'thread/start', rpcError: { code: -32001, message: `rollout unavailable: ${secret}` } });
    harness.bundle.connectors.push({ ...connector('diagnostic-secret'), secrets: { api_key: secret }, hasSecrets: true });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Diagnose fixture failure.' });
        const runId = started.runs.at(-1)!.id;
        const failed = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === runId && run.state === 'failed'));
        const message = getRun(failed, runId).error ?? '';
        assert.match(message, /thread\/start/);
        assert.match(message, /-32001/);
        assert.match(message, /rollout unavailable/);
        assert.ok(!message.includes(secret));
        const destination = join(harness.root, 'rpc-error-export');
        harness.supervisor.journalExport(sessionId, destination, 'full');
        const exported = exportedText(destination);
        assert.match(exported, /rollout unavailable/);
        assert.ok(!exported.includes(secret));
    } finally { await harness.supervisor.shutdown(); cleanupHarness(harness); }
});

test('thread replacement cancellation and stop never start a replacement thread and can be confirmed again', async () => {
    const harness = createHarness();
    try {
        const sessionId = await createNativeSession(harness);
        await startAndWait(harness.supervisor, sessionId, 'First fixture turn.');
        const changedBundle = structuredClone(harness.bundle);
        changedBundle.skills = [{ id: 'skill-b', name: 'Changed skill', description: 'different bundle', enabled: true, source: 'fixture', path: 'skills/changed/SKILL.md' }];
        harness.setBundle(changedBundle);

        const cancelled = await waitForThreadReplacement(harness, sessionId, 'Cancel this replacement.');
        assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1);
        await answerThreadReplacement(harness, cancelled.runId, cancelled.question.id, '取消本次发送');
        const cancelledSnapshot = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === cancelled.runId && run.state === 'stopped'));
        const cancelledRun = getRun(cancelledSnapshot, cancelled.runId);
        assert.notEqual(cancelledRun.harnessState, 'needs_reconciliation');
        assert.equal(cancelledRun.native?.threadId, undefined);

        const invalid = await waitForThreadReplacement(harness, sessionId, 'Reject an inexact confirmation answer.');
        await answerThreadReplacement(harness, invalid.runId, invalid.question.id, '新建线程并继续 ');
        const invalidSnapshot = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === invalid.runId && run.state === 'stopped'));
        assert.equal(getRun(invalidSnapshot, invalid.runId).native?.threadId, undefined);
        assert.notEqual(getRun(invalidSnapshot, invalid.runId).harnessState, 'needs_reconciliation');

        const stopped = await waitForThreadReplacement(harness, sessionId, 'Stop while confirmation is pending.');
        assert.match(stopped.question.questions[0]?.question ?? '', /thread-fixture/);
        await harness.supervisor.execute({ type: 'stop-run', runId: stopped.runId, reason: '用户在新线程确认时停止。' });
        const stoppedSnapshot = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === stopped.runId && run.state === 'stopped'));
        const stoppedRun = getRun(stoppedSnapshot, stopped.runId);
        assert.equal(stoppedRun.nativeQuestions?.find(item => item.id === stopped.question.id)?.status, 'cancelled');
        assert.notEqual(stoppedRun.harnessState, 'needs_reconciliation');
        assert.equal(stoppedRun.native?.threadId, undefined);
        assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('native thread replacement approval expires when runtime configuration or bridge tools change', async (t) => {
    await t.test('native revision', async () => {
        const harness = createHarness();
        try {
            const sessionId = await createNativeSession(harness);
            await startAndWait(harness.supervisor, sessionId, 'First fixture turn.');
            const changed = structuredClone(harness.bundle);
            changed.native.revision += 1;
            harness.setBundle(changed);
            const pending = await waitForThreadReplacement(harness, sessionId, 'Replace after runtime change.');
            const newer = structuredClone(changed);
            newer.native.revision += 1;
            harness.setBundle(newer);
            await answerThreadReplacement(harness, pending.runId, pending.question.id, '新建线程并继续');
            const failed = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === pending.runId && run.state === 'failed'));
            const failedRun = getRun(failed, pending.runId);
            assert.match(failedRun.error ?? '', /配置.*已经变化/);
            assert.notEqual(failedRun.harnessState, 'needs_reconciliation');
            assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1);
        } finally {
            await harness.supervisor.shutdown();
            cleanupHarness(harness);
        }
    });

    await t.test('delegation bridge tools', async () => {
        const harness = createHarness();
        try {
            const settings = defaultAgentSettings();
            harness.setAgentSettings(settings);
            const sessionId = await createNativeSession(harness);
            await startAndWait(harness.supervisor, sessionId, 'First fixture turn.');
            const changed = structuredClone(harness.bundle);
            changed.skills = [{ id: 'skill-b', name: 'Changed skill', description: 'different bundle', enabled: true, source: 'fixture', path: 'skills/changed/SKILL.md' }];
            harness.setBundle(changed);
            const pending = await waitForThreadReplacement(harness, sessionId, 'Replace after bridge configuration change.');
            const disabled = structuredClone(settings);
            disabled.subagents.enabled = false;
            harness.setAgentSettings(disabled);
            await answerThreadReplacement(harness, pending.runId, pending.question.id, '新建线程并继续');
            const failed = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === pending.runId && run.state === 'failed'));
            assert.match(getRun(failed, pending.runId).error ?? '', /配置.*已经变化/);
            assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1);
        } finally {
            await harness.supervisor.shutdown();
            cleanupHarness(harness);
        }
    });

    await t.test('session history', async () => {
        const harness = createHarness();
        try {
            const sessionId = await createNativeSession(harness);
            const first = await startAndWait(harness.supervisor, sessionId, 'First fixture turn.');
            const changed = structuredClone(harness.bundle);
            changed.skills = [{ id: 'skill-b', name: 'Changed skill', description: 'different bundle', enabled: true, source: 'fixture', path: 'skills/changed/SKILL.md' }];
            harness.setBundle(changed);
            const pending = await waitForThreadReplacement(harness, sessionId, 'Replace after history change.');
            const internals = harness.supervisor as unknown as { runs: { get(id: string): RunRecord | undefined; set(id: string, run: RunRecord): void } };
            const earlier = internals.runs.get(first.id);
            assert.ok(earlier);
            internals.runs.set(first.id, { ...earlier, output: `${earlier.output} edited during confirmation` });
            await answerThreadReplacement(harness, pending.runId, pending.question.id, '新建线程并继续');
            const failed = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === pending.runId && run.state === 'failed'));
            assert.match(getRun(failed, pending.runId).error ?? '', /会话历史已变化/);
            assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1);
        } finally {
            await harness.supervisor.shutdown();
            cleanupHarness(harness);
        }
    });
});

test('a failed run without native metadata still asks before replacing the earlier real thread', async () => {
    const harness = createHarness();
    try {
        const sessionId = await createNativeSession(harness);
        await startAndWait(harness.supervisor, sessionId, 'First fixture turn.');
        const brokenBundle = structuredClone(harness.bundle);
        const scenario = JSON.parse(brokenBundle.native.args[1]!);
        scenario.badLine = true;
        brokenBundle.native.args = [fixturePath, JSON.stringify(scenario)];
        brokenBundle.native.revision += 1;
        harness.setBundle(brokenBundle);

        const failing = await waitForThreadReplacement(harness, sessionId, 'Attempt replacement that will fail before a thread is returned.');
        await answerThreadReplacement(harness, failing.runId, failing.question.id, '新建线程并继续');
        const failed = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === failing.runId && run.state === 'failed'));
        assert.equal(getRun(failed, failing.runId).native?.threadId, undefined);
        assert.notEqual(getRun(failed, failing.runId).harnessState, 'needs_reconciliation');

        const next = await waitForThreadReplacement(harness, sessionId, 'Retry after an earlier native thread.');
        assert.match(next.question.questions[0]?.question ?? '', /thread-fixture/);
        assert.match(next.question.questions[0]?.question ?? '', /上一轮没有可安全续接的原生线程/);
        await harness.supervisor.execute({ type: 'stop-run', runId: next.runId });
        await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === next.runId && run.state === 'stopped'));
        assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('old goal commands are rejected before replacement confirmation when resume is unsafe', async () => {
    const harness = createHarness({ goalCompletionStatus: 'complete' });
    try {
        const sessionId = await createNativeSession(harness);
        await startAndWait(harness.supervisor, sessionId, '/goal Finish this goal.');
        const changed = structuredClone(harness.bundle);
        changed.native.revision += 1;
        harness.setBundle(changed);
        const failed = await startAndWait(harness.supervisor, sessionId, '/goal resume', 'failed');
        assert.equal(Boolean(failed.nativeQuestions?.some(item => item.id === 'question:thread-replacement')), false);
        assert.match(failed.error ?? '', /无法在新线程中操作旧目标/);
        assert.equal(records(harness).filter(record => record.direction === 'client' && record.method === 'thread/start').length, 1);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('native question submit clears its waiter when persisting the answer fails', async () => {
    const harness = createHarness({ userInputRequest: {} });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: '/plan Ask before finishing.' });
        const runId = started.runs.at(-1)!.id;
        const pending = await waitForSnapshot(harness.supervisor, snapshot => Boolean(snapshot.runs.find(run => run.id === runId)?.nativeQuestions?.some(item => item.status === 'pending')));
        const question = getRun(pending, runId).nativeQuestions![0]!;
        const supervisor = harness.supervisor as unknown as {
            commit(changes: any, extra?: any[]): void;
            nativeQuestions: Map<string, unknown>;
        };
        const commit = supervisor.commit.bind(harness.supervisor);
        supervisor.commit = (changes, extra) => {
            const publishesAnswer = changes.runs?.some((run: RunRecord) => run.nativeQuestions?.some(item => item.status === 'answered'));
            if (publishesAnswer) throw new Error('simulated journal failure');
            commit(changes, extra);
        };
        try {
            await assert.rejects(harness.supervisor.execute({ type: 'answer-native-question', runId, questionId: question.id, answers: { choice: { answers: ['A'] } } }), /simulated journal failure/);
        } finally {
            supervisor.commit = commit;
        }
        assert.equal(supervisor.nativeQuestions.size, 0);
        const complete = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === runId && run.state === 'completed'));
        assert.deepEqual(records(harness).find(record => record.method === 'fixture/userInputResponse')?.params
            && ((records(harness).find(record => record.method === 'fixture/userInputResponse')!.params as any).result.answers), {});
        assert.equal(getRun(complete, runId).nativeQuestions?.[0]?.status, 'pending');
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('native goal auto-continues while active and status queries make no model request', async () => {
    const harness = createHarness({ goalCompletionStatuses: ['active', 'complete'], goalTokensPerTurn: 18 });
    try {
        const sessionId = await createNativeSession(harness);
        const goal = await startAndWait(harness.supervisor, sessionId, '/goal Finish the fixture.');
        assert.equal(goal.native?.goal?.status, 'complete');
        assert.equal(goal.native?.goal?.objective, 'Finish the fixture.');
        assert.equal(goal.native?.goal?.tokenBudget, null);
        const queried = await startAndWait(harness.supervisor, sessionId, '/goal');
        assert.equal(queried.native?.turnId, undefined);
        assert.equal(queried.native?.usage, undefined);
        const turns = records(harness).filter(record => record.direction === 'client' && record.method === 'turn/start');
        assert.equal(turns.length, 2);
        assert.equal((turns[0]?.params as any).input[0].text, 'Finish the fixture.');
        assert.match((turns[1]?.params as any).input[0].text, /继续推进当前原生目标/);
        assert.ok(records(harness).some(record => record.method === 'thread/goal/get'));
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('user stop pauses an active native goal and a later goal resume continues the same thread', async () => {
    const harness = createHarness({ hold: true, goalCompletionStatuses: ['active'], goalTokensPerTurn: 4 });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: '/goal Resume after stop.' });
        const run = started.runs.at(-1)!;
        await waitForSnapshot(harness.supervisor, snapshot => Boolean(snapshot.runs.find(item => item.id === run.id)?.native?.turnId));
        const stopped = await harness.supervisor.execute({ type: 'stop-run', runId: run.id, reason: 'Stop an active native goal.' });
        const stoppedRun = getRun(stopped, run.id);
        assert.equal(stoppedRun.state, 'stopped');
        assert.equal(stoppedRun.harnessState, undefined);
        assert.equal(stoppedRun.native?.goal?.status, 'paused');

        const resumedBundle = structuredClone(harness.bundle);
        const scenario = JSON.parse(resumedBundle.native.args[1]!);
        scenario.hold = false;
        scenario.goalCompletionStatuses = ['complete'];
        resumedBundle.native.args = [fixturePath, JSON.stringify(scenario)];
        harness.setBundle(resumedBundle);
        const resumed = await startAndWait(harness.supervisor, sessionId, '/goal resume');
        assert.equal(resumed.native?.threadId, stoppedRun.native?.threadId);
        assert.equal(resumed.native?.goal?.status, 'complete');
        const resumeRequest = records(harness).find(record => record.direction === 'client' && record.method === 'thread/resume');
        assert.equal((resumeRequest?.params as any).threadId, stoppedRun.native?.threadId);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('failure to confirm goal pause is diagnosed and never recorded as paused', async () => {
    const harness = createHarness({ hold: true, unsupportedGoalMethod: 'thread/goal/get', goalCompletionStatuses: ['active'] });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: '/goal Stop with uncertain goal.' });
        const run = started.runs.at(-1)!;
        await waitForSnapshot(harness.supervisor, snapshot => Boolean(snapshot.runs.find(item => item.id === run.id)?.native?.turnId));
        const stopped = await harness.supervisor.execute({ type: 'stop-run', runId: run.id, reason: 'Test unconfirmed goal pause.' });
        const stoppedRun = getRun(stopped, run.id);
        assert.equal(stoppedRun.state, 'stopped');
        assert.equal(stoppedRun.harnessState, 'needs_reconciliation');
        assert.match(stoppedRun.error ?? '', /目标状态未确认已暂停/);
        assert.notEqual(stoppedRun.native?.goal?.status, 'paused');
        assert.ok(records(harness).some(record => record.direction === 'client' && record.method === 'thread/goal/get'));
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});
