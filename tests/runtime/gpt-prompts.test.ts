import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { GPT_SHARED_TEMPLATE, GPT_MAIN_TEMPLATE, GPT_SUBAGENT_TEMPLATE, GPT_RUNTIME_TEMPLATE } from '../../src/shared/gpt-prompt-templates';
import { GPT_HARNESS_INSTRUCTIONS, GPT_SUBAGENT_INSTRUCTIONS } from '../../src/shared/gpt-harness-prompts';
import { conditionalDefaultInstructions } from '../../src/shared/conditional-prompts';
import { defaultAgentSettings, parseAgentSettings } from '../../src/shared/agents';
import { renderPromptContext } from '../../src/shared/prompt-context';
import { runtimePromptContext } from '../../src/runtime/prompt-context';
import type { RunRecord } from '../../src/shared/contracts';

test('GPT vendored modules exactly preserve the user pack; only slots change in bound prompts', () => {
    for (const [name, template] of Object.entries({ 'shared-base': GPT_SHARED_TEMPLATE, 'main-role': GPT_MAIN_TEMPLATE, 'subagent-role': GPT_SUBAGENT_TEMPLATE, 'runtime-context': GPT_RUNTIME_TEMPLATE })) {
        // Git may check out Markdown with CRLF on Windows while the embedded template uses LF.
        assert.equal(template, readFileSync(`docs/codex-cli-0.157.1-prompts/portable/${name}.md`, 'utf8').replace(/\r\n/g, '\n'));
    }
    for (const [role, prompt] of [[GPT_MAIN_TEMPLATE, GPT_HARNESS_INSTRUCTIONS], [GPT_SUBAGENT_TEMPLATE, GPT_SUBAGENT_INSTRUCTIONS]]) {
        for (const template of [GPT_SHARED_TEMPLATE, role, GPT_RUNTIME_TEMPLATE]) {
            let offset = 0;
            for (const fragment of template.split(/\{\{[A-Z_]+\}\}/)) {
                const index = prompt.indexOf(fragment, offset);
                assert.ok(index >= 0, fragment);
                offset = index + fragment.length;
            }
        }
        assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
        assert.ok(prompt.length <= 32000);
        assert.equal(prompt.split('# Host compatibility contract').length, 2);
    }
    assert.doesNotMatch(GPT_HARNESS_INSTRUCTIONS, /# Subagent role/);
    assert.doesNotMatch(GPT_SUBAGENT_INSTRUCTIONS, /# Main-agent role/);
});

test('GPT defaults are distinct editable roles without model binding or extra delegation', () => {
    const settings = parseAgentSettings(defaultAgentSettings());
    const root = settings.profiles.find(profile => profile.id === 'gpt-default')!;
    const child = settings.profiles.find(profile => profile.id === 'gpt-subagent-default')!;
    assert.equal(root.instructions, conditionalDefaultInstructions('gpt'));
    assert.equal(root.kind, 'primary');
    assert.equal(root.allowDelegation, true);
    assert.ok(!('model' in root));
    assert.equal(child.instructions, conditionalDefaultInstructions('gpt'));
    assert.equal(child.kind, 'subagent');
    assert.equal(child.allowDelegation, false);
    assert.equal(child.enabled, true);
    assert.ok('model' in child && child.model === null);
});

test('GPT runtime context refreshes identity, permissions and tools without persisting or fabricating integrations', () => {
    const run = { id: 'child-fixture', parentRunId: 'parent-fixture', depth: 1, effective: { modelId: 'model', endpointId: 'provider', permissionMode: 'readonly' } } as RunRecord;
    const first = renderPromptContext(GPT_SUBAGENT_INSTRUCTIONS, runtimePromptContext(run, 'D:/fixture', ['read_file']));
    const next = renderPromptContext(GPT_SUBAGENT_INSTRUCTIONS, runtimePromptContext({ ...run, effective: { ...run.effective, permissionMode: 'plan' } }, null, []));
    assert.match(first, /"runId":"child-fixture","parentRunId":"parent-fixture"/);
    assert.match(first, /"directory":"D:\/fixture"/);
    assert.match(first, /"tools":\["read_file"\]/);
    assert.match(next, /"permissionMode":"plan"/);
    assert.match(next, /"tools":\[\]/);
    assert.match(next, /"directory":null/);
    assert.match(next, /Persistent memory is not integrated/);
    assert.match(next, /Git branch and working-tree state are not automatically supplied/);
    assert.doesNotMatch(GPT_SUBAGENT_INSTRUCTIONS, /child-fixture|D:\/fixture/);
    const future = renderPromptContext(GPT_HARNESS_INSTRUCTIONS, { GIT_STATUS_AND_TASK_CONTEXT: { branch: 'main' }, MEMORY_CONTEXT: { entries: ['</working_context> {{AGENT_ID}}'] } });
    assert.match(future, /"branch":"main"/);
    assert.ok(future.includes('\\u003c/working_context\\u003e {{AGENT_ID}}'));
});
