import type { ApiProtocol, EndpointCommand, EndpointReply } from './endpoints';
import type { AgentCommand, AgentSettings } from './agents';
import type { ModelParameters } from './model-parameters';
import type { PermissionMode } from './permissions';
import { parseSessionControls, type SessionControls } from './session-controls';
import type { DelegationRequest, DelegationPlan } from './delegation';

// Additive journal contracts; existing IPC RunState and sequence retain their semantics.
export type { RunIdentity, RequestIdentity, InvocationIdentity, HarnessRunState,
    TranscriptEvent, TranscriptManifest, RequestSnapshot, UsageRecord } from './harness-contracts';

export interface RuntimeConfig {
    runtimeId: string;
    modelId: string;
    agentId: string;
    policyVersion: number;
    endpointId?: string;
    endpointRevision?: number;
    endpointUrl?: string;
    protocol?: ApiProtocol;
    /** Snapshot of the primary-agent settings used for this run. */
    agentName?: string;
    agentInstructions?: string;
    /** Compatibility with snapshots written before model settings were separated. */
    agentParameters?: ModelParameters;
    modelParameters?: ModelParameters;
    permissionMode?: PermissionMode;
    allowDelegation?: boolean;
}

export interface SessionRecord {
    branchHistory?: Array<{ messages: import('./endpoints').ApiMessage[]; modelFrame?: import('./harness-contracts').ModelFrame }>;
    branchArtifacts?: import('./harness-contracts').ArtifactReference[];
    activePlanRunId?: string;
    pendingModeTransition?: ModeTransition;
    branchAgent?: RuntimeConfig;
    branchFromRunId?: string;
    branchMessages?: import('./endpoints').ApiMessage[];
    id: string;
    title: string;
    directory: string | null;
    requested: RuntimeConfig;
    createdAt: string;
    controls?: SessionControls;
    controlsRevision?: number;
    initialConfig?: {
        agentId: string;
        selection: { endpointId: string; modelId: string } | null;
        controls: SessionControls;
        directory: string | null;
    };
}

export type RunState =
    | 'running'
    | 'approval'
    | 'cancelRequested'
    | 'stopping'
    | 'stopped'
    | 'completed'
    | 'failed';

export interface RunActivity {
    id: string;
    kind: 'text' | 'reasoning' | 'tool' | 'agent';
    title: string;
    content: string;
    status: 'running' | 'approval' | 'completed' | 'failed' | 'stopped';
    childRunId?: string;
    /** Structured display metadata; content remains the canonical legacy/history text. */
    tool?: { name: string; arguments: Record<string, unknown>; result?: string; isError?: boolean; artifactId?: string; outcome?: import('./harness-contracts').ToolOutcome };
}
export interface RunRecord {
    goalVerification?: import('./goal-verification').GoalVerification;
    resumeOfRunId?: string;
    reconciliation?: { reviewId: string; throughSeq: number; reviewedAt: string; resourceFingerprint: string };
    activeStepId?: string;
    steering?: Array<{ id: string; expectedStepId: string; input: string; status: 'queued' | 'applied' }>;
    contextState?: { version: string; taskState: import('./harness-contracts').ArtifactReference };
    budgetState?: import('./harness-contracts').JsonValue;
    toolProgress?: import('./harness-contracts').ToolProgressState;
    budgetStopCode?: string;
    modelFrame?: import('./harness-contracts').ModelFrame;
    /** Machine state supplements the legacy UI projection; never infer recovery from `state`. */
    harnessState?: import('./harness-contracts').HarnessRunState;
    requestContext?: import('./request-context').RequestContextSummary;
    modeTransition?: ModeTransition;
    plan?: PlanRecord;
    history?: { editedOutput?: string; deleted?: boolean };
    retryOfRunId?: string;
    finishedAt?: string;
    /** Optional user explanation supplied when explicitly stopping this run. */
    stopReason?: string;
    parentRunId?: string;
    depth?: number;
    contextMessages?: import('./endpoints').ApiMessage[];
    activities?: RunActivity[];
    id: string;
    sessionId: string;
    turnId: string;
    state: RunState;
    input: string;
    output: string;
    effective: RuntimeConfig;
    sequence: number;
    error?: string;
    createdAt: string;
}

