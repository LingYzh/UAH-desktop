import type { ApiConnection } from '../../shared/endpoints.js';
import type { ApiUsage } from '../../shared/tool-protocol.js';

export type UsageProtocol = ApiConnection['protocol'];
export type UsageCoverage = 'complete' | 'partial' | 'unknown';

export type UsageDiagnosticCode =
    | 'usage.not_object'
    | 'usage.counter_invalid'
    | 'usage.counter_overflow'
    | 'usage.detail_invalid'
    | 'usage.cache_breakdown_mismatch'
    | 'usage.deepseek_cache_conflict'
    | 'usage.deepseek_cache_total_mismatch'
    | 'usage.openai_cache_write_unrecognized';

export interface UsageDiagnostic {
    code: UsageDiagnosticCode;
    paths: string[];
}

/**
 * Provider-independent usage fields. `usage` intentionally remains the
 * existing ApiUsage projection so callers that only understand the v1
 * contract continue to receive the same counters.
 */
export interface NormalizedProviderUsage {
    usage: ApiUsage;
    inputTokensTotal?: number;
    inputCacheReadTokens?: number;
    inputCacheWriteTokens?: number;
    inputUncachedTokens?: number;
    outputTokens?: number;
    reasoningTokens?: number;
    reportedTotalTokens?: number;
    coverage: UsageCoverage;
    sourcePaths: string[];
    diagnostics: UsageDiagnostic[];
}

export type UsageNormalization = NormalizedProviderUsage;

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validCounter(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function safeSum(values: number[]): number | undefined {
    let total = 0;
    for (const value of values) {
        if (!validCounter(value) || total > Number.MAX_SAFE_INTEGER - value) return undefined;
        total += value;
    }
    return total;
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function detailAt(raw: Record<string, unknown>, key: string, path: string,
    diagnostics: UsageDiagnostic[], present: { value: boolean }): Record<string, unknown> | undefined {
    if (!hasOwn(raw, key)) return undefined;
    present.value = true;
    const detail = raw[key];
    if (!isRecord(detail)) {
        diagnostics.push({ code: 'usage.detail_invalid', paths: [path] });
        return undefined;
    }
    return detail;
}

function readCounter(raw: Record<string, unknown>, key: string, path: string,
    diagnostics: UsageDiagnostic[], present: { value: boolean }): number | undefined {
    if (!hasOwn(raw, key)) return undefined;
    present.value = true;
    const value = raw[key];
    if (validCounter(value)) return value;
    diagnostics.push({ code: 'usage.counter_invalid', paths: [path] });
    return undefined;
}

function readDetailCounter(detail: Record<string, unknown> | undefined, key: string, path: string,
    diagnostics: UsageDiagnostic[], present: { value: boolean }): number | undefined {
    if (!detail || !hasOwn(detail, key)) return undefined;
    present.value = true;
    const value = detail[key];
    if (validCounter(value)) return value;
    diagnostics.push({ code: 'usage.counter_invalid', paths: [path] });
    return undefined;
}

function addSource(sourcePaths: string[], path: string): void {
    if (!sourcePaths.includes(path)) sourcePaths.push(path);
}

function addDiagnostic(diagnostics: UsageDiagnostic[], code: UsageDiagnosticCode, paths: string[]): void {
    if (diagnostics.some(item => item.code === code && item.paths.length === paths.length
        && item.paths.every((path, index) => path === paths[index]))) return;
    diagnostics.push({ code, paths: [...paths] });
}

function coverageFor(
    protocol: UsageProtocol,
    usage: ApiUsage,
    diagnostics: UsageDiagnostic[],
    present: boolean,
): UsageCoverage {
    const hasAny = Object.keys(usage).length > 0;
    if (!hasAny && !present) return diagnostics.length > 0 ? 'partial' : 'unknown';
    if (!hasAny) return 'partial';
    const input = validCounter(usage.inputTokens);
    const output = validCounter(usage.outputTokens);
    const cached = validCounter(usage.cachedInputTokens);
    const cacheWrite = protocol === 'anthropic' || protocol.startsWith('openai-')
        ? validCounter(usage.cacheCreationInputTokens) : false;
    const total = protocol.startsWith('openai-') && validCounter(usage.totalTokens);
    const complete = protocol === 'anthropic'
        ? input && output && cached && cacheWrite
        : input && output && total && cached && cacheWrite;
    return complete && diagnostics.length === 0 ? 'complete' : 'partial';
}

/**
 * Merge cumulative provider usage updates without accepting invalid counters.
 * Streaming providers may send input details in one frame and output details
 * in a later frame; one-level detail merging preserves both facts.
 */
export function mergeUsageSnapshot(
    previous: Record<string, unknown>,
    update: Record<string, unknown>,
): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...previous };
    for (const [key, value] of Object.entries(update)) {
        if (isRecord(value)) {
            const before = isRecord(merged[key]) ? merged[key] : {};
            const details: Record<string, unknown> = { ...before };
            for (const [detailKey, detailValue] of Object.entries(value)) {
                if (validCounter(detailValue)) details[detailKey] = detailValue;
            }
            if (Object.keys(details).length > 0) merged[key] = details;
        } else if (validCounter(value)) {
            merged[key] = value;
        }
    }
    return merged;
}

