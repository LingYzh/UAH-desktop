import { app, safeStorage } from 'electron';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { EndpointStore } from '../../src/main/endpoint-store.js';
import { Supervisor } from '../../src/runtime/supervisor.js';
import { inspectRequest, type PrefixEvidence } from '../../src/runtime/context/projection.js';
import type { ApprovalRecord, RunRecord, Snapshot } from '../../src/shared/contracts.js';
import type { ApiConnection, EndpointRecord } from '../../src/shared/endpoints.js';
import type { AgentProfile } from '../../src/shared/agents.js';
import { defaultModelParameters } from '../../src/shared/model-parameters.js';

type Phase = 'first' | 'middle' | 'final' | 'repair' | 'audit';
type RunnerArgs = {
    phase: Phase;
    endpointId: string;
    modelId: string;
    dataDirectory: string;
    workspace: string;
    stateFile: string;
    reportFile: string;
    testResultFile: string;
    nodeExecutable: string;
    contextWindow?: number;
};
type RunnerState = {
    schemaVersion: 1;
    endpointId: string;
    modelId: string;
    sessionId: string;
    workspace: string;
    completedTurns: number[];
    runIds: string[];
};

const AGENT_ID = 'context-coding-live';
const TOTAL_TURNS = 8;
const WAIT_LIMIT_MS = 30 * 60 * 1000;
const ACCEPTANCE_LIMIT_MS = 10 * 60 * 1000;

const turns = [
    `第1轮（结构与基线）：阅读 PROJECT_BRIEF.md、specs/ 下所有规格和 fixtures/sample.csv。创建最小 package.json、src/csv.js 与 tests/parser.test.js，先实现可用的基础 CSV 解析器和对应 node:test 用例。工具操作顺序必须包含：读规格/样例、写入新文件、重新读取至少一个写入文件核对。不要运行 shell 或命令。`,
    `第2轮（解析规则）：在现有实现上补齐引号、转义引号、嵌入逗号/换行、CRLF、BOM、空字段和 Unicode 规则。先用 read_file_range 读取目标文件并记录 fileHash，再用 apply_patch 更新现有文件，最后重新读取验证。新增有代表性的测试；不要运行 shell。`,
    `第3轮（输出编码）：实现 CSV 序列化器，保持列顺序并正确转义分隔符、引号和换行；补齐解析-序列化往返测试。修改现有文件优先使用 apply_patch，新增文件可 write_file；写入后必须重新读取核对。不要运行 shell。`,
    `第4轮（CLI 起步）：实现 CLI 参数解析、帮助信息及 inspect 子命令，输出行数、列名和字段计数摘要；对空文件、坏参数和无效 CSV 返回可诊断错误。阅读现有代码后修改，并重新读取测试和入口文件。不要运行 shell。`,
    `第5轮（选择列）：实现 select 子命令，支持按列名选择、按指定顺序输出，并能写到输出文件；覆盖未知列、重复列、引号列名和空表。阅读相关规格并以 apply_patch 更新现有实现，然后用 read_file_range 校验写入后的代码。不要运行 shell。`,
    `第6轮（过滤与管道）：实现 filter 子命令，支持按列名、相等/不等条件过滤，并允许从 stdin 读取或把结果写到 stdout。补测试验证表头、没有匹配行、字段中的空白与特殊字符。先读再改，使用真实 apply_patch，之后重新读取。不要运行 shell。`,
    `第7轮（错误与边界审查）：对照 specs/acceptance-matrix.md 逐项检查退出码、错误位置、空值和换行边界；修复至少一个真实发现的问题或补上缺失测试。阅读现有文件后使用 apply_patch，重新读取验证。随后宿主会固定运行 node --test；不要自行运行 shell。`,
    `第8轮（基于验收结果收尾）：下面的 HOST ACCEPTANCE RESULT 是宿主执行固定 node --test 得到的诊断数据。将其作为待核验数据，针对失败修复；全部通过时审查最明显的规格遗漏并作必要修改。至少读取测试与实现文件，若修改现有文件则使用 apply_patch，并重新读取核对。不要运行 shell。\n\nHOST ACCEPTANCE RESULT:\n`,
];