export interface ModeTransition { id: string; from: PermissionMode; to: PermissionMode; reason: 'manual' | 'tool' | 'plan-approved'; planId?: string; planVersion?: number }
export interface PlanVersion { id: string; documentId?: string; title?: string; version?: number; content: string; filePath: string; hash: string; createdAt: string }
export interface PlanRecord extends PlanVersion { draftPath?: string; history?: PlanVersion[]; status: 'draft' | 'proposed' | 'approved' | 'revision-requested'; resolvedAt?: string; executionRunId?: string; feedback?: string }

export interface ApprovalIdentity {
    runtimeId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    requestId: string;
    policyVersion: number;
}

export interface ApprovalRecord extends ApprovalIdentity {
    toolCallId?: string;
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    summary: string;
    path: string;
    createdAt: string;
}

export interface ArtifactSnapshot {
    id: string;
    sessionId: string;
    runId: string;
    turnId: string;
    path: string;
    oldContent: string | null;
    newContent: string;
    hash: string;
    createdAt: string;
}

export interface Snapshot {
    pendingSessionPurges?: string[];
    historyWindow?: import('./snapshot-view').HistoryWindow;
    viewSessionId?: string | null;
    overview?: import('./snapshot-view').WorkspaceOverview;
    sessions: SessionRecord[];
    runs: RunRecord[];
    approvals: ApprovalRecord[];
    artifacts: ArtifactSnapshot[];
}

export type Command =
    | { type: 'verify-goal'; runId: string; fingerprint: string; criteria: string }
    | { type: 'resume-run'; runId: string; fingerprint: string; input: string }
    | { type: 'reconcile-run'; runId: string; fingerprint: string; note: string }
    | { type: 'snapshot' }
    | { type: 'create-session'; title: string; directory: string | null; selection?: { endpointId: string; modelId: string }; controls?: SessionControls; agentId?: string; branchFromRunId?: string }
    | { type: 'edit-reply'; runId: string; output: string }
    | { type: 'edit-plan'; runId: string; planId: string; content: string; title: string }
    | { type: 'delete-reply'; runId: string }
    | { type: 'regenerate-run'; runId: string; selection?: { endpointId: string; modelId: string } | null }
    | { type: 'resolve-plan'; runId: string; planId: string; decision: 'approve' | 'revise'; permissionMode?: 'manual' | 'accept-edits' | 'auto' | 'bypass'; feedback?: string; selection?: { endpointId: string; modelId: string } | null }
    | { type: 'set-session-controls'; sessionId: string; controls: SessionControls; revision: number }
    | {
          type: 'start-run';
          sessionId: string;
          input: string;
          selection?: { endpointId: string; modelId: string } | null;
          agentId?: string;
      }
    | { type: 'stop-run'; runId: string; reason?: string }
    | { type: 'steer-run'; runId: string; expectedStepId: string; input: string }
    | {
          type: 'resolve-approval';
          identity: ApprovalIdentity;
          decision: 'approve' | 'reject';
      };

type EventEnvelope<TType extends string, TPayload> = {
    runtimeId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    sequence: number;
    type: TType;
    payload: TPayload;
};

export type RuntimeEvent =
    | EventEnvelope<'run-state', { run: RunRecord }>
    | EventEnvelope<'delta', { text: string; offset?: number; activityId?: string; activityOffset?: number }>
    | EventEnvelope<'activity-delta', { activityId: string; kind: 'reasoning'; title: string; offset: number; text: string }>
    | EventEnvelope<'approval-requested', { approval: ApprovalRecord }>
    | EventEnvelope<'approval-resolved', { approval: ApprovalRecord }>
    | EventEnvelope<'artifact-created', { artifact: ArtifactSnapshot }>
    | EventEnvelope<'session-created', { session: SessionRecord }>;

export type BrowserAction =
    | { type: 'open'; url: string; sessionId: string }
    | {
          type: 'bounds';
          sessionId: string;
          x: number;
          y: number;
          width: number;
          height: number;
      }
    | { type: 'hide' }
    | { type: 'close' };

