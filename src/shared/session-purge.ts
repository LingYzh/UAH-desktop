export interface SessionPurgeReview {
    sessionId: string;
    fingerprint: string;
    runCount: number;
    fileCount: number;
    bytes: number;
    backupCount: number;
    incompleteBackupFiles: number;
    branchCount: number;
    canDelete: boolean;
    reasons: string[];
}
export interface SessionPurgeResult { sessionId: string; completed: boolean; error?: string }
