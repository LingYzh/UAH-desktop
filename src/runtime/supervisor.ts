import { createHash, randomUUID } from 'node:crypto';
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
import { streamAgentApi, appendToolResults } from './api-transport.js';
import { executeWorkspaceTool, workspaceToolDefinitions } from './workspace-tools.js';
import { delegationToolDefinitions } from './delegation-tools.js';
import { parentConversation, resolveDelegation } from '../shared/delegation.js';
import { boundedHistoryText, conversationMessages, latestVisibleRootRun, visibleRootRuns } from '../shared/conversation-history.js';
import { sessionHasFileChanges } from '../shared/run-effects.js';
import { submitPlanTool, enterPlanModeTool, writePlanTool, readPlanTool, writePlanFile, readPlanFile } from './plan-tools.js';
import type { AgentSettings } from '../shared/agents.js';
import type { ToolCall } from '../shared/tool-protocol.js';
import { LocalVerificationAdapter } from './local-verification.js';
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
import { RuntimeStore } from './store.js';
import { readGit, gitPromptContext } from './git';
import { gitToolDefinitions, executeGitTool } from './git-tools';
import { captureRequestContext, contextSummary } from './request-context';
import type { RequestContextDetail } from '../shared/request-context';

export const LOCAL_VERIFICATION_RUNTIME_ID = 'local-verification';
const MAX_ACTIVE_RUNS = 64;
const DEFAULT_DELAY_MS = 35;

export interface SupervisorOptions {
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
    private readonly dataDirectory: string;
    private readonly store: RuntimeStore;
    private readonly onEvent: (event: RuntimeEvent) => void;
    private readonly delayMs: number;
    private readonly adapter: RuntimeAdapter;
    private readonly resolveConnection?: (endpointId: string) => Promise<ApiConnection>;
    private readonly resolveAgent?: (agentId: string) => AgentProfile;
    private readonly getAgentSettings?: () => AgentSettings;
    private readonly toolApprovals = new Map<string, (allowed: boolean) => void>();
    private readonly sessions = new Map<string, SessionRecord>();
    private readonly runs = new Map<string, RunRecord>();
    private readonly approvals = new Map<string, ApprovalRecord>();
    private readonly active = new Map<string, ActiveExecution>();
    private readonly planEdits = new Set<string>();
    private readonly planEditSettled = new Map<string, Promise<void>>();
    private readonly directoryLeases = new Map<string, string>();
    private shuttingDown = false;
    private closed = false;

    constructor(options: SupervisorOptions) {
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
        this.onEvent = options.onEvent;
        this.delayMs = Math.min(requestedDelay, 10_000);
        this.adapter = new LocalVerificationAdapter();
        this.resolveConnection = options.resolveConnection;
        this.resolveAgent = options.resolveAgent;
        this.getAgentSettings = options.getAgentSettings;
        this.loadAndRecover();
    }

    async execute(input: Command): Promise<Snapshot> {
        this.assertRunning();
        const command = parseCommand(input);
        switch (command.type) {
            case 'snapshot':
                return this.store.readSnapshot();
            case 'create-session':
                await this.createSession(command.title, command.directory, command.selection, command.controls, command.agentId, command.branchFromRunId);
                return this.store.readSnapshot();
            case 'edit-reply':
            case 'delete-reply':
                this.changeReply(command.runId, command.type === 'edit-reply' ? command.output : undefined);
                this.invalidateRequestContexts(this.requireRun(command.runId).sessionId);
                return this.store.readSnapshot();
            case 'regenerate-run': {
                const original = this.requireHistoryRun(command.runId);
                this.assertRegenerable(original);
                const unchanged = this.historyGuard(original.sessionId);
                await this.startRun(original.sessionId, original.input, command.selection, undefined, original.id, () => { unchanged(); this.assertRegenerable(original); });
                return this.store.readSnapshot();
            }
            case 'edit-plan':
                await this.editPlan(command);
                this.invalidateRequestContexts(this.requireRun(command.runId).sessionId);
                return this.store.readSnapshot();
            case 'resolve-plan':
                await this.resolvePlan(command);
                return this.store.readSnapshot();
            case 'set-session-controls':
                this.setSessionControls(command.sessionId, command.controls, command.revision);
                return this.store.readSnapshot();
            case 'start-run':
                await this.startRun(command.sessionId, command.input, command.selection, command.agentId);
                return this.store.readSnapshot();
            case 'stop-run':
                await this.stopRun(command.runId, command.reason);
                return this.store.readSnapshot();
            case 'resolve-approval':
                this.resolveApproval(command.identity, command.decision);
                return this.store.readSnapshot();
        }
    }

