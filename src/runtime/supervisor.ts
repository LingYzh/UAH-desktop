import { createHash, randomUUID } from 'node:crypto';
import { collectJournalOrphans, reviewJournalCleanup } from './journal-gc';
import { finishSessionPurgeFiles, prepareSessionPurgeFiles, purgeFilesFingerprint, type SessionPurgeIntent } from './session-purge-files';
import type { SessionPurgeReview, SessionPurgeResult } from '../shared/session-purge';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import type {
    ApprovalIdentity,
    ApprovalRecord,
    ArtifactSnapshot,
    Command,
    RuntimeEvent,
    RunRecord,
    SessionRecord,
    Snapshot,
    RuntimeConfig,
    RunActivity,
} from '../shared/contracts.js';
import { parseCommand } from '../shared/contracts.js';
import type { AgentProfile } from '../shared/agents.js';
import { defaultModelParameters } from '../shared/model-parameters.js';
import { parsePermissionMode } from '../shared/permissions.js';
import { assemblePrompt } from './prompt-assembler';
import { recordPromptAssembly } from './diagnostics';
import { applySessionReasoning, defaultSessionControls, parseSessionControls, type SessionControls } from '../shared/session-controls.js';
import type { ApiConnection, ApiMessage } from '../shared/endpoints.js';
import { effectiveModelDetails } from '../shared/endpoints.js';
import { streamAgentApi, appendToolResults, ApiTransportError } from './api-transport.js';
import { retryDelayMs, abortableRetryDelay } from './request-retry';
import { ToolProgressGovernor } from './tool-progress';
import { RunCache } from './run-cache';
import { requestEvents } from './request-events';
import { inspectRecoveryResources } from './recovery-evidence';
import type { RecoveryReview } from '../shared/recovery';
import type { ResourceVersion } from '../shared/harness-contracts';
import { parseSnapshotView, type SnapshotView } from '../shared/snapshot-view';
import { executeWorkspaceTool, workspaceToolDefinitions } from './workspace-tools.js';
import { artifactToolDefinitions, executeArtifactRead } from './artifact-tools';
import { ToolScheduler } from './tool-scheduler';
import { delegationToolDefinitions } from './delegation-tools.js';
import { parentConversation, resolveDelegation } from '../shared/delegation.js';
import { boundedHistoryText, conversationMessages, interruptedRunSummary, latestVisibleRootRun, visibleRootRuns } from '../shared/conversation-history.js';
import { sessionHasFileChanges } from '../shared/run-effects.js';
import { submitPlanTool, enterPlanModeTool, writePlanTool, readPlanTool, writePlanFile, readPlanFile } from './plan-tools.js';
import type { AgentSettings } from '../shared/agents.js';
import type { ToolCall } from '../shared/tool-protocol.js';
import type { ToolOutcome, RequestIdentity, InvocationIdentity, JsonValue, ModelFrame } from '../shared/harness-contracts';
import { LocalVerificationAdapter } from './local-verification.js';
import { redactJournalValue } from './journal-artifacts.js';
import type { RuntimeAdapter } from './local-verification.js';
import {
    canonicalizeDirectory,
    directoryLeaseKey,
    expectedOutputPath,
    removeCreatedFile,
    sameDirectory,
    writeNewFileExclusive,
} from './paths.js';
import type { CreatedFile } from './paths.js';
import { RuntimeStore, type StoreCommit } from './store.js';
import { RunJournal } from './run-journal';
import { RequestJournal } from './request-journal';
import { WindowsExecutionBackend } from './execution-backend';
import { beginToolOutcome } from './tool-outcome';
import { exportTranscript, usageStats } from './transcript-offline';
import { managedCommand } from './managed-command';
import { historyTurns, nativeHistory, modelTurnFingerprint } from './model-history';
import { publicHistoryCandidate } from './context-compaction';
import { assessContext, TaskTreeBudget, BudgetExceededError, type TaskTreeBudgetOptions } from './context-governor';
import { readGit, gitPromptContext } from './git';
import { gitToolDefinitions, executeGitTool } from './git-tools';
import { captureRequestContext, contextSummary } from './request-context';
import type { RequestContextDetail } from '../shared/request-context';

export const LOCAL_VERIFICATION_RUNTIME_ID = 'local-verification';
const MAX_ACTIVE_RUNS = 64;
const DEFAULT_DELAY_MS = 35;

export interface SupervisorOptions {
    getCaptureRaw?: () => boolean;
    taskBudget?: TaskTreeBudgetOptions;
    executionHelperPath?: string;
    dataDirectory: string;
    onEvent: (event: RuntimeEvent) => void;
    delayMs?: number;
    resolveConnection?: (endpointId: string) => Promise<ApiConnection>;
    resolveAgent?: (agentId: string) => AgentProfile;
    getAgentSettings?: () => AgentSettings;
}

interface ActiveExecution {
    cancelled: boolean;
    task: Promise<void>;
    waiters: Set<() => void>;
    directoryLeaseKey: string | null;
    abortController: AbortController;
    stopTask?: Promise<void>;
}
interface PlanTransition { source: RunRecord; decision: 'approve' | 'revise'; permissionMode: SessionControls['permissionMode']; feedback?: string; validate: () => void; }

type EventType = RuntimeEvent['type'];

export class Supervisor {
    private purgeInProgress: string | null = null;
    private readonly dataDirectory: string;
    private readonly store: RuntimeStore;
    private readonly journal: RunJournal;
    private commandBackend?: WindowsExecutionBackend;
    private readonly executionHelperPath?: string;
    private readonly onEvent: (event: RuntimeEvent) => void;
    private readonly delayMs: number;
    private readonly adapter: RuntimeAdapter;
    private readonly resolveConnection?: (endpointId: string) => Promise<ApiConnection>;
    private readonly resolveAgent?: (agentId: string) => AgentProfile;
    private readonly getAgentSettings?: () => AgentSettings;
    private readonly toolApprovals = new Map<string, (allowed: boolean) => void>();
    private readonly sessions = new Map<string, SessionRecord>();
    private readonly runs: RunCache;
    private readonly approvals = new Map<string, ApprovalRecord>();
    private readonly active = new Map<string, ActiveExecution>();
    private readonly planEdits = new Set<string>();
    private readonly planEditSettled = new Map<string, Promise<void>>();
    private readonly directoryLeases = new Map<string, string>();
    private readonly recordingFailures = new Set<string>();
    private readonly activeRequests = new Map<string, RequestIdentity>();
    private readonly activeCaptures = new Map<string, RequestJournal>();
    private readonly completedFrames = new Map<string, Omit<ModelFrame, 'publicFingerprint'>>();
    private readonly taskBudgets = new Map<string, TaskTreeBudget>();
    private readonly toolScheduler = new ToolScheduler();
    private readonly budgetTimers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly taskBudgetOptions?: TaskTreeBudgetOptions;
    private readonly getCaptureRaw: () => boolean;
    private shuttingDown = false;
    private closed = false;

    constructor(options: SupervisorOptions) {
        this.taskBudgetOptions = options.taskBudget;
        this.getCaptureRaw = options.getCaptureRaw ?? (() => true);
        this.dataDirectory = options.dataDirectory;
        if (!options || typeof options.dataDirectory !== 'string' || !options.dataDirectory.trim()) {
            throw new TypeError('Supervisor requires a dataDirectory');
        }
        if (typeof options.onEvent !== 'function') {
            throw new TypeError('Supervisor requires an onEvent callback');
        }
        const requestedDelay = options.delayMs ?? DEFAULT_DELAY_MS;
        if (!Number.isFinite(requestedDelay) || requestedDelay < 0) {
            throw new TypeError('delayMs must be a non-negative finite number');
        }

        this.store = new RuntimeStore(options.dataDirectory);
        this.runs = new RunCache(id => this.store.readRun(id), id => this.store.readSessionRuns(id));
        this.onEvent = options.onEvent;
        this.delayMs = Math.min(requestedDelay, 10_000);
        this.adapter = new LocalVerificationAdapter();
        this.resolveConnection = options.resolveConnection;
        this.resolveAgent = options.resolveAgent;
        this.getAgentSettings = options.getAgentSettings;
        this.executionHelperPath = options.executionHelperPath;
        this.journal = new RunJournal(this.store, this.dataDirectory, id => this.runs.get(id), () => {
            for (const [id, active] of this.active) {
                const run = this.runs.get(id);
                if (run) this.recordingFailures.add(run.sessionId);
                active.abortController.abort(new Error('Canonical journal unavailable'));
            }
        });
        this.loadAndRecover();
    }

    journalSessionDirectory(sessionId: string): string {
        if (!this.sessions.has(sessionId)) throw new Error('会话不存在。');
        return this.journal.project(sessionId);
    }

    private preparePurge(sessionId: string): { review: SessionPurgeReview; intent?: SessionPurgeIntent } {
        this.assertRunning();
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error('会话不存在。');
        const reasons: string[] = [];
        if (this.active.size || this.planEdits.size || this.purgeInProgress) reasons.push('请先结束所有正在运行的任务、计划编辑或删除操作。');
        if (this.journal.authorityFailed || this.recordingFailures.has(sessionId)) reasons.push('记录失败期间不能确认任务及输出生命周期。');
        const rows = this.runs.forSession(sessionId), runIds = new Set(rows.map(run => run.id));
        if (rows.some(run => run.harnessState === 'recording_failed')) reasons.push('会话包含持久化的记录失败状态，尚不能确认完整删除边界。');
        if (rows.some(run => !this.isTerminal(run.state))) reasons.push('会话仍有未结束的任务。');
        const executions = new Map<string, string>(), settled = new Set<string>();
        let after = 0;
        while (true) {
            const events = this.store.readJournal(sessionId, after, 1000);
            if (!events.length) break;
            for (const event of events) {
                if (event.type === 'tool.dispatch' && event.payload.executionId) executions.set(event.payload.executionId, JSON.stringify([event.run.runId, event.payload.identity.invocationId, event.payload.executionId]));
                if (event.type === 'tool.result') {
                    const evidence = event.payload.outcome.executionEvidence;
                    if (evidence?.treeExited && evidence.outputDrained) settled.add(JSON.stringify([event.run.runId, event.payload.invocationId, evidence.executionId]));
                }
            }
            after = events.at(-1)!.sessionSeq;
        }
        if ([...executions.values()].some(identity => !settled.has(identity))) reasons.push('有命令缺少进程树退出与输出排空证据，不能清理其记录。');
        let intent: SessionPurgeIntent | undefined;
        if (!reasons.length) {
            this.journal.flush();
            intent = prepareSessionPurgeFiles(this.dataDirectory, sessionId, [...executions.keys()]);
        }
        const fingerprint = createHash('sha256').update(JSON.stringify({ session, rows,
            durable: this.store.journalWatermark(sessionId).durableSeq, files: intent && purgeFilesFingerprint(intent) })).digest('hex');
        return { intent, review: { sessionId, fingerprint, runCount: rows.length, fileCount: intent?.files.length ?? 0,
            bytes: intent?.files.reduce((total, file) => total + file.bytes, 0) ?? 0,
            backupCount: intent?.backups.length ?? 0,
            incompleteBackupFiles: intent?.files.filter(file => file.path.startsWith('upgrade-backups/')).length ?? 0,
            branchCount: [...this.sessions.values()].filter(item => item.branchFromRunId && runIds.has(item.branchFromRunId)).length,
            canDelete: reasons.length === 0, reasons } };
    }
    sessionPurgeReview(sessionId: string): SessionPurgeReview { return this.preparePurge(sessionId).review; }
    beginSessionPurge(sessionId: string, fingerprint: string): void {
        const prepared = this.preparePurge(sessionId);
        if (!prepared.review.canDelete || !prepared.intent || prepared.review.fingerprint !== fingerprint) throw new Error('会话或删除范围已变化，请重新检查后确认。');
        const runIds = new Set(this.runs.forSession(sessionId).map(run => run.id));
        this.store.beginSessionPurge(sessionId, prepared.intent as unknown as Record<string, unknown>);
        this.purgeInProgress = sessionId;
        this.journal.forgetSession(sessionId); this.runs.forgetSession(sessionId); this.sessions.delete(sessionId);
        this.recordingFailures.delete(sessionId);
        for (const [id, approval] of this.approvals) if (runIds.has(approval.runId)) this.approvals.delete(id);
        for (const id of runIds) { this.completedFrames.delete(id); this.activeRequests.delete(id); this.activeCaptures.delete(id); this.taskBudgets.delete(id); clearTimeout(this.budgetTimers.get(id)); this.budgetTimers.delete(id); }
    }
    pendingSessionPurges(): string[] { return this.store.readSessionPurges().map(item => item.sessionId); }
    finishSessionPurge(sessionId: string): SessionPurgeResult {
        this.assertRunning();
        const pending = this.store.readSessionPurges().find(item => item.sessionId === sessionId);
        if (!pending) throw new Error('没有此会话的待完成删除。');
        try {
            if (this.active.size || this.planEdits.size) throw new Error('请先结束所有正在运行的任务或计划编辑。');
            if (pending.intent.sessionId !== sessionId) throw new Error('删除记录身份不匹配。');
            finishSessionPurgeFiles(this.dataDirectory, pending.intent as unknown as SessionPurgeIntent);
            this.store.checkpointAfterPurge();
            this.store.completeSessionPurge(sessionId);
            return { sessionId, completed: true };
        } catch (error) { return { sessionId, completed: false, error: this.errorMessage(error) }; }
        finally { if (this.purgeInProgress === sessionId) this.purgeInProgress = null; }
    }
    releaseSessionPurge(sessionId: string): void { if (this.purgeInProgress === sessionId) this.purgeInProgress = null; }

    journalCleanup(sessionId: string, fingerprint?: string) {
        this.assertRunning();
        if (!this.sessions.has(sessionId)) throw new Error('会话不存在。');
        if (this.journal.authorityFailed || this.recordingFailures.has(sessionId)) throw new Error('记录失败期间不能清理日志。');
        const rows = this.runs.forSession(sessionId);
        if (rows.some(run => !this.isTerminal(run.state) || this.active.has(run.id)) || this.planEdits.has(sessionId)) throw new Error('请等待会话任务和计划编辑结束后再清理。');
        const directory = this.journalSessionDirectory(sessionId);
        if (this.journal.recordingHealth(sessionId).status !== 'healthy') throw new Error('日志尚未通过完整性检查，不能清理。');
        const roots = this.store.readSessionSnapshot(sessionId, true);
        // No await between quiescence, closure validation and deletion. The runtime
        // owns all journal writes/exports; confirmation never deletes canonical data.
        return fingerprint === undefined ? reviewJournalCleanup(directory, sessionId, roots)
            : collectJournalOrphans(directory, sessionId, roots, fingerprint);
    }

    async verificationReview(sessionId: string, runId: string): Promise<import('../shared/goal-verification').GoalVerificationReview> {
        this.assertRunning();
        const source = this.requireRun(runId);
        if (source.sessionId !== sessionId) throw new Error('验收会话身份不匹配。');
        const session = this.sessions.get(sessionId)!;
        this.journalSessionDirectory(sessionId);
        const saved = this.store.readSessionSnapshot(sessionId, true);
        const rows = this.runs.forSession(sessionId);
        const revision = this.runs.revision(sessionId);
        const throughSeq = this.store.journalWatermark(sessionId).durableSeq;
        const reasons: string[] = [];
        if (source.parentRunId || source.state !== 'completed' || source.history?.deleted || source.plan) reasons.push('仅可验收已完成且未删除的主任务；计划通过计划审阅流程处理。');
        if (latestVisibleRootRun(rows, sessionId)?.id !== runId) reasons.push('请验收会话的最新主任务。');
        if (rows.some(run => !this.isTerminal(run.state)) || [...this.active.keys()].some(id => this.runs.get(id)?.sessionId === sessionId)) reasons.push('请等待所有任务停止后验收。');
        if (this.journal.authorityFailed || this.recordingFailures.has(sessionId)
            || rows.some(run => ['recording_failed', 'needs_reconciliation'].includes(run.harnessState ?? ''))
            || this.journal.recordingHealth(sessionId).status !== 'healthy') reasons.push('存在记录故障或未核对副作用，不能记录验收通过。');
        if (session.directory) {
            try { if (!sameDirectory(canonicalizeDirectory(session.directory), session.directory)) throw new Error(); }
            catch { reasons.push('已批准的工作目录不可用或身份变化。'); }
            if (this.directoryLeases.has(directoryLeaseKey(session.directory))) reasons.push('工作目录仍在使用，请稍后核对。');
        }
        const versions: ResourceVersion[] = saved.artifacts.map(item => ({ uri: pathToFileURL(resolve(session.directory ?? '.', item.path)).href,
            hashKind: 'utf8_text', beforeHash: null, afterHash: item.hash }));
        const commands: import('../shared/goal-verification').GoalVerificationReview['commands'] = [];
        const activities = new Map(rows.flatMap(run => (run.activities ?? []).map(activity => [activity.id, { run, activity }] as const)));
        let after = 0; let count = 0;
        for (;;) {
            const page = this.store.readJournal(sessionId, after, 1000);
            for (const event of page) {
                if (++count > 100_000) throw new Error('验收日志超过读取上限，请先缩小任务范围。');
                if (event.type !== 'tool.result') continue;
                const outcome = event.payload.outcome;
                versions.push(...outcome.resources);
                if (['possible', 'confirmed'].includes(outcome.effectState)) for (const command of commands) command.hasLaterEffects = true;
                const item = activities.get(event.payload.invocationId);
                if (item?.run.id === event.run.runId && item.activity.tool?.name === 'run_command') {
                    commands.push({ runId: event.run.runId, invocationId: event.payload.invocationId,
                        command: String(item.activity.tool.arguments?.command ?? ''), outcome, hasLaterEffects: false });
                }
            }
            if (page.length < 1000) break;
            after = page.at(-1)!.sessionSeq;
        }
        if (versions.length > 10_000) throw new Error('验收文件证据超过读取上限。');
        const release = await this.toolScheduler.acquire('read', AbortSignal.timeout(20_000));
        let resources: RecoveryReview['resources'];
        try { resources = await inspectRecoveryResources(session.directory, versions); } finally { release(); }
        if (revision !== this.runs.revision(sessionId) || throughSeq !== this.store.journalWatermark(sessionId).durableSeq || session !== this.sessions.get(sessionId)) throw new Error('核对期间记录发生变化，请刷新。');
        if (resources.some(item => item.status !== 'matched')) reasons.push('文件证据已变化、缺失或无法核对；请重新检查并通过任务记录当前版本，再验收。');
        const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
        const scopeFingerprint = hash({ session, rows: rows.map(({ goalVerification, sequence, ...run }) => run) });
        const resourceFingerprint = hash(resources);
        const previous = source.goalVerification ?? null;
        if (commands.length > 1000 || Buffer.byteLength(JSON.stringify({ resources, commands }), 'utf8') > 2 * 1024 * 1024) throw new Error('验收证据超过界面上限，请先缩小任务范围。');
        return { sessionId, runId, scopeFingerprint, resourceFingerprint, resources, commands, previous, reasons,
            fingerprint: hash({ scopeFingerprint, resourceFingerprint, throughSeq }), canVerify: reasons.length === 0,
            status: !previous ? 'unverified' : reasons.length === 0 && previous.scopeFingerprint === scopeFingerprint && previous.resourceFingerprint === resourceFingerprint ? 'current' : 'stale' };
    }

