import assert from 'node:assert/strict';
import test from 'node:test';
import { assemblePrompt } from '../../src/runtime/prompt-assembler';
import { runtimePromptContext } from '../../src/runtime/prompt-context';
import { gitPromptContext } from '../../src/runtime/git';
import { renderProjectRules } from '../../src/runtime/knowledge-service';
import { promptContextSlot } from '../../src/shared/prompt-context';
import type { RunRecord } from '../../src/shared/contracts';
import type { GitSnapshot } from '../../src/shared/git';
import type { ProjectRulesSnapshot } from '../../src/runtime/context-sources';

function run(overrides: Partial<RunRecord> = {}): RunRecord {
    return {
        id: 'run-a', sessionId: 'session', turnId: 'turn', state: 'running', input: 'task', output: '', sequence: 1,
        createdAt: '2026-10-04T00:00:00.000Z',
        effective: { runtimeId: 'api', modelId: 'fixture', endpointId: 'provider', permissionMode: 'readonly', agentInstructions: 'stable' },
        ...overrides,
    } as RunRecord;
}

test('V2 projects changing context into ordered runtime sections and keeps tools stable', () => {
    const result = assemblePrompt({
        run: run(), directory: 'D:/project', tools: ['z_tool', 'a_tool'], contextEngineVersion: 2,
        projectRules: 'rule <payload>',
        contextSources: [
            { id: 'b', kind: 'memory', scope: 'user', path: 'b.md', modifiedAt: 'later', warnings: ['ignored'], selected: true },
            { id: 'a', kind: 'rule', scope: 'project', path: 'a.md', modifiedAt: 'earlier', selected: false },
        ],
        context: { GIT_STATUS_AND_TASK_CONTEXT: { branch: 'main' }, MEMORY_CONTEXT: { text: '</memory>' } },
    });
    assert.deepEqual(result.runtimeSections.map(section => section.id), ['project.rules', 'context.sources', 'context.git', 'context.memory', 'context.environment']);
    for (const id of ['project.rules', 'context.sources', 'context.git', 'context.memory', 'context.environment']) {
        assert.doesNotMatch(result.instructions, new RegExp(`UAH_MODULE:${id}`));
    }
    assert.match(result.instructions, /UAH_MODULE:context.tools/);
    assert.match(result.instructions, /尾部快照按 runtimeSections/);
    assert.match(result.runtimeSections[0].content, /\\u003cpayload\\u003e/);
    assert.doesNotMatch(result.runtimeSections[1].content, /modifiedAt|warnings/);
    assert.match(result.runtimeSections[3].content, /\\u003c\/memory\\u003e/);
});

test('V2 plan transitions are tail updates instead of one-shot instruction prefix changes', () => {
    const source = run();
    const transition = { id: 'transition-1', from: 'plan', to: 'readonly', reason: 'manual' } as const;
    const legacy = assemblePrompt({ run: source, directory: null, tools: [], modeTransition: transition });
    const v2 = assemblePrompt({ run: source, directory: null, tools: [], contextEngineVersion: 2, modeTransition: transition });
    assert.match(legacy.instructions, /UAH_MODULE:plan\.transition/);
    assert.doesNotMatch(v2.instructions, /UAH_MODULE:plan\.transition/);
    assert.equal(v2.runtimeSections.find(section => section.id === 'plan.transition')?.content.includes('不是计划审批'), true);
});

test('semantic runtime context is stable across run IDs, clocks, budgets and tool progress', () => {
    const first = run({ id: 'run-a', parentRunId: 'parent-a', depth: 1, harnessState: 'running_tools', budgetState: { elapsedMs: 10, requestsUsed: 1 },
        toolProgress: { failedBatches: 1, repeatedFailureBatches: 0, lastFailureFingerprint: 'a'.repeat(64), stopCode: null }, resumeOfRunId: 'old-a' });
    const second = run({ id: 'run-b', parentRunId: 'parent-b', depth: 1, harnessState: 'waiting_resource', budgetState: { elapsedMs: 9999, requestsUsed: 9 },
        toolProgress: { failedBatches: 3, repeatedFailureBatches: 2, lastFailureFingerprint: 'b'.repeat(64), stopCode: 'no_progress' }, resumeOfRunId: 'old-b' });
    const firstContext = runtimePromptContext(first, 'D:/project', ['z_tool', 'a_tool'], undefined, { semantic: true });
    const secondContext = runtimePromptContext(second, 'D:/project', ['a_tool', 'z_tool'], undefined, { semantic: true });
    assert.deepEqual(firstContext, secondContext);
    const serialized = JSON.stringify(firstContext);
    for (const field of ['runId', 'parentRunId', 'executionState', 'taskTreeBudget', 'resumeOfRunId']) assert.doesNotMatch(serialized, new RegExp(field));
    assert.doesNotMatch(serialized, /"state":/);
    assert.match(serialized, /token 用量仅作统计/);
    assert.match(serialized, /"directory":"D:\/project"/);
    assert.match(serialized, /"role":"subagent"/);
    assert.deepEqual((firstContext.DYNAMIC_TOOL_AND_MCP_INSTRUCTIONS as { tools: string[] }).tools, ['a_tool', 'z_tool']);
    const changed = runtimePromptContext(first, 'D:/other', ['z_tool', 'a_tool'], undefined, { semantic: true });
    assert.notDeepEqual(firstContext, changed);
});