/**
 * Normalize one provider usage snapshot. `previous` is a normalized snapshot,
 * used when a streaming update omits counters already observed in an earlier
 * frame. Missing counters remain missing; no zeroes or cumulative totals are
 * invented.
 */
export function normalizeProviderUsage(
    protocol: UsageProtocol,
    rawValue: unknown,
    previous: ApiUsage = {},
): NormalizedProviderUsage {
    const usage: ApiUsage = { ...previous };
    const sourcePaths: string[] = [];
    const diagnostics: UsageDiagnostic[] = [];
    const present = { value: false };
    const raw = isRecord(rawValue) ? rawValue : undefined;
    if (!raw) {
        if (rawValue !== undefined) diagnostics.push({ code: 'usage.not_object', paths: ['usage'] });
        return {
            usage,
            inputTokensTotal: usage.inputTokens,
            inputCacheReadTokens: usage.cachedInputTokens,
            inputCacheWriteTokens: usage.cacheCreationInputTokens,
            outputTokens: usage.outputTokens,
            reportedTotalTokens: usage.totalTokens,
            coverage: coverageFor(protocol, usage, diagnostics, false),
            sourcePaths,
            diagnostics,
        };
    }

    let inputTokensTotal: number | undefined;
    let inputCacheReadTokens: number | undefined;
    let inputCacheWriteTokens: number | undefined;
    let inputUncachedTokens: number | undefined;
    let outputTokens: number | undefined;
    let reasoningTokens: number | undefined;
    let reportedTotalTokens: number | undefined;

    if (protocol === 'anthropic') {
        const input = readCounter(raw, 'input_tokens', 'input_tokens', diagnostics, present);
        const cacheRead = readCounter(raw, 'cache_read_input_tokens', 'cache_read_input_tokens', diagnostics, present);
        const cacheWrite = readCounter(raw, 'cache_creation_input_tokens', 'cache_creation_input_tokens', diagnostics, present);
        const output = readCounter(raw, 'output_tokens', 'output_tokens', diagnostics, present);
        if (input !== undefined) {
            inputUncachedTokens = input;
            addSource(sourcePaths, 'input_tokens');
        }
        if (cacheRead !== undefined) {
            inputCacheReadTokens = cacheRead;
            usage.cachedInputTokens = cacheRead;
            addSource(sourcePaths, 'cache_read_input_tokens');
        }
        if (cacheWrite !== undefined) {
            inputCacheWriteTokens = cacheWrite;
            usage.cacheCreationInputTokens = cacheWrite;
            addSource(sourcePaths, 'cache_creation_input_tokens');
        }
        if (input !== undefined || usage.inputTokens !== undefined) {
            const base = input ?? (validCounter(usage.inputTokens) ? usage.inputTokens : undefined);
            const read = cacheRead ?? (validCounter(usage.cachedInputTokens) ? usage.cachedInputTokens : 0);
            const write = cacheWrite ?? (validCounter(usage.cacheCreationInputTokens) ? usage.cacheCreationInputTokens : 0);
            if (base !== undefined) {
                const total = safeSum([base, read, write]);
                if (total === undefined) {
                    delete usage.inputTokens;
                    addDiagnostic(diagnostics, 'usage.counter_overflow', [
                        'input_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens',
                    ]);
                } else {
                    usage.inputTokens = total;
                    inputTokensTotal = total;
                }
            }
        }
        if (output !== undefined) {
            outputTokens = output;
            usage.outputTokens = output;
            addSource(sourcePaths, 'output_tokens');
        }
        if (inputTokensTotal === undefined && validCounter(usage.inputTokens)) inputTokensTotal = usage.inputTokens;
        if (inputCacheReadTokens === undefined && validCounter(usage.cachedInputTokens)) {
            inputCacheReadTokens = usage.cachedInputTokens;
        }
        if (inputCacheWriteTokens === undefined && validCounter(usage.cacheCreationInputTokens)) {
            inputCacheWriteTokens = usage.cacheCreationInputTokens;
        }
        if (outputTokens === undefined && validCounter(usage.outputTokens)) outputTokens = usage.outputTokens;
    } else {
        const inputKey = protocol === 'openai-chat' ? 'prompt_tokens' : 'input_tokens';
        const outputKey = protocol === 'openai-chat' ? 'completion_tokens' : 'output_tokens';
        const inputPath = inputKey;
        const outputPath = outputKey;
        const input = readCounter(raw, inputKey, inputPath, diagnostics, present);
        const output = readCounter(raw, outputKey, outputPath, diagnostics, present);
        const total = readCounter(raw, 'total_tokens', 'total_tokens', diagnostics, present);
        const detailKey = protocol === 'openai-chat' ? 'prompt_tokens_details' : 'input_tokens_details';
        const detailPath = `${detailKey}`;
        const details = detailAt(raw, detailKey, detailPath, diagnostics, present);
        const cacheReadPath = `${detailKey}.cached_tokens`;
        const cacheWritePath = `${detailKey}.cache_write_tokens`;
        const cacheRead = readDetailCounter(details, 'cached_tokens', cacheReadPath, diagnostics, present);
        const cacheWrite = readDetailCounter(details, 'cache_write_tokens', cacheWritePath, diagnostics, present);
        const outputDetailsKey = protocol === 'openai-chat' ? 'completion_tokens_details' : 'output_tokens_details';
        const outputDetails = detailAt(raw, outputDetailsKey, outputDetailsKey, diagnostics, present);
        const reasoning = readDetailCounter(outputDetails, 'reasoning_tokens', `${outputDetailsKey}.reasoning_tokens`, diagnostics, present);

        if (input !== undefined) {
            inputTokensTotal = input;
            usage.inputTokens = input;
            addSource(sourcePaths, inputPath);
        } else if (validCounter(usage.inputTokens)) inputTokensTotal = usage.inputTokens;
        if (output !== undefined) {
            outputTokens = output;
            usage.outputTokens = output;
            addSource(sourcePaths, outputPath);
        } else if (validCounter(usage.outputTokens)) outputTokens = usage.outputTokens;
        if (total !== undefined) {
            reportedTotalTokens = total;
            usage.totalTokens = total;
            addSource(sourcePaths, 'total_tokens');
        } else if (validCounter(usage.totalTokens)) reportedTotalTokens = usage.totalTokens;
        if (reasoning !== undefined) {
            reasoningTokens = reasoning;
            addSource(sourcePaths, `${outputDetailsKey}.reasoning_tokens`);
        }
        if (cacheRead !== undefined) {
            inputCacheReadTokens = cacheRead;
            usage.cachedInputTokens = cacheRead;
            addSource(sourcePaths, cacheReadPath);
        } else if (validCounter(usage.cachedInputTokens)) inputCacheReadTokens = usage.cachedInputTokens;
        if (cacheWrite !== undefined) {
            inputCacheWriteTokens = cacheWrite;
            usage.cacheCreationInputTokens = cacheWrite;
            addSource(sourcePaths, cacheWritePath);
        } else if (validCounter(usage.cacheCreationInputTokens)) inputCacheWriteTokens = usage.cacheCreationInputTokens;

        // DeepSeek documents both the OpenAI-compatible cached_tokens field and
        // its prompt_cache_hit_tokens/miss_tokens fields. The standard field
        // wins when both are present; the proprietary fields are a fallback,
        // never an additional cache component.
        const hit = protocol === 'openai-chat'
            ? readCounter(raw, 'prompt_cache_hit_tokens', 'prompt_cache_hit_tokens', diagnostics, present)
            : undefined;
        const miss = protocol === 'openai-chat'
            ? readCounter(raw, 'prompt_cache_miss_tokens', 'prompt_cache_miss_tokens', diagnostics, present)
            : undefined;
        if (cacheRead !== undefined && hit !== undefined) {
            addSource(sourcePaths, 'prompt_cache_hit_tokens');
            if (cacheRead !== hit) addDiagnostic(diagnostics, 'usage.deepseek_cache_conflict', [cacheReadPath, 'prompt_cache_hit_tokens']);
        } else if (cacheRead === undefined && hit !== undefined) {
            inputCacheReadTokens = hit;
            usage.cachedInputTokens = hit;
            addSource(sourcePaths, 'prompt_cache_hit_tokens');
        }
        if (miss !== undefined) {
            inputUncachedTokens = miss;
            addSource(sourcePaths, 'prompt_cache_miss_tokens');
        } else if (inputTokensTotal !== undefined && inputCacheReadTokens !== undefined) {
            // DeepSeek has no separate cache-write component. For OpenAI, an
            // omitted official cache_write_tokens field leaves the ordinary
            // input portion unknown, so do not silently treat it as zero.
            const deepSeekShape = hit !== undefined || hasOwn(raw, 'prompt_cache_hit_tokens')
                || hasOwn(raw, 'prompt_cache_miss_tokens');
            const canDerive = !protocol.startsWith('openai-') || deepSeekShape || inputCacheWriteTokens !== undefined;
            if (canDerive) {
                const components = inputCacheWriteTokens === undefined
                    ? [inputCacheReadTokens] : [inputCacheReadTokens, inputCacheWriteTokens];
                const cachedTotal = safeSum(components);
                if (cachedTotal !== undefined && cachedTotal <= inputTokensTotal) {
                    inputUncachedTokens = inputTokensTotal - cachedTotal;
                    addSource(sourcePaths, inputCacheWriteTokens === undefined
                        ? `${inputPath} - ${cacheReadPath}` : `${inputPath} - ${cacheReadPath} - ${cacheWritePath}`);
                } else {
                    addDiagnostic(diagnostics, 'usage.cache_breakdown_mismatch', [inputPath, cacheReadPath,
                        ...(inputCacheWriteTokens === undefined ? [] : [cacheWritePath])]);
                }
            }
        } else if (inputTokensTotal !== undefined && inputCacheWriteTokens !== undefined
            && inputCacheWriteTokens > inputTokensTotal) {
            addDiagnostic(diagnostics, 'usage.cache_breakdown_mismatch', [inputPath, cacheWritePath]);
        }
        if (inputTokensTotal !== undefined && hit !== undefined && miss !== undefined) {
            const sum = safeSum([hit, miss]);
            if (sum === undefined || sum !== inputTokensTotal) {
                addDiagnostic(diagnostics, 'usage.deepseek_cache_total_mismatch', [inputPath, 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']);
            }
        } else if (inputTokensTotal !== undefined && inputCacheReadTokens !== undefined && miss !== undefined) {
            const sum = safeSum([inputCacheReadTokens, miss]);
            if (sum === undefined || sum !== inputTokensTotal) {
                addDiagnostic(diagnostics, 'usage.deepseek_cache_total_mismatch', [inputPath, cacheReadPath, 'prompt_cache_miss_tokens']);
            }
        }

        // `cache_write_tokens` is an official OpenAI input-details field. Only
        // these protocol-specific paths are accepted; similarly named legacy
        // or gateway fields are kept as diagnostics instead of being guessed.
        const suspiciousWriteKeys = ['cache_creation_input_tokens', 'cache_write_input_tokens', 'prompt_cache_write_tokens'];
        for (const key of suspiciousWriteKeys) {
            if (hasOwn(raw, key)) addDiagnostic(diagnostics, 'usage.openai_cache_write_unrecognized', [key]);
            if (details && hasOwn(details, key)) addDiagnostic(diagnostics, 'usage.openai_cache_write_unrecognized', [`${detailKey}.${key}`]);
        }
    }

    return {
        usage,
        ...(inputTokensTotal === undefined ? {} : { inputTokensTotal }),
        ...(inputCacheReadTokens === undefined ? {} : { inputCacheReadTokens }),
        ...(inputCacheWriteTokens === undefined ? {} : { inputCacheWriteTokens }),
        ...(inputUncachedTokens === undefined ? {} : { inputUncachedTokens }),
        ...(outputTokens === undefined ? {} : { outputTokens }),
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
        ...(reportedTotalTokens === undefined ? {} : { reportedTotalTokens }),
        coverage: coverageFor(protocol, usage, diagnostics, present.value),
        sourcePaths,
        diagnostics,
    };
}

/** Short alias for callers that do not need the provider-specific name. */
export const normalizeUsage = normalizeProviderUsage;