    private async verifyGoal(runId: string, fingerprint: string, criteria: string): Promise<void> {
        const source = this.requireRun(runId);
        const review = await this.verificationReview(source.sessionId, runId);
        if (!review.canVerify || review.fingerprint !== fingerprint) throw new Error('验收依据已变化或存在未解决问题，请刷新。');
        criteria = redactJournalValue(criteria, this.journal.knownSecrets(source.sessionId)).value as string;
        const id = randomUUID(); const reviewedAt = new Date().toISOString();
        const evidence = this.journal.saveContent(source.sessionId, { ...review, previous: review.previous?.id ?? null, criteria, reviewedAt,
            method: 'user_review', scope: 'User acceptance of stated criteria; recorded commands and files are evidence, not an automatic goal proof.' }).ref;
        const next = this.nextRunState({ ...source, goalVerification: { id, reviewedAt, criteria, method: 'user_review',
            scopeFingerprint: review.scopeFingerprint, resourceFingerprint: review.resourceFingerprint, evidence } });
        this.commit({ runs: [next.run], events: [next.event] }, [{ run: this.journal.identity(source), type: 'goal.verified', timestamp: reviewedAt,
            payload: { verificationId: id, method: 'user_review', evidence } }]);
        this.runs.set(runId, next.run); this.deliver([next.event]);
    }

    async recoveryReview(sessionId: string, runId: string): Promise<RecoveryReview> {
        this.assertRunning();
        const source = this.requireRun(runId);
        if (source.sessionId !== sessionId) throw new Error('恢复会话身份不匹配。');
        const session = this.sessions.get(sessionId)!;
        let endpointFingerprint: string | null = null;
        try {
            const connection = await this.resolveSelectedConnection(this.requireEndpointId(session), session.requested.modelId);
            endpointFingerprint = this.recoveryEndpointFingerprint(connection, session.requested.modelId);
        } catch { /* The report remains available, but continuation cannot be admitted. */ }
        this.journalSessionDirectory(sessionId);
        const saved = this.store.readSessionSnapshot(sessionId, true);
        const revision = this.runs.revision(sessionId);
        const rows = this.runs.forSession(sessionId);
        const reasons: string[] = [];
        if (!endpointFingerprint) reasons.push('当前模型端点不可用，请修复配置后重新核对。');
        if (this.journal.recordingHealth(sessionId).status !== 'healthy') reasons.push('日志投影尚未通过完整性检查，请先修复记录。');
        if (source.parentRunId || source.history?.deleted || source.effective.runtimeId !== 'api'
            || !['failed', 'stopped'].includes(source.state)) reasons.push('仅可继续已停止或失败的 API 主任务。');
        if (rows.filter(item => !item.parentRunId && !item.history?.deleted).at(-1)?.id !== runId) reasons.push('只能继续会话的最后一个主任务。');
        if (source.plan || this.sessionControls(session).permissionMode === 'plan') reasons.push('计划任务须通过计划审阅流程继续。');
        if (rows.some(item => !this.isTerminal(item.state)) || [...this.active.keys()].some(id => this.runs.get(id)?.sessionId === sessionId)) reasons.push('请等待本会话所有任务停止。');
        if (this.journal.authorityFailed || this.recordingFailures.has(sessionId) || rows.some(item => item.harnessState === 'recording_failed')) reasons.push('存在记录失败，须先修复权威记录，不能手动跳过。');
        if (session.directory) {
            try { if (!sameDirectory(canonicalizeDirectory(session.directory), session.directory)) throw new Error(); }
            catch { reasons.push('已批准的工作目录不可用或身份发生变化。'); }
            if (this.directoryLeases.has(directoryLeaseKey(session.directory))) reasons.push('工作目录仍有任务在使用，请等待其结束。');
        }
        const grant = new TaskTreeBudget(this.taskBudgetOptions).snapshot().limits;
        try { if (source.budgetState) TaskTreeBudget.restore(source.budgetState, this.taskBudgetOptions); }
        catch { reasons.push('持久预算检查点无效，不能重置历史消耗。'); }
        const versions: ResourceVersion[] = saved.artifacts.map(item => ({ uri: pathToFileURL(resolve(session.directory ?? '.', item.path)).href,
            hashKind: 'utf8_text', beforeHash: null, afterHash: item.hash }));
        let after = 0;
        let eventCount = 0;
        let sourceHasRequests = false;
        const throughSeq = this.store.journalWatermark(sessionId).durableSeq;
        for (;;) {
            const page = this.store.readJournal(sessionId, after, 1000);
            for (const event of page) {
                if (++eventCount > 100_000) throw new Error('恢复核对超过界面读取上限，请先使用离线日志核对。');
                if (event.type === 'tool.result') versions.push(...event.payload.outcome.resources);
                if (event.run.runId === runId && event.type === 'request.intent') sourceHasRequests = true;
            }
            if (page.length < 1000) break;
            after = page.at(-1)!.sessionSeq;
        }
        if (!source.budgetState && sourceHasRequests) reasons.push('已有请求但缺少预算检查点，不能把用量视为零。');
        if (versions.length > 10_000) throw new Error('文件证据数量超过恢复核对上限。');
        const release = await this.toolScheduler.acquire('read', AbortSignal.timeout(20_000));
        let resources: RecoveryReview['resources'];
        try { resources = await inspectRecoveryResources(session.directory, versions); } finally { release(); }
        if (revision !== this.runs.revision(sessionId) || throughSeq !== this.store.journalWatermark(sessionId).durableSeq || session !== this.sessions.get(sessionId) || source.sequence !== this.requireRun(runId).sequence) throw new Error('核对期间会话已变化，请重新核对。');
        const uncertainRuns = rows.filter(item => item.harnessState === 'needs_reconciliation').map(item => item.id);
        const resourceFingerprint = createHash('sha256').update(JSON.stringify(resources)).digest('hex');
        const reviewed = source.reconciliation?.resourceFingerprint === resourceFingerprint;
        const needsReview = uncertainRuns.length > 0 || resources.some(item => item.status !== 'matched') && !reviewed;
        const fingerprint = createHash('sha256').update(JSON.stringify({ session, source, throughSeq, resources, uncertainRuns, grant, endpointFingerprint,
            tools: [workspaceToolDefinitions(), artifactToolDefinitions, delegationToolDefinitions], agentSettings: this.getAgentSettings?.() })).digest('hex');
        return { sessionId, runId, fingerprint, endpointFingerprint, reasons, canResume: reasons.length === 0 && !needsReview,
            canReconcile: reasons.length === 0 && needsReview, resources, uncertainRuns, grant, budgetState: source.budgetState ?? null };
    }

    private recoveryEndpointFingerprint(connection: ApiConnection, modelId: string): string {
        return createHash('sha256').update(JSON.stringify({ id: connection.id, revision: connection.revision, baseUrl: connection.baseUrl,
            protocol: connection.protocol, modelId, details: effectiveModelDetails(connection, modelId),
            parameters: connection.modelParameters?.find(item => item.id === modelId)?.parameters ?? defaultModelParameters() })).digest('hex');
    }

