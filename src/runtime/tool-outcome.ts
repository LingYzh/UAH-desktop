import { randomUUID, createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { ToolOutcome } from '../shared/harness-contracts.js';

// Shared for this process lifetime, never reconstructed from a wall-clock timestamp.
const processEpochId = randomUUID();
export function textHash(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}
export function beginToolOutcome() {
    const started = performance.now();
    const outcome: ToolOutcome = {
        schemaVersion: 1, status: 'succeeded', effectState: 'not_started', recordingState: 'pending',
        retryClass: 'safe', idempotencyKey: null, errorCode: null, exitCode: null,
        preview: '', artifactRefs: [], truncation: { truncated: false, reason: null }, resources: [],
        time: { processEpochId, startedAt: new Date().toISOString(), finishedAt: null, durationMs: null },
    };
    return {
        outcome,
        finish(result: { content: string; isError?: boolean }) {
            outcome.preview = result.content;
            outcome.time.finishedAt = new Date().toISOString();
            outcome.time.durationMs = Math.max(0, performance.now() - started);
            return { ...result, outcome };
        },
    };
}
