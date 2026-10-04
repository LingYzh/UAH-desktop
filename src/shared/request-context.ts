import type { ApiProtocol } from './endpoints';
import type { ApiUsage } from './tool-protocol';

export interface ContextSectionSummary {
    id: string;
    label: string;
    characters: number;
    estimatedTokens: number;
    truncated: boolean;
}

/** Last attempted model request, not a prediction of the next turn. */
export interface RequestContextSummary {
    requestId: string;
    runId: string;
    round: number;
    capturedAt: string;
    modelId: string;
    protocol: ApiProtocol;
    capacity?: number;
    estimatedInputTokens: number;
    pressure?: { inputEstimatedTokens: number; requiredTokens: number; outputReserve: number; toolReserve: number; errorReserve: number; bodyBytes: number; bodyByteLimit: number | null; estimateConfidence: string; reason: string };
    usage?: ApiUsage;
    omittedPrivateState: boolean;
    /** Host diagnostics only, never inserted into the model input. */
    contextDiagnostics?: string;
    sections: ContextSectionSummary[];
}

export interface RequestContextDetail extends RequestContextSummary {
    sections: Array<ContextSectionSummary & { content: string }>;
    sessionUsage?: import('../runtime/context/session-usage').SessionUsageSummary;
}

export type ContextQuery = { runId: string } | { sessionId: string };
export function parseContextQuery(value: unknown): ContextQuery {
    const key = value && typeof value === 'object' && Object.hasOwn(value, 'sessionId') ? 'sessionId' : 'runId';
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, key)
        || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw new TypeError('无效的上下文查询。');
    const id = (value as Record<string, unknown>)[key];
    if (typeof id !== 'string' || !id.trim() || id.length > 200 || /[\u0000-\u001f]/.test(id)) throw new TypeError('无效的上下文查询。');
    return key === 'sessionId' ? { sessionId: id } : { runId: id };
}
