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
} from '../shared/contracts.js';
import { parseCommand } from '../shared/contracts.js';
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

export const LOCAL_VERIFICATION_RUNTIME_ID = 'local-verification';
const MAX_ACTIVE_RUNS = 16;
const DEFAULT_DELAY_MS = 35;

export interface SupervisorOptions {
    dataDirectory: string;
    onEvent: (event: RuntimeEvent) => void;
    delayMs?: number;
}

interface ActiveExecution {
    cancelled: boolean;
    task: Promise<void>;
    waiters: Set<() => void>;
    directoryLeaseKey: string | null;
}

type EventType = RuntimeEvent['type'];

export class Supervisor {
    private readonly store: RuntimeStore;
    private readonly onEvent: (event: RuntimeEvent) => void;
    private readonly delayMs: number;
    private readonly adapter: RuntimeAdapter;
    private readonly sessions = new Map<string, SessionRecord>();
    private readonly runs = new Map<string, RunRecord>();
    private readonly approvals = new Map<string, ApprovalRecord>();
    private readonly active = new Map<string, ActiveExecution>();
    private readonly directoryLeases = new Map<string, string>();
    private shuttingDown = false;
    private closed = false;

    constructor(options: SupervisorOptions) {
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
        this.loadAndRecover();
    }

    async execute(input: Command): Promise<Snapshot> {
        this.assertRunning();
        const command = parseCommand(input);
        switch (command.type) {
            case 'snapshot':
                return this.store.readSnapshot();
            case 'create-session':
                this.createSession(command.title, command.directory);
                return this.store.readSnapshot();
            case 'start-run':
                this.startRun(command.sessionId, command.input);
                return this.store.readSnapshot();
            case 'stop-run':
                this.stopRun(command.runId);
                return this.store.readSnapshot();
            case 'resolve-approval':
                this.resolveApproval(command.identity, command.decision);
                return this.store.readSnapshot();
        }
    }

    async shutdown(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.shuttingDown = true;
        const activeIds = [...this.active.keys()];
        const tasks = [...this.active.values()].map((execution) => execution.task);
        const errors: unknown[] = [];
        for (const runId of activeIds) {
            try {
                this.stopRun(runId);
            } catch (error) {
                errors.push(error);
                const execution = this.active.get(runId);
                if (execution) {
                    execution.cancelled = true;
                    this.releaseWaiters(execution);
                }
            }
        }

        await Promise.all(tasks);
        this.store.close();
        this.closed = true;
        if (errors.length > 0) {
            throw new AggregateError(errors, 'One or more active runs could not be persisted as stopped');
        }
    }

    private createSession(title: string, requestedDirectory: string | null): void {
        this.store.assertCanCreateSession();
        const directory =
            requestedDirectory === null ? null : canonicalizeDirectory(requestedDirectory);
        const now = new Date().toISOString();
        const session: SessionRecord = {
            id: randomUUID(),
            title,
            directory,
            requested: {
                runtimeId: this.adapter.runtimeId,
                modelId: this.adapter.modelId,
                agentId: 'local-verification',
                policyVersion: 1,
            },
            createdAt: now,
        };
        const event = {
            runtimeId: this.adapter.runtimeId,
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

    private startRun(sessionId: string, input: string): void {
        const session = this.sessions.get(sessionId);
        if (!session) {
            throw new Error(`Session not found: ${sessionId}`);
        }
        if (
            session.requested.modelId !== this.adapter.modelId ||
            session.requested.runtimeId !== this.adapter.runtimeId
        ) {
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
            effective: structuredClone(session.requested),
            sequence: 0,
            createdAt: new Date().toISOString(),
        };
        const initial = this.nextRunState(run);
        this.store.commit({ runs: [initial.run], events: [initial.event] });
        this.runs.set(run.id, initial.run);

        const execution: ActiveExecution = {
            cancelled: false,
            task: Promise.resolve(),
            waiters: new Set(),
            directoryLeaseKey: leaseKey,
        };
        this.active.set(run.id, execution);
        if (leaseKey) {
            this.directoryLeases.set(leaseKey, run.id);
        }
        this.deliver([initial.event]);
        execution.task = this.streamRun(run.id, canonicalDirectory, execution);
    }

    private async streamRun(
        runId: string,
        directory: string | null,
        execution: ActiveExecution,
    ): Promise<void> {
        try {
            const run = this.runs.get(runId);
            if (!run) {
                return;
            }
            for await (const text of this.adapter.stream(run.input)) {
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
            if (directory === null) {
                this.completeRun(runId);
            } else {
                this.requestApproval(runId, directory);
            }
        } catch (error) {
            if (execution.cancelled || this.closed || this.shuttingDown) {
                return;
            }
            try {
                this.failRun(runId, error);
            } catch (persistError) {
                console.error('Failed to persist local verification run failure', persistError);
            }
        }
    }

    private appendDelta(runId: string, text: string): void {
        const current = this.requireRun(runId);
        if (current.state !== 'running') {
            return;
        }
        const updated = { ...current, output: current.output + text };
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

    private stopRun(runId: string): void {
        const current = this.runs.get(runId);
        if (!current) {
            throw new Error(`Run not found: ${runId}`);
        }
        if (this.isTerminal(current.state)) {
            return;
        }

        const execution = this.active.get(runId);
        if (execution) {
            execution.cancelled = true;
            this.releaseWaiters(execution);
        }

        const events: RuntimeEvent[] = [];
        let next = current;
        for (const state of ['cancelRequested', 'stopping', 'stopped'] as const) {
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
