export type ModelReasoningEffort =
    | 'default'
    | 'none'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'
    | 'ultra';

export interface ModelParameters {
    temperature: number | null;
    topP: number | null;
    maxOutputTokens: number | null;
    reasoningEffort: ModelReasoningEffort;
    thinkingBudget: number | null;
    historyTurns: number;
    timeoutSeconds: number;
    stop: string[];
}

const REASONING_EFFORTS: readonly ModelReasoningEffort[] = [
    'default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra',
];

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
    if (value === null
        || typeof value !== 'object'
        || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).some((key) => typeof key !== 'string' || !keys.includes(key))
        || keys.some((key) => {
            if (!Object.hasOwn(value, key)) return true;
            const descriptor = Object.getOwnPropertyDescriptor(value, key);
            return !descriptor || !('value' in descriptor);
        })) {
        throw new TypeError('模型参数字段无效。');
    }
}

function number(value: unknown, min: number, max: number, field: string, integer = false): number {
    if (typeof value !== 'number'
        || !Number.isFinite(value)
        || value < min
        || value > max
        || (integer && !Number.isSafeInteger(value))) {
        throw new TypeError(`模型参数 ${field} 必须在 ${min} 到 ${max} 之间。`);
    }
    return value;
}

function nullableNumber(value: unknown, min: number, max: number, field: string, integer = false): number | null {
    return value === null ? null : number(value, min, max, field, integer);
}

function stopStrings(value: unknown): string[] {
    if (!Array.isArray(value)
        || Object.getPrototypeOf(value) !== Array.prototype
        || value.length > 4) {
        throw new TypeError('模型停止序列最多包含 4 项。');
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1
        || keys.some((key) => key !== 'length'
            && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new TypeError('模型停止序列格式无效。');
    }
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)
            || typeof descriptor.value !== 'string' || descriptor.value.length > 200) {
            throw new TypeError('模型停止序列中的文本无效。');
        }
        result.push(descriptor.value);
    }
    return result;
}

export function defaultModelParameters(): ModelParameters {
    return {
        temperature: null,
        topP: null,
        maxOutputTokens: null,
        reasoningEffort: 'default',
        thinkingBudget: null,
        historyTurns: 50,
        timeoutSeconds: 60,
        stop: [],
    };
}

export function parseModelParameters(value: unknown): ModelParameters {
    record(value, [
        'temperature', 'topP', 'maxOutputTokens', 'reasoningEffort',
        'thinkingBudget', 'historyTurns', 'timeoutSeconds', 'stop',
    ]);
    if (typeof value.reasoningEffort !== 'string'
        || !REASONING_EFFORTS.includes(value.reasoningEffort as ModelReasoningEffort)) {
        throw new TypeError('模型推理强度无效。');
    }
    return {
        temperature: nullableNumber(value.temperature, 0, 2, 'temperature'),
        topP: nullableNumber(value.topP, 0, 1, 'topP'),
        maxOutputTokens: nullableNumber(value.maxOutputTokens, 1, 1_000_000, 'maxOutputTokens', true),
        reasoningEffort: value.reasoningEffort as ModelReasoningEffort,
        thinkingBudget: nullableNumber(value.thinkingBudget, 1024, 999_999, 'thinkingBudget', true),
        historyTurns: number(value.historyTurns, 0, 100, 'historyTurns', true),
        timeoutSeconds: number(value.timeoutSeconds, 5, 600, 'timeoutSeconds', true),
        stop: stopStrings(value.stop),
    };
}
