import type { ContextAssessment } from '../context-governor';
import { contextHash, semanticWireItem } from './projection';

/** Local serialization/memory guard, not a provider or model token-window claim. */
export const CONTEXT_LIMITS = Object.freeze({ version: 2, requestBytes: 8_000_000 });
export interface UsageAnchor {
    headerHash: string; historyHash: string; historyLength: number;
    inputTokens: number; estimatedTokens: number;
}
const validReportedInput = (value: number) => Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER / 4;
function envelope(serialized: string) {
    const body = JSON.parse(serialized) as Record<string, unknown>;
    const history = ((body.input ?? body.messages ?? []) as unknown[]).map(semanticWireItem);
    const { input: _input, messages: _messages, prompt_cache_options: _cache, ...header } = body;
    // Chat system instructions are part of messages and must independently match.
    return { history, headerHash: contextHash({ ...header, systemMessages: history.filter(item => (item as { role?: string })?.role === 'system') }) };
}
export function createUsageAnchor(serialized: string, inputTokens: number): UsageAnchor | undefined {
    if (!validReportedInput(inputTokens)) return undefined;
    const estimatedTokens = assessCompiledRequest(serialized).inputEstimatedTokens;
    // Opaque replay blobs and JSON schemas can greatly exceed their provider token price.
    // A density heuristic is not evidence that a valid reported count is incorrect.
    const { history, headerHash } = envelope(serialized);
    return { headerHash, historyHash: contextHash(history), historyLength: history.length, inputTokens, estimatedTokens };
}

/** Whole compiled body estimate, not billing or a claim to run a provider tokenizer. */
export function assessCompiledRequest(serialized: string, capacity?: number, maxOutputTokens?: number | null, anchor?: UsageAnchor): ContextAssessment & {
    estimator: 'compiled-json-heuristic-v1' | 'provider-anchor-delta-v1'; estimateConfidence: 'low' | 'calibrated';
} {
    let ascii = 0; let other = 0;
    for (const character of serialized) character.codePointAt(0)! < 128 ? ascii++ : other++;
    const bodyBytes = Buffer.byteLength(serialized);
    let inputEstimatedTokens = Math.ceil((ascii / 3 + other) * 1.15) + 128;
    let calibrated = false;
    if (anchor && Number.isSafeInteger(anchor.historyLength) && anchor.historyLength >= 0
        && validReportedInput(anchor.inputTokens)
        && Number.isSafeInteger(anchor.estimatedTokens) && anchor.estimatedTokens > 0) {
        const current = envelope(serialized);
        if (current.headerHash === anchor.headerHash && current.history.length >= anchor.historyLength
            && contextHash(current.history.slice(0, anchor.historyLength)) === anchor.historyHash) {
            inputEstimatedTokens = Math.ceil((anchor.inputTokens + Math.max(0, inputEstimatedTokens - anchor.estimatedTokens)) * 1.05);
            calibrated = true;
        }
    }
    const window = Number.isSafeInteger(capacity) && capacity! > 0 ? capacity! : null;
    const outputReserve = maxOutputTokens ?? (window === null ? 0 : Math.min(8192, Math.floor(window * 0.2)));
    const toolReserve = window === null ? 0 : Math.min(8192, Math.floor(window * 0.1));
    const errorReserve = window === null ? 0 : Math.ceil(window * 0.05);
    const requiredTokens = inputEstimatedTokens + outputReserve + toolReserve + errorReserve;
    const admitted = bodyBytes <= CONTEXT_LIMITS.requestBytes && (window === null || requiredTokens <= window);
    return { admitted, reason: bodyBytes > CONTEXT_LIMITS.requestBytes ? 'body_bytes_exceeded'
        : window === null ? 'capacity_unknown_body_within_limit' : admitted ? 'within_capacity' : 'context_capacity_exceeded',
        capacityKnown: window !== null, capacity: window, bodyBytes, wrapperTokens: 128, inputEstimatedTokens,
        outputReserve, toolReserve, errorReserve, requiredTokens, bodyByteLimit: CONTEXT_LIMITS.requestBytes,
        estimator: calibrated ? 'provider-anchor-delta-v1' : 'compiled-json-heuristic-v1', estimateConfidence: calibrated ? 'calibrated' : 'low' };
}