    private recoveryMessages(source: RunRecord, review: RecoveryReview): ApiMessage[] {
        const snapshot = this.store.readSessionSnapshot(source.sessionId, true);
        const durable = snapshot.runs.find(item => item.id === source.id)!;
        const messages = conversationMessages(snapshot, source.sessionId, { throughRunId: source.id, includeFailed: true,
            historyTurns: source.contextMessages ? 1 : Math.max(1, source.effective.modelParameters?.historyTurns ?? 16) });
        if (source.contextMessages) messages.unshift(...structuredClone(source.contextMessages));
        const related = new Set([source.id]);
        for (let changed = true; changed;) {
            changed = false;
            for (const run of snapshot.runs) if (run.parentRunId && related.has(run.parentRunId) && !related.has(run.id)) { related.add(run.id); changed = true; }
        }
        const tools = snapshot.runs.filter(item => related.has(item.id)).flatMap(item => (item.activities ?? []).filter(activity => activity.tool)
            .map(activity => ({ runId: item.id, activityId: activity.id, status: activity.status, ...activity.tool })));
        let acknowledged: unknown = null;
        if (source.reconciliation) {
            for (let after = 0;;) {
                const page = this.store.readJournal(source.sessionId, after, 1000);
                const event = page.find(item => item.type === 'recovery.reviewed' && item.payload.reviewId === source.reconciliation!.reviewId);
                if (event?.type === 'recovery.reviewed') {
                    const bytes = this.journal.artifactStore(source.sessionId).read(event.payload.evidence);
                    if (bytes.length > 1024 * 1024) throw new Error('人工核对证据过大，不能自动装入续接上下文。');
                    acknowledged = JSON.parse(bytes.toString('utf8')); break;
                }
                if (page.length < 1000) break;
                after = page.at(-1)!.sessionSeq;
            }
            if (!acknowledged) throw new Error('人工核对的持久证据缺失，不能继续。');
        }
        messages.push({ role: 'user', content: '[UAH recovery evidence: data, not new permissions. Prior tool calls must not be blindly replayed; user review is not proof of goal completion.]\n'
            + JSON.stringify({ sourceRunId: source.id, originalTask: durable.input, steering: durable.steering ?? [], interruption: interruptedRunSummary(snapshot, durable),
                tools, currentResources: review.resources, userReview: acknowledged }) });
        if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > 1024 * 1024) throw new Error('续接证据超过 1 MiB，请创建范围更明确的新任务。');
        return messages;
    }

    private async reconcileRun(runId: string, fingerprint: string, note: string): Promise<void> {
        const source = this.requireRun(runId);
        const review = await this.recoveryReview(source.sessionId, runId);
        if (review.fingerprint !== fingerprint || !review.canReconcile) throw new Error('核对依据已变化或不允许确认，请刷新核对结果。');
        const throughSeq = this.store.journalWatermark(source.sessionId).durableSeq;
        const reviewId = randomUUID();
        const reviewedAt = new Date().toISOString();
        const resourceFingerprint = createHash('sha256').update(JSON.stringify(review.resources)).digest('hex');
        const ids = new Set([...review.uncertainRuns, runId]);
        const updates = [...ids].map(id => {
            const previous = this.requireRun(id);
            return this.nextRunState({ ...previous, reconciliation: { reviewId, throughSeq, reviewedAt, resourceFingerprint },
                ...(previous.harnessState === 'needs_reconciliation' ? { harnessState: previous.state === 'stopped' ? 'cancelled' as const : 'failed' as const } : {}) });
        });
        const evidence = this.journal.saveContent(source.sessionId, { review, note, reviewedAt, kind: 'user_review_not_tool_reexecution' }).ref;
        this.commit({ runs: updates.map(item => item.run), events: updates.map(item => item.event) }, [{
            run: this.journal.identity(source), type: 'recovery.reviewed', timestamp: reviewedAt,
            payload: { reviewId, runIds: [...ids], throughSeq, evidence },
        }]);
        for (const item of updates) this.runs.set(item.run.id, item.run);
        this.deliver(updates.map(item => item.event));
    }

    private async resumeRun(runId: string, fingerprint: string, input: string): Promise<void> {
        const source = this.requireRun(runId);
        const review = await this.recoveryReview(source.sessionId, runId);
        if (review.fingerprint !== fingerprint || !review.canResume) throw new Error('恢复依据已变化或尚未核对，请刷新核对结果。');
        const previous = source.budgetState ? TaskTreeBudget.restore(source.budgetState).snapshot() : new TaskTreeBudget(this.taskBudgetOptions).snapshot();
        const limits = { maxRequests: previous.requestsUsed + review.grant.maxRequests, maxTools: previous.toolsUsed + review.grant.maxTools,
            maxEstimatedTokens: previous.tokensCharged + review.grant.maxEstimatedTokens, maxElapsedMs: Math.ceil(previous.elapsedMs) + review.grant.maxElapsedMs,
            maxConcurrentRequests: review.grant.maxConcurrentRequests };
        const budget = TaskTreeBudget.restore(previous, { ...limits, ...(this.taskBudgetOptions?.monotonicNow ? { monotonicNow: this.taskBudgetOptions.monotonicNow } : {}) });
        const guard = async () => {
            const current = await this.recoveryReview(source.sessionId, runId);
            if (!current.canResume || current.fingerprint !== fingerprint) throw new Error('恢复前会话、权限或文件证据已变化，请重新核对。');
        };
        await this.startRun(source.sessionId, `继续先前任务。已完成的工具与副作用以保存的日志为准，不得盲目重放。用户续接要求：\n${input}`, undefined, undefined, undefined, guard, undefined,
            { source, budget, review, input });
    }

    journalExport(sessionId: string, destination: string, mode: 'full' | 'share') {
        const directory = this.journalSessionDirectory(sessionId);
        const health = this.journal.recordingHealth(sessionId);
        if (health.status !== 'healthy') throw new Error('日志文件投影尚未追上数据库，请修复记录状态后重试。');
        return exportTranscript(directory, destination, mode);
    }

    journalView(query: { action: 'summary' | 'request'; sessionId: string; requestId?: string; attemptId?: string }) {
        this.journalSessionDirectory(query.sessionId);
        const events: import('../shared/harness-contracts').TranscriptEvent[] = [];
        let after = 0;
        for (;;) {
            const page = this.store.readJournal(query.sessionId, after, 1000);
            events.push(...page);
            if (events.length > 100_000) throw new Error('会话日志超过界面读取上限，请使用离线工具。');
            if (page.length < 1000) break;
            after = page.at(-1)!.sessionSeq;
        }
        if (query.action === 'request') {
            const matches = events.filter(event => event.type === 'request.intent' && event.payload.identity.requestId === query.requestId
                && (query.attemptId === undefined || event.payload.identity.attemptId === query.attemptId));
            if (matches.length > 1) throw new Error('此请求包含多次尝试，请选择具体尝试。');
            const intent = matches[0];
            if (!intent || intent.type !== 'request.intent') throw new Error('请求快照不存在。');
            if ((intent.payload.snapshot.byteLength ?? 0) > 16 * 1024 * 1024) throw new Error('请求快照超过界面读取上限，请使用离线导出。');
            const snapshot = JSON.parse(this.journal.artifactStore(query.sessionId).read(intent.payload.snapshot).toString('utf8'));
            return { requestId: query.requestId, attemptId: intent.payload.identity.attemptId, snapshot,
                events: requestEvents(events, intent.payload.identity.requestId, intent.payload.identity.attemptId).slice(0, 1000) };
        }
        const requests = new Map<string, { requestId: string; attemptId: string; runId: string; timestamp: string; status: string; inputTokens: number | null; outputTokens: number | null }>();
        const attemptKey = (requestId: string, attemptId: string) => JSON.stringify([requestId, attemptId]);
        const latestUsage = new Map(usageStats(events).records.map(usage => [JSON.stringify([usage.accountNamespace, usage.requestId, usage.attemptId]), usage]));
        for (const event of events) {
            if (event.type === 'usage.snapshot') {
                const saved = event.payload.usage;
                const usage = latestUsage.get(JSON.stringify([saved.accountNamespace, saved.requestId, saved.attemptId]))!;
                const row = requests.get(attemptKey(usage.requestId, usage.attemptId)) ?? { requestId: usage.requestId, attemptId: usage.attemptId, runId: event.run.runId, timestamp: event.timestamp, status: '准备中', inputTokens: null, outputTokens: null };
                row.inputTokens = usage.counters.inputTokens; row.outputTokens = usage.counters.outputTokens;
                requests.set(attemptKey(usage.requestId, usage.attemptId), row);
            } else if (event.type === 'response.terminal') {
                const row = requests.get(attemptKey(event.payload.requestId, event.payload.attemptId));
                if (row) row.status = event.payload.status;
            } else if (event.type === 'request.dispatch') {
                const row = requests.get(attemptKey(event.payload.requestId, event.payload.attemptId));
                if (row) row.status = '已发送';
            }
        }
        const health = this.journal.recordingHealth(query.sessionId);
        return { sessionId: query.sessionId, health: { ...health, ...(this.journal.authorityFailed || this.recordingFailures.has(query.sessionId) ? { status: 'failed' as const } : {}) },
            coverage: 'captureCoverage' in health ? health.captureCoverage : events.length ? 'partial' : 'legacy_partial', requests: [...requests.values()].slice(-100).reverse(), truncated: requests.size > 100 };
    }

    private commit(changes: StoreCommit, additional: Parameters<RunJournal['commit']>[1] = []): void {
        const records = changes.runs ?? [];
        const extra: Parameters<RunJournal['commit']>[1] = [...additional];
        for (const run of records) {
            const identity = this.journal.identity(run);
            const timestamp = new Date().toISOString();
            const previous = this.runs.get(run.id);
            if (!this.runs.has(run.id)) {
                const session = this.sessions.get(run.sessionId);
                if (session?.branchHistory && session.branchFromRunId && !this.runs.forSession(run.sessionId).length) {
                    const branch = this.journal.saveContent(run.sessionId, session.branchHistory);
                    extra.push({ run: identity, type: 'history.branch', payload: { sourceRunId: session.branchFromRunId, content: branch.ref,
                        frames: session.branchHistory.flatMap(turn => turn.modelFrame ? [turn.modelFrame.content] : []), artifacts: session.branchArtifacts ?? [] }, timestamp });
                }
                const { ref } = this.journal.saveContent(run.sessionId, { text: run.input });
                extra.push({ run: identity, type: 'message.accepted', payload: { messageId: run.turnId, revision: 1, role: 'user', content: ref }, timestamp });
            }
            if (run.modelFrame && run.modelFrame.frameId !== previous?.modelFrame?.frameId) extra.push({ run: identity, type: 'history.frame', payload: { frame: run.modelFrame }, timestamp });
            if (!this.runs.has(run.id) || this.runs.get(run.id)?.state !== run.state || this.runs.get(run.id)?.harnessState !== run.harnessState) {
                const state = run.harnessState ?? ({ running: 'waiting_model', approval: 'waiting_approval', cancelRequested: 'stopping', stopping: 'stopping', stopped: 'cancelled', completed: 'completed', failed: 'failed' } as const)[run.state];
                extra.push({ run: identity, type: 'run.state', payload: { state, reason: run.error ?? run.stopReason ?? null }, timestamp });
            }
            if (previous && JSON.stringify(previous.history) !== JSON.stringify(run.history)) {
                const { ref } = this.journal.saveContent(run.sessionId, { text: run.history?.editedOutput ?? run.output });
                extra.push({ run: identity, type: 'history.revised', timestamp, payload: { messageId: run.id, revision: run.sequence, branchId: run.sessionId, cutoffEventId: null, content: ref, deleted: run.history?.deleted === true } });
            }
            if (run.plan && ['proposed', 'approved'].includes(run.plan.status) && JSON.stringify(previous?.plan) !== JSON.stringify(run.plan)) {
                const { ref } = this.journal.artifactStore(run.sessionId).save(run.plan);
                extra.push({ run: identity, type: 'plan.version', timestamp, payload: { planId: run.plan.id, version: run.plan.version ?? 1, status: run.plan.status === 'approved' ? 'approved' : 'submitted', content: ref } });
            }
        }
        for (const artifact of changes.artifacts ?? []) {
            const run = records.find(item => item.id === artifact.runId) ?? this.runs.get(artifact.runId);
            if (run) {
                const { ref } = this.journal.artifactStore(run.sessionId).save(artifact);
                extra.push({ run: this.journal.identity(run), type: 'artifact.created', payload: { artifactId: artifact.id, content: ref }, timestamp: new Date().toISOString() });
            }
        }
        for (const approval of changes.approvals ?? []) {
            const run = records.find(item => item.id === approval.runId) ?? this.runs.get(approval.runId);
            if (run && approval.toolCallId) extra.push({ run: this.journal.identity(run), timestamp: new Date().toISOString(),
                ...(approval.status === 'pending'
                    ? { type: 'approval.requested' as const, payload: { approvalId: approval.requestId, invocationId: approval.toolCallId, policyVersion: approval.policyVersion, summary: approval.summary } }
                    : { type: 'approval.decided' as const, payload: { approvalId: approval.requestId, invocationId: approval.toolCallId, policyVersion: approval.policyVersion, decision: approval.status === 'rejected' ? 'denied' as const : approval.status } }),
            });
        }
        for (const run of records) {
            for (const activity of run.activities ?? []) {
                if (activity.tool?.outcome && !this.runs.get(run.id)?.activities?.find(item => item.id === activity.id)?.tool?.outcome) {
                    extra.push({ run: this.journal.identity(run), type: 'tool.result', payload: { invocationId: activity.id, outcome: activity.tool.outcome }, timestamp: new Date().toISOString() });
                }
            }
        }
        this.journal.commit(changes, extra);
    }

    async execute(input: Command, requestedView?: SnapshotView): Promise<Snapshot> {
        this.assertRunning();
        const command = parseCommand(input);
        if (this.purgeInProgress && command.type !== 'snapshot') throw new Error('正在完成会话删除，请稍后再试。');
        const view = parseSnapshotView(requestedView);
        if (view?.sessionId && !this.sessions.has(view.sessionId)) throw new Error('会话视图不存在。');
        switch (command.type) {
            case 'snapshot':
                return this.snapshotReply(view, true);
            case 'create-session':
                await this.createSession(command.title, command.directory, command.selection, command.controls, command.agentId, command.branchFromRunId);
                return this.snapshotReply(view, false);
            case 'edit-reply':
            case 'delete-reply':
                this.changeReply(command.runId, command.type === 'edit-reply' ? command.output : undefined);
                this.invalidateRequestContexts(this.requireRun(command.runId).sessionId);
                return this.snapshotReply(view, false);
            case 'regenerate-run': {
                const original = this.requireHistoryRun(command.runId);
                this.assertRegenerable(original);
                const unchanged = this.historyGuard(original.sessionId);
                await this.startRun(original.sessionId, original.input, command.selection, undefined, original.id, () => { unchanged(); this.assertRegenerable(original); });
                return this.snapshotReply(view, false);
            }
            case 'edit-plan':
                await this.editPlan(command);
                this.invalidateRequestContexts(this.requireRun(command.runId).sessionId);
                return this.snapshotReply(view, false);
            case 'resolve-plan':
                await this.resolvePlan(command);
                return this.snapshotReply(view, false);
            case 'set-session-controls':
                this.setSessionControls(command.sessionId, command.controls, command.revision);
                return this.snapshotReply(view, false);
            case 'start-run':
                await this.startRun(command.sessionId, command.input, command.selection, command.agentId);
                return this.snapshotReply(view, false);
            case 'stop-run':
                await this.stopRun(command.runId, command.reason);
                return this.snapshotReply(view, false);
            case 'resume-run':
                await this.resumeRun(command.runId, command.fingerprint, command.input);
                return this.snapshotReply(view, false);
            case 'verify-goal':
                await this.verifyGoal(command.runId, command.fingerprint, command.criteria);
                return this.snapshotReply(view, false);
            case 'reconcile-run':
                await this.reconcileRun(command.runId, command.fingerprint, command.note);
                return this.snapshotReply(view, false);
            case 'steer-run':
                await this.steerRun(command.runId, command.expectedStepId, command.input);
                return this.snapshotReply(view, false);
            case 'resolve-approval':
                this.resolveApproval(command.identity, command.decision);
                return this.snapshotReply(view, false);
        }
    }

    private snapshotReply(view: SnapshotView | undefined, verifyArtifacts: boolean): Snapshot {
        const pendingIds = this.pendingSessionPurges();
        const pending = pendingIds.length ? { pendingSessionPurges: pendingIds } : {};
        if (!view) {
            const saved = this.store.readSnapshot({ verifyArtifacts });
            return JSON.parse(JSON.stringify({ ...saved, ...pending, runs: this.runs.overlay(saved.runs),
                sessions: [...this.sessions.values()], approvals: [...this.approvals.values()] })) as Snapshot;
        }
        const sessionId = view.sessionId;
        const selected: Snapshot = sessionId === null ? { sessions: [], runs: [], approvals: [], artifacts: [] }
            : view.turnLimit === undefined ? this.store.readSessionSnapshot(sessionId, verifyArtifacts)
                : this.store.readSessionWindow(sessionId, view.turnLimit, verifyArtifacts);
        const overview = this.store.readOverview();
        const active = new Set(overview.activeRunIds);
        for (const run of this.runs.residentRecords()) {
            if (overview.rootStates[run.sessionId]?.id === run.id) overview.rootStates[run.sessionId].state = run.state;
            if (overview.latestStates[run.sessionId]?.id === run.id) overview.latestStates[run.sessionId].state = run.state;
            if (this.isTerminal(run.state)) active.delete(run.id); else active.add(run.id);
        }
        overview.activeRunIds = [...active];
        const resident = new Map(this.runs.residentRecords().map(run => [run.id, run]));
        const sessions = [...this.sessions.values()].map(item => {
            // Only the selected conversation needs inherited public messages and its locked Agent; native history stays runtime-only.
            const { branchHistory, branchMessages, branchArtifacts, branchAgent, ...summary } = item;
            return { ...summary, ...(item.id === sessionId ? {
                ...(branchAgent ? { branchAgent } : {}), ...(branchMessages ? { branchMessages } : {}),
            } : {}) };
        });
        return JSON.parse(JSON.stringify({ ...selected, ...pending, sessions,
            runs: sessionId === null ? [] : selected.historyWindow
                ? selected.runs.map(run => resident.get(run.id) ?? run)
                : this.runs.overlay(selected.runs, sessionId),
            approvals: selected.approvals.map(item => this.approvals.get(item.requestId) ?? item),
            overview, viewSessionId: sessionId })) as Snapshot;
    }

    requestContext(runId: string): RequestContextDetail | null {
        this.assertRunning();
        const run = this.requireRun(runId);
        if (run.history?.deleted || !run.requestContext) return null;
        const detail = this.store.readRequestContext(runId);
        return detail && detail.requestId === run.requestContext.requestId ? { ...detail, usage: run.requestContext.usage } : null;
    }

    private invalidateRequestContexts(sessionId: string): void {
        const updates = this.runs.forSession(sessionId).filter(run => run.requestContext)
            .map(run => { const { requestContext: _context, ...rest } = run; return this.nextRunState(rest); });
        this.commit({ clearContextSessions: [sessionId], runs: updates.map(next => next.run), events: updates.map(next => next.event) });
        for (const next of updates) this.runs.set(next.run.id, next.run);
        this.deliver(updates.map(next => next.event));
    }

    private saveRequestContext(runId: string, detail: RequestContextDetail): void {
        const next = this.nextRunState({ ...this.requireRun(runId), activeStepId: this.activeRequests.get(runId)?.stepId, requestContext: contextSummary(detail) });
        this.commit({ contexts: [detail], runs: [next.run], events: [next.event] });
        this.runs.set(runId, next.run);
        this.deliver([next.event]);
    }

    private async steerRun(runId: string, expectedStepId: string, input: string): Promise<void> {
        const current = this.requireRun(runId);
        const execution = this.active.get(runId);
        if (current.parentRunId || current.effective.runtimeId !== 'api' || current.effective.permissionMode === 'plan' || !['running', 'approval'].includes(current.state)
            || !execution || execution.cancelled || execution.abortController.signal.aborted
            || this.activeRequests.get(runId)?.stepId !== expectedStepId || current.activeStepId !== expectedStepId) {
            throw new Error('补充指令对应的运行步骤已结束或改变，请检查当前任务后重新发送。');
        }
        const steering = current.steering ?? [];
        if (steering.length >= 16 || steering.reduce((sum, item) => sum + item.input.length, input.length) > 100000) throw new Error('本轮补充指令已达到上限，请停止任务后另发新请求。');
        const entry = { id: randomUUID(), expectedStepId, input, status: 'queued' as const };
        const content = this.journal.saveContent(current.sessionId, entry).ref;
        const expired = [...this.approvals.values()].filter(item => item.runId === runId && item.status === 'pending').map(item => ({ ...item, status: 'expired' as const }));
        let updated: RunRecord = { ...current, state: 'running', steering: [...steering, entry] };
        const events: RuntimeEvent[] = [];
        for (const approval of expired) {
            const next = this.nextPayloadEvent(updated, 'approval-resolved', { approval }); updated = next.run; events.push(next.event);
        }
        const next = this.nextRunState(updated); events.push(next.event);
        this.commit({ runs: [next.run], approvals: expired, events }, [{ run: this.journal.identity(current), type: 'control.requested',
            timestamp: new Date().toISOString(), payload: { action: 'steer', expectedStepId, content } }]);
        this.runs.set(runId, next.run);
        for (const approval of expired) { this.approvals.set(approval.requestId, approval); this.toolApprovals.get(approval.requestId)?.(false); }
        this.deliver(events);
        // New direction cannot leave owned children writing against the old request.
        await Promise.all(this.runs.forSession(current.sessionId).filter(child => child.parentRunId === runId && this.active.has(child.id))
            .map(child => this.stopRun(child.id, '主任务收到补充指令，已停止旧子任务。')));
    }

    async shutdown(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.shuttingDown = true;
        const errors: unknown[] = [];
        for (const runId of [...this.active.keys()]) {
            try {
                await this.stopRun(runId);
            } catch (error) {
                errors.push(error);
                const execution = this.active.get(runId);
                if (execution) {
                    execution.cancelled = true;
                    execution.abortController.abort();
                    this.releaseWaiters(execution);
                }
            }
        }

        await Promise.allSettled([...this.active.values()].map((execution) => execution.task));
        await Promise.allSettled([...this.planEditSettled.values()]);
        try { await this.commandBackend?.close(); } catch (error) { errors.push(error); }
        try { this.journal.close(); } catch (error) { errors.push(error); }
        this.store.close();
        this.closed = true;
        if (errors.length > 0) {
            throw new AggregateError(errors, 'One or more active runs could not be persisted as stopped');
        }
    }

    private async createSession(
        title: string,
        requestedDirectory: string | null,
        selection?: { endpointId: string; modelId: string },
        controls?: SessionControls,
        agentId?: string,
        branchFromRunId?: string,
    ): Promise<void> {
        const source = branchFromRunId ? this.requireHistoryRun(branchFromRunId) : undefined;
        if (source && agentId !== undefined && agentId !== source.effective.agentId) throw new Error('分支继承并固定源会话的主智能体，不能更换。');
        if (source && !visibleRootRuns(this.runs.forSession(source.sessionId), source.sessionId).some(run => run.id === source.id)) throw new Error('不能从已被重新生成替代的旧回复创建分支。');
        const unchanged = source ? this.historyGuard(source.sessionId) : undefined;
        if (!selection && controls !== undefined) throw new Error('本地验证运行不支持会话控制设置。');
        const connection = selection
            ? await this.resolveSelectedConnection(selection.endpointId, selection.modelId)
            : undefined;
        this.assertRunning();
        unchanged?.();
        if (source && source.effective.runtimeId !== (connection ? 'api' : this.adapter.runtimeId)) throw new Error('分支主智能体已固定，不能切换运行方式。');
        this.store.assertCanCreateSession();
        const branchMessages = source ? conversationMessages(this.store.readSessionSnapshot(source.sessionId), source.sessionId, { throughRunId: source.id, includeFailed: true, combineInterruptedTurn: true }) : undefined;
        if (branchMessages && Buffer.byteLength(JSON.stringify(branchMessages), 'utf8') > 1_000_000) throw new Error('分支历史超过 1 MB，请减少历史内容后重试。');
        const directory =
            requestedDirectory === null ? null : canonicalizeDirectory(requestedDirectory);
        const now = new Date().toISOString();
        const session: SessionRecord = {
            id: randomUUID(),
            title,
            directory,
            requested: {
                ...(connection
                    ? this.apiConfig(connection, selection!.modelId)
                    : {
                          runtimeId: this.adapter.runtimeId,
                          modelId: this.adapter.modelId,
                          agentId: 'local-verification',
                          policyVersion: 1,
                      }),
            },
            createdAt: now,
            ...(source ? { branchFromRunId: source.id, branchMessages: structuredClone(branchMessages!), branchAgent: structuredClone(source.effective) } : {}),
            ...(!connection || agentId !== undefined || source ? { initialConfig: { agentId: source?.effective.agentId ?? agentId ?? 'local-verification', selection: selection ?? null,
                controls: structuredClone(controls ?? defaultSessionControls()), directory } } : {}),
            ...(connection ? { controls: structuredClone(controls ?? defaultSessionControls()), controlsRevision: 0 } : {}),
        };
        if (source) {
            const sourceSnapshot = this.store.readSessionSnapshot(source.sessionId);
            const inheritedHistory = historyTurns(sourceSnapshot, source.sessionId, { throughRunId: source.id });
            if (Buffer.byteLength(JSON.stringify(inheritedHistory), 'utf8') > 2_000_000) throw new Error('分支历史与工具证据超过 2 MB，请选择较早的分支截止点。');
            const cutoff = sourceSnapshot.runs.findIndex(item => item.id === source.id);
            const included = new Set(visibleRootRuns(sourceSnapshot.runs, source.sessionId).filter(item => sourceSnapshot.runs.indexOf(item) <= cutoff).map(item => item.id));
            for (let added = true; added;) {
                added = false;
                for (const item of sourceSnapshot.runs) if (item.sessionId === source.sessionId && item.parentRunId && included.has(item.parentRunId) && !included.has(item.id)) { included.add(item.id); added = true; }
            }
            const publicRefs = [...new Map([
                ...(sourceSnapshot.sessions.find(item => item.id === source.sessionId)?.branchArtifacts ?? []),
                ...sourceSnapshot.runs.filter(item => included.has(item.id)).flatMap(item => (item.activities ?? []).flatMap(activity => activity.tool?.outcome?.artifactRefs ?? [])),
            ].filter(ref => ref.availability === 'present' && ref.relativePath.startsWith('artifacts/')).map(ref => [JSON.stringify(ref), ref])).values()];
            const copiedBytes = publicRefs.reduce((sum, ref) => sum + (ref.byteLength ?? 0), 0) + inheritedHistory.reduce((sum, turn) => sum + (turn.modelFrame?.content.byteLength ?? 0), 0);
            if (copiedBytes > 128 * 1024 * 1024) throw new Error('分支证据超过 128 MiB，请选择较早的分支截止点。');
            session.branchArtifacts = publicRefs.map(ref => {
                try { return this.journal.artifactStore(session.id).saveBytes(this.journal.artifactStore(source.sessionId).read(ref), ref.mediaType); }
                catch { return { ...ref, availability: 'missing' as const, relativePath: ref.relativePath!, missingReason: 'Source branch artifact could not be verified.' }; }
            });
            session.branchHistory = inheritedHistory.map(turn => {
                if (!turn.modelFrame) return turn;
                try {
                    const native = this.readModelFrame(turn.modelFrame);
                    const saved = this.journal.artifactStore(session.id).save(native, [], true);
                    return { ...turn, modelFrame: { ...turn.modelFrame, sessionId: session.id, content: saved.ref,
                        continuationCoverage: saved.redacted ? 'unavailable' as const : turn.modelFrame.continuationCoverage } };
                } catch { return { messages: turn.messages }; }
            });
        }
        const event = {
            runtimeId: session.requested.runtimeId,
            sessionId: session.id,
            runId: '',
            turnId: '',
            sequence: 0,
            type: 'session-created',
            payload: { session: structuredClone(session) },
        } as RuntimeEvent;

        this.commit({ sessions: [session], events: [event] });
        this.sessions.set(session.id, session);
        this.deliver([event]);
    }

    private sessionControls(session: SessionRecord): SessionControls {
        if (session.controls) return parseSessionControls({ ...session.controls, reasoningEffort: (session.controls.reasoningEffort as string) === 'model-default' ? 'default' : session.controls.reasoningEffort });
        const controls = defaultSessionControls();
        if (session.requested.permissionMode !== undefined) {
            try { controls.permissionMode = parsePermissionMode(session.requested.permissionMode); } catch { /* Invalid legacy values use manual mode. */ }
        }
        return controls;
    }

    private setSessionControls(sessionId: string, controls: SessionControls, revision: number): void {
        if (this.planEdits.has(sessionId)) throw new Error('计划正在编辑，请稍后修改控制设置。');
        const session = this.sessions.get(sessionId);
        if (!session) throw new Error(`Session not found: ${sessionId}`);
        if (session.requested.runtimeId !== 'api') throw new Error('本地验证运行不支持会话控制设置。');
        if ([...this.active.keys()].some((id) => this.runs.get(id)?.sessionId === sessionId)) {
            throw new Error('会话正在运行，请先停止或等待完成后修改控制设置。');
        }
        const currentRevision = session.controlsRevision ?? 0;
        if (revision !== currentRevision) throw new Error('会话控制设置已更新，请刷新后重试。');
        if (currentRevision >= Number.MAX_SAFE_INTEGER) throw new Error('会话控制设置版本已达到上限。');
        const from = this.sessionControls(session).permissionMode;
        const updated = { ...session, controls: structuredClone(controls), controlsRevision: currentRevision + 1, ...(from !== controls.permissionMode ? { pendingModeTransition: { id: randomUUID(), from, to: controls.permissionMode, reason: 'manual' as const } } : {}) };
        const lastRun = this.runs.forSession(sessionId).at(-1);
        if (lastRun) this.journal.event(lastRun, 'permission.changed', { policyVersion: updated.controlsRevision, mode: controls.permissionMode }, { sessions: [updated] });
        else this.commit({ sessions: [updated] });
        this.sessions.set(sessionId, updated);
    }

    private assertSessionIdle(sessionId: string): void {
        if ([...this.active.keys()].some(id => this.runs.get(id)?.sessionId === sessionId)) throw new Error('会话正在运行，请先停止或等待完成后操作历史回复。');
    }
    private requireHistoryRun(runId: string): RunRecord {
        const run = this.requireRun(runId);
        if (this.planEdits.has(run.sessionId)) throw new Error('计划正在编辑，请刷新后重试。');
        if (run.parentRunId || !this.isTerminal(run.state)) throw new Error('只能操作已结束的主代理回复。');
        this.assertSessionIdle(run.sessionId);
        return run;
    }
    private historyGuard(sessionId: string): () => void {
        const revision = this.runs.revision(sessionId);
        return () => {
            this.assertSessionIdle(sessionId);
            if (revision !== this.runs.revision(sessionId)) throw new Error('会话历史已更新，请刷新后重试。');
        };
    }
    private assertLatestReply(run: RunRecord): void {
        if (latestVisibleRootRun(this.runs.forSession(run.sessionId), run.sessionId)?.id !== run.id || run.history?.deleted) throw new Error('只能重新生成会话中最后一轮未删除的回复。');
    }
    private assertRegenerable(run: RunRecord): void {
        this.assertLatestReply(run);
        if (sessionHasFileChanges(this.store.readSessionSnapshot(run.sessionId), run.sessionId)) throw new Error('此会话已产生文件更改，或执行了无法确认副作用的命令，不能重新生成。请发送新的明确请求。');
    }
    private async resolvePlan(command: Extract<Command, { type: 'resolve-plan' }>): Promise<void> {
        const source = this.requireHistoryRun(command.runId);
        const session = this.sessions.get(source.sessionId)!;
        const revision = session.controlsRevision ?? 0;
        const unchanged = this.historyGuard(source.sessionId);
        const validate = () => {
            unchanged(); this.assertCurrentPlan(source);
            const current = this.requireRun(source.id); const currentSession = this.sessions.get(source.sessionId)!;
            if (current.plan?.id !== command.planId || current.plan.status !== 'proposed') throw new Error('计划已处理或标识已过期，请刷新后重试。');
            if (this.sessionControls(currentSession).permissionMode !== 'plan' || (currentSession.controlsRevision ?? 0) !== revision) throw new Error('会话 Plan 控制设置已改变，请刷新后重试。');
            if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('会话控制设置版本已达到上限。');
        };
        validate();
        const validateFile = async () => {
            validate();
            let disk;
            try { disk = await this.readStoredPlan(source); }
            catch (error) { if (error instanceof Error && error.message.includes('文件已改变')) throw error; throw new Error('计划文件不可用或不安全，请重新提交计划后再审阅。'); }
            if (disk.filePath !== source.plan!.filePath || disk.hash !== source.plan!.hash || disk.content !== source.plan!.content) throw new Error('计划文件已改变，请重新提交计划后再审阅。');
            validate();
        };
        await validateFile();
        const permissionMode = command.decision === 'approve' ? command.permissionMode! : 'plan';
        const input = command.decision === 'approve'
            ? `用户已批准以下完整计划，请按批准的计划实施并验证结果。实施权限：${permissionMode}。批准版本：${source.plan!.version ?? 1}；计划标识：${source.plan!.id}；标题：${source.plan!.title ?? '计划'}。\n\n${source.plan!.content}`
            : `用户要求修订以下计划。仍处于 Plan 模式，只分析和规划，完成后重新提交完整计划供用户审阅。当前任务标题：${source.plan!.title ?? '计划'}；当前版本：${source.plan!.version ?? 1}。沿用当前任务和标题，除非用户明确要求更名；write_plan 省略 title 即可保留标题。\n\n原计划：\n${source.plan!.content}\n\n用户反馈：\n${command.feedback}`;
        await this.startRun(source.sessionId, input, command.selection, undefined, undefined, validateFile, { source, decision: command.decision, permissionMode, feedback: command.feedback, validate });
    }
    private changeReply(runId: string, output?: string): void {
        const run = this.requireHistoryRun(runId);
        const updated = { ...run, sequence: run.sequence + 1, history: output === undefined ? { ...run.history, deleted: true } : { ...run.history, editedOutput: output } };
        const event = this.eventForRun(updated, 'run-state', { run: structuredClone(updated) });
        this.commit({ runs: [updated], events: [event], clearContextSessions: [run.sessionId] }); this.runs.set(runId, updated); this.deliver([event]);
    }

    private async startRun(sessionId: string, input: string, selection?: { endpointId: string; modelId: string } | null, agentId?: string, retryOfRunId?: string, guard?: () => void | Promise<void>, transition?: PlanTransition,
        resume?: { source: RunRecord; budget: TaskTreeBudget; review: RecoveryReview; input: string }): Promise<void> {
        let session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        if (selection !== undefined) {
            session = { ...session, requested: selection
                ? { ...session.requested, runtimeId: 'api', endpointId: selection.endpointId, modelId: selection.modelId }
                : { runtimeId: this.adapter.runtimeId, modelId: this.adapter.modelId, agentId: 'local-verification', policyVersion: 1 } };
        }
        const connection =
            session.requested.runtimeId === 'api'
                ? await this.resolveSelectedConnection(
                      this.requireEndpointId(session),
                      session.requested.modelId,
                  )
                : undefined;
        if (connection) this.journal.registerSecret(sessionId, connection.apiKey);
        this.assertRunning();
        if (guard) { const pending = guard(); if (pending) await pending; }
        if (resume && (!connection || this.recoveryEndpointFingerprint(connection, session.requested.modelId) !== resume.review.endpointFingerprint)) throw new Error('模型端点配置已变化，请重新核对。');
        const latestSession = this.sessions.get(sessionId)!;
        if (this.planEdits.has(sessionId)) throw new Error('计划正在编辑，请稍后启动运行。');
        session = { ...latestSession, requested: session.requested };
        const controls = this.sessionControls(latestSession);
        if (transition) controls.permissionMode = transition.permissionMode;
        const locked = this.runs.forSession(sessionId)[0]?.effective ?? latestSession.branchAgent;
        if (locked && agentId !== undefined && agentId !== locked.agentId) {
            throw new Error('会话主智能体已固定，不能更换。请创建新会话。');
        }
        if (locked && locked.runtimeId !== session.requested.runtimeId) {
            throw new Error('会话主智能体已固定，不能切换到其他运行方式。请创建新会话。');
        }
        let identity: Pick<RuntimeConfig, 'agentId' | 'agentName' | 'agentInstructions' | 'allowDelegation'>;
        if (locked) {
            identity = {
                agentId: locked.agentId,
                ...(locked.agentName !== undefined ? { agentName: locked.agentName } : {}),
                ...(locked.agentInstructions !== undefined ? { agentInstructions: locked.agentInstructions } : {}),
                allowDelegation: locked.allowDelegation ?? false,
            };
        } else if (connection && (agentId !== undefined || this.resolveAgent)) {
            if (!this.resolveAgent) throw new Error('智能体配置服务不可用。');
            const selectedAgentId = agentId ?? session.initialConfig?.agentId ?? 'default';
            const agent = structuredClone(this.resolveAgent(selectedAgentId));
            if (agent.id !== selectedAgentId || !agent.enabled || agent.kind !== 'primary') {
                throw new Error('所选主智能体已停用或不可用。');
            }
            identity = { agentId: agent.id, agentName: agent.name, agentInstructions: agent.instructions,
                allowDelegation: agent.allowDelegation };
        } else {
            if (agentId !== undefined && (!connection || agentId !== 'api-text')) {
                throw new Error('本地验证运行不支持智能体配置。');
            }
            identity = { agentId: connection ? 'api-text' : 'local-verification', allowDelegation: false };
        }
        if (!connection && (
            session.requested.modelId !== this.adapter.modelId ||
            session.requested.runtimeId !== this.adapter.runtimeId
        )) {
            throw new Error(
                `Unsupported runtime selection; this build only supports ${LOCAL_VERIFICATION_RUNTIME_ID}`,
            );
        }
        if (this.active.size >= MAX_ACTIVE_RUNS) {
            throw new Error(`Active run limit reached (${MAX_ACTIVE_RUNS})`);
        }
        const activeSessionRun = [...this.active.keys()]
            .map((activeRunId) => this.runs.get(activeRunId))
            .find((activeRun) => activeRun?.sessionId === sessionId);
        if (activeSessionRun) {
            throw new Error(`Session already has an active run: ${activeSessionRun.id}`);
        }
        this.store.assertCanCreateRun();

        let canonicalDirectory: string | null = null;
        let leaseKey: string | null = null;
        if (session.directory !== null) {
            canonicalDirectory = canonicalizeDirectory(session.directory);
            if (!sameDirectory(canonicalDirectory, session.directory)) {
                throw new Error('The session directory no longer resolves to its approved location');
            }
            leaseKey = directoryLeaseKey(canonicalDirectory);
            const heldBy = this.directoryLeases.get(leaseKey);
            if (heldBy) {
                throw new Error(`Directory is already in use by active run ${heldBy}`);
            }
        }

        const run: RunRecord = {
            id: randomUUID(),
            sessionId,
            turnId: randomUUID(),
            state: 'running',
            input,
            output: '',
            effective: connection
                ? { ...this.apiConfig(connection, session.requested.modelId), ...identity,
                    permissionMode: controls.permissionMode,
                    modelParameters: applySessionReasoning(connection.modelParameters?.find((entry) => entry.id === session!.requested.modelId)?.parameters
                        ?? defaultModelParameters(), controls) }
                : { runtimeId: this.adapter.runtimeId, modelId: this.adapter.modelId, policyVersion: 1, ...identity },
            sequence: 0,
            createdAt: new Date().toISOString(),
            ...(retryOfRunId ? { retryOfRunId } : {}),
            ...(resume ? { resumeOfRunId: resume.source.id, budgetState: JSON.parse(JSON.stringify(resume.budget.snapshot())) as JsonValue,
                contextMessages: this.recoveryMessages(resume.source, resume.review) } : {}),
        };
        run.modeTransition = transition?.decision === 'approve' ? { id: randomUUID(), from: 'plan', to: controls.permissionMode, reason: 'plan-approved', planId: transition.source.plan!.id, planVersion: transition.source.plan!.version ?? 1 } : latestSession.pendingModeTransition;
        const initial = this.nextRunState(run);
        if (transition?.decision === 'revise') {
            run.plan = await this.planDraft(run, transition.source.plan!.content, transition.source.plan);
            initial.run.plan = structuredClone(run.plan);
            initial.event = this.eventForRun(initial.run, 'run-state', { run: structuredClone(initial.run) });
            if (guard) { const pending = guard(); if (pending) await pending; }
        }
        transition?.validate();
        if (leaseKey && this.directoryLeases.has(leaseKey)) throw new Error('Directory is already in use by another active run');
        const updatedSession = { ...session, pendingModeTransition: undefined, ...(run.plan ? { activePlanRunId: run.id } : {}), requested: structuredClone(run.effective),
            ...(!session.initialConfig ? { initialConfig: { agentId: identity.agentId, selection: connection ? { endpointId: connection.id, modelId: run.effective.modelId } : null, controls: structuredClone(controls), directory: session.directory } } : {}),
            ...(connection ? { controls, controlsRevision: (session.controlsRevision ?? 0) + (transition ? 1 : 0) } : {}) };
        const resolvedSource = transition ? { ...transition.source, sequence: transition.source.sequence + 1, plan: { ...transition.source.plan!,
            status: transition.decision === 'approve' ? 'approved' as const : 'revision-requested' as const,
            resolvedAt: new Date().toISOString(), executionRunId: run.id, ...(transition.feedback !== undefined ? { feedback: transition.feedback } : {}) } } : undefined;
        const sourceEvent = resolvedSource ? this.eventForRun(resolvedSource, 'run-state', { run: structuredClone(resolvedSource) }) : undefined;
        const resumeEvidence = resume ? this.journal.saveContent(sessionId, { review: resume.review, input: resume.input, budget: initial.run.budgetState }).ref : undefined;
        this.commit({ sessions: [updatedSession], runs: [...(resolvedSource ? [resolvedSource] : []), initial.run], events: [...(sourceEvent ? [sourceEvent] : []), initial.event] }, resume && resumeEvidence ? [{
            run: this.journal.identity(initial.run), type: 'recovery.resumed', timestamp: initial.run.createdAt,
            payload: { sourceRunId: resume.source.id, fingerprint: resume.review.fingerprint, evidence: resumeEvidence },
        }] : []);
        this.sessions.set(sessionId, updatedSession);
        if (resolvedSource) this.runs.set(resolvedSource.id, resolvedSource);
        this.runs.set(run.id, initial.run);
        if (resume) this.taskBudgets.set(run.id, resume.budget);

        const execution: ActiveExecution = {
            cancelled: false,
            task: Promise.resolve(),
            waiters: new Set(),
            directoryLeaseKey: leaseKey,
            abortController: new AbortController(),
        };
        this.active.set(run.id, execution);
        if (leaseKey) {
            this.directoryLeases.set(leaseKey, run.id);
        }
        this.deliver([...(sourceEvent ? [sourceEvent] : []), initial.event]);
        execution.task = this.streamRun(run.id, canonicalDirectory, execution, connection);
    }

    private async streamRun(
        runId: string,
        directory: string | null,
        execution: ActiveExecution,
        connection?: ApiConnection,
    ): Promise<void> {
        try {
            const run = this.runs.get(runId);
            if (!run) {
                return;
            }
            if (execution.cancelled || this.closed || this.shuttingDown) {
                return;
            }
            if (connection) {
                await this.agentLoop(run, directory, execution, connection);
                if (!execution.cancelled && !this.closed && !this.shuttingDown) this.completeRun(runId);
                return;
            }
            const stream = this.adapter.stream(run.input);
            for await (const text of stream) {
                if (!(await this.pause(execution))) {
                    return;
                }
                if (execution.cancelled || this.closed || this.shuttingDown) {
                    return;
                }
                this.appendDelta(runId, text);
            }

            if (execution.cancelled || this.closed || this.shuttingDown) {
                return;
            }
            if (connection || directory === null) {
                this.completeRun(runId);
            } else {
                this.requestApproval(runId, directory);
            }
        } catch (error) {
            if (execution.cancelled || this.closed || this.shuttingDown) {
                return;
            }
            try {
                if (this.journal.authorityFailed) { this.finishRecordingFailure(runId); return; }
                const cause = execution.abortController.signal.aborted && execution.abortController.signal.reason instanceof Error ? execution.abortController.signal.reason : error;
                if (cause instanceof BudgetExceededError) {
                    const current = this.requireRun(runId);
                    const expired = [...this.approvals.values()].filter(item => item.runId === runId && item.status === 'pending').map(item => ({ ...item, status: 'expired' as const }));
                    const harnessState = current.harnessState === 'recording_failed' || current.harnessState === 'needs_reconciliation' ? current.harnessState : 'suspended_budget';
                    let pendingRun = current;
                    const events: RuntimeEvent[] = [];
                    for (const approval of expired) {
                        const next = this.nextPayloadEvent(pendingRun, 'approval-resolved', { approval });
                        pendingRun = next.run; events.push(next.event);
                    }
                    const reason = { requests: '模型请求次数', tools: '工具调用次数', elapsed_ms: '运行时限', estimated_tokens: '估算用量', concurrent_requests: '并发请求数', context_capacity: '模型上下文容量', no_progress: '重复失败且无新证据的工具批次', model_corrections: '工具失败后的模型纠错次数' }[cause.code];
                    const paused = this.nextRunState({ ...pendingRun, state: 'stopped', harnessState, budgetStopCode: cause.code,
                        stopReason: `已达到${reason}限制。已保留历史与工具证据；可缩小任务后发送新的明确请求，不会自动重放工具。` });
                    events.push(paused.event);
                    this.commit({ runs: [paused.run], approvals: expired, events });
                    for (const approval of expired) { this.approvals.set(approval.requestId, approval); this.toolApprovals.get(approval.requestId)?.(false); }
                    this.runs.set(runId, paused.run); this.deliver(events); this.finishActiveRun(runId);
                } else this.failRun(runId, connection ? this.apiError(cause, connection.apiKey) : cause);
            } catch (persistError) {
                const current = this.runs.get(runId);
                if (current) {
                    this.recordingFailures.add(current.sessionId);
                    const failed = this.nextRunState({ ...current, state: 'failed', harnessState: 'recording_failed', error: '运行记录写入失败，已停止执行。请检查日志存储和工作区副作用。' });
                    this.runs.set(runId, failed.run); this.deliver([failed.event]);
                }
                // Independent in-memory notification, without leaking raw filesystem errors.
                console.error('Failed to persist runtime run failure');
            }
        } finally {
            if (this.runs.get(runId)?.state === 'failed') this.finishActiveRun(runId);
        }
    }

    private updateActivity(runId: string, activity: RunActivity, incrementalBytes?: number): void {
        const current = this.requireRun(runId);
        const activities = structuredClone(current.activities || []);
        const index = activities.findIndex(item => item.id === activity.id);
        if (index < 0) activities.push(structuredClone(activity)); else activities[index] = structuredClone(activity);
        const previousLength = current.activities?.find(item => item.id === activity.id)?.content.length ?? 0;
        const next = incrementalBytes !== undefined && activity.kind === 'reasoning'
            ? this.nextPayloadEvent({ ...current, activities }, 'activity-delta', { activityId: activity.id, kind: 'reasoning', title: activity.title, offset: previousLength, text: activity.content.slice(previousLength) })
            : this.nextRunState({ ...current, activities });
        if (incrementalBytes !== undefined) this.journal.materialize(next.run, incrementalBytes);
        else this.commit({ runs: [next.run], events: [next.event] });
        this.runs.set(runId, next.run); this.deliver([next.event]);
    }

    private availableTools(run: RunRecord, connection: ApiConnection) {
        if (effectiveModelDetails(connection, run.effective.modelId)?.tools === false) return [];
        const mode = run.effective.permissionMode ?? 'manual';
        const settings = this.getAgentSettings?.().subagents;
        const canDelegate = settings && run.effective.allowDelegation && settings.enabled && (run.depth ?? 0) < settings.maxDepth;
        const blocked = this.sessionNeedsReconciliation(run.sessionId);
        return [...workspaceToolDefinitions().filter(tool => !(['plan', 'readonly'].includes(mode) || blocked) || !['write_file', 'apply_patch', 'run_command'].includes(tool.name)),
            ...artifactToolDefinitions,
            ...gitToolDefinitions,
            ...(canDelegate ? delegationToolDefinitions.filter(tool => !blocked || tool.name !== 'spawn_agent') : []),
            ...(!run.parentRunId ? mode === 'plan' ? [writePlanTool, readPlanTool, submitPlanTool] : mode !== 'readonly' ? [readPlanTool, enterPlanModeTool] : [readPlanTool] : [])];
    }
    private currentPlan(sessionId: string): RunRecord | undefined {
        const session = this.sessions.get(sessionId)!;
        if (session.activePlanRunId) {
            const run = this.runs.get(session.activePlanRunId);
            return run?.sessionId === sessionId && !run.parentRunId && !run.history?.deleted && run.plan ? run : undefined;
        }
        return this.runs.forSession(sessionId).filter(run => !run.parentRunId && !run.history?.deleted && run.plan).at(-1);
    }

    private sessionNeedsReconciliation(sessionId: string): boolean {
        return this.recordingFailures.has(sessionId) || this.runs.forSession(sessionId).some(run =>
            run.harnessState === 'recording_failed' || run.harnessState === 'needs_reconciliation');
    }

    private recordToolResult(runId: string, activity: RunActivity, result: { content: string; isError?: boolean; outcome?: ToolOutcome }): void {
        const current = this.requireRun(runId);
        const unsafe = result.outcome?.recordingState === 'failed' ? 'recording_failed'
            : result.outcome && ['possible', 'confirmed'].includes(result.outcome.effectState) && ['failed', 'cancelled'].includes(result.outcome.status) ? 'needs_reconciliation' : undefined;
        // Pending tool result becomes durable only with this transaction. A failed file
        // snapshot remains failed even when the failure itself is successfully recorded.
        const outcome = result.outcome && { ...result.outcome, recordingState: result.outcome.recordingState === 'failed' ? 'failed' as const : 'durable' as const };
        const updated: RunActivity = { ...activity, tool: { ...activity.tool!, result: result.content, isError: result.isError === true, ...(outcome ? { outcome } : {}) },
            content: activity.content + '\n\n' + result.content, status: outcome?.status === 'cancelled' ? 'stopped' : result.isError ? 'failed' : 'completed' };
        const activities = structuredClone(current.activities || []).map(item => item.id === activity.id ? updated : item);
        const next = this.nextRunState({ ...current, activities, ...(unsafe ? { harnessState: unsafe } : {}) });
        try { this.commit({ runs: [next.run], events: [next.event] }); }
        catch {
            this.recordingFailures.add(current.sessionId);
            if (updated.tool?.outcome) updated.tool.outcome.recordingState = 'failed';
            const failed = this.nextRunState({ ...current, activities, harnessState: 'recording_failed', state: 'failed', error: '工具结果记录失败；已暂停此会话的写入与命令。必须核对已发生的副作用。' });
            this.runs.set(runId, failed.run); this.deliver([failed.event]);
            throw new Error(failed.run.error);
        }
        this.runs.set(runId, next.run); this.deliver([next.event]);
        if (unsafe) throw new Error(unsafe === 'recording_failed'
            ? '文件变更已发生，但快照记录失败；本轮已暂停，未执行后续工具。请先核对文件与记录。'
            : '工具可能已产生部分副作用；本轮已暂停，未执行后续工具。请先核对工作区。');
    }
    private assertCurrentPlan(run: RunRecord): void {
        if (run.history?.deleted || this.currentPlan(run.sessionId)?.id !== run.id) throw new Error('计划已过期，请审阅当前任务最新版本。');
    }
    private async readStoredPlan(run: RunRecord) {
        const plan = run.plan!;
        const disk = await readPlanFile(this.dataDirectory, run.sessionId, plan.documentId ? plan.status === 'draft' ? 'draft' : plan.id : run.id, plan.documentId);
        if (plan.documentId && plan.status !== 'draft') {
            const draft = await readPlanFile(this.dataDirectory, run.sessionId, 'draft', plan.documentId);
            if (draft.content !== plan.content || draft.hash !== plan.hash) throw new Error('计划文件已改变，请重新提交计划后再审阅。');
        }
        return disk;
    }
    private async planDraft(run: RunRecord, content: string, seed?: RunRecord['plan'], title?: string): Promise<NonNullable<RunRecord['plan']>> {
        const existing = run.plan?.status === 'draft' ? run.plan : undefined;
        const documentId = existing?.documentId ?? seed?.documentId ?? seed?.id ?? randomUUID();
        const version = existing?.version ?? (seed ? (seed.version ?? 1) + 1 : 1);
        if (!Number.isSafeInteger(version) || version > 10000) throw new Error('计划版本数量已达到上限。');
        const file = await writePlanFile(this.dataDirectory, run.sessionId, 'draft', content, documentId);
        return { ...file, documentId, version, title: title ?? existing?.title ?? seed?.title ?? this.sessions.get(run.sessionId)!.title, draftPath: file.filePath, id: existing?.id ?? randomUUID(), status: 'draft', createdAt: existing?.createdAt ?? new Date().toISOString() };
    }
    private async storePlanDraft(runId: string, content: string, options: { title?: string; newPlan?: boolean } = {}): Promise<void> {
        const run = this.requireRun(runId);
        if (run.parentRunId || run.effective.permissionMode !== 'plan' || run.state !== 'running' || (run.plan && run.plan.status !== 'draft')) throw new Error('只有正在运行的 Plan 主代理可写本轮草稿。');
        const source = options.newPlan ? undefined : this.currentPlan(run.sessionId)?.plan;
        const plan = await this.planDraft(options.newPlan ? { ...run, plan: undefined } : run, content, source, options.title);
        const current = this.requireRun(runId);
        if (current.state !== 'running' || this.active.get(runId)?.abortController.signal.aborted) throw new Error('计划保存期间运行已取消。');
        const next = this.nextRunState({ ...current, plan });
        const session = { ...this.sessions.get(run.sessionId)!, activePlanRunId: runId };
        this.commit({ sessions: [session], runs: [next.run], events: [next.event] }); this.sessions.set(session.id, session); this.runs.set(runId, next.run); this.deliver([next.event]);
    }
    private async submitPlan(runId: string): Promise<void> {
        const run = this.requireRun(runId);
        if (run.parentRunId || run.effective.permissionMode !== 'plan' || run.plan?.status !== 'draft') throw new Error('请先由 Plan 主代理写入本轮计划草稿。');
        const disk = await this.readStoredPlan(run);
        const snapshot = await writePlanFile(this.dataDirectory, run.sessionId, run.plan.id, disk.content, run.plan.documentId, true);
        const current = this.requireRun(runId);
        if (current.state !== 'running' || this.active.get(runId)?.abortController.signal.aborted) throw new Error('计划提交期间运行已取消。');
        const next = this.nextRunState({ ...current, plan: { ...run.plan, ...snapshot, status: 'proposed' } });
        this.commit({ runs: [next.run], events: [next.event] }); this.runs.set(runId, next.run); this.deliver([next.event]);
    }
    private async editPlan(command: Extract<Command, { type: 'edit-plan' }>): Promise<void> {
        const source = this.requireHistoryRun(command.runId);
        if (this.planEdits.has(source.sessionId)) throw new Error('计划正在编辑，请刷新后重试。');
        const revision = this.sessions.get(source.sessionId)!.controlsRevision ?? 0;
        const unchanged = this.historyGuard(source.sessionId);
        const validate = () => {
            unchanged(); this.assertCurrentPlan(source);
            const session = this.sessions.get(source.sessionId)!;
            if (source.state !== 'completed' || source.plan?.status !== 'proposed' || source.plan.id !== command.planId) throw new Error('计划已处理或标识已过期。');
            if (this.sessionControls(session).permissionMode !== 'plan' || (session.controlsRevision ?? 0) !== revision) throw new Error('会话 Plan 控制设置已改变。');
        };
        validate();
        this.planEdits.add(source.sessionId);
        let release!: () => void;
        this.planEditSettled.set(source.sessionId, new Promise<void>(resolve => { release = resolve; }));
        try {
            const disk = await this.readStoredPlan(source);
            if (disk.content !== source.plan!.content || disk.hash !== source.plan!.hash || disk.filePath !== source.plan!.filePath) throw new Error('计划文件已改变，请重新提交。');
            validate();
            const old = source.plan!;
            if ((old.history?.length ?? 0) >= 100 || (old.history ?? []).reduce((sum, item) => sum + item.content.length, 0) + old.content.length > 2000000) throw new Error('计划编辑历史达到上限，请开启新计划。');
            const version = (old.version ?? 1) + 1;
            if (!Number.isSafeInteger(version) || version > 10000) throw new Error('计划版本数量已达到上限。');
            const documentId = old.documentId ?? old.id; const id = randomUUID();
            const snapshot = await writePlanFile(this.dataDirectory, source.sessionId, id, command.content, documentId, true);
            validate();
            const draft = await writePlanFile(this.dataDirectory, source.sessionId, 'draft', command.content, documentId);
            validate();
            const { status, history, draftPath, resolvedAt, executionRunId, feedback, ...previous } = old;
            const next = this.nextRunState({ ...source, plan: { ...snapshot, id, documentId, title: command.title, version, draftPath: draft.filePath, status: 'proposed', createdAt: new Date().toISOString(), history: [...(history ?? []), previous] } });
            const session = { ...this.sessions.get(source.sessionId)!, activePlanRunId: source.id };
            this.commit({ sessions: [session], runs: [next.run], events: [next.event], clearContextSessions: [source.sessionId] }); this.sessions.set(session.id, session); this.runs.set(source.id, next.run); this.deliver([next.event]);
        } finally { this.planEdits.delete(source.sessionId); this.planEditSettled.delete(source.sessionId); release(); }
    }
    private async planTool(runId: string, call: ToolCall): Promise<{ content: string }> {
        let args: unknown;
        try { args = JSON.parse(call.arguments); } catch { throw new Error('Plan 工具参数必须是有效 JSON。'); }
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Plan 工具参数必须是对象。');
        const run = this.requireRun(runId);
        if (run.parentRunId) throw new Error('子代理不能改变父会话模式或提交可批准的计划。');
        if (call.name === 'write_plan') {
            const value = args as Record<string, unknown>;
            if (Object.keys(value).some(key => !['content', 'title', 'newPlan'].includes(key)) || typeof value.content !== 'string'
                || (Object.hasOwn(value, 'title') && (typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200))
                || (Object.hasOwn(value, 'newPlan') && typeof value.newPlan !== 'boolean')) throw new Error('写计划只接受 content 正文、可选 title 标题与 newPlan 布尔字段。');
            await this.storePlanDraft(runId, value.content, value as { title?: string; newPlan?: boolean });
            return { content: '本轮真实 .md 计划草稿已保存，尚未提交或批准。请 read_plan 核对，再 submit_plan 交用户审阅。' };
        }
        if (call.name === 'read_plan') {
            if (Object.keys(args).length) throw new Error('读计划只接受空对象。');
            const source = run.plan ? run : this.currentPlan(run.sessionId);
            if (!source?.plan) throw new Error('当前任务还没有计划。');
            return { content: (await this.readStoredPlan(source)).content };
        }
        if (call.name === 'submit_plan') {
            if (Object.keys(args).some(key => key !== 'plan') || (Object.hasOwn(args, 'plan') && typeof (args as { plan?: unknown }).plan !== 'string')) throw new Error('提交计划只接受可选 plan 文本字段。');
            if (Object.hasOwn(args, 'plan')) await this.storePlanDraft(runId, (args as { plan: string }).plan);
            await this.submitPlan(runId);
            return { content: '完整计划已提交并保存在会话中。本轮即将结束，等待用户批准或要求修订；未执行计划。' };
        }
        if (Object.keys(args).length || ['readonly', 'plan'].includes(run.effective.permissionMode ?? 'manual')) throw new Error('当前模式不能进入 Plan，或参数不是空对象。');
        if ([...this.active.keys()].some(id => this.runs.get(id)?.parentRunId === run.id)) throw new Error('请先收拢现有子代理结果，再进入 Plan。');
        const session = this.sessions.get(run.sessionId)!;
        const revision = session.controlsRevision ?? 0;
        if (revision >= Number.MAX_SAFE_INTEGER) throw new Error('会话控制设置版本已达到上限。');
        const controls = { ...this.sessionControls(session), permissionMode: 'plan' as const };
        const next = this.nextRunState({ ...run, modeTransition: { id: randomUUID(), from: run.effective.permissionMode ?? 'manual', to: 'plan', reason: 'tool' }, effective: { ...run.effective, permissionMode: 'plan' } });
        const updatedSession = { ...session, controls, controlsRevision: revision + 1, requested: { ...session.requested, permissionMode: 'plan' as const } };
        this.commit({ sessions: [updatedSession], runs: [next.run], events: [next.event] });
        this.sessions.set(session.id, updatedSession); this.runs.set(runId, next.run); this.deliver([next.event]);
        return { content: '已进入 Plan 模式并保存会话设置。从现在起只读探索，禁止修改与命令；下一模型轮准备完整计划并调用 submit_plan 等待用户审阅。' };
    }

    private async agentLoop(run: RunRecord, directory: string | null, execution: ActiveExecution, connection: ApiConnection): Promise<void> {
        const rootId = this.journal.identity(run).rootRunId;
        let budget = this.taskBudgets.get(rootId);
        if (!budget) {
            budget = new TaskTreeBudget(this.taskBudgetOptions);
            this.taskBudgets.set(rootId, budget);
        }
        if (!this.budgetTimers.has(rootId)) {
            const state = budget.snapshot();
            const timer = setTimeout(() => this.active.get(rootId)?.abortController.abort(new BudgetExceededError('elapsed_ms')), Math.max(1, state.limits.maxElapsedMs - state.elapsedMs));
            timer.unref(); this.budgetTimers.set(rootId, timer);
        }
        const saveBudget = () => {
            const root = this.requireRun(rootId);
            const state = JSON.parse(JSON.stringify(budget.snapshot())) as JsonValue;
            const next = this.nextRunState({ ...root, budgetState: state });
            this.journal.event(root, 'budget.updated', { state }, { runs: [next.run], events: [next.event] });
            this.runs.set(rootId, next.run); this.deliver([next.event]);
        };
        const messages = run.contextMessages
            ? [...run.contextMessages, { role: 'user' as const, content: run.input }]
            : this.apiMessages(run.sessionId, run.input, run.id, run.effective.modelParameters?.historyTurns);
        let continuation: unknown[] | undefined = run.contextMessages ? undefined : [
            ...nativeHistory(historyTurns(this.store.readSessionSnapshot(run.sessionId), run.sessionId, { beforeRunId: run.id, limit: run.effective.modelParameters?.historyTurns }),
                { protocol: connection.protocol, modelId: run.effective.modelId, accountNamespace: `${connection.id}@${connection.revision}` }, frame => this.readModelFrame(frame)),
            { role: 'user', content: run.input },
        ];
        let prefixLength = (continuation ?? messages).length - 1;
        let compactionAttempted = false;
        let networkRetries = 0;
        let retryIdentity: Pick<RequestIdentity, 'stepId' | 'requestId'> | undefined;
        const toolProgress = new ToolProgressGovernor();
        let finished = false;
        let lastModeTransitionId: string | undefined;
        const consumedChildren = new Map<string, string>();
        const pendingChildren = new Map<string, { version: string; deliveryId: string; resultEventId: string }>();
        const hasSteering = () => this.requireRun(run.id).steering?.some(item => item.status === 'queued') === true;
        const applySteering = async () => {
            if (!hasSteering()) return;
            await this.waitForChildren(run.id);
            execution.abortController.signal.throwIfAborted();
            const current = this.requireRun(run.id);
            const pending = current.steering!.filter(item => item.status === 'queued');
            toolProgress.resetStreak();
            retryIdentity = undefined;
            const next = this.nextRunState({ ...current, toolProgress: toolProgress.snapshot(), steering: current.steering!.map(item => ({ ...item, status: 'applied' as const })) });
            this.commit({ runs: [next.run], events: [next.event] }, [{ run: this.journal.identity(current), type: 'control.applied',
                timestamp: new Date().toISOString(), payload: { action: 'steer', controlIds: pending.map(item => item.id) } },
                { run: this.journal.identity(current), type: 'progress.updated', timestamp: new Date().toISOString(), payload: { state: next.run.toolProgress! } }]);
            this.runs.set(run.id, next.run); this.deliver([next.event]);
            continuation = [...(continuation ?? messages), ...pending.map(item => ({ role: 'user', content: item.input }))];
        };
        const terminalVersion = (child: RunRecord) => ['completed', 'failed', 'stopped'].includes(child.state) ? `${child.state}:${child.sequence}:${child.finishedAt ?? ''}` : undefined;
        const queueChild = (child: RunRecord) => {
            const version = terminalVersion(child);
            if (!version || pendingChildren.get(child.id)?.version === version) return;
            let after = 0;
            let resultEventId: string | undefined;
            for (;;) {
                const page = this.store.readJournal(child.sessionId, after, 1000);
                for (const event of page) if (event.run.runId === child.id && event.type === 'run.state'
                    && ['completed', 'failed', 'cancelled', 'suspended_budget', 'recording_failed', 'needs_reconciliation'].includes(event.payload.state)) resultEventId = event.eventId;
                if (page.length < 1000) break;
                after = page.at(-1)!.sessionSeq;
            }
            if (!resultEventId) throw new Error('子任务终态缺少持久化记录，未投递结果。');
            const delivery = { version, deliveryId: randomUUID(), resultEventId };
            this.journal.event(run, 'delegation.delivery', { deliveryId: delivery.deliveryId, childRunId: child.id, resultEventId, stage: 'delivered', attemptId: null });
            pendingChildren.set(child.id, delivery);
        };
        const deliveryStage = (stage: 'prepared' | 'sent' | 'consumed', attemptId: string) => {
            for (const [childRunId, delivery] of pendingChildren) this.journal.event(run, 'delegation.delivery', {
                deliveryId: delivery.deliveryId, childRunId, resultEventId: delivery.resultEventId, stage, attemptId,
            });
        };
        try {
            for (let round = 0; round < 16; round++) {
                execution.abortController.signal.throwIfAborted();
                await applySteering();
                run = this.requireRun(run.id);
                const settings = this.getAgentSettings?.().subagents;
                const tools = this.availableTools(run, connection);
                const git = await readGit({ directory, kind: 'status' }, execution.abortController.signal);
                execution.abortController.signal.throwIfAborted();
                await applySteering();
                run = this.requireRun(run.id);
                const requestIdentity: RequestIdentity = { ...this.journal.identity(run), ...(retryIdentity ?? { stepId: randomUUID(), requestId: randomUUID() }), attemptId: randomUUID() };
                retryIdentity = undefined;
                this.journal.registerSecret(run.sessionId, connection.apiKey);
                this.activeRequests.set(run.id, requestIdentity);
                const previousModeTransitionId = lastModeTransitionId;
                const assembled = assemblePrompt({ run: { ...run, budgetState: JSON.parse(JSON.stringify(budget.snapshot())) as JsonValue }, directory, tools: tools.map(tool => tool.name), settings, modeTransition: run.modeTransition?.id !== lastModeTransitionId ? run.modeTransition : undefined,
                    context: { GIT_STATUS_AND_TASK_CONTEXT: gitPromptContext(git.snapshot) } });
                lastModeTransitionId = run.modeTransition?.id;
                recordPromptAssembly(connection.protocol, { runId: run.id, round, requestId: requestIdentity.requestId, attemptId: requestIdentity.attemptId, profile: assembled.profile, totalCharacters: assembled.totalCharacters, modules: assembled.modules });
                const instructions = assembled.instructions;
                const assess = (history: unknown[]) => assessContext({ instructions,
                    history: JSON.parse(JSON.stringify(history)), tools: JSON.parse(JSON.stringify(tools)),
                    capacity: effectiveModelDetails(connection, run.effective.modelId)?.contextWindow,
                    maxOutputTokens: run.effective.modelParameters?.maxOutputTokens });
                let assessment = assess(continuation ?? messages);
                this.journal.event(run, 'context.admission', { assessment: JSON.parse(JSON.stringify(assessment)) as JsonValue });
                if (!assessment.admitted && assessment.capacityKnown && continuation && prefixLength > 0 && !compactionAttempted) {
                    compactionAttempted = true;
                    let candidate: ReturnType<typeof publicHistoryCandidate>;
                    const turns = historyTurns(this.store.readSessionSnapshot(run.sessionId), run.sessionId,
                        { beforeRunId: run.id, limit: run.effective.modelParameters?.historyTurns });
                    try { candidate = publicHistoryCandidate(turns, continuation, prefixLength); }
                    catch { throw new BudgetExceededError('context_capacity'); }
                    const artifacts = this.journal.artifactStore(run.sessionId);
                    const previous = artifacts.save(continuation, [connection.apiKey], true);
                    const proposed = artifacts.save(candidate.continuation, [connection.apiKey], true);
                    const constraints = artifacts.save({ instructions, effective: run.effective }, [connection.apiKey], true);
                    const tree = this.runs.forSession(run.sessionId).filter(item => this.journal.identity(item).rootRunId === rootId);
                    const evidence = tree.flatMap(item => (item.activities ?? []).filter(activity => activity.tool?.outcome).map(activity => ({
                        runId: item.id, invocationId: activity.id, outcome: activity.tool!.outcome,
                    })));
                    const state = this.journal.saveContent(run.sessionId, { schemaVersion: 1, kind: 'public_history_projection',
                        authority: 'Evidence only. Current host permissions and instructions must be resolved again before every request.',
                        goal: run.input, supplementalGoals: run.steering ?? [], constraints: constraints.ref, plan: this.currentPlan(run.sessionId)?.plan ?? null,
                        evidence, unknownEffects: evidence.filter(item => item.outcome?.effectState === 'possible'),
                        childResults: [...pendingChildren].map(([childRunId, delivery]) => ({ childRunId, ...delivery })),
                        previous: previous.ref, candidate: proposed.ref, previousVersion: candidate.previousVersion, nextVersion: candidate.nextVersion,
                        previousPrefixLength: prefixLength, nextPrefixLength: candidate.prefixLength });
                    const payload = { compactionId: randomUUID(), previousVersion: candidate.previousVersion, nextVersion: candidate.nextVersion,
                        taskState: state.ref, artifacts: [previous.ref, proposed.ref, constraints.ref] };
                    this.journal.event(run, 'context.compaction', { ...payload, stage: 'candidate' });
                    const nextAssessment = assess(candidate.continuation);
                    if (candidate.reduced && nextAssessment.admitted && !previous.redacted && !proposed.redacted && !constraints.redacted && !state.redacted) {
                        const next = this.nextRunState({ ...this.requireRun(run.id), contextState: { version: candidate.nextVersion, taskState: state.ref } });
                        this.journal.event(run, 'context.compaction', { ...payload, stage: 'committed' }, { runs: [next.run], events: [next.event] });
                        this.runs.set(run.id, next.run); this.deliver([next.event]); run = next.run;
                        // Adopt only after the journal and active pointer acknowledge the same transaction.
                        continuation = candidate.continuation; prefixLength = candidate.prefixLength; assessment = nextAssessment;
                        this.journal.event(run, 'context.admission', { assessment: JSON.parse(JSON.stringify(assessment)) as JsonValue });
                    } else this.journal.event(run, 'context.compaction', { ...payload, stage: 'rolled_back' });
                }
                if (!assessment.admitted) throw new BudgetExceededError('context_capacity');
                const reservation = budget.reserveRequest(assessment.requiredTokens);
                let reportedTokens: number | null = null;
                let settled = false;
                let receivedProviderFrame = false;
                const settle = () => {
                    if (settled) return;
                    settled = true; budget.settleRequest(reservation, reportedTokens); saveBudget();
                };
                try {
                saveBudget();
                const requestContext = captureRequestContext({ runId: run.id, round, requestId: requestIdentity.requestId, protocol: connection.protocol, modelId: run.effective.modelId,
                    capacity: effectiveModelDetails(connection, run.effective.modelId)?.contextWindow,
                    sections: assembled.sections, messages, continuation, tools });
                this.saveRequestContext(run.id, requestContext);
                // A control can arrive through the state notification before network dispatch.
                if (hasSteering()) { lastModeTransitionId = previousModeTransitionId; continue; }
                const capture = new RequestJournal(this.journal, run, requestIdentity, connection, { captureRaw: this.getCaptureRaw() });
                this.activeCaptures.set(run.id, capture);
                let completed: { toolCalls: ToolCall[]; continuation: unknown[] } | undefined;
                let reasoning: RunActivity | undefined;
                deliveryStage('prepared', requestIdentity.attemptId);
                for await (const event of streamAgentApi(connection, run.effective.modelId, messages, execution.abortController.signal, {
                    instructions,
                    requestIdentity, observer: { ...capture.observer, providerEvent: frame => {
                        receivedProviderFrame = true; capture.observer.providerEvent(frame);
                    }, responseStarted: () => {
                        capture.observer.responseStarted();
                        // An HTTP response confirms the prepared request crossed the send boundary.
                        deliveryStage('sent', requestIdentity.attemptId);
                    } },
                    parameters: run.effective.modelParameters, tools, continuation,
                })) {
                    execution.abortController.signal.throwIfAborted();
                    if (event.type === 'text') this.appendDelta(run.id, event.text);
                    else if (event.type === 'usage') {
                        const observed = event.usage.totalTokens ?? (event.usage.inputTokens !== undefined && event.usage.outputTokens !== undefined ? event.usage.inputTokens + event.usage.outputTokens : null);
                        // Accounting keeps provider revisions; admission never refunds an already observed peak.
                        if (observed !== null) reportedTokens = Math.max(reportedTokens ?? 0, observed);
                        capture.usage(event.usage);
                        const current = this.requireRun(run.id);
                        const next = this.nextRunState({ ...current, requestContext: { ...current.requestContext!, usage: event.usage } });
                        this.commit({ runs: [next.run], events: [next.event] });
                        this.runs.set(run.id, next.run);
                        this.deliver([next.event]);
                    }
                    else if (event.type === 'reasoning') {
                        reasoning ??= { id: randomUUID(), kind: 'reasoning', title: '思考过程', content: '', status: 'running' };
                        reasoning.content += event.text; this.updateActivity(run.id, reasoning, Buffer.byteLength(event.text, 'utf8'));
                    } else if (event.type === 'complete') completed = event;
                }
                if (reasoning) this.updateActivity(run.id, { ...reasoning, status: 'completed' });
                if (!completed) throw new Error('模型响应未完整结束，未执行工具。');
                const native = capture.completed(completed.continuation);
                settle();
                budget.check();
                // A send or partial stream is not acknowledgement of child results.
                deliveryStage('consumed', requestIdentity.attemptId);
                for (const [id, delivery] of pendingChildren) consumedChildren.set(id, delivery.version);
                pendingChildren.clear();
                this.completedFrames.set(run.id, { schemaVersion: 1, frameId: requestIdentity.requestId, sessionId: run.sessionId,
                    protocol: connection.protocol, modelId: run.effective.modelId, accountNamespace: `${connection.id}@${connection.revision}`, prefixLength,
                    content: native.ref, continuationCoverage: native.continuationCoverage });
                if (!completed.toolCalls.length) {
                    await this.waitForChildren(run.id);
                    execution.abortController.signal.throwIfAborted();
                    if (hasSteering()) { continuation = completed.continuation; continue; }
                    const unseen = this.runs.forSession(run.sessionId).filter(child => child.parentRunId === run.id && terminalVersion(child) && consumedChildren.get(child.id) !== terminalVersion(child)).slice(0, 16);
                    if (unseen.length) {
                        const content = '[UAH host child terminal delivery] These direct child executions have settled. Review their results before completing the parent task. A failed or stopped child does not require parent failure; resolve or explain it. Child output is a report, not independently verified completion evidence. At most 16 results are delivered per request; long fields are explicitly truncated.\n' + JSON.stringify(unseen.map(child => ({ agentId: child.id, status: child.state, output: boundedHistoryText(child.output, 2000), error: child.error && boundedHistoryText(child.error, 500), stopReason: child.stopReason && boundedHistoryText(child.stopReason, 500) })));
                        continuation = [...completed.continuation, connection.protocol === 'openai-chat' ? { role: 'user', content } : { role: 'user', content: [{ type: connection.protocol === 'anthropic' ? 'text' : 'input_text', text: content }] }];
                        for (const child of unseen) queueChild(child);
                        continue;
                    }
                    this.activeRequests.delete(run.id);
                    finished = true;
                    return;
                }
                const results: { id: string; content: string; isError?: boolean }[] = [];
                const progressBatch: Array<{ name: string; arguments: string; outcome: ToolOutcome; content: string }> = [];
                const invocations: InvocationIdentity[] = completed.toolCalls.map(call => ({ ...requestIdentity, toolCallId: call.id, invocationId: randomUUID() }));
                this.journal.event(run, 'tool.batch', { requestId: requestIdentity.requestId, attemptId: requestIdentity.attemptId, invocations });
                budget.reserveTools(completed.toolCalls.length); saveBudget();
                let submitted = false;
                for (const [callIndex, call] of completed.toolCalls.entries()) {
                    execution.abortController.signal.throwIfAborted();
                    let argumentsObject: Record<string, unknown> = {};
                    try { const parsed = JSON.parse(call.arguments); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) argumentsObject = structuredClone(parsed); } catch { /* Executor reports invalid arguments. */ }
                    const activity: RunActivity = { id: invocations[callIndex].invocationId, kind: 'tool', title: call.name, content: call.arguments, status: 'running', tool: { name: call.name, arguments: argumentsObject } };
                    this.updateActivity(run.id, activity);
                    let result: { content: string; isError?: boolean; outcome?: ToolOutcome };
                    const executionId = call.name === 'run_command' ? randomUUID() : null;
                    const fallback = beginToolOutcome();
                    let dispatched = false;
                    let releaseResource: (() => void) | undefined;
                    try {
                    try {
                        const current = this.requireRun(run.id);
                        if (hasSteering()) throw new Error('收到新的用户补充指令；旧请求中尚未派发的工具已跳过。');
                        if (submitted) throw new Error('计划已提交，本批后续工具未执行。请等待用户审阅。');
                        if (['plan', 'readonly'].includes(current.effective.permissionMode ?? 'manual') && ['write_file', 'apply_patch', 'run_command'].includes(call.name)) throw new Error('Permission mode denies this operation.');
                        if (!tools.some(tool => tool.name === call.name) || !this.availableTools(current, connection).some(tool => tool.name === call.name)) throw new Error('本轮未提供此工具，不能执行伪造或已失效的工具调用。');
                        const dispatch = () => {
                            if (hasSteering()) throw new Error('收到新的用户补充指令；旧请求中尚未派发的工具已跳过。');
                            budget.check();
                            if (this.sessionNeedsReconciliation(current.sessionId) && ['write_file', 'apply_patch', 'run_command', 'spawn_agent'].includes(call.name)) throw new Error('Session requires reconciliation');
                            this.journal.admit(current.sessionId);
                            const approval = [...this.approvals.values()].find(item => item.toolCallId === activity.id && item.status === 'approved');
                            this.journal.event(current, 'tool.dispatch', { identity: invocations[callIndex], executionId, approvalId: approval?.requestId ?? null, toolName: call.name });
                            dispatched = true;
                        };
                        if ([submitPlanTool.name, enterPlanModeTool.name, writePlanTool.name, readPlanTool.name].includes(call.name)) {
                            if (call.name !== enterPlanModeTool.name) releaseResource = await this.toolScheduler.acquire(call.name === writePlanTool.name ? 'write' : 'read', execution.abortController.signal);
                            dispatch();
                            result = await this.planTool(run.id, call); submitted = call.name === submitPlanTool.name;
                        } else if (delegationToolDefinitions.some(tool => tool.name === call.name)) {
                            dispatch();
                            result = await this.delegationTool(current, call, execution, activity);
                            if (call.name === 'wait_agents') {
                                for (const delivered of JSON.parse(result.content)) {
                                    const child = this.runs.get(delivered.agentId);
                                    const version = child && terminalVersion(child);
                                    if (version && child?.parentRunId === run.id && delivered.status === child.state) queueChild(child);
                                }
                            }
                        } else if (artifactToolDefinitions.some(tool => tool.name === call.name)) {
                            dispatch();
                            const refs = [...(this.sessions.get(current.sessionId)?.branchArtifacts ?? []), ...this.runs.forSession(current.sessionId)
                                .flatMap(item => (item.activities ?? []).flatMap(item => item.tool?.outcome?.artifactRefs ?? []))];
                            result = executeArtifactRead(call, refs, ref => this.journal.artifactStore(current.sessionId).read(ref), execution.abortController.signal);
                        } else if (gitToolDefinitions.some(tool => tool.name === call.name)) {
                            releaseResource = await this.toolScheduler.acquire('read', execution.abortController.signal);
                            dispatch(); result = await executeGitTool(call, directory, execution.abortController.signal);
                        }
                        else result = await executeWorkspaceTool(call, {
                            directory, permissionMode: current.effective.permissionMode ?? 'manual', signal: execution.abortController.signal,
                            beforeDispatch: dispatch,
                            acquireResource: async mode => { releaseResource = await this.toolScheduler.acquire(mode, execution.abortController.signal); },
                            commandRunner: (command, cwd, timeoutSeconds, outcome) => {
                                this.commandBackend ??= new WindowsExecutionBackend({ dataDirectory: this.dataDirectory, helperPath: this.executionHelperPath });
                                return managedCommand(this.commandBackend, { executionId: executionId!, command, cwd, timeoutSeconds, signal: execution.abortController.signal,
                                    redactSecrets: this.journal.knownSecrets(current.sessionId),
                                    saveOutput: bytes => this.journal.artifactStore(current.sessionId).saveBytes(bytes) }, outcome);
                            },
                            approve: (summary, path) => {
                                if (hasSteering()) return Promise.resolve(false);
                                this.updateActivity(run.id, { ...activity, status: 'approval' });
                                return this.requestToolApproval(run.id, activity.id, summary, path, execution);
                            },
                            onArtifact: change => {
                                activity.tool!.artifactId = this.recordToolArtifact(run.id, change, activity.id);
                            },
                        });
                    } catch (error) { result = { content: this.errorMessage(error), isError: true }; }
                    if (!result.outcome) {
                        // Host-only actions validate before their atomic state commit.
                        // Files/commands keep the executor's more precise outcome.
                        const mayWrite = ['write_file', 'apply_patch', 'run_command', 'write_plan'].includes(call.name)
                            || (!result.isError && ['spawn_agent', 'submit_plan', 'enter_plan_mode', 'stop_agent'].includes(call.name));
                        fallback.outcome.status = execution.abortController.signal.aborted ? 'cancelled' : result.isError ? 'failed' : 'succeeded';
                        fallback.outcome.effectState = dispatched && mayWrite ? 'possible' : 'not_started';
                        fallback.outcome.retryClass = dispatched && mayWrite ? 'reconcile_first' : 'safe';
                        fallback.outcome.errorCode = result.isError ? 'TOOL_FAILED' : null;
                        result = fallback.finish(result);
                    }
                    if (!dispatched && hasSteering() && result.outcome?.effectState === 'not_started') {
                        result.outcome.status = 'cancelled'; result.outcome.errorCode = 'CONTROL_SUPERSEDED'; result.isError = true;
                    }
                    this.recordToolResult(run.id, activity, result);
                    progressBatch.push({ name: call.name, arguments: call.arguments, outcome: result.outcome!, content: result.content });
                    execution.abortController.signal.throwIfAborted();
                    results.push({ id: call.id, content: result.content, isError: result.isError });
                    } finally { releaseResource?.(); }
                }
                if (hasSteering()) toolProgress.resetStreak();
                const progressState = toolProgress.observe(progressBatch);
                const progressRun = this.nextRunState({ ...this.requireRun(run.id), toolProgress: progressState });
                this.journal.event(progressRun.run, 'progress.updated', { state: progressState }, { runs: [progressRun.run], events: [progressRun.event] });
                this.runs.set(run.id, progressRun.run); this.deliver([progressRun.event]);
                if (progressState.stopCode) throw new BudgetExceededError(progressState.stopCode);
                if (submitted) {
                    await this.waitForChildren(run.id); execution.abortController.signal.throwIfAborted();
                    finished = true; return;
                }
                continuation = appendToolResults(connection.protocol, completed.continuation, results);
                } catch (error) {
                    const delayMs = error instanceof ApiTransportError && !receivedProviderFrame
                        ? retryDelayMs(error.reason, networkRetries) : null;
                    if (delayMs === null || execution.cancelled || execution.abortController.signal.aborted) throw error;
                    // Failed attempts retain their charge and terminal evidence; no tool batch is replayed.
                    settle(); budget.check();
                    this.journal.event(this.requireRun(run.id), 'request.retry', { requestId: requestIdentity.requestId,
                        attemptId: requestIdentity.attemptId, reason: (error as ApiTransportError).reason,
                        retryNumber: ++networkRetries, delayMs });
                    retryIdentity = { stepId: requestIdentity.stepId, requestId: requestIdentity.requestId };
                    lastModeTransitionId = previousModeTransitionId;
                    await abortableRetryDelay(delayMs, execution.abortController.signal);
                } finally { settle(); }
            }
            throw new BudgetExceededError('requests');
        } finally {
            this.activeRequests.delete(run.id);
            this.activeCaptures.delete(run.id);
            // Own child executions must settle before releasing the root workspace lease.
            if (!finished || execution.abortController.signal.aborted || execution.cancelled) {
                await Promise.all(this.runs.forSession(run.sessionId).filter(child => child.parentRunId === run.id && this.active.has(child.id)).map(child => this.stopRun(child.id)));
            } else await this.waitForChildren(run.id);
            // Include tool/approval/child waiting time in the durable continuation budget.
            if (!this.journal.authorityFailed && !this.recordingFailures.has(run.sessionId)) saveBudget();
        }
    }

    private async waitForChildren(parentId: string): Promise<void> {
        await Promise.all(this.runs.forSession(this.requireRun(parentId).sessionId).filter(child => child.parentRunId === parentId).map(child => this.active.get(child.id)?.task));
    }

    private async delegationTool(parentRun: RunRecord, call: ToolCall, parentExecution: ActiveExecution, activity: RunActivity): Promise<{ content: string }> {
        if (!parentRun.effective.allowDelegation || !this.getAgentSettings) throw new Error('此代理不允许委派。');
        const settings = this.getAgentSettings();
        if (!settings.subagents.enabled) throw new Error('子代理全局开关已关闭。');
        const args = JSON.parse(call.arguments);
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('子代理工具参数无效。');
        if (call.name === 'list_agent_presets') {
            if (Object.keys(args).length) throw new Error('列出角色不接受参数。');
            return { content: JSON.stringify({ currentProviderId: parentRun.effective.endpointId, currentModelId: parentRun.effective.modelId, profiles: settings.profiles.filter(item => item.kind === 'subagent' && item.enabled) }) };
        }
        if (call.name === 'wait_agents') {
            const timeoutMs = args.timeoutMs === undefined ? 30_000 : args.timeoutMs;
            if (Object.keys(args).some(key => !['agentIds', 'timeoutMs'].includes(key)) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000 || !Array.isArray(args.agentIds) || !args.agentIds.length || args.agentIds.length > 16 || new Set(args.agentIds).size !== args.agentIds.length) throw new Error('等待子代理参数无效。');
            const children = args.agentIds.map((id: unknown) => {
                const child = typeof id === 'string' ? this.runs.get(id) : undefined;
                if (!child || child.parentRunId !== parentRun.id) throw new Error('只能等待本代理直接启动的子代理。');
                return child;
            });
            if (timeoutMs > 0) {
                const signal = parentExecution.abortController.signal;
                signal.throwIfAborted();
                let timer: ReturnType<typeof setTimeout> | undefined;
                let wake: () => void = () => {};
                try {
                    await Promise.race([
                        Promise.all(children.map((child: RunRecord) => this.active.get(child.id)?.task)),
                        new Promise<void>(resolve => {
                            wake = resolve;
                            timer = setTimeout(resolve, timeoutMs);
                            signal.addEventListener('abort', wake, { once: true });
                        }),
                    ]);
                } finally {
                    clearTimeout(timer);
                    signal.removeEventListener('abort', wake);
                }
                signal.throwIfAborted();
            }
            return { content: JSON.stringify(children.map((child: RunRecord) => {
                const current = this.requireRun(child.id); return { agentId: child.id, status: current.state, output: boundedHistoryText(current.output, 64_000), error: current.error, ...(current.stopReason !== undefined ? { stopReason: current.stopReason } : {}) };
            })) };
        }
        const { prompt, ...request } = args;
        if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > 100_000) throw new Error('子任务内容无效。');
        const session = this.sessions.get(parentRun.sessionId)!;
        const plan = resolveDelegation({
            agentId: parentRun.effective.agentId, agentName: parentRun.effective.agentName || 'Agent', agentInstructions: parentRun.effective.agentInstructions || '',
            permissionMode: parentRun.effective.permissionMode ?? 'manual', allowDelegation: parentRun.effective.allowDelegation === true,
            providerId: parentRun.effective.endpointId!, modelId: parentRun.effective.modelId, directory: session.directory, depth: parentRun.depth ?? 0,
        }, settings, request, parentConversation(this.store.readSessionSnapshot(parentRun.sessionId), parentRun.id));
        const connection = await this.resolveSelectedConnection(plan.providerId, plan.modelId);
        parentExecution.abortController.signal.throwIfAborted();
        // Recheck after endpoint lookup: sibling launches can consume the final slot.
        const activeChildren = [...this.active.keys()].filter(id => this.runs.get(id)?.parentRunId);
        if (activeChildren.length >= settings.subagents.maxConcurrentThreads || this.active.size >= MAX_ACTIVE_RUNS) throw new Error('子代理并发上限已达到，请先等待正在运行的子代理。');
        this.store.assertCanCreateRun();
        const effort = request.reasoningEffort ?? parentRun.effective.modelParameters?.reasoningEffort ?? 'default';
        const run: RunRecord = { id: randomUUID(), parentRunId: parentRun.id, depth: plan.depth, contextMessages: plan.contextMessages,
            sessionId: parentRun.sessionId, turnId: randomUUID(), state: 'running', input: prompt, output: '', sequence: 0, createdAt: new Date().toISOString(),
            effective: { ...this.apiConfig(connection, plan.modelId), agentId: plan.agentId, agentName: plan.agentName, agentInstructions: plan.agentInstructions,
                allowDelegation: plan.allowDelegation, permissionMode: plan.permissionMode,
                modelParameters: applySessionReasoning(connection.modelParameters?.find(item => item.id === plan.modelId)?.parameters ?? defaultModelParameters(), { permissionMode: plan.permissionMode, reasoningEffort: effort }) } };
        const initial = this.nextRunState(run);
        this.commit({ runs: [initial.run], events: [initial.event] }); this.runs.set(run.id, initial.run); this.deliver([initial.event]);
        const execution: ActiveExecution = { cancelled: false, task: Promise.resolve(), waiters: new Set(), directoryLeaseKey: null, abortController: new AbortController() };
        this.active.set(run.id, execution);
        const abort = () => { void this.stopRun(run.id); };
        parentExecution.abortController.signal.addEventListener('abort', abort, { once: true });
        const timer = setTimeout(() => execution.abortController.abort(new Error('子代理任务超时。')), plan.timeoutSeconds * 1000);
        execution.task = this.streamRun(run.id, session.directory, execution, connection).finally(() => { clearTimeout(timer); parentExecution.abortController.signal.removeEventListener('abort', abort); });
        activity.kind = 'agent'; activity.title = plan.agentName; activity.childRunId = run.id;
        return { content: JSON.stringify({ agentId: run.id, status: 'running', providerId: plan.providerId, modelId: plan.modelId, reasoningEffort: effort, permissionMode: plan.permissionMode }) };
    }

    private requestToolApproval(runId: string, activityId: string, summary: string, path: string, execution: ActiveExecution): Promise<boolean> {
        const current = this.requireRun(runId);
        const approval: ApprovalRecord = { runtimeId: current.effective.runtimeId, sessionId: current.sessionId, runId, turnId: current.turnId, requestId: randomUUID(), policyVersion: current.effective.policyVersion,
            toolCallId: activityId, summary, path, status: 'pending', createdAt: new Date().toISOString() };
        const next = this.nextPayloadEvent({ ...current, state: 'approval' }, 'approval-requested', { approval });
        this.commit({ runs: [next.run], approvals: [approval], events: [next.event] });
        this.runs.set(runId, next.run); this.approvals.set(approval.requestId, approval); this.deliver([next.event]);
        return new Promise(resolve => {
            const finish = (allowed: boolean) => { execution.abortController.signal.removeEventListener('abort', abort); this.toolApprovals.delete(approval.requestId); resolve(allowed); };
            const abort = () => finish(false);
            this.toolApprovals.set(approval.requestId, finish);
            execution.abortController.signal.addEventListener('abort', abort, { once: true });
            if (execution.abortController.signal.aborted) abort();
        });
    }

    private recordToolArtifact(runId: string, change: { path: string; oldContent: string | null; newContent: string }, activityId: string): string {
        const run = this.requireRun(runId);
        const artifact: ArtifactSnapshot = { ...change, id: randomUUID(), sessionId: run.sessionId, runId, turnId: run.turnId,
            hash: createHash('sha256').update(change.newContent, 'utf8').digest('hex'), createdAt: new Date().toISOString() };
        const activities = run.activities?.map(activity => activity.id === activityId && activity.tool
            ? { ...activity, tool: { ...activity.tool, artifactId: artifact.id } } : activity);
        const next = this.nextPayloadEvent({ ...run, activities }, 'artifact-created', { artifact });
        this.commit({ runs: [next.run], artifacts: [artifact], events: [next.event] }); this.runs.set(runId, next.run); this.deliver([next.event]);
        return artifact.id;
    }

    private apiMessages(sessionId: string, input: string, currentRunId: string, historyTurns?: number): ApiMessage[] {
        const history = conversationMessages(this.store.readSessionSnapshot(sessionId), sessionId, { beforeRunId: currentRunId, historyTurns, includeFailed: true });
        history.push({ role: 'user', content: input });
        return history;
    }

    private async resolveSelectedConnection(
        endpointId: string,
        modelId: string,
    ): Promise<ApiConnection> {
        if (!this.resolveConnection) {
            throw new Error('API runtime is unavailable because no endpoint resolver is configured');
        }
        const connection = await this.resolveConnection(endpointId);
        if (connection.id !== endpointId || !connection.enabled || !connection.models.includes(modelId)) {
            throw new Error('The selected API endpoint is unavailable or no longer offers this model');
        }
        return connection;
    }

    private requireEndpointId(session: SessionRecord): string {
        const endpointId = session.requested.endpointId;
        if (!endpointId) {
            throw new Error('API session is missing its selected endpoint');
        }
        return endpointId;
    }

    private apiConfig(connection: ApiConnection, modelId: string) {
        return {
            runtimeId: 'api',
            modelId,
            agentId: 'api-text',
            policyVersion: 1,
            endpointId: connection.id,
            endpointRevision: connection.revision,
            endpointUrl: connection.baseUrl,
            protocol: connection.protocol,
        } as const;
    }

    private apiError(error: unknown, apiKey: string): Error {
        const message = error instanceof Error ? error.message : String(error);
        const safeMessage = apiKey ? message.split(apiKey).join('[redacted]') : message;
        return new Error(safeMessage);
    }

    private appendDelta(runId: string, text: string): void {
        const current = this.requireRun(runId);
        if (current.state !== 'running') {
            return;
        }
        const activities = structuredClone(current.activities || []);
        if (current.effective.runtimeId === 'api') {
            const previous = activities.at(-1);
            if (previous?.kind === 'text') previous.content += text;
            else activities.push({ id: randomUUID(), kind: 'text', title: '', content: text, status: 'completed' });
        }
        const updated = { ...current, output: current.output + text, ...(current.effective.runtimeId === 'api' ? { activities } : {}) };
        const textActivity = activities.at(-1);
        const next = this.nextPayloadEvent(updated, 'delta', { text, offset: current.output.length,
            ...(current.effective.runtimeId === 'api' && textActivity?.kind === 'text' ? { activityId: textActivity.id, activityOffset: textActivity.content.length - text.length } : {}) });
        const request = this.activeRequests.get(runId);
        if (request) this.activeCaptures.get(runId)!.text(next.run, text, current.output.length);
        else this.commit({ runs: [next.run], events: [next.event] });
        this.runs.set(runId, next.run);
        this.deliver([next.event]);
    }

    private requestApproval(runId: string, directory: string): void {
        const current = this.requireRun(runId);
        if (current.state !== 'running') {
            return;
        }
        const targetPath = expectedOutputPath(directory, current.id);
        const approval: ApprovalRecord = {
            runtimeId: current.effective.runtimeId,
            sessionId: current.sessionId,
            runId: current.id,
            turnId: current.turnId,
            requestId: randomUUID(),
            policyVersion: current.effective.policyVersion,
            status: 'pending',
            summary: '将在所选目录新建一个验证文件；不调用 AI 模型。',
            path: targetPath,
            createdAt: new Date().toISOString(),
        };
        const pendingRun = { ...current, state: 'approval' as const };
        const state = this.nextRunState(pendingRun);
        const requested = this.nextPayloadEvent(state.run, 'approval-requested', {
            approval: structuredClone(approval),
        });
        this.commit({
            runs: [requested.run],
            approvals: [approval],
            events: [state.event, requested.event],
        });
        this.runs.set(runId, requested.run);
        this.approvals.set(approval.requestId, approval);
        this.deliver([state.event, requested.event]);
    }

    private completeRun(runId: string): void {
        const current = this.requireRun(runId);
        if (current.state !== 'running') {
            return;
        }
        const completed: RunRecord = { ...current, state: 'completed' };
        const frame = this.completedFrames.get(runId);
        if (frame) completed.modelFrame = { ...frame, publicFingerprint: modelTurnFingerprint(completed) };
        const next = this.nextRunState(completed);
        this.commit({ runs: [next.run], events: [next.event] });
        this.runs.set(runId, next.run);
        this.deliver([next.event]);
        this.finishActiveRun(runId);
    }

    private readModelFrame(frame: ModelFrame): unknown {
        if (frame.content.availability !== 'present' || frame.content.byteLength > 16 * 1024 * 1024) throw new Error('Model frame unavailable');
        return JSON.parse(this.journal.artifactStore(frame.sessionId).read(frame.content).toString('utf8'));
    }

    private async stopRun(runId: string, reason?: string): Promise<void> {
        const current = this.runs.get(runId);
        if (!current) {
            throw new Error(`Run not found: ${runId}`);
        }
        if (this.isTerminal(current.state)) {
            return;
        }

        // Capture the first explicit explanation before aborting so all terminal transitions retain it.
        if (reason !== undefined && current.stopReason === undefined) {
            const updated = { ...current, stopReason: reason };
            try { this.commit({ runs: [updated] }); }
            catch { this.recordingFailures.add(current.sessionId); }
            this.runs.set(runId, updated);
        }

        const execution = this.active.get(runId);
        if (execution) {
            if (!execution.stopTask) {
                execution.stopTask = this.stopActiveRun(runId, execution);
            }
            await execution.stopTask;
            return;
        }

        this.persistStoppedRun(runId);
    }

    private async stopActiveRun(runId: string, execution: ActiveExecution): Promise<void> {
        const stoppingRun = this.runs.get(runId);
        if (stoppingRun) {
            try {
                const content = stoppingRun.stopReason ? this.journal.artifactStore(stoppingRun.sessionId).save({ text: stoppingRun.stopReason }).ref : null;
                this.journal.event(stoppingRun, 'control.requested', { action: 'stop', expectedStepId: this.activeRequests.get(runId)?.stepId ?? null, content });
            } catch { this.recordingFailures.add(stoppingRun.sessionId); }
        }
        execution.cancelled = true;
        execution.abortController.abort();
        this.releaseWaiters(execution);

        const cancelling = this.runs.get(runId);
        if (cancelling && !this.isTerminal(cancelling.state)) {
            const requested = this.nextRunState({ ...cancelling, state: 'cancelRequested' });
            const stopping = this.nextRunState({ ...requested.run, state: 'stopping' });
            try {
                this.commit({ runs: [stopping.run], events: [requested.event, stopping.event] });
                this.runs.set(runId, stopping.run);
                this.deliver([requested.event, stopping.event]);
            } catch {
                // Cancellation must still drain owned executions when persistence is unavailable.
                this.recordingFailures.add(cancelling.sessionId);
            }
        }

        try {
            await execution.task;
        } catch {
            // The streaming task persists operational failures itself. Cancellation remains stopped.
        }
        this.persistStoppedRun(runId);
    }

    private persistStoppedRun(runId: string): void {
        const current = this.runs.get(runId);
        if (!current || this.isTerminal(current.state)) {
            this.finishActiveRun(runId);
            return;
        }

        const events: RuntimeEvent[] = [];
        let next = current;
        const states = current.state === 'stopping'
            ? ['stopped'] as const
            : ['cancelRequested', 'stopping', 'stopped'] as const;
        for (const state of states) {
            const step = this.nextRunState({ ...next, state });
            next = step.run;
            events.push(step.event);
        }

        const approval = [...this.approvals.values()].find(
            (candidate) => candidate.runId === runId && candidate.status === 'pending',
        );
        let expired: ApprovalRecord | undefined;
        if (approval) {
            expired = { ...approval, status: 'expired' };
            const resolved = this.nextPayloadEvent(next, 'approval-resolved', {
                approval: structuredClone(expired),
            });
            next = resolved.run;
            events.push(resolved.event);
        }

        try { this.commit({ runs: [next], approvals: expired ? [expired] : [], events }); }
        catch { this.finishRecordingFailure(runId); return; }
        this.runs.set(runId, next);
        if (expired) {
            this.approvals.set(expired.requestId, expired);
        }
        this.deliver(events);
        this.finishActiveRun(runId);
    }

    /** Only called after the owned streaming/tool task has settled. */
    private finishRecordingFailure(runId: string): void {
        const current = this.requireRun(runId);
        this.recordingFailures.add(current.sessionId);
        let next: RunRecord = { ...current, state: 'failed', harnessState: 'recording_failed', error: '执行已停止，但运行记录无法完整保存。请检查日志存储与工作区副作用。' };
        const notices: RuntimeEvent[] = [];
        for (const approval of this.approvals.values()) if (approval.runId === runId && approval.status === 'pending') {
            const expired = { ...approval, status: 'expired' as const };
            const notice = this.nextPayloadEvent(next, 'approval-resolved', { approval: expired });
            next = notice.run; notices.push(notice.event); this.approvals.set(approval.requestId, expired);
            this.toolApprovals.get(approval.requestId)?.(false);
        }
        const failed = this.nextRunState(next);
        // The fault latch permits an explicit failed projection, never new execution.
        try { this.commit({ runs: [failed.run], events: [failed.event] }); } catch { /* Independent memory/IPC fault channel remains available. */ }
        this.runs.set(runId, failed.run); this.deliver([...notices, failed.event]); this.finishActiveRun(runId);
    }

    private resolveApproval(
        identity: ApprovalIdentity,
        decision: 'approve' | 'reject',
    ): void {
        const approval = this.approvals.get(identity.requestId);
        if (!approval || !this.sameApprovalIdentity(approval, identity)) {
            throw new Error('Approval identity does not match the pending request');
        }
        if (approval.status !== 'pending') {
            throw new Error(`Approval is no longer pending (${approval.status})`);
        }

        const current = this.requireRun(approval.runId);
        const execution = this.active.get(current.id);
        if (current.state !== 'approval' || !execution || execution.cancelled) {
            throw new Error('Approval is stale because its run is no longer active');
        }
        if (
            current.effective.runtimeId !== identity.runtimeId ||
            current.effective.policyVersion !== identity.policyVersion
        ) {
            throw new Error('Approval runtime or policy version changed');
        }

        if (approval.toolCallId) {
            const resolve = this.toolApprovals.get(approval.requestId);
            if (!resolve) throw new Error('工具审批已失效。');
            const resolved = { ...approval, status: decision === 'approve' ? 'approved' as const : 'rejected' as const };
            const event = this.nextPayloadEvent({ ...current, state: 'running' }, 'approval-resolved', { approval: resolved });
            this.commit({ runs: [event.run], approvals: [resolved], events: [event.event] });
            this.runs.set(current.id, event.run); this.approvals.set(resolved.requestId, resolved);
            this.deliver([event.event]); this.toolApprovals.delete(resolved.requestId); resolve(decision === 'approve');
            return;
        }

        if (decision === 'reject') {
            const rejected: ApprovalRecord = { ...approval, status: 'rejected' };
            const first = this.nextPayloadEvent(current, 'approval-resolved', {
                approval: structuredClone(rejected),
            });
            const done = this.nextRunState({ ...first.run, state: 'completed' });
            const events = [first.event, done.event];
            this.commit({ runs: [done.run], approvals: [rejected], events });
            this.runs.set(current.id, done.run);
            this.approvals.set(rejected.requestId, rejected);
            this.deliver(events);
            this.finishActiveRun(current.id);
            return;
        }

        const session = this.sessions.get(current.sessionId);
        if (!session?.directory) {
            throw new Error('This session has no writable directory');
        }
        const directory = canonicalizeDirectory(session.directory);
        if (!sameDirectory(directory, session.directory)) {
            throw new Error('The session directory no longer resolves to its approved location');
        }
        const targetPath = expectedOutputPath(directory, current.id);
        if (approval.path !== targetPath) {
            throw new Error('Approval output path no longer matches the run destination');
        }

        let createdFile: CreatedFile;
        try {
            createdFile = writeNewFileExclusive(directory, current.id, current.output);
        } catch (error) {
            this.failApproval(current, approval, error);
            return;
        }

        const approved: ApprovalRecord = { ...approval, status: 'approved' };
        const artifact: ArtifactSnapshot = {
            id: randomUUID(),
            sessionId: current.sessionId,
            runId: current.id,
            turnId: current.turnId,
            path: createdFile.path,
            oldContent: null,
            newContent: current.output,
            hash: createHash('sha256').update(current.output, 'utf8').digest('hex'),
            createdAt: new Date().toISOString(),
        };
        const first = this.nextPayloadEvent(current, 'approval-resolved', {
            approval: structuredClone(approved),
        });
        const second = this.nextPayloadEvent(first.run, 'artifact-created', {
            artifact: structuredClone(artifact),
        });
        const done = this.nextRunState({ ...second.run, state: 'completed' });
        const events = [first.event, second.event, done.event];
        try {
            this.commit({
                runs: [done.run],
                approvals: [approved],
                artifacts: [artifact],
                events,
            });
        } catch (error) {
            removeCreatedFile(createdFile);
            throw error;
        }
        this.runs.set(current.id, done.run);
        this.approvals.set(approved.requestId, approved);
        this.deliver(events);
        this.finishActiveRun(current.id);
    }

    private failApproval(
        current: RunRecord,
        approval: ApprovalRecord,
        error: unknown,
    ): void {
        const expired: ApprovalRecord = { ...approval, status: 'expired' };
        const failedRun = {
            ...current,
            state: 'failed' as const,
            error: this.errorMessage(error),
        };
        const first = this.nextRunState(failedRun);
        const second = this.nextPayloadEvent(first.run, 'approval-resolved', {
            approval: structuredClone(expired),
        });
        const events = [first.event, second.event];
        this.commit({ runs: [second.run], approvals: [expired], events });
        this.runs.set(current.id, second.run);
        this.approvals.set(expired.requestId, expired);
        this.deliver(events);
        this.finishActiveRun(current.id);
    }

    private failRun(runId: string, error: unknown): void {
        const current = this.runs.get(runId);
        if (!current || this.isTerminal(current.state)) {
            return;
        }
        for (const approval of this.approvals.values()) {
            if (approval.runId !== runId || approval.status !== 'pending') continue;
            const expired: ApprovalRecord = { ...approval, status: 'expired' };
            this.commit({ approvals: [expired] }); this.approvals.set(approval.requestId, expired);
            this.toolApprovals.get(approval.requestId)?.(false);
        }
        const failed = this.nextRunState({
            ...current,
            state: 'failed',
            error: this.errorMessage(error),
        });
        this.commit({ runs: [failed.run], events: [failed.event] });
        this.runs.set(runId, failed.run);
        this.deliver([failed.event]);
        this.finishActiveRun(runId);
    }

    private loadAndRecover(): void {
        const uncertainRuns = this.store.readUnresolvedDispatchRuns();
        const snapshot = this.store.readRecoverySnapshot(uncertainRuns);
        for (const session of snapshot.sessions) {
            this.sessions.set(session.id, session);
        }
        for (const approval of snapshot.approvals) {
            this.approvals.set(approval.requestId, approval);
        }

        for (const run of snapshot.runs) {
            const pending = [...this.approvals.values()].filter(
                (approval) => approval.runId === run.id && approval.status === 'pending',
            );
            let updated = run;
            const events: RuntimeEvent[] = [];
            let wasChanged = false;
            if (uncertainRuns.has(run.id) && updated.harnessState !== 'recording_failed') {
                updated = { ...updated, harnessState: 'needs_reconciliation', error: '工具已派发但没有持久结果；必须核对副作用，不能自动重放。' };
                wasChanged = true;
            }
            if (!this.isTerminal(run.state)) {
                const stopped = this.nextRunState({
                    ...updated,
                    state: 'stopped',
                    error: uncertainRuns.has(run.id) ? updated.error : 'Stopped during runtime restart',
                });
                updated = stopped.run;
                events.push(stopped.event);
                wasChanged = true;
            }

            const expiredApprovals: ApprovalRecord[] = [];
            for (const approval of pending) {
                const expired: ApprovalRecord = { ...approval, status: 'expired' };
                const resolved = this.nextPayloadEvent(updated, 'approval-resolved', {
                    approval: structuredClone(expired),
                });
                updated = resolved.run;
                events.push(resolved.event);
                expiredApprovals.push(expired);
                wasChanged = true;
            }

            if (wasChanged) {
                this.commit({
                    runs: [updated],
                    approvals: expiredApprovals,
                    events,
                });
                this.runs.set(run.id, updated);
                for (const approval of expiredApprovals) {
                    this.approvals.set(approval.requestId, approval);
                }
                this.deliver(events);
            }
        }
    }

    private pause(execution: ActiveExecution): Promise<boolean> {
        if (execution.cancelled || this.closed || this.shuttingDown) {
            return Promise.resolve(false);
        }
        return new Promise((resolve) => {
            let timer: ReturnType<typeof setTimeout>;
            const finish = (continues: boolean) => {
                clearTimeout(timer);
                execution.waiters.delete(cancel);
                resolve(continues && !execution.cancelled && !this.closed && !this.shuttingDown);
            };
            const cancel = () => finish(false);
            timer = setTimeout(() => finish(true), this.delayMs);
            execution.waiters.add(cancel);
        });
    }

    private releaseWaiters(execution: ActiveExecution): void {
        for (const cancel of [...execution.waiters]) {
            cancel();
        }
    }

    private finishActiveRun(runId: string): void {
        this.completedFrames.delete(runId);
        if (!this.runs.get(runId)?.parentRunId) {
            clearTimeout(this.budgetTimers.get(runId)); this.budgetTimers.delete(runId); this.taskBudgets.delete(runId);
        }
        const execution = this.active.get(runId);
        if (!execution) {
            return;
        }
        execution.cancelled = true;
        this.releaseWaiters(execution);
        this.active.delete(runId);
        if (
            execution.directoryLeaseKey &&
            this.directoryLeases.get(execution.directoryLeaseKey) === runId
        ) {
            this.directoryLeases.delete(execution.directoryLeaseKey);
        }
    }

    private nextRunState(run: RunRecord): { run: RunRecord; event: RuntimeEvent } {
        if (this.isTerminal(run.state) && !run.finishedAt && this.runs.get(run.id) && !this.isTerminal(this.runs.get(run.id)!.state)) run = { ...run, finishedAt: new Date().toISOString() };
        if (this.isTerminal(run.state) && run.activities) {
            const status = run.state as 'completed' | 'failed' | 'stopped';
            run = { ...run, activities: run.activities.map(activity => ['running', 'approval'].includes(activity.status) ? { ...activity, status } : activity) };
        }
        const sequencedRun = { ...run, sequence: run.sequence + 1 };
        const event = this.eventForRun(sequencedRun, 'run-state', {
            run: structuredClone(sequencedRun),
        });
        return { run: sequencedRun, event };
    }

    private nextPayloadEvent<TPayload>(
        run: RunRecord,
        type: EventType,
        payload: TPayload,
    ): { run: RunRecord; event: RuntimeEvent } {
        const sequencedRun = { ...run, sequence: run.sequence + 1 };
        return {
            run: sequencedRun,
            event: this.eventForRun(sequencedRun, type, payload),
        };
    }

    private eventForRun(run: RunRecord, type: EventType, payload: unknown): RuntimeEvent {
        return {
            runtimeId: run.effective.runtimeId,
            sessionId: run.sessionId,
            runId: run.id,
            turnId: run.turnId,
            sequence: run.sequence,
            type,
            payload,
        } as RuntimeEvent;
    }

    private deliver(events: RuntimeEvent[]): void {
        for (const event of events) {
            try {
                this.onEvent(structuredClone(event));
            } catch {
                // A disconnected UI must not roll back a committed runtime transition.
            }
        }
    }

    private sameApprovalIdentity(
        approval: ApprovalRecord,
        identity: ApprovalIdentity,
    ): boolean {
        return (
            approval.runtimeId === identity.runtimeId &&
            approval.sessionId === identity.sessionId &&
            approval.runId === identity.runId &&
            approval.turnId === identity.turnId &&
            approval.requestId === identity.requestId &&
            approval.policyVersion === identity.policyVersion
        );
    }

    private requireRun(runId: string): RunRecord {
        const run = this.runs.get(runId);
        if (!run) {
            throw new Error(`Run not found: ${runId}`);
        }
        return run;
    }

    private isTerminal(state: RunRecord['state']): boolean {
        return state === 'stopped' || state === 'completed' || state === 'failed';
    }

    private errorMessage(error: unknown): string {
        const message = error instanceof Error ? error.message : String(error);
        return message.slice(0, 2_000);
    }

    private assertRunning(): void {
        if (this.closed || this.shuttingDown) {
            throw new Error('Runtime supervisor is shutting down');
        }
    }
}
