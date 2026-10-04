import assert from 'node:assert/strict';
import test from 'node:test';
import { nativePermissionPreset, parseNativeInput } from '../../src/shared/native-codex-commands';
import { parseCommand } from '../../src/shared/contracts';

test('native slash commands distinguish mode changes, tasks and ordinary text', () => {
    assert.deepEqual(parseNativeInput('/plan'), { kind: 'plan', mode: 'plan', task: '' });
    assert.deepEqual(parseNativeInput('/plan', 'plan'), { kind: 'plan', mode: 'default', task: '' });
    assert.deepEqual(parseNativeInput('/plan off'), { kind: 'plan', mode: 'default', task: '' });
    assert.deepEqual(parseNativeInput('/plan 修复测试'), { kind: 'plan', mode: 'plan', task: '修复测试' });
    assert.equal(parseNativeInput('说明 /plan 的用法'), undefined);
    assert.equal(parseNativeInput('/planet'), undefined);
});

test('native plan execution phrases exit Plan mode only on full exact matches', () => {
    for (const phrase of ['执行计划', '开始执行计划', '按计划执行', '实施计划', 'execute plan', 'implement the plan']) {
        assert.deepEqual(parseNativeInput(`  ${phrase}  `, 'plan'), {
            kind: 'plan', mode: 'default', task: '执行已确认的计划。',
        });
    }
    assert.deepEqual(parseNativeInput('执行计划。', 'plan'), { kind: 'plan', mode: 'default', task: '执行已确认的计划。' });
    assert.deepEqual(parseNativeInput('开始执行计划.', 'plan'), { kind: 'plan', mode: 'default', task: '执行已确认的计划。' });
    assert.deepEqual(parseNativeInput('按计划执行！', 'plan'), { kind: 'plan', mode: 'default', task: '执行已确认的计划。' });
    assert.deepEqual(parseNativeInput('IMPLEMENT THE PLAN!', 'plan'), { kind: 'plan', mode: 'default', task: '执行已确认的计划。' });
    assert.deepEqual(parseNativeInput('/plan execute'), { kind: 'plan', mode: 'default', task: '执行已确认的计划。' });
    assert.deepEqual(parseNativeInput('/plan execute', 'plan'), { kind: 'plan', mode: 'default', task: '执行已确认的计划。' });
});

test('native plan revise keeps Plan mode and treats blank feedback as a request to ask', () => {
    assert.deepEqual(parseNativeInput('/plan revise 补充失败恢复步骤'), {
        kind: 'plan', mode: 'plan', task: '请根据以下反馈修订计划，不开始实施：\n补充失败恢复步骤',
    });
    assert.deepEqual(parseNativeInput('/plan revise   ', 'plan'), {
        kind: 'plan', mode: 'plan', task: '请先询问需要如何修改计划，再修订计划，不开始实施。',
    });
});

test('native plan execution does not trigger from negation, quotation, questions or substrings', () => {
    for (const input of ['不要执行计划', '“执行计划”', '执行计划？', '执行计划之后再说', 'please execute plan']) {
        assert.equal(parseNativeInput(input, 'plan'), undefined, input);
    }
    assert.equal(parseNativeInput('execute plan'), undefined);
    assert.equal(parseNativeInput('普通用户请求'), undefined);
    assert.deepEqual(parseNativeInput('/plan 普通计划任务', 'plan'), { kind: 'plan', mode: 'plan', task: '普通计划任务' });
});

test('native goals preserve explicit budgets and do not infer one', () => {
    assert.deepEqual(parseNativeInput('/goal 完成测试'), { kind: 'goal', command: { type: 'set', objective: '完成测试' }, task: '完成测试' });
    const budgeted = parseNativeInput('/goal --budget 1000 完成测试');
    assert.equal(budgeted?.kind, 'goal');
    assert.deepEqual(budgeted?.kind === 'goal' ? budgeted.command : undefined, { type: 'set', objective: '完成测试', tokenBudget: 1000 });
    assert.deepEqual(parseNativeInput('/goal'), { kind: 'goal', command: { type: 'get' }, task: '' });
    for (const action of ['pause', 'resume', 'clear']) assert.equal((parseNativeInput(`/goal ${action}`) as any).command.type, action);
    assert.throws(() => parseNativeInput('/goal --budget 0 task'));
    assert.throws(() => parseNativeInput('/goal ' + 'a'.repeat(4001)));
    assert.equal(nativePermissionPreset('auto'), 'manual');
    assert.equal(nativePermissionPreset('bypass'), 'bypass');
});

test('native answer command validates bounded strings and exact transport fields', () => {
    const command = { type: 'answer-native-question', runId: 'run', questionId: 'item', answers: { scope: { answers: ['first'] } } };
    assert.equal(parseCommand(command).type, 'answer-native-question');
    assert.throws(() => parseCommand({ ...command, answers: { scope: { answers: [42] } } }));
    assert.throws(() => parseCommand({ ...command, answers: { scope: { answers: ['a'.repeat(8001)] } } }));
});