test('V2 source metadata ignores modified time and warning-only fields while sorting', () => {
    const make = (modifiedAt: string, warnings: string[]) => assemblePrompt({
        run: run(), directory: null, tools: [], contextEngineVersion: 2,
        contextSources: [
            { id: 'source-b', kind: 'memory', scope: 'user', path: 'b', selected: true, modifiedAt, warnings },
            { id: 'source-a', kind: 'rule', scope: 'project', path: 'a', selected: false, modifiedAt, warnings },
        ],
    });
    assert.equal(make('one', ['a']).runtimeSections.find(section => section.id === 'context.sources')?.content,
        make('two', ['b', 'c']).runtimeSections.find(section => section.id === 'context.sources')?.content);
});

test('custom dynamic templates retain legacy rendering and report the compatibility diagnostic', () => {
    const instructions = `custom\n${promptContextSlot('ENVIRONMENT_CONTEXT', 'unknown')}\n${promptContextSlot('MEMORY_CONTEXT', 'unknown')}`;
    const source = run({ effective: { runtimeId: 'api', modelId: 'fixture', agentId: 'agent', policyVersion: 1, endpointId: 'provider', permissionMode: 'readonly', agentInstructions: instructions } });
    const legacy = assemblePrompt({ run: source, directory: 'D:/project', tools: [], context: { MEMORY_CONTEXT: { text: '<!-- UAH_CONTEXT:ENVIRONMENT_CONTEXT:v1 -->' } } });
    const v2 = assemblePrompt({ run: source, directory: 'D:/project', tools: [], contextEngineVersion: 2, context: { MEMORY_CONTEXT: { text: '<!-- UAH_CONTEXT:ENVIRONMENT_CONTEXT:v1 -->' } } });
    assert.ok(v2.diagnostics.includes('legacy_dynamic_template'));
    assert.equal(v2.sections.find(section => section.id === 'agent.instructions')?.content,
        legacy.sections.find(section => section.id === 'agent.instructions')?.content);
    assert.match(v2.instructions, /"runId":"run-a"/);
    assert.match(v2.instructions, /\\u003c!-- UAH_CONTEXT:ENVIRONMENT_CONTEXT:v1 --\\u003e/);
});

test('semantic Git and rule renderers omit only non-semantic diagnostics by opt in', () => {
    const snapshot = { state: 'ready', directory: 'D:/project', root: 'D:/project', branch: 'main', files: [], truncated: false,
        capturedAt: '2026-10-04T00:00:00.000Z', message: 'ready' } as GitSnapshot;
    assert.match(gitPromptContext(snapshot), /capturedAt/);
    assert.doesNotMatch(gitPromptContext(snapshot, { semantic: true }), /capturedAt/);
    const rules: ProjectRulesSnapshot = { sources: [], active: [{ source: { id: 'r', kind: 'rule', scope: '.', path: 'AGENTS.md', modifiedAt: 'now', selected: true, reason: 'ok' }, content: 'rule' }], warnings: ['clock-only warning'], fingerprint: 'fingerprint' };
    const rendered = renderProjectRules(rules, { includeWarnings: false });
    assert.match(rendered, /fingerprint/);
    assert.match(rendered, /rule/);
    assert.doesNotMatch(rendered, /clock-only warning/);
    assert.match(renderProjectRules(rules), /clock-only warning/);
    const touched: ProjectRulesSnapshot = { ...rules, fingerprint: 'different-file-metadata', warnings: ['different diagnostic'],
        active: rules.active.map(item => ({ ...item, source: { ...item.source, modifiedAt: 'later' } })) };
    assert.equal(renderProjectRules(touched, { includeWarnings: false }), rendered);
    const changed = { ...touched, active: touched.active.map(item => ({ ...item, content: 'changed rule' })) };
    assert.notEqual(renderProjectRules(changed, { includeWarnings: false }), rendered);
});
