export type NativeGoalCommand = { type: 'set'; objective: string; tokenBudget?: number }
    | { type: 'get' | 'pause' | 'resume' | 'clear' };
export type NativeInputCommand = { kind: 'plan'; mode: 'default' | 'plan'; task: string }
    | { kind: 'goal'; command: NativeGoalCommand; task: string };

const PLAN_EXECUTION_TASK = '执行已确认的计划。';
const PLAN_REVISION_EMPTY_TASK = '请先询问需要如何修改计划，再修订计划，不开始实施。';
const PLAN_EXECUTION_PHRASES = new Set([
    '执行计划',
    '开始执行计划',
    '按计划执行',
    '实施计划',
    'execute plan',
    'implement the plan',
]);

function isPlanExecutionPhrase(input: string): boolean {
    const phrase = input.trim().replace(/[。.!！]$/, '');
    if (PLAN_EXECUTION_PHRASES.has(phrase)) return true;
    return PLAN_EXECUTION_PHRASES.has(phrase.toLowerCase());
}

export function parseNativeInput(input: string, currentMode: 'default' | 'plan' = 'default'): NativeInputCommand | undefined {
    if (currentMode === 'plan' && isPlanExecutionPhrase(input)) {
        return { kind: 'plan', mode: 'default', task: PLAN_EXECUTION_TASK };
    }

    const match = /^\/(plan|goal)(?:\s+([\s\S]*))?$/.exec(input.trim());
    if (!match) return undefined;
    const argument = (match[2] || '').trim();
    if (match[1] === 'plan') {
        if (!argument) return { kind: 'plan', mode: currentMode === 'plan' ? 'default' : 'plan', task: '' };
        if (argument === 'off') return { kind: 'plan', mode: 'default', task: '' };
        if (argument === 'on') return { kind: 'plan', mode: 'plan', task: '' };
        if (argument === 'execute') return { kind: 'plan', mode: 'default', task: PLAN_EXECUTION_TASK };
        const reviseMatch = /^revise(?:\s+([\s\S]*))?$/.exec(argument);
        if (reviseMatch) {
            const feedback = (reviseMatch[1] || '').trim();
            return {
                kind: 'plan',
                mode: 'plan',
                task: feedback
                    ? `请根据以下反馈修订计划，不开始实施：\n${feedback}`
                    : PLAN_REVISION_EMPTY_TASK,
            };
        }
        return { kind: 'plan', mode: 'plan', task: argument };
    }
    if (!argument) return { kind: 'goal', command: { type: 'get' }, task: '' };
    if (['pause', 'resume', 'clear'].includes(argument)) return {
        kind: 'goal', command: { type: argument as 'pause' | 'resume' | 'clear' },
        task: argument === 'resume' ? '继续完成当前原生目标。' : '',
    };
    const budgetMatch = /^--budget\s+(\d+)\s+([\s\S]+)$/.exec(argument);
    const objective = (budgetMatch?.[2] ?? argument).trim();
    const tokenBudget = budgetMatch ? Number(budgetMatch[1]) : undefined;
    if (argument.startsWith('--budget') && !budgetMatch || tokenBudget !== undefined && (!Number.isSafeInteger(tokenBudget) || tokenBudget <= 0)) {
        throw new Error('目标预算格式：/goal --budget 正整数 目标内容。');
    }
    if (!objective || objective.length > 4000) throw new Error('原生目标内容需为 1–4000 个字符。');
    return { kind: 'goal', command: { type: 'set', objective, ...(tokenBudget === undefined ? {} : { tokenBudget }) }, task: objective };
}

// Preserve the stored API-era identifiers without exposing API permission names
// in the native UI. Legacy Plan is migrated to collaboration mode separately.
export function nativePermissionPreset(mode: string): 'readonly' | 'manual' | 'bypass' {
    return mode === 'readonly' ? 'readonly' : mode === 'bypass' ? 'bypass' : 'manual';
}
