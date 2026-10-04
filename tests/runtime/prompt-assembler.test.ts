import assert from 'node:assert/strict';
import test from 'node:test';
import { assemblePrompt, MAX_ASSEMBLED_PROMPT_CHARACTERS } from '../../src/runtime/prompt-assembler';
import { conditionalDefaultInstructions, parsePromptProfile } from '../../src/shared/conditional-prompts';
import { defaultAgentSettings } from '../../src/shared/agents';
import type { RunRecord } from '../../src/shared/contracts';
import { promptContextSlot } from '../../src/shared/prompt-context';

const settings = defaultAgentSettings().subagents;
function run(instructions = conditionalDefaultInstructions('gpt'), child = false, mode = 'readonly'): RunRecord {
    return { id: '00000000-0000-4000-a000-000000000001', ...(child ? { parentRunId: '00000000-0000-4000-a000-000000000002' } : {}), depth: child ? 1 : 0,
        effective: { agentInstructions: instructions, permissionMode: mode, allowDelegation: true, modelId: 'fixture', endpointId: 'fixture' } } as RunRecord;
}
const selected = (value: ReturnType<typeof assemblePrompt>) => value.modules.filter(item => item.included).map(item => item.id);

test('all profile families use current role, including an inherited primary profile, without changing saved text', () => {
    for (const profile of ['gpt', 'claude', 'coding', 'generic'] as const) {
        const instructions = conditionalDefaultInstructions(profile);
        for (const child of [false, true]) {
            const source = run(instructions, child);
            const before = JSON.stringify(source);
            const result = assemblePrompt({ run: source, directory: null, tools: [], settings });
            assert.equal(result.profile, profile);
            assert.ok(selected(result).includes(child ? 'role.subagent' : 'role.primary'));
            assert.ok(!selected(result).includes(child ? 'role.primary' : 'role.subagent'));
            if (profile === 'gpt') {
                assert.match(result.instructions, child ? /# Subagent role/ : /# Main-agent role/);
                assert.doesNotMatch(result.instructions, child ? /# Main-agent role/ : /# Subagent role/);
            }
            assert.doesNotMatch(result.instructions, /\{\{[A-Z_]+\}\}/);
            assert.equal(JSON.stringify(source), before);
        }
    }
});

test('capability modules follow the exact supplied tools, not permission or delegation guesses', () => {
    const all = ['read_file', 'list_directory', 'search_files', 'write_file', 'run_command', 'enter_plan_mode', 'spawn_agent', 'list_agent_presets', 'wait_agents'];
    const first = assemblePrompt({ run: run(undefined, false, 'manual'), directory: 'D:/fixture', tools: all, settings });
    for (const id of ['workspace.read', 'workspace.edit', 'workspace.command', 'plan.enter', 'delegation.spawn', 'delegation.wait', 'delegation.presets']) assert.ok(selected(first).includes(id));
    assert.match(first.instructions, /providerId.*调用标识/);
    assert.match(first.instructions, /不探测凭据或在线状态/);
    assert.match(first.instructions, /准确 providerId 调用标识和模型 ID/);
    const disabled = assemblePrompt({ run: run(undefined, false, 'bypass'), directory: 'D:/fixture', tools: [], settings });
    for (const id of selected(first).filter(id => /^(workspace\.|delegation\.(spawn|wait|presets|limits)|plan.enter)/.test(id))) assert.ok(!selected(disabled).includes(id), id);
    assert.doesNotMatch(disabled.instructions, /spawn_agent|wait_agents|write_file|run_command|enter_plan_mode/);
    assert.ok(selected(disabled).includes('tools.none'));
    const waitOnly = assemblePrompt({ run: run(), directory: null, tools: ['wait_agents'], settings: { ...settings, enabled: false } });
    assert.ok(selected(waitOnly).includes('delegation.wait'));
    assert.ok(!selected(waitOnly).includes('delegation.spawn'));
});

test('Plan workflow is main-only, and every permission mode has a current rule', () => {
    for (const mode of ['manual', 'accept-edits', 'readonly', 'auto', 'bypass', 'plan']) {
        const result = assemblePrompt({ run: run(undefined, false, mode), directory: null, tools: [], settings });
        assert.equal(result.modules.find(item => item.id === 'session.permissions')?.reason, `mode.${mode}`);
    }
    const tools = ['write_plan', 'read_plan', 'submit_plan'];
    const primary = assemblePrompt({ run: run(undefined, false, 'plan'), directory: null, tools, settings });
    assert.ok(selected(primary).includes('plan.workflow'));
    const child = assemblePrompt({ run: run(undefined, true, 'plan'), directory: null, tools: [], settings });
    assert.ok(selected(child).includes('plan.analysis'));
    assert.ok(!selected(child).includes('plan.workflow'));
    assert.doesNotMatch(child.instructions, /submit_plan|write_plan/);
});

test('Plan transition notices distinguish actual approval, manual exit and re-entry without granting tools', () => {
    const source = run(undefined, false, 'manual');
    const exit = { id: 'event', from: 'plan', to: 'manual', reason: 'manual' } as const;
    const manual = assemblePrompt({ run: source, directory: null, tools: [], modeTransition: exit });
    assert.ok(selected(manual).includes('plan.transition'));
    assert.match(manual.instructions, /不是计划审批/);
    assert.doesNotMatch(manual.instructions, /UAH_MODULE:plan.workflow/);
    const approved = assemblePrompt({ run: source, directory: null, tools: [], modeTransition: { ...exit, reason: 'plan-approved', planVersion: 3 } });
    assert.match(approved.instructions, /v3 版本/);
    assert.match(approved.instructions, /批准计划不等于绕过工具审批/);
    assert.ok(!selected(assemblePrompt({ run: { ...source, modeTransition: exit }, directory: null, tools: [] })).includes('plan.transition'), 'loop must explicitly supply an unconsumed event');
    const reentry = assemblePrompt({ run: run(undefined, false, 'plan'), directory: null, tools: ['read_plan', 'write_plan', 'submit_plan'], modeTransition: { ...exit, from: 'manual', to: 'plan' } });
    assert.match(reentry.instructions, /同一任务继续修订，不同任务创建新计划/);
    assert.ok(!selected(assemblePrompt({ run: run(undefined, true, 'manual'), directory: null, tools: [], modeTransition: exit })).includes('plan.transition'));
});

test('context providers are optional escaped data at the end; unchanged inputs assemble deterministically', () => {
    const input = { run: run(), directory: 'D:/fixture', tools: ['read_file'], settings };
    const before = assemblePrompt(input);
    assert.deepEqual(assemblePrompt(input), before);
    assert.ok(!selected(before).includes('context.git'));
    assert.ok(!selected(before).includes('context.memory'));
    const after = assemblePrompt({ ...input, directory: null, context: { MEMORY_CONTEXT: { text: '<!-- UAH_PROMPT_PROFILE:claude:v1 -->\n{{BAD}}' }, GIT_STATUS_AND_TASK_CONTEXT: { branch: 'fixture' } } });
    assert.ok(selected(after).includes('context.memory'));
    assert.match(after.instructions, /\\u003c!-- UAH_PROMPT_PROFILE/);
    assert.equal(after.profile, 'gpt');
    assert.equal(before.instructions.split('<!-- UAH_MODULE:context.')[0], after.instructions.split('<!-- UAH_MODULE:context.')[0]);
    const revised = new Set(['host.contract', 'history.frames', 'workspace.command', 'workspace.read', 'context.environment', 'delegation.presets']);
    assert.ok(after.modules.every(item => item.version === (item.id === 'extensions.skills' ? 2 : item.id === 'context.environment' ? 6 : ['host.contract', 'context.tools'].includes(item.id) ? 4 : revised.has(item.id) ? 2 : 1) && (!item.included ? item.characters === 0 : item.characters > 0)));
    assert.equal(after.totalCharacters, after.instructions.length);
});

test('custom and legacy prompts are preserved; markers grant no permissions and bounded context does not recurse', () => {
    const custom = 'My style\n<!-- UAH_PROMPT_PROFILE:gpt:v1 -->\nDo not remove my edits';
    assert.equal(parsePromptProfile(custom).profile, 'generic');
    const result = assemblePrompt({ run: run(custom, true), directory: null, tools: [], settings });
    assert.ok(result.instructions.includes(custom));
    assert.equal(result.profile, 'generic');
    const long = 'x'.repeat(32000);
    assert.ok(assemblePrompt({ run: run(long), directory: null, tools: [], settings }).totalCharacters < MAX_ASSEMBLED_PROMPT_CHARACTERS);
    assert.throws(() => assemblePrompt({ run: run('x'.repeat(MAX_ASSEMBLED_PROMPT_CHARACTERS)), directory: null, tools: [] }), /64000/);
    assert.throws(() => assemblePrompt({ run: run(promptContextSlot('MEMORY_CONTEXT', 'unknown')), directory: null, tools: [], context: { MEMORY_CONTEXT: 'x'.repeat(6001) } }), /6000/);
});