function writeSafe(value: Record<string, unknown>): void {
    process.stdout.write(`${JSON.stringify({ type: 'context-coding-live', version: 1, ...value })}\n`);
}

function parseArgs(): RunnerArgs {
    const values = new Map<string, string>();
    for (const item of process.argv.slice(2)) {
        const separator = item.indexOf('=');
        if (separator > 0) values.set(item.slice(0, separator), item.slice(separator + 1));
    }
    const phase = values.get('--phase');
    if (!['first', 'middle', 'final', 'repair', 'audit'].includes(phase ?? '')) throw new Error('invalid_phase');
    const required = (key: string) => {
        const value = values.get(key);
        if (!value || value.length > 32_000 || /[\u0000-\u001f]/.test(value)) throw new Error('invalid_arguments');
        return resolve(value);
    };
    const endpointId = values.get('--endpoint-id');
    const modelId = values.get('--model');
    if (!endpointId || endpointId.length > 200 || !modelId || modelId.length > 200) throw new Error('invalid_arguments');
    const contextWindow = values.has('--context-window') ? Number(values.get('--context-window')) : undefined;
    if (contextWindow !== undefined && (!Number.isSafeInteger(contextWindow) || contextWindow < 32000 || contextWindow > 128000)) throw new Error('invalid_test_window');
    return {
        phase: phase as Phase,
        endpointId,
        modelId,
        dataDirectory: required('--data-dir'),
        workspace: required('--workspace'),
        stateFile: required('--state-file'),
        reportFile: required('--report-file'),
        testResultFile: required('--test-result-file'),
        nodeExecutable: required('--node-exe'),
        contextWindow,
    };
}

function readJson<T>(path: string): T {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function atomicJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'w' });
    renameSync(temporary, path);
}

function findEndpoint(records: EndpointRecord[], selector: string): EndpointRecord {
    const matches = records.filter(item => item.id === selector || item.providerId === selector);
    if (matches.length !== 1) throw new Error(matches.length ? 'endpoint_not_unique' : 'endpoint_not_found');
    return matches[0];
}

function makeConnection(store: EndpointStore, endpoint: EndpointRecord, modelId: string): ApiConnection {
    if (!endpoint.models.includes(modelId)) throw new Error('model_not_configured');
    const connection = store.resolve(endpoint.id);
    const parameters = connection.modelParameters?.find(item => item.id === modelId)?.parameters ?? defaultModelParameters();
    return { ...connection, modelParameters: [
        ...(connection.modelParameters ?? []).filter(item => item.id !== modelId),
        { id: modelId, parameters: { ...parameters, timeoutSeconds: 600 } },
    ] };
}