export interface BrowserState {
    url: string;
    visible: boolean;
    error?: string;
}

export interface DesktopBridge {
    journalPolicy(command: import('./journal-policy').JournalPolicyCommand): Promise<import('./journal-policy').JournalPolicy>;
    journal(query: import('./journal-view').JournalQuery): Promise<unknown>;
    git(query: import('./git').GitQuery): Promise<import('./git').GitResult>;
    requestContext(query: { runId: string }): Promise<import('./request-context').RequestContextDetail | null>;
    openLogs(): Promise<void>;
    openExternal(url: string): Promise<void>;
    writeClipboard(text: string): Promise<void>;
    agents(command: AgentCommand): Promise<AgentSettings>;
    previewDelegation(value: { parentRunId: string; request: DelegationRequest }): Promise<DelegationPlan>;
    endpoints(command: EndpointCommand): Promise<EndpointReply>;
    command(command: Command, view?: import('./snapshot-view').SnapshotView): Promise<Snapshot>;
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
    setWindowTheme(theme: 'light' | 'dark'): Promise<void>;
    chooseDirectory(): Promise<string | null>;
    observeDesktop(): Promise<unknown>;
    browser(action: BrowserAction): Promise<BrowserState>;
}

const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_INPUT_LENGTH = 100_000;