    requestContext(runId: string): RequestContextDetail | null {
        this.assertRunning();
        const run = this.requireRun(runId);
        if (run.history?.deleted || !run.requestContext) return null;
        const detail = this.store.readRequestContext(runId);
        return detail && detail.requestId === run.requestContext.requestId ? { ...detail, usage: run.requestContext.usage } : null;
    }

    private invalidateRequestContexts(sessionId: string): void {
        const updates = [...this.runs.values()].filter(run => run.sessionId === sessionId && run.requestContext)
            .map(run => { const { requestContext: _context, ...rest } = run; return this.nextRunState(rest); });
        this.store.commit({ clearContextSessions: [sessionId], runs: updates.map(next => next.run), events: updates.map(next => next.event) });
        for (const next of updates) this.runs.set(next.run.id, next.run);
        this.deliver(updates.map(next => next.event));
    }

    private saveRequestContext(runId: string, detail: RequestContextDetail): void {
        const next = this.nextRunState({ ...this.requireRun(runId), requestContext: contextSummary(detail) });
        this.store.commit({ contexts: [detail], runs: [next.run], events: [next.event] });
        this.runs.set(runId, next.run);
        this.deliver([next.event]);
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
        if (source && !visibleRootRuns([...this.runs.values()], source.sessionId).some(run => run.id === source.id)) throw new Error('不能从已被重新生成替代的旧回复创建分支。');
        const unchanged = source ? this.historyGuard(source.sessionId) : undefined;
        if (!selection && controls !== undefined) throw new Error('本地验证运行不支持会话控制设置。');
        const connection = selection
            ? await this.resolveSelectedConnection(selection.endpointId, selection.modelId)
            : undefined;
        this.assertRunning();
        unchanged?.();
        if (source && source.effective.runtimeId !== (connection ? 'api' : this.adapter.runtimeId)) throw new Error('分支主智能体已固定，不能切换运行方式。');
        this.store.assertCanCreateSession();
        const branchMessages = source ? conversationMessages(this.store.readSnapshot(), source.sessionId, { throughRunId: source.id, includeFailed: true, combineInterruptedTurn: true }) : undefined;
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
        const event = {
            runtimeId: session.requested.runtimeId,
            sessionId: session.id,
            runId: '',
            turnId: '',
            sequence: 0,
            type: 'session-created',
            payload: { session: structuredClone(session) },
        } as RuntimeEvent;

        this.store.commit({ sessions: [session], events: [event] });
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
        this.store.commit({ sessions: [updated] });
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
        const captured = [...this.runs.values()].filter(run => run.sessionId === sessionId);
        return () => {
            this.assertSessionIdle(sessionId);
            const current = [...this.runs.values()].filter(run => run.sessionId === sessionId);
            if (captured.length !== current.length || captured.some((run, index) => run !== current[index])) throw new Error('会话历史已更新，请刷新后重试。');
        };
    }
    private assertLatestReply(run: RunRecord): void {
        if (latestVisibleRootRun([...this.runs.values()], run.sessionId)?.id !== run.id || run.history?.deleted) throw new Error('只能重新生成会话中最后一轮未删除的回复。');
    }
    private assertRegenerable(run: RunRecord): void {
        this.assertLatestReply(run);
        if (sessionHasFileChanges(this.store.readSnapshot(), run.sessionId)) throw new Error('此会话已产生文件更改，或执行了无法确认副作用的命令，不能重新生成。请发送新的明确请求。');
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
        this.store.commit({ runs: [updated], events: [event], clearContextSessions: [run.sessionId] }); this.runs.set(runId, updated); this.deliver([event]);
    }

