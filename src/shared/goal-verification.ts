import type { ArtifactReference, ToolOutcome } from './harness-contracts';
import type { RecoveryResource } from './recovery';

/** A human acceptance decision, separately recorded from engine completion. */
export interface GoalVerification {
    id: string;
    method: 'user_review';
    reviewedAt: string;
    criteria: string;
    scopeFingerprint: string;
    resourceFingerprint: string;
    evidence: ArtifactReference;
}
export interface GoalVerificationReview {
    sessionId: string;
    runId: string;
    fingerprint: string;
    scopeFingerprint: string;
    resourceFingerprint: string;
    canVerify: boolean;
    reasons: string[];
    resources: RecoveryResource[];
    commands: Array<{ runId: string; invocationId: string; command: string; outcome: ToolOutcome; hasLaterEffects: boolean }>;
    previous: GoalVerification | null;
    status: 'unverified' | 'current' | 'stale';
}
