import type { RunState } from './contracts';
import type { ApiProtocol } from './endpoints';

/** Versioned desktop journal/runtime contracts; legacy UI projections remain additive. */
export const HARNESS_SCHEMA_VERSION = 1 as const;
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface RunIdentity {
    sessionId: string;
    runId: string;
    parentRunId: string | null;
    rootRunId: string;
    turnId: string;
}
export interface RequestIdentity extends RunIdentity {
    stepId: string;
    requestId: string;
    attemptId: string;
}
export interface InvocationIdentity extends RequestIdentity {
    toolCallId: string;
    invocationId: string;
}

export type HarnessRunState = 'waiting_model' | 'waiting_approval' | 'waiting_resource'
    | 'running_tools' | 'stopping' | 'suspended_budget' | 'recording_failed'
    | 'needs_reconciliation' | 'completed' | 'failed' | 'cancelled';

/** Lossy display mapping only: never use this projection to authorize or resume work. */
export function projectLegacyRunState(state: HarnessRunState): RunState {
    switch (state) {
        case 'waiting_model': case 'waiting_resource': case 'running_tools': return 'running';
        case 'waiting_approval': return 'approval';
        case 'stopping': return 'stopping';
        case 'cancelled': return 'stopped';
        case 'completed': return 'completed';
        case 'failed': case 'recording_failed': case 'needs_reconciliation': case 'suspended_budget': return 'failed';
    }
}

export type ArtifactReference = { mediaType: string } & (
    | { availability: 'present'; relativePath: string; sha256: string; byteLength: number; missingReason: null }
    | { availability: 'missing'; relativePath: string; sha256: string | null; byteLength: number | null; missingReason: string }
    | { availability: 'external_reference_only'; relativePath: null; sha256: null; byteLength: null; externalReference: string; missingReason: string }
);
export interface ResourceVersion {
    hashKind?: 'raw_bytes' | 'utf8_text';
    uri: string;
    beforeHash: string | null;
    afterHash: string | null;
}
export interface TimeEvidence {
    processEpochId: string;
    startedAt: string;
    finishedAt: string | null;
    /** Monotonic duration within this epoch; never subtract wall clocks across restarts. */
    durationMs: number | null;
}
export interface ToolOutcome {
    executionEvidence?: { executionId: string; treeExited: boolean; outputDrained: boolean; terminationReason: string | null; stdoutBytes: number; stderrBytes: number; outputRedacted?: boolean; provenance?: ExecutionProvenance };
    schemaVersion: 1;
    status: 'succeeded' | 'failed' | 'denied' | 'cancelled' | 'running';
    effectState: 'not_started' | 'possible' | 'confirmed' | 'reconciled';
    recordingState: 'durable' | 'pending' | 'failed';
    retryClass: 'safe' | 'idempotent_with_key' | 'reconcile_first' | 'never';
    idempotencyKey: string | null;
    errorCode: string | null;
    exitCode: number | null;
    preview: string;
    artifactRefs: ArtifactReference[];
    truncation: { truncated: boolean; reason: string | null };
    resources: ResourceVersion[];
    time: TimeEvidence;
}

/** Additive invocation metadata; encoded command body is intentionally absent. */
export interface ExecutionProvenance {
    shell: string;
    shellVersion: string;
    shellVersionSource: string;
    arguments: string[];
    commandEncoding: string;
    outputEncoding: string;
    commandArgumentCapture: 'omitted';
    cwd: string;
    timeoutMs: number;
    maxOutputBytes: number;
    redacted: boolean;
}

export interface ToolProgressState {
    failedBatches: number;
    repeatedFailureBatches: number;
    lastFailureFingerprint: string | null;
    stopCode: 'no_progress' | 'model_corrections' | null;
}

export interface UsageCounters {
    inputTokens: number | null;
    outputTokens: number | null;
    cachedInputTokens: number | null;
    cacheCreationInputTokens: number | null;
    totalTokens: number | null;
}
export interface UsageRecord {
    schemaVersion: 1;
    requestId: string;
    attemptId: string;
    /** Revision replaces the previous snapshot for this attempt; it is not a delta. */
    revision: number;
    purpose: 'agent' | 'connection_test' | 'auxiliary' | 'compaction';
    scope: { kind: 'session'; sessionId: string; runId: string } | { kind: 'application' };
    protocol: ApiProtocol;
    adapterVersion: string;
    source: 'provider' | 'unavailable';
    completeness: 'complete' | 'partial' | 'unknown';
    rawUsage: JsonValue;
    counters: UsageCounters;
    normalization?: { version: 1; sourcePaths: string[]; diagnostics: Array<{ code: string; paths: string[] }>;
        inputUncachedTokens: number | null; reasoningTokens: number | null };
    providerResponseId: string | null;
    /** Namespaces response IDs without storing endpoint credentials. */
    accountNamespace: string;
    reportedCost: { amount: string; currency: string } | null;
    estimatedCost: { amount: string; currency: string; pricingVersion: string } | null;
}

export interface RequestSnapshot {
    bodyCapture?: 'disabled';
    schemaVersion: 1;
    identity: RequestIdentity;
    protocol: ApiProtocol;
    adapterVersion: string;
    capturedAt: string;
    /** Final application payload after protocol encoding, without authentication headers. */
    body: JsonValue;
    artifacts: ArtifactReference[];
    coverage: 'complete' | 'partial' | 'external_reference_only';
    redactionPolicyVersion: string;
}

