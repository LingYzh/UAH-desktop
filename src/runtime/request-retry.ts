const RETRYABLE_REASONS = new Set([
    'http.408', 'http.429', 'http.500', 'http.502', 'http.503', 'http.504',
    'network.ECONNRESET', 'network.ETIMEDOUT', 'network.UND_ERR_CONNECT_TIMEOUT',
]);
const DELAYS = [250, 1000] as const;

/** Structured reason only. The caller owns a run-wide retriesUsed counter. */
export function retryDelayMs(reason: string, retriesUsed: number): number | null {
    if (!Number.isSafeInteger(retriesUsed) || retriesUsed < 0) throw new Error('retriesUsed must be a nonnegative safe integer.');
    return RETRYABLE_REASONS.has(reason) && retriesUsed < DELAYS.length ? DELAYS[retriesUsed] : null;
}

/** Timer only: no requests, identity changes, budget updates or transport decisions. */
export async function abortableRetryDelay(ms: number, signal: AbortSignal): Promise<void> {
    if (!Number.isSafeInteger(ms) || ms < 0 || ms > 10000) throw new Error('Retry delay must be an integer from 0 through 10000 ms.');
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
        const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
        const abort = () => { cleanup(); reject(signal.reason); };
        const timer = setTimeout(() => { cleanup(); resolve(); }, ms);
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
}
