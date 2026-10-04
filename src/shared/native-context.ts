export interface NativeContextTokenCounts {
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteInputTokens?: number;
    reasoningOutputTokens?: number;
    totalTokens?: number;
}

export interface NativeContextUsage extends NativeContextTokenCounts {
    capturedAt: string;
    threadId: string;
    turnId: string;
    capacity?: number;
    cumulative?: NativeContextTokenCounts;
}

const TOKEN_FIELDS = [
    'inputTokens',
    'outputTokens',
    'cachedInputTokens',
    'cacheWriteInputTokens',
    'reasoningOutputTokens',
    'totalTokens',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTokenCount(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function readTokenCounts(value: unknown): NativeContextTokenCounts | null {
    if (!isRecord(value)) return null;

    const counts: NativeContextTokenCounts = {};
    for (const field of TOKEN_FIELDS) {
        if (!(field in value)) continue;
        const count = value[field];
        if (!isTokenCount(count)) return null;
        counts[field] = count;
    }
    return counts;
}

/**
 * Parses a thread/tokenUsage/updated notification for a specific active turn.
 * `last` represents the latest request; `total` is kept separately as cumulative usage.
 * The caller supplies capture time so this parser stays deterministic.
 */
export function parseNativeContextUsageUpdated(
    value: unknown,
    expectedThreadId: string,
    expectedTurnId: string,
    capturedAt: string,
): NativeContextUsage | null {
    if (
        !isRecord(value)
        || typeof expectedThreadId !== 'string'
        || expectedThreadId.length === 0
        || typeof expectedTurnId !== 'string'
        || expectedTurnId.length === 0
        || typeof capturedAt !== 'string'
        || capturedAt.trim().length === 0
        || value.threadId !== expectedThreadId
        || value.turnId !== expectedTurnId
        || !isRecord(value.tokenUsage)
    ) return null;

    const last = readTokenCounts(value.tokenUsage.last);
    const total = readTokenCounts(value.tokenUsage.total);
    if (!last || !total) return null;

    const result: NativeContextUsage = {
        capturedAt,
        threadId: expectedThreadId,
        turnId: expectedTurnId,
    };

    Object.assign(result, last);
    if (Object.keys(total).length > 0) result.cumulative = total;

    const rawCapacity = value.tokenUsage.modelContextWindow;
    if (rawCapacity !== undefined && rawCapacity !== null) {
        if (!isTokenCount(rawCapacity) || rawCapacity === 0) return null;
        result.capacity = rawCapacity;
    }

    return result;
}