/** Immutable provider-native turn stored separately from its editable public view. */
export interface ModelFrame {
    schemaVersion: 1;
    frameId: string;
    sessionId: string;
    protocol: ApiProtocol;
    modelId: string;
    accountNamespace: string;
    publicFingerprint: string;
    prefixLength: number;
    /** A full V2 continuation may replace the prefix only while its public ancestry still matches. */
    surface?: { historyDigest: string; turns: number };
    content: ArtifactReference;
    continuationCoverage: 'native' | 'unavailable';
}

export interface TranscriptPayloads {
    'native.event': { method: string; content: ArtifactReference; coverage: 'partial' };
    'goal.verified': { verificationId: string; method: 'user_review'; evidence: ArtifactReference };
    'message.accepted': { messageId: string; revision: number; role: 'user' | 'assistant'; content: ArtifactReference };
    'history.revised': { messageId: string; revision: number; branchId: string; cutoffEventId: string | null; content?: ArtifactReference; deleted?: boolean };
    'history.frame': { frame: ModelFrame };
    'history.branch': { sourceRunId: string; content: ArtifactReference; frames: ArtifactReference[]; artifacts?: ArtifactReference[] };
    'run.state': { state: HarnessRunState; reason: string | null };
    'request.intent': { identity: RequestIdentity; snapshot: ArtifactReference };
    'request.sent': { requestId: string; attemptId: string };
    /** Dispatch boundary only; receipt/billing remain uncertain after a crash. */
    'request.dispatch': { requestId: string; attemptId: string };
    'request.retry': { requestId: string; attemptId: string; reason: string; retryNumber: number; delayMs: number };
    'provider.frame': { requestId: string; attemptId: string; frame: ArtifactReference };
    'response.native': { requestId: string; attemptId: string; content: ArtifactReference };
    'artifact.created': { artifactId: string; content: ArtifactReference };
    'response.started': { requestId: string; attemptId: string };
    'response.delta': { requestId: string; attemptId: string; blockId: string; offset: number; offsetUnit: 'utf16'; text: string };
    'response.terminal': { requestId: string; attemptId: string; status: 'completed' | 'failed' | 'cancelled'; partial: boolean };
    'tool.batch': { requestId: string; attemptId: string; invocations: InvocationIdentity[] };
    'approval.decided': { approvalId: string; invocationId: string; policyVersion: number; decision: 'approved' | 'denied' | 'expired' };
    'approval.requested': { approvalId: string; invocationId: string; policyVersion: number; summary: string };
    'tool.dispatch': { identity: InvocationIdentity; executionId: string | null; approvalId: string | null; toolName?: string };
    'tool.result': { invocationId: string; outcome: ToolOutcome };
    'usage.snapshot': { usage: UsageRecord };
    'budget.updated': { state: JsonValue };
    'progress.updated': { state: ToolProgressState };
    'recovery.reviewed': { reviewId: string; runIds: string[]; throughSeq: number; evidence: ArtifactReference };
    'recovery.resumed': { sourceRunId: string; fingerprint: string; evidence: ArtifactReference };
    'context.admission': { assessment: JsonValue };
    'context.surface': { ownerId: string; revision: number; epoch: number; reason: string; state: ArtifactReference; entries: ArtifactReference[] };
    'context.request': { requestId: string; attemptId: string; ownerId: string; revision: number; manifest: ArtifactReference };
    'plan.version': { planId: string; version: number; status: 'submitted' | 'approved'; content: ArtifactReference };
    'permission.changed': { policyVersion: number; mode: string };
    'control.requested': { action: 'stop' | 'steer' | 'retry' | 'resume' | 'fork'; expectedStepId: string | null; content: ArtifactReference | null };
    'control.applied': { action: 'steer'; controlIds: string[] };
    'delegation.delivery': { deliveryId: string; childRunId: string; resultEventId: string; stage: 'delivered' | 'prepared' | 'sent' | 'consumed'; attemptId: string | null };
    'context.compaction': { compactionId: string; stage: 'candidate' | 'committed' | 'rolled_back'; previousVersion: string; nextVersion: string; taskState: ArtifactReference; artifacts?: ArtifactReference[] };
    'recording.checkpoint': { durableSeq: number; exportedSeq: number };
}

export interface TranscriptManifest {
    schemaVersion: 1;
    sessionId: string;
    durableSeq: number;
    exportedSeq: number;
    segments: Array<{ relativePath: string; firstSeq: number; lastSeq: number; sha256: string }>;
    artifacts: ArtifactReference[];
    retainedRanges: Array<{ firstSeq: number; lastSeq: number }>;
    redactionPolicyVersion: string;
    captureCoverage: 'complete' | 'partial' | 'legacy_partial';
    continuationCoverage: 'native' | 'public_only' | 'unavailable';
    recovery: 'stopped' | 'needs_reconciliation' | 'eligible_for_review';
}

/** sessionSeq is allocated by the session writer, independently of legacy run.sequence. */
export type TranscriptEvent = {
    [K in keyof TranscriptPayloads]: {
        schemaVersion: 1;
        eventId: string;
        sessionSeq: number;
        timestamp: string;
        processEpochId: string;
        run: RunIdentity;
        type: K;
        payload: TranscriptPayloads[K];
    }
}[keyof TranscriptPayloads];

/** Provider call IDs are scoped to an attempt; JSON tuples avoid delimiter collisions. */
export function toolCallKey(attemptId: string, toolCallId: string): string {
    return JSON.stringify([attemptId, toolCallId]);
}

/** Conservative bridge for old provider adapters; metadata stays in the host journal. */
export function projectLegacyToolResult(id: string, outcome: ToolOutcome): import('./tool-protocol').ToolResult {
    return {
        id,
        content: outcome.preview,
        isError: outcome.status !== 'succeeded' || outcome.recordingState !== 'durable',
    };
}
