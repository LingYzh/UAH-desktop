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
    usage?: ApiUsage;
    omittedPrivateState: boolean;
    sections: ContextSectionSummary[];
}

export interface RequestContextDetail extends RequestContextSummary {
    sections: Array<ContextSectionSummary & { content: string }>;
}

export function parseContextQuery(value: unknown): { runId: string } {
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).length !== 1 || !Object.hasOwn(value, 'runId')
        || !('value' in Object.getOwnPropertyDescriptor(value, 'runId')!) || !('runId' in value)
        || typeof value.runId !== 'string' || !value.runId.trim() || value.runId.length > 200
        || /[\u0000-\u001f]/.test(value.runId)) throw new TypeError('无效的上下文查询。');
    return { runId: value.runId };
}
