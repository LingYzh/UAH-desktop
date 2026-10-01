export interface JournalCleanupReview {
    sessionId: string;
    fingerprint: string;
    files: Array<{ relativePath: string; byteLength: number }>;
    bytes: number;
    minimumAgeHours: number;
}
export interface JournalCleanupResult {
    removedFiles: number;
    removedBytes: number;
    remainingFiles: number;
    error?: string;
}
