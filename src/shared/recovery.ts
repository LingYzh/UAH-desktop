export interface RecoveryResource {
    uri: string;
    hashKind: 'raw_bytes' | 'utf8_text';
    expectedHash: string | null;
    actualHash: string | null;
    status: 'matched' | 'changed' | 'missing' | 'unverifiable';
    detail: string;
}
export interface RecoveryReview {
    sessionId: string;
    runId: string;
    fingerprint: string;
    endpointFingerprint: string | null;
    reasons: string[];
    canResume: boolean;
    canReconcile: boolean;
    resources: RecoveryResource[];
    uncertainRuns: string[];
    grant: { maxRequests: number; maxTools: number; maxElapsedMs: number; maxEstimatedTokens: number; maxConcurrentRequests: number };
    budgetState: unknown;
}