function fail(message: string): never {
    throw new TypeError(`Invalid runtime command: ${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
    value: unknown,
    requiredKeys: readonly string[],
    field: string,
): asserts value is Record<string, unknown> {
    if (!isPlainRecord(value)) {
        fail(`${field} must be a plain object`);
    }

    const actualKeys = Reflect.ownKeys(value);
    const expected = new Set(requiredKeys);
    const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
    const unknown = actualKeys.filter((key) => typeof key !== 'string' || !expected.has(key));
    if (missing.length > 0 || unknown.length > 0) {
        const details = [
            missing.length > 0 ? `missing ${missing.join(', ')}` : '',
            unknown.length > 0 ? `unknown ${unknown.map(String).join(', ')}` : '',
        ]
            .filter(Boolean)
            .join('; ');
        fail(`${field} has ${details}`);
    }

    for (const key of actualKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) {
            fail(`${field}.${String(key)} must be a data property`);
        }
    }
}

function readString(value: unknown, field: string, maximumLength = MAX_ID_LENGTH): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
        fail(`${field} must be a non-empty string of at most ${maximumLength} characters`);
    }
    return value;
}

function readInput(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_INPUT_LENGTH) {
        fail(`input must be a string of at most ${MAX_INPUT_LENGTH} characters`);
    }
    return value;
}

function readPolicyVersion(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        fail('identity.policyVersion must be a non-negative safe integer');
    }
    return value as number;
}

function parseApprovalIdentity(value: unknown): ApprovalIdentity {
    assertExactKeys(
        value,
        ['runtimeId', 'sessionId', 'runId', 'turnId', 'requestId', 'policyVersion'],
        'identity',
    );

    return {
        runtimeId: readString(value.runtimeId, 'identity.runtimeId'),
        sessionId: readString(value.sessionId, 'identity.sessionId'),
        runId: readString(value.runId, 'identity.runId'),
        turnId: readString(value.turnId, 'identity.turnId'),
        requestId: readString(value.requestId, 'identity.requestId'),
        policyVersion: readPolicyVersion(value.policyVersion),
    };
}

/** Validates the renderer-to-runtime protocol and rejects all extra fields. */
export function parseCommand(value: unknown): Command {
    if (!isPlainRecord(value) || typeof value.type !== 'string') {
        fail('command must be an object with a type');
    }

    switch (value.type) {
        case 'verify-goal': {
            assertExactKeys(value, ['type', 'runId', 'fingerprint', 'criteria'], 'command');
            const fingerprint = readString(value.fingerprint, 'fingerprint');
            if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail('Invalid verification fingerprint');
            return { type: 'verify-goal', runId: readString(value.runId, 'runId'), fingerprint, criteria: readString(value.criteria, 'criteria', 4000) };
        }
        case 'snapshot': {
            assertExactKeys(value, ['type'], 'command');
            return { type: 'snapshot' };
        }
        case 'create-session': {
            const hasSelection = Object.hasOwn(value, 'selection');
            const hasControls = Object.hasOwn(value, 'controls');
            assertExactKeys(value, ['type', 'title', 'directory', ...(hasSelection ? ['selection'] : []), ...(hasControls ? ['controls'] : []), ...(Object.hasOwn(value, 'agentId') ? ['agentId'] : []), ...(Object.hasOwn(value, 'branchFromRunId') ? ['branchFromRunId'] : [])], 'command');
            let selection: { endpointId: string; modelId: string } | undefined;
            if (hasSelection) {
                assertExactKeys(value.selection, ['endpointId', 'modelId'], 'selection');
                selection = {
                    endpointId: readString(value.selection.endpointId, 'selection.endpointId'),
                    modelId: readString(value.selection.modelId, 'selection.modelId'),
                };
            }
            if (value.directory !== null && typeof value.directory !== 'string') {
                fail('directory must be a string or null');
            }
            if (typeof value.directory === 'string' && value.directory.length > 32_000) {
                fail('directory is too long');
            }

            return {
                type: 'create-session',
                title: readString(value.title, 'title', MAX_TITLE_LENGTH),
                directory: value.directory as string | null,
                ...(selection ? { selection } : {}),
                ...(hasControls ? { controls: parseSessionControls(value.controls) } : {}),
                ...(Object.hasOwn(value, 'agentId') ? { agentId: readString(value.agentId, 'agentId') } : {}),
                ...(Object.hasOwn(value, 'branchFromRunId') ? { branchFromRunId: readString(value.branchFromRunId, 'branchFromRunId') } : {}),
            };
        }
        case 'edit-reply': {
            assertExactKeys(value, ['type', 'runId', 'output'], 'command');
            if (typeof value.output !== 'string' || value.output.length > 1_000_000) fail('output must be text up to 1000000 characters');
            return { type: 'edit-reply', runId: readString(value.runId, 'runId'), output: value.output };
        }
        case 'edit-plan': {
            assertExactKeys(value, ['type', 'runId', 'planId', 'content', 'title'], 'command');
            if (typeof value.content !== 'string' || !value.content.trim() || value.content.length > 100000 || new TextDecoder().decode(new TextEncoder().encode(value.content)) !== value.content) fail('plan content must be valid nonempty Unicode up to 100000 characters');
            return { type: 'edit-plan', runId: readString(value.runId, 'runId'), planId: readString(value.planId, 'planId'), content: value.content, title: readString(value.title, 'title', MAX_TITLE_LENGTH) };
        }
        case 'resolve-plan': {
            const hasSelection = Object.hasOwn(value, 'selection');
            if (value.decision !== 'approve' && value.decision !== 'revise') fail('plan decision must be approve or revise');
            assertExactKeys(value, ['type', 'runId', 'planId', 'decision', value.decision === 'approve' ? 'permissionMode' : 'feedback', ...(hasSelection ? ['selection'] : [])], 'command');
            if (value.decision === 'approve' && !['manual', 'accept-edits', 'auto', 'bypass'].includes(value.permissionMode as string)) fail('approved plan requires an explicit execution permission mode');
            if (value.decision === 'revise' && (typeof value.feedback !== 'string' || !value.feedback.trim() || value.feedback.length > 20000)) fail('plan feedback must be nonempty text up to 20000 characters');
            const selection = hasSelection ? parseCommand({ type: 'start-run', sessionId: 'plan', input: 'plan', selection: value.selection }) : undefined;
            return { type: 'resolve-plan', runId: readString(value.runId, 'runId'), planId: readString(value.planId, 'planId'), decision: value.decision,
                ...(value.decision === 'approve' ? { permissionMode: value.permissionMode as 'manual' | 'accept-edits' | 'auto' | 'bypass' } : { feedback: value.feedback as string }),
                ...(selection?.type === 'start-run' ? { selection: selection.selection } : {}) };
        }
        case 'regenerate-run': {
            const hasSelection = Object.hasOwn(value, 'selection');
            assertExactKeys(value, ['type', 'runId', ...(hasSelection ? ['selection'] : [])], 'command');
            let selection: { endpointId: string; modelId: string } | null = null;
            if (hasSelection && value.selection !== null) {
                assertExactKeys(value.selection, ['endpointId', 'modelId'], 'selection');
                selection = { endpointId: readString(value.selection.endpointId, 'selection.endpointId'), modelId: readString(value.selection.modelId, 'selection.modelId') };
            }
            return { type: 'regenerate-run', runId: readString(value.runId, 'runId'), ...(hasSelection ? { selection } : {}) };
        }
        case 'delete-reply': {
            assertExactKeys(value, ['type', 'runId'], 'command');
            return { type: 'delete-reply', runId: readString(value.runId, 'runId') };
        }
        case 'set-session-controls': {
            assertExactKeys(value, ['type', 'sessionId', 'controls', 'revision'], 'command');
            if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 0) fail('revision must be a non-negative safe integer');
            return { type: 'set-session-controls', sessionId: readString(value.sessionId, 'sessionId'),
                controls: parseSessionControls(value.controls), revision: value.revision as number };
        }
        case 'start-run': {
            const hasSelection = Object.hasOwn(value, 'selection');
            const hasAgentId = Object.hasOwn(value, 'agentId');
            assertExactKeys(value, ['type', 'sessionId', 'input', ...(hasSelection ? ['selection'] : []), ...(hasAgentId ? ['agentId'] : [])], 'command');
            let selection: { endpointId: string; modelId: string } | null = null;
            if (hasSelection && value.selection !== null) {
                assertExactKeys(value.selection, ['endpointId', 'modelId'], 'selection');
                selection = { endpointId: readString(value.selection.endpointId, 'selection.endpointId'), modelId: readString(value.selection.modelId, 'selection.modelId') };
            }
            const agentId = hasAgentId ? readString(value.agentId, 'agentId') : undefined;
            const input = readInput(value.input);
            if (input.trim().length === 0) {
                fail('input must not be empty');
            }

            return {
                type: 'start-run',
                sessionId: readString(value.sessionId, 'sessionId'),
                input,
                ...(hasSelection ? { selection } : {}),
                ...(agentId ? { agentId } : {}),
            };
        }
        case 'stop-run': {
            const hasReason = Object.hasOwn(value, 'reason');
            assertExactKeys(value, ['type', 'runId', ...(hasReason ? ['reason'] : [])], 'command');
            return {
                type: 'stop-run',
                runId: readString(value.runId, 'runId'),
                ...(hasReason ? { reason: readString(value.reason, 'reason', 2000) } : {}),
            };
        }
        case 'resume-run':
        case 'reconcile-run': {
            const field = value.type === 'resume-run' ? 'input' : 'note';
            assertExactKeys(value, ['type', 'runId', 'fingerprint', field], 'command');
            const fingerprint = readString(value.fingerprint, 'fingerprint', 64);
            if (!/^[a-f0-9]{64}$/.test(fingerprint)) fail('Invalid recovery fingerprint');
            const common = { runId: readString(value.runId, 'runId'), fingerprint };
            return value.type === 'resume-run' ? { type: 'resume-run', ...common, input: readString(value.input, 'input', 20000) }
                : { type: 'reconcile-run', ...common, note: readString(value.note, 'note', 4000) };
        }
        case 'steer-run': {
            assertExactKeys(value, ['type', 'runId', 'expectedStepId', 'input'], 'command');
            return { type: 'steer-run', runId: readString(value.runId, 'runId'), expectedStepId: readString(value.expectedStepId, 'expectedStepId'), input: readString(value.input, 'input', 20000) };
        }
        case 'resolve-approval': {
            assertExactKeys(value, ['type', 'identity', 'decision'], 'command');
            if (value.decision !== 'approve' && value.decision !== 'reject') {
                fail('decision must be approve or reject');
            }

            return {
                type: 'resolve-approval',
                identity: parseApprovalIdentity(value.identity),
                decision: value.decision,
            };
        }
        default:
            fail(`unknown command type ${value.type}`);
    }
}