function runHostTests(nodeExecutable: string, workspace: string) {
    const result = spawnSync(nodeExecutable, ['--test', '--test-reporter=tap'], {
        cwd: workspace,
        encoding: 'utf8',
        timeout: ACCEPTANCE_LIMIT_MS,
        maxBuffer: 8 * 1024 * 1024,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-60_000);
    const tests = Number(output.match(/^# tests (\d+)$/m)?.[1] ?? 0);
    const passed = Number(output.match(/^# pass (\d+)$/m)?.[1] ?? 0);
    const failed = Number(output.match(/^# fail (\d+)$/m)?.[1] ?? (result.status === 0 ? 0 : 1));
    return {
        command: 'node --test --test-reporter=tap',
        exitCode: result.status,
        signal: result.signal,
        timedOut: result.error?.name === 'ETIMEDOUT',
        tests,
        passed,
        failed,
        output,
    };
}

function terminal(run: RunRecord | undefined): boolean {
    return Boolean(run && ['completed', 'failed', 'stopped'].includes(run.state));
}

function isSafeTestCommand(activity: NonNullable<RunRecord['activities']>[number] | undefined, workspace: string): boolean {
    const args = activity?.tool?.arguments;
    if (activity?.tool?.name !== 'run_command' || !args || args.command !== 'node --test') return false;
    const target = typeof args.path === 'string' ? args.path : '.';
    return resolve(workspace, target) === workspace;
}

async function settleApprovals(supervisor: Supervisor, snapshot: Snapshot, workspace: string): Promise<void> {
    for (const approval of snapshot.approvals.filter(item => item.status === 'pending')) {
        const run = snapshot.runs.find(item => item.id === approval.runId);
        const activity = run?.activities?.find(item => item.id === approval.toolCallId);
        const approve = isSafeTestCommand(activity, workspace);
        const item = approval as ApprovalRecord;
        await supervisor.execute({
            type: 'resolve-approval',
            identity: {
                runtimeId: item.runtimeId,
                sessionId: item.sessionId,
                runId: item.runId,
                turnId: item.turnId,
                requestId: item.requestId,
                policyVersion: item.policyVersion,
            },
            decision: approve ? 'approve' : 'reject',
        });
    }
}

async function waitForRun(supervisor: Supervisor, runId: string, phase: Phase, turn: number, workspace: string): Promise<RunRecord> {
    const end = Date.now() + WAIT_LIMIT_MS;
    while (Date.now() < end) {
        const snapshot = await supervisor.execute({ type: 'snapshot' });
        await settleApprovals(supervisor, snapshot, workspace);
        const run = snapshot.runs.find(item => item.id === runId);
        if (terminal(run)) {
            writeSafe({ event: 'turn-finished', phase, turn, state: run!.state });
            return run!;
        }
        await new Promise(resolvePromise => setTimeout(resolvePromise, 500));
    }
    throw new Error('run_timeout');
}

function runSummary(run: RunRecord) {
    const tools = (run.activities ?? []).flatMap(activity => {
        if (!activity.tool) return [];
        const outcome = activity.tool.outcome;
        const argPath = typeof activity.tool.arguments?.path === 'string' ? activity.tool.arguments.path : null;
        return [{
            name: activity.tool.name,
            status: outcome?.status ?? activity.status,
            effectState: outcome?.effectState ?? 'unknown',
            retryClass: outcome?.retryClass ?? 'unknown',
            errorCode: outcome?.errorCode ?? null,
            path: argPath,
            resources: (outcome?.resources ?? []).map(resource => ({
                beforeHash: resource.beforeHash,
                afterHash: resource.afterHash,
                hashKind: resource.hashKind ?? null,
            })),
        }];
    });
    return { runId: run.id, state: run.state, harnessState: run.harnessState ?? null, tools };
}

function summarizeRequests(supervisor: Supervisor, sessionId: string, dataDirectory: string) {
    const view = supervisor.journalView({ action: 'summary', sessionId }) as {
        health: unknown;
    };
    const usageByAttempt = new Map<string, Record<string, any>>();
    let events: Array<Record<string, any>> = [];
    const database = new DatabaseSync(resolve(dataDirectory, 'runtime.sqlite'), { readOnly: true });
    try {
        const rows = database.prepare("SELECT data FROM canonical_events WHERE session_id = ? AND json_extract(data, '$.type') IN ('usage.snapshot','request.intent','request.dispatch','request.retry','response.terminal') ORDER BY session_seq").all(sessionId);
        events = rows.map(row => JSON.parse(String(row.data)));
        for (const event of events.filter(item => item.type === 'usage.snapshot')) {
            const usage = event.payload.usage;
            const key = JSON.stringify([usage.requestId, usage.attemptId]);
            if (!usageByAttempt.has(key) || usage.revision >= usageByAttempt.get(key)!.revision) usageByAttempt.set(key, usage);
        }
    } finally { database.close(); }
    const dispatched = new Set(events.filter(item => item.type === 'request.dispatch').map(item => JSON.stringify([item.payload.requestId, item.payload.attemptId])));
    const requests = events.filter(item => item.type === 'request.intent'
        && dispatched.has(JSON.stringify([item.payload.identity.requestId, item.payload.identity.attemptId])));
    const sessionRoot = resolve(dataDirectory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
    let previous: PrefixEvidence | undefined;
    const attempts = requests.map(intent => {
        const row = { ...intent.payload.identity, timestamp: intent.timestamp };
        const artifactPath = resolve(sessionRoot, intent.payload.snapshot.relativePath);
        const relativeArtifact = relative(sessionRoot, artifactPath);
        if (relativeArtifact.startsWith('..') || isAbsolute(relativeArtifact)) throw new Error('invalid_artifact_reference');
        const snapshot = readJson<{ body: Record<string, unknown>; protocol: ApiConnection['protocol'] }>(artifactPath);
        const usage = usageByAttempt.get(JSON.stringify([row.requestId, row.attemptId])) ?? {};
        const prefix = inspectRequest(snapshot.body, snapshot.protocol, row.requestId, usage.purpose === 'compaction' ? undefined : previous);
        if (usage.purpose !== 'compaction') previous = prefix;
        const attemptEvents = events.filter(event => event.payload.requestId === row.requestId && event.payload.attemptId === row.attemptId);
        const retryEvents = attemptEvents.filter(event => event.type === 'request.retry')
            .map(event => ({ reason: event.payload.reason, retryNumber: event.payload.retryNumber, delayMs: event.payload.delayMs }));
        return {
            requestId: row.requestId,
            attemptId: row.attemptId,
            runId: row.runId,
            timestamp: row.timestamp,
            status: attemptEvents.findLast(event => event.type === 'response.terminal')?.payload.status ?? 'unknown',
            purpose: usage.purpose ?? 'unknown',
            inputTokens: usage.counters?.inputTokens ?? null,
            outputTokens: usage.counters?.outputTokens ?? null,
            rawUsage: usage.rawUsage ?? null,
            normalizedUsage: usage.counters ?? null,
            usageCompleteness: usage.completeness ?? 'unknown',
            retries: retryEvents,
            processEpochId: intent.processEpochId ?? null,
            prefix: {
                previousRequestId: prefix.previousRequestId,
                retainedSegments: prefix.retainedSegments,
                previousSegments: prefix.previousSegments,
                firstChanged: prefix.firstChanged,
                appendOnly: prefix.appendOnly,
                bodyBytes: prefix.bodyBytes,
                segments: prefix.segments,
            },
        };
    });
    return { health: view.health, truncated: false, attempts };
}

function summarizeTools(runs: RunRecord[], workspace: string) {
    const result = runs.flatMap(run => runSummary(run).tools.map(tool => {
        let path = tool.path;
        if (path && isAbsolute(path)) {
            const rel = relative(workspace, resolve(path));
            path = rel.startsWith('..') || isAbsolute(rel) ? '(outside-workspace)' : rel || '.';
        }
        return { runId: run.id, ...tool, path };
    }));
    return {
        calls: result,
        counts: Object.fromEntries(['read_file', 'read_file_range', 'write_file', 'apply_patch'].map(name =>
            [name, result.filter(item => item.name === name && item.status === 'succeeded').length])),
    };
}

async function main(): Promise<void> {
    let args: RunnerArgs;
    try { args = parseArgs(); }
    catch (error) {
        writeSafe({ event: 'failed', phase: 'unknown', failure: error instanceof Error ? error.message : 'invalid_arguments' });
        app.exit(2);
        return;
    }

    // Electron safeStorage must be pointed at the cloned artifact userData before ready.
    app.setPath('userData', args.dataDirectory);
    await app.whenReady();
    let endpointStore: EndpointStore | undefined;
    let supervisor: Supervisor | undefined;
    let failure = 'runner_failure';
    let exitCode = 0;
    try {
        const workspace = resolve(args.workspace);
        if (!existsSync(workspace) || !isAbsolute(workspace)) throw new Error('workspace_unavailable');
        endpointStore = new EndpointStore(args.dataDirectory, safeStorage);
        const endpoint = findEndpoint(endpointStore.list(), args.endpointId);
        const configuredConnection = makeConnection(endpointStore, endpoint, args.modelId);
        const baseConnection = args.contextWindow === undefined ? configuredConnection : {
            ...configuredConnection,
            modelDetails: [
                ...(configuredConnection.modelDetails ?? []).filter(item => item.id !== args.modelId),
                { ...(configuredConnection.modelDetails?.find(item => item.id === args.modelId) ?? { id: args.modelId }), contextWindow: args.contextWindow },
            ],
        };
        const profile: AgentProfile = {
            id: AGENT_ID,
            name: 'CSV CLI 验收助手',
            description: '只在隔离的 CSV CLI 工件项目内实现并验证用户要求。',
            instructions: `你负责逐步完成隔离项目中的 JavaScript CSV CLI。每轮先读取相关规格和当前文件，按用户本轮范围实现；已有文件优先用 apply_patch，新增文件用 write_file；修改后再次读取核对。只操作当前工作目录。不要调用 run_command、MCP、Git、外部服务或子代理；固定 node --test 由宿主执行。不得输出或要求查看本机凭据。遵守目录中的 PROJECT_BRIEF.md 和 specs。`,
            enabled: true,
            kind: 'primary',
            allowDelegation: false,
        };
        supervisor = new Supervisor({
            dataDirectory: args.dataDirectory,
            homeDirectory: resolve(args.dataDirectory, 'context-home'),
            onEvent: () => {},
            delayMs: 0,
            getCaptureRaw: () => true,
            resolveConnection: async id => {
                if (id !== endpoint.id && id !== endpoint.providerId) throw new Error('endpoint_not_found');
                return baseConnection;
            },
            resolveAgent: id => {
                if (id !== AGENT_ID) throw new Error('agent_not_found');
                return profile;
            },
        });

        let state: RunnerState;
        if (args.phase === 'first' && !existsSync(args.stateFile)) {
            const created = await supervisor.execute({
                type: 'create-session',
                title: `CSV live coding ${createHash('sha256').update(args.workspace).digest('hex').slice(0, 10)}`,
                directory: workspace,
                selection: { endpointId: endpoint.id, modelId: args.modelId },
                controls: { permissionMode: 'accept-edits', reasoningEffort: 'default' },
                agentId: AGENT_ID,
            });
            const session = created.sessions.at(-1);
            if (!session) throw new Error('session_create_failed');
            state = { schemaVersion: 1, endpointId: endpoint.id, modelId: args.modelId, sessionId: session.id,
                workspace, completedTurns: [], runIds: [] };
            atomicJson(args.stateFile, state);
        } else {
            state = readJson<RunnerState>(args.stateFile);
            if (state.schemaVersion !== 1 || state.endpointId !== endpoint.id || state.modelId !== args.modelId
                || resolve(state.workspace) !== workspace) throw new Error('run_state_mismatch');
        }

        const range = args.phase === 'audit' ? [0, 0] : args.phase === 'first' ? [0, 4] : args.phase === 'middle' ? [4, 7] : args.phase === 'repair' ? [8, 10] : [7, 8];
        for (let index = range[0]; index < range[1]; index += 1) {
            if (state.completedTurns.includes(index + 1)) continue;
            let input = turns[index];
            if (index >= 8) {
                const result = runHostTests(args.nodeExecutable, workspace);
                input = `宿主已创建 src 和 tests 目录，此前缺少父目录的问题已解决。这是新的明确修复请求，请不要只给建议：读取现状与规格，补齐实际缺失的 CSV 解析器、序列化器、CLI 和 node:test 测试文件；已有文件用真实 apply_patch（先读取 read_file_range 返回的 fileHash，作为 expectedHash）。新增文件必须调用 write_file 并显式包含 expectedContent:null；只传 path/content 会被拒绝。不要用缺失参数重试。apply_patch.edits 使用唯一匹配 oldText/newText。必须实际写入并重新读取核验。禁止把0个测试当通过，不允许跳过或删除失败测试。若测试已通过，请对照规格补一项真实缺失的测试/行为并通过 apply_patch 修改现有文件。宿主会运行固定测试，不要调用 shell。\nHOST RESULT:\n${JSON.stringify(result)}`;
            }
            if (index === 7) {
                const hostResult = readJson<ReturnType<typeof runHostTests>>(args.testResultFile);
                const summary = `命令: ${hostResult.command}\n退出码: ${hostResult.exitCode}\n测试数: ${hostResult.tests}, 通过: ${hostResult.passed}, 失败: ${hostResult.failed}\n\n${hostResult.output}`;
                input += summary.slice(-50_000);
            }
            writeSafe({ event: 'turn-started', phase: args.phase, turn: index + 1, totalTurns: TOTAL_TURNS });
            const started = await supervisor.execute({ type: 'start-run', sessionId: state.sessionId, input });
            const run = started.runs.at(-1);
            if (!run) throw new Error('run_start_failed');
            state.runIds.push(run.id);
            atomicJson(args.stateFile, state);
            const finished = await waitForRun(supervisor, run.id, args.phase, index + 1, workspace);
            if (finished.state !== 'completed' || ['recording_failed', 'needs_reconciliation'].includes(finished.harnessState ?? '')) {
                atomicJson(args.stateFile, state);
                throw new Error(finished.harnessState === 'recording_failed' || finished.harnessState === 'needs_reconciliation'
                    ? 'harness_reconciliation_required' : 'model_run_failed');
            }
            state.completedTurns.push(index + 1);
            atomicJson(args.stateFile, state);
        }

        if (args.phase === 'middle') {
            const testResult = runHostTests(args.nodeExecutable, workspace);
            atomicJson(args.testResultFile, testResult);
            writeSafe({ event: 'host-tests', phase: args.phase, exitCode: testResult.exitCode, tests: testResult.tests,
                passed: testResult.passed, failed: testResult.failed });
        }

        if (args.phase === 'final' || args.phase === 'repair' || args.phase === 'audit') {
            const snapshot = await supervisor.execute({ type: 'snapshot' });
            const runs = snapshot.runs.filter(run => state.runIds.includes(run.id));
            const requestData = summarizeRequests(supervisor, state.sessionId, args.dataDirectory);
            const toolData = summarizeTools(runs, workspace);
            const finalTests = runHostTests(args.nodeExecutable, workspace);
            const epochIds = [...new Set(requestData.attempts.map(item => item.processEpochId).filter((item): item is string => !!item))];
            const report = {
                schemaVersion: 1,
                endpoint: { name: endpoint.name, protocol: endpoint.protocol, modelId: args.modelId },
                workspace,
                turnsCompleted: state.completedTurns.length,
                testTimeoutSeconds: 600,
                testContextWindow: args.contextWindow ?? null,
                sessionUsage: supervisor.sessionContext(state.sessionId)?.sessionUsage,
                turns: runs.map(runSummary),
                modelRequests: requestData.attempts.length,
                minimumModelRequests: 20,
                requestThresholdMet: requestData.attempts.length >= 20,
                attemptCoverage: requestData.truncated ? 'partial' : 'complete',
                journalHealth: requestData.health,
                processEpochs: epochIds,
                actualSupervisorRestartObserved: epochIds.length >= 2,
                rawAttempts: requestData.attempts,
                toolSummary: toolData,
                realReadWritePatchCallsObserved: toolData.counts.read_file + toolData.counts.read_file_range > 0
                    && toolData.counts.write_file > 0 && toolData.counts.apply_patch > 0,
                hostAcceptance: finalTests,
            };
            atomicJson(args.reportFile, report);
            writeSafe({ event: 'complete', phase: args.phase, turnsCompleted: report.turnsCompleted,
                modelRequests: report.modelRequests, requestThresholdMet: report.requestThresholdMet,
                actualSupervisorRestartObserved: report.actualSupervisorRestartObserved,
                readCalls: toolData.counts.read_file + toolData.counts.read_file_range,
                writeCalls: toolData.counts.write_file, patchCalls: toolData.counts.apply_patch,
                testExitCode: finalTests.exitCode });
            if (report.turnsCompleted < TOTAL_TURNS || !report.requestThresholdMet
                || !report.actualSupervisorRestartObserved || !report.realReadWritePatchCallsObserved || finalTests.exitCode !== 0
                || finalTests.tests < 1) {
                failure = 'acceptance_incomplete';
                throw new Error(failure);
            }
        }
    } catch (error) {
        const code = error instanceof Error && /^[a-z0-9_]{1,64}$/.test(error.message) ? error.message : failure;
        writeSafe({ event: 'failed', phase: args.phase, failure: code });
        exitCode = 1;
    } finally {
        try { await supervisor?.shutdown(); } catch { /* Child will exit; parent keeps only sanitized status. */ }
        try { endpointStore?.close(); } catch { /* Preserve the safe status line. */ }
        app.exit(exitCode);
    }
}

void main().catch(() => {
    writeSafe({ event: 'failed', phase: 'unknown', failure: 'runner_failure' });
    app.exit(1);
});