    private async startRun(sessionId: string, input: string, selection?: { endpointId: string; modelId: string } | null, agentId?: string, retryOfRunId?: string, guard?: () => void | Promise<void>, transition?: PlanTransition): Promise<void> {
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
        this.assertRunning();
        if (guard) { const pending = guard(); if (pending) await pending; }
        const latestSession = this.sessions.get(sessionId)!;
        if (this.planEdits.has(sessionId)) throw new Error('计划正在编辑，请稍后启动运行。');
        session = { ...latestSession, requested: session.requested };
        const controls = this.sessionControls(latestSession);
        if (transition) controls.permissionMode = transition.permissionMode;
        const locked = [...this.runs.values()].find((run) => run.sessionId === sessionId)?.effective ?? latestSession.branchAgent;
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
        this.store.commit({ sessions: [updatedSession], runs: [...(resolvedSource ? [resolvedSource] : []), initial.run], events: [...(sourceEvent ? [sourceEvent] : []), initial.event] });
        this.sessions.set(sessionId, updatedSession);
        if (resolvedSource) this.runs.set(resolvedSource.id, resolvedSource);
        this.runs.set(run.id, initial.run);

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
                const cause = execution.abortController.signal.aborted && execution.abortController.signal.reason instanceof Error ? execution.abortController.signal.reason : error;
                this.failRun(runId, connection ? this.apiError(cause, connection.apiKey) : cause);
            } catch (persistError) {
                console.error('Failed to persist runtime run failure', persistError);
            }
        }
    }

    private updateActivity(runId: string, activity: RunActivity): void {
        const current = this.requireRun(runId);
        const activities = structuredClone(current.activities || []);
        const index = activities.findIndex(item => item.id === activity.id);
        if (index < 0) activities.push(structuredClone(activity)); else activities[index] = structuredClone(activity);
        const next = this.nextRunState({ ...current, activities });
        this.store.commit({ runs: [next.run], events: [next.event] });
        this.runs.set(runId, next.run); this.deliver([next.event]);
    }

    private availableTools(run: RunRecord, connection: ApiConnection) {
        if (effectiveModelDetails(connection, run.effective.modelId)?.tools === false) return [];
        const mode = run.effective.permissionMode ?? 'manual';
        const settings = this.getAgentSettings?.().subagents;
        const canDelegate = settings && run.effective.allowDelegation && settings.enabled && (run.depth ?? 0) < settings.maxDepth;
        return [...workspaceToolDefinitions().filter(tool => !['plan', 'readonly'].includes(mode) || !['write_file', 'run_command'].includes(tool.name)),
            ...gitToolDefinitions,
            ...(canDelegate ? delegationToolDefinitions : []),
            ...(!run.parentRunId ? mode === 'plan' ? [writePlanTool, readPlanTool, submitPlanTool] : mode !== 'readonly' ? [readPlanTool, enterPlanModeTool] : [readPlanTool] : [])];
    }
    private currentPlan(sessionId: string): RunRecord | undefined {
        const session = this.sessions.get(sessionId)!;
        if (session.activePlanRunId) {
            const run = this.runs.get(session.activePlanRunId);
            return run?.sessionId === sessionId && !run.parentRunId && !run.history?.deleted && run.plan ? run : undefined;
        }
        return [...this.runs.values()].filter(run => run.sessionId === sessionId && !run.parentRunId && !run.history?.deleted && run.plan).at(-1);
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
        this.store.commit({ sessions: [session], runs: [next.run], events: [next.event] }); this.sessions.set(session.id, session); this.runs.set(runId, next.run); this.deliver([next.event]);
    }
    private async submitPlan(runId: string): Promise<void> {
        const run = this.requireRun(runId);
        if (run.parentRunId || run.effective.permissionMode !== 'plan' || run.plan?.status !== 'draft') throw new Error('请先由 Plan 主代理写入本轮计划草稿。');
        const disk = await this.readStoredPlan(run);
        const snapshot = await writePlanFile(this.dataDirectory, run.sessionId, run.plan.id, disk.content, run.plan.documentId, true);
        const current = this.requireRun(runId);
        if (current.state !== 'running' || this.active.get(runId)?.abortController.signal.aborted) throw new Error('计划提交期间运行已取消。');
        const next = this.nextRunState({ ...current, plan: { ...run.plan, ...snapshot, status: 'proposed' } });
        this.store.commit({ runs: [next.run], events: [next.event] }); this.runs.set(runId, next.run); this.deliver([next.event]);
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
            this.store.commit({ sessions: [session], runs: [next.run], events: [next.event], clearContextSessions: [source.sessionId] }); this.sessions.set(session.id, session); this.runs.set(source.id, next.run); this.deliver([next.event]);
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
        this.store.commit({ sessions: [updatedSession], runs: [next.run], events: [next.event] });
        this.sessions.set(session.id, updatedSession); this.runs.set(runId, next.run); this.deliver([next.event]);
        return { content: '已进入 Plan 模式并保存会话设置。从现在起只读探索，禁止修改与命令；下一模型轮准备完整计划并调用 submit_plan 等待用户审阅。' };
    }

    private async agentLoop(run: RunRecord, directory: string | null, execution: ActiveExecution, connection: ApiConnection): Promise<void> {
        const messages = run.contextMessages
            ? [...run.contextMessages, { role: 'user' as const, content: run.input }]
            : this.apiMessages(run.sessionId, run.input, run.id, run.effective.modelParameters?.historyTurns);
        let continuation: unknown[] | undefined;
        let finished = false;
        let lastModeTransitionId: string | undefined;
        const consumedChildren = new Map<string, string>();
        const pendingChildren = new Map<string, string>();
        const terminalVersion = (child: RunRecord) => ['completed', 'failed', 'stopped'].includes(child.state) ? `${child.state}:${child.sequence}:${child.finishedAt ?? ''}` : undefined;
        try {
            for (let round = 0; round < 16; round++) {
                execution.abortController.signal.throwIfAborted();
                run = this.requireRun(run.id);
                const settings = this.getAgentSettings?.().subagents;
                const tools = this.availableTools(run, connection);
                const git = await readGit({ directory, kind: 'status' }, execution.abortController.signal);
                execution.abortController.signal.throwIfAborted();
                const assembled = assemblePrompt({ run, directory, tools: tools.map(tool => tool.name), settings, modeTransition: run.modeTransition?.id !== lastModeTransitionId ? run.modeTransition : undefined,
                    context: { GIT_STATUS_AND_TASK_CONTEXT: gitPromptContext(git.snapshot) } });
                lastModeTransitionId = run.modeTransition?.id;
                recordPromptAssembly(connection.protocol, { runId: run.id, round, profile: assembled.profile, totalCharacters: assembled.totalCharacters, modules: assembled.modules });
                const instructions = assembled.instructions;
                const requestContext = captureRequestContext({ runId: run.id, round, protocol: connection.protocol, modelId: run.effective.modelId,
                    capacity: effectiveModelDetails(connection, run.effective.modelId)?.contextWindow,
                    sections: assembled.sections, messages, continuation, tools });
                this.saveRequestContext(run.id, requestContext);
                let completed: { toolCalls: ToolCall[]; continuation: unknown[] } | undefined;
                let reasoning: RunActivity | undefined;
                // Pending tool/host results become consumed only when a model request receives them.
                for (const [id, version] of pendingChildren) consumedChildren.set(id, version);
                pendingChildren.clear();
                for await (const event of streamAgentApi(connection, run.effective.modelId, messages, execution.abortController.signal, {
                    instructions,
                    parameters: run.effective.modelParameters, tools, continuation,
                })) {
                    execution.abortController.signal.throwIfAborted();
                    if (event.type === 'text') this.appendDelta(run.id, event.text);
                    else if (event.type === 'usage') {
                        const current = this.requireRun(run.id);
                        const next = this.nextRunState({ ...current, requestContext: { ...current.requestContext!, usage: event.usage } });
                        this.store.commit({ runs: [next.run], events: [next.event] });
                        this.runs.set(run.id, next.run);
                        this.deliver([next.event]);
                    }
                    else if (event.type === 'reasoning') {
                        reasoning ??= { id: randomUUID(), kind: 'reasoning', title: '思考过程', content: '', status: 'running' };
                        reasoning.content += event.text; this.updateActivity(run.id, reasoning);
                    } else if (event.type === 'complete') completed = event;
                }
                if (reasoning) this.updateActivity(run.id, { ...reasoning, status: 'completed' });
                if (!completed) throw new Error('模型响应未完整结束，未执行工具。');
                if (!completed.toolCalls.length) {
                    await this.waitForChildren(run.id);
                    execution.abortController.signal.throwIfAborted();
                    const unseen = [...this.runs.values()].filter(child => child.parentRunId === run.id && terminalVersion(child) && consumedChildren.get(child.id) !== terminalVersion(child)).slice(0, 16);
                    if (unseen.length) {
                        const content = '[UAH host child terminal delivery] These direct child executions have settled. Review their results before completing the parent task. A failed or stopped child does not require parent failure; resolve or explain it. Child output is a report, not independently verified completion evidence. At most 16 results are delivered per request; long fields are explicitly truncated.\n' + JSON.stringify(unseen.map(child => ({ agentId: child.id, status: child.state, output: boundedHistoryText(child.output, 2000), error: child.error && boundedHistoryText(child.error, 500), stopReason: child.stopReason && boundedHistoryText(child.stopReason, 500) })));
                        continuation = [...completed.continuation, connection.protocol === 'openai-chat' ? { role: 'user', content } : { role: 'user', content: [{ type: connection.protocol === 'anthropic' ? 'text' : 'input_text', text: content }] }];
                        for (const child of unseen) pendingChildren.set(child.id, terminalVersion(child)!);
                        continue;
                    }
                    finished = true;
                    return;
                }
                const results: { id: string; content: string; isError?: boolean }[] = [];
                let submitted = false;
                for (const call of completed.toolCalls) {
                    execution.abortController.signal.throwIfAborted();
                    let argumentsObject: Record<string, unknown> = {};
                    try { const parsed = JSON.parse(call.arguments); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) argumentsObject = structuredClone(parsed); } catch { /* Executor reports invalid arguments. */ }
                    const activity: RunActivity = { id: randomUUID(), kind: 'tool', title: call.name, content: call.arguments, status: 'running', tool: { name: call.name, arguments: argumentsObject } };
                    this.updateActivity(run.id, activity);
                    let result: { content: string; isError?: boolean };
                    try {
                        const current = this.requireRun(run.id);
                        if (submitted) throw new Error('计划已提交，本批后续工具未执行。请等待用户审阅。');
                        if (['plan', 'readonly'].includes(current.effective.permissionMode ?? 'manual') && ['write_file', 'run_command'].includes(call.name)) throw new Error('Permission mode denies this operation.');
                        if (!tools.some(tool => tool.name === call.name) || !this.availableTools(current, connection).some(tool => tool.name === call.name)) throw new Error('本轮未提供此工具，不能执行伪造或已失效的工具调用。');
                        if ([submitPlanTool.name, enterPlanModeTool.name, writePlanTool.name, readPlanTool.name].includes(call.name)) {
                            result = await this.planTool(run.id, call); submitted = call.name === submitPlanTool.name;
                        } else if (delegationToolDefinitions.some(tool => tool.name === call.name)) {
                            result = await this.delegationTool(current, call, execution, activity);
                            if (call.name === 'wait_agents') {
                                for (const delivered of JSON.parse(result.content)) {
                                    const child = this.runs.get(delivered.agentId);
                                    const version = child && terminalVersion(child);
                                    if (version && child?.parentRunId === run.id && delivered.status === child.state) pendingChildren.set(child.id, version);
                                }
                            }
                        } else if (gitToolDefinitions.some(tool => tool.name === call.name)) result = await executeGitTool(call, directory, execution.abortController.signal);
                        else result = await executeWorkspaceTool(call, {
                            directory, permissionMode: current.effective.permissionMode ?? 'manual', signal: execution.abortController.signal,
                            approve: (summary, path) => {
                                this.updateActivity(run.id, { ...activity, status: 'approval' });
                                return this.requestToolApproval(run.id, activity.id, summary, path, execution);
                            },
                            onArtifact: change => {
                                activity.tool!.artifactId = this.recordToolArtifact(run.id, change, activity.id);
                            },
                        });
                    } catch (error) { result = { content: this.errorMessage(error), isError: true }; }
                    execution.abortController.signal.throwIfAborted();
                    this.updateActivity(run.id, { ...activity, tool: { ...activity.tool!, result: result.content, isError: result.isError === true }, content: activity.content + '\n\n' + result.content, status: result.isError ? 'failed' : 'completed' });
                    results.push({ id: call.id, ...result });
                }
                if (submitted) {
                    await this.waitForChildren(run.id); execution.abortController.signal.throwIfAborted();
                    finished = true; return;
                }
                continuation = appendToolResults(connection.protocol, completed.continuation, results);
            }
            throw new Error('已达到每轮 16 次模型/工具循环上限。');
        } finally {
            // Own child executions must settle before releasing the root workspace lease.
            if (!finished || execution.abortController.signal.aborted || execution.cancelled) {
                await Promise.all([...this.runs.values()].filter(child => child.parentRunId === run.id && this.active.has(child.id)).map(child => this.stopRun(child.id)));
            } else await this.waitForChildren(run.id);
        }
    }

    private async waitForChildren(parentId: string): Promise<void> {
        await Promise.all([...this.runs.values()].filter(child => child.parentRunId === parentId).map(child => this.active.get(child.id)?.task));
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
        }, settings, request, parentConversation(this.store.readSnapshot(), parentRun.id));
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
        this.store.commit({ runs: [initial.run], events: [initial.event] }); this.runs.set(run.id, initial.run); this.deliver([initial.event]);
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
        this.store.commit({ runs: [next.run], approvals: [approval], events: [next.event] });
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
        this.store.commit({ runs: [next.run], artifacts: [artifact], events: [next.event] }); this.runs.set(runId, next.run); this.deliver([next.event]);
        return artifact.id;
    }

    private apiMessages(sessionId: string, input: string, currentRunId: string, historyTurns?: number): ApiMessage[] {
        const history = conversationMessages(this.store.readSnapshot(), sessionId, { beforeRunId: currentRunId, historyTurns, includeFailed: true });
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
        const next = this.nextPayloadEvent(updated, 'delta', { text });
        this.store.commit({ runs: [next.run], events: [next.event] });
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
        this.store.commit({
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
        const next = this.nextRunState({ ...current, state: 'completed' });
        this.store.commit({ runs: [next.run], events: [next.event] });
        this.runs.set(runId, next.run);
        this.deliver([next.event]);
        this.finishActiveRun(runId);
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
            this.store.commit({ runs: [updated] });
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
        execution.cancelled = true;
        execution.abortController.abort();
        this.releaseWaiters(execution);

        const cancelling = this.runs.get(runId);
        if (cancelling && !this.isTerminal(cancelling.state)) {
            const requested = this.nextRunState({ ...cancelling, state: 'cancelRequested' });
            const stopping = this.nextRunState({ ...requested.run, state: 'stopping' });
            this.store.commit({ runs: [stopping.run], events: [requested.event, stopping.event] });
            this.runs.set(runId, stopping.run);
            this.deliver([requested.event, stopping.event]);
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

        this.store.commit({
            runs: [next],
            approvals: expired ? [expired] : [],
            events,
        });
        this.runs.set(runId, next);
        if (expired) {
            this.approvals.set(expired.requestId, expired);
        }
        this.deliver(events);
        this.finishActiveRun(runId);
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
            this.store.commit({ runs: [event.run], approvals: [resolved], events: [event.event] });
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
            this.store.commit({ runs: [done.run], approvals: [rejected], events });
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
            this.store.commit({
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
        this.store.commit({ runs: [second.run], approvals: [expired], events });
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
            this.store.commit({ approvals: [expired] }); this.approvals.set(approval.requestId, expired);
            this.toolApprovals.get(approval.requestId)?.(false);
        }
        const failed = this.nextRunState({
            ...current,
            state: 'failed',
            error: this.errorMessage(error),
        });
        this.store.commit({ runs: [failed.run], events: [failed.event] });
        this.runs.set(runId, failed.run);
        this.deliver([failed.event]);
        this.finishActiveRun(runId);
    }

    private loadAndRecover(): void {
        const snapshot = this.store.readSnapshot();
        for (const session of snapshot.sessions) {
            this.sessions.set(session.id, session);
        }
        for (const run of snapshot.runs) {
            this.runs.set(run.id, run);
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
            if (!this.isTerminal(run.state)) {
                const stopped = this.nextRunState({
                    ...updated,
                    state: 'stopped',
                    error: 'Stopped during runtime restart',
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
                this.store.commit({
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
