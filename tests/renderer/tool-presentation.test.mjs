import assert from 'node:assert/strict';
import test from 'node:test';
import { presentTool, legacyToolMetadata, nativeReasoningSummary, coalesceNativeActivities } from '../../src/renderer/tool-presentation.js';

const activity = (name, args, result = '', status = 'completed') => ({ id: 'activity', kind: 'tool', title: name, content: `${JSON.stringify(args)}\n\n${result}`, status, tool: { name, arguments: args, result } });

test('native bridge duplicates coalesce only by matching call identity and tool', () => {
    const bridge = { ...activity('uah_list_agent_presets', {}, '{}'), id: 'uah:call-1' };
    const native = { ...activity('native:dynamicToolCall', { tool: 'uah_list_agent_presets', arguments: {} }, '{}'), id: 'native:call-1' };
    assert.deepEqual(coalesceNativeActivities([bridge, native]), [bridge]);
    assert.equal(coalesceNativeActivities([bridge, { ...native, id: 'native:call-2' }]).length, 2);
    assert.equal(coalesceNativeActivities([{ ...bridge, status: 'running' }, native]).length, 2);
    assert.equal(coalesceNativeActivities([bridge, { ...native, tool: { ...native.tool, arguments: { tool: 'other' } } }]).length, 2);
    const legacy = { ...native, tool: undefined, content: JSON.stringify({ type: 'dynamicToolCall', id: 'call-1', tool: 'uah_list_agent_presets', arguments: {}, contentItems: [] }) };
    assert.deepEqual(coalesceNativeActivities([bridge, legacy]), [bridge]);
});

test('provider catalog is visible even when no child presets are enabled', () => {
    const shown = presentTool(activity('list_agent_presets', {}, JSON.stringify({ profiles: [], providerCatalogAvailable: true, providers: [{ providerId: 'company', name: '公司', models: ['model-a'], runtimeId: 'api' }] })));
    assert.match(shown.result, /Provider ID：company/);
    assert.match(shown.result, /公司/);
    assert.match(shown.result, /model-a/);
    assert.match(shown.result, /未探测服务在线/);
});

test('known UAH bridge activities use the shared friendly presentation and retain the raw result', () => {
    const raw = JSON.stringify({
        currentProviderId: 'fixture', currentModelId: 'model-a', providerCatalogAvailable: true,
        profiles: [], providers: [{ providerId: 'fixture', name: 'Fixture API', models: ['model-a'], runtimeId: 'api' }],
    });
    const shown = presentTool(activity('uah_list_agent_presets', {}, raw));
    assert.equal(shown.title, '查询子代理角色');
    assert.equal(shown.toolName, 'list_agent_presets');
    assert.equal(shown.originalToolName, 'uah_list_agent_presets');
    assert.match(shown.result, /Fixture API/);
    assert.equal(shown.rawResult, raw);

    const skillRaw = JSON.stringify({ name: 'Review skill', source: 'builtin', content: 'Skill body.' });
    const skill = presentTool(activity('uah_read_skill', { id: 'review', path: 'references/checks.md' }, skillRaw));
    assert.equal(skill.title, '读取技能');
    assert.equal(skill.toolName, 'read_skill');
    assert.equal(skill.originalToolName, 'uah_read_skill');
    assert.match(skill.usage, /references\/checks\.md/);
    assert.match(skill.result, /Review skill[\s\S]*Skill body\./);
    assert.equal(skill.rawResult, skillRaw);
});

test('native dynamic UAH tool wrappers unwrap into the same friendly delegation summary', () => {
    const raw = JSON.stringify([{ agentId: 'child-1', status: 'completed', output: 'Finished the delegated task.' }]);
    const dynamic = {
        id: 'native:dynamic-tool', kind: 'tool', title: '原生动态工具', status: 'completed', content: raw,
        tool: { name: 'native:dynamicToolCall', arguments: { tool: 'uah_wait_agents', arguments: { agentIds: ['child-1'], timeoutMs: 0 } }, result: raw },
    };
    const shown = presentTool(dynamic);
    assert.equal(shown.title, '等待子代理');
    assert.equal(shown.toolName, 'wait_agents');
    assert.equal(shown.originalToolName, 'uah_wait_agents');
    assert.match(shown.usage, /查询 1 个子代理状态/);
    assert.match(shown.result, /Finished the delegated task\./);
    assert.equal(shown.rawResult, raw);
});

test('unknown native dynamic and MCP tools preserve their true name, arguments, and result', () => {
    const dynamic = {
        id: 'native:dynamic-unknown', kind: 'tool', title: '原生动态工具', status: 'completed',
        tool: { name: 'native:dynamicToolCall', arguments: { tool: 'future_tool_v7', arguments: { limit: 3, query: 'exact' } }, result: 'Future result.' },
    };
    const shownDynamic = presentTool(dynamic);
    assert.match(shownDynamic.title, /future_tool_v7/);
    assert.equal(shownDynamic.toolName, 'future_tool_v7');
    assert.equal(shownDynamic.originalToolName, 'future_tool_v7');
    assert.match(shownDynamic.usage, /"query": "exact"/);
    assert.equal(shownDynamic.result, 'Future result.');

    const unknownMcp = activity('mcp_vendor__lookup', { query: 'unmodified args' }, 'Unmodified result.');
    const shownMcp = presentTool(unknownMcp);
    assert.match(shownMcp.title, /mcp_vendor__lookup/);
    assert.equal(shownMcp.toolName, 'mcp_vendor__lookup');
    assert.match(shownMcp.usage, /"query": "unmodified args"/);
    assert.equal(shownMcp.result, 'Unmodified result.');

    const missing = presentTool({ id: 'unknown', kind: 'tool', title: 'future', content: '', status: 'completed', tool: { name: 'future', arguments: {} } });
    assert.equal(missing.result, '原始记录没有结果。');
    const pending = presentTool({ id: 'pending', kind: 'tool', title: 'future', content: '', status: 'running', tool: { name: 'future', arguments: {} } });
    assert.equal(pending.result, '', 'an in-flight call must leave the UI pending instead of claiming a terminal result is missing');
});

test('bridge errors retain the original error text rather than parsing it as a successful result', () => {
    const raw = 'Provider resolution failed safely.';
    const shown = presentTool(activity('uah_spawn_agent', { providerId: 'missing', modelId: 'm' }, raw, 'failed'));
    assert.equal(shown.title, '启动子代理');
    assert.equal(shown.originalToolName, 'uah_spawn_agent');
    assert.equal(shown.result, raw);
    assert.equal(shown.rawResult, undefined);
});

test('friendly usage covers workspace, delegation and planning tools without parameter JSON', () => {
    const cases = [
        ['read_file', { path: 'a.ts', offset: 5, limit: 10 }, '读取 a.ts'],
        ['list_directory', {}, '直接子项'], ['search_files', { query: '[x]', path: 'src' }, '字面文本：[x]'],
        ['write_file', { path: 'a.txt', expectedContent: null, content: 'x' }, '创建 a.txt'],
        ['run_command', { command: 'Get-Location' }, 'Get-Location'],
        ['spawn_agent', { agent: { type: 'inline', name: '审查员', instructions: 'PRIVATE INSTRUCTIONS' }, prompt: '检查实现' }, '任务：检查实现'],
        ['wait_agents', { agentIds: ['child'], timeoutMs: 0 }, '查询 1 个子代理状态'], ['list_agent_presets', {}, '已启用'],
        ['enter_plan_mode', {}, '只读调研'], ['write_plan', { content: '# plan' }, 'Markdown 文件'],
        ['read_plan', {}, '读取此轮'], ['submit_plan', {}, '等待用户批准'],
    ];
    for (const [name, args, usage] of cases) {
        const shown = presentTool(activity(name, args));
        assert.ok(shown.usage.includes(usage));
        assert.ok(!shown.usage.includes('PRIVATE INSTRUCTIONS'));
        assert.ok(!shown.usage.includes('"expectedContent"'));
        assert.notEqual(shown.title, name);
    }
    assert.equal(presentTool(activity('read_file', { path: 'x', offset: 5, limit: 10 })).usage, '读取 x · 第 6 个字符起，最多 10 个字符');
    assert.equal(presentTool(activity('wait_agents', { agentIds: ['private-uuid'] })).usage, '等待 1 个子代理 · 最多 30 秒');
});

test('legacy JSON boundary handles whitespace, braces, quotes and blank-line results', () => {
    const args = { path: 'a.txt', content: 'a\n\n"quoted" \\ { }', expectedContent: null };
    const legacy = { ...activity('write_file', args, 'first\n\nsecond'), tool: undefined };
    assert.deepEqual(legacyToolMetadata(legacy), { name: 'write_file', arguments: args, result: 'first\n\nsecond' });
    assert.equal(presentTool(legacy).usage, '创建 a.txt');
    const pending = { ...legacy, content: JSON.stringify(args, null, 2), status: 'approval' };
    assert.equal(presentTool(pending).diffSource, 'proposal');
    assert.equal(presentTool(pending).after, args.content);
    for (const content of ['{"path":', '{"path":"a"} garbage', 'raw secret parameters']) {
        const shown = presentTool({ ...legacy, content });
        assert.equal(shown.usage, '操作详情不可用。');
        assert.equal(shown.after, undefined);
        assert.ok(!JSON.stringify(shown).includes(content));
    }
});

test('completed edits require exact artifact identity; pending edits are explicit proposals', () => {
    const edit = activity('write_file', { path: 'same.txt', expectedContent: 'old', content: 'proposal' }, 'File written.');
    const artifacts = [{ id: 'other', path: 'same.txt', oldContent: 'old', newContent: 'unrelated' }, { id: 'exact', path: '/project/same.txt', oldContent: null, newContent: 'actual' }];
    assert.equal(presentTool(edit, artifacts).after, undefined);
    edit.tool.artifactId = 'exact';
    assert.deepEqual(presentTool(edit, artifacts), { title: '编辑文件', usage: '替换 same.txt', result: 'File written.', path: '/project/same.txt', artifactId: 'exact', before: null, after: 'actual', diffSource: 'artifact' });
    edit.tool.artifactId = 'missing'; edit.status = 'failed';
    assert.equal(presentTool(edit, artifacts).after, undefined);
    edit.status = 'approval';
    assert.equal(presentTool(edit, artifacts).after, 'proposal');
    assert.equal(presentTool(edit, artifacts).diffSource, 'proposal');
});

test('delegation result summaries expose status and model but omit profile instructions JSON', () => {
    const wait = presentTool(activity('wait_agents', { agentIds: ['child'] }, JSON.stringify([{ agentId: 'child', status: 'stopped', output: 'partial\n\ntext', stopReason: '用户停止' }])));
    assert.match(wait.result, /已中止/); assert.match(wait.result, /停止理由：用户停止/); assert.ok(!wait.result.includes('"status"'));
    const presets = presentTool(activity('list_agent_presets', {}, JSON.stringify({ profiles: [{ name: 'Reviewer', instructions: 'SECRET', model: { endpointId: 'endpoint', modelId: 'model' } }] })));
    assert.equal(presets.result, 'Reviewer · endpoint / model');
    const spawned = activity('spawn_agent', { prompt: 'task', agent: { type: 'inherit' } }, '{"agentId":"child","status":"running"}');
    spawned.kind = 'agent'; spawned.title = 'Custom agent';
    assert.equal(presentTool(spawned).title, '启动子代理');
    assert.match(presentTool(spawned).result, /运行中/);
    assert.equal(presentTool(activity('wait_agents', {}, '{broken')).result, '结果详情不可用。');
});

test('workspace file output stays literal plain text', () => {
    const raw = '# heading\n<script>untrusted</script>\n{"secret":"value"}';
    for (const name of ['read_file', 'list_directory', 'search_files', 'run_command']) assert.equal(presentTool(activity(name, {}, raw)).result, raw);
});

test('Git activity displays scoped status and literal diff instead of unavailable metadata', () => {
    const snapshot = { state: 'ready', branch: 'main', files: [{ path: '中文 文件.txt', indexStatus: '?', worktreeStatus: '?', untracked: true }], truncated: true };
    const status = presentTool(activity('git_status', {}, JSON.stringify({ snapshot })));
    assert.equal(status.title, '查看 Git 状态');
    assert.match(status.result, /中文 文件.txt · 未跟踪/);
    assert.match(status.result, /已截断/);
    const diff = presentTool(activity('git_diff', { staged: true }, JSON.stringify({ snapshot, diff: '+<script>untrusted</script>' })));
    assert.match(diff.usage, /索引对 HEAD/);
    assert.equal(diff.result, '+<script>untrusted</script>');
    assert.equal(presentTool(activity('git_status', {}, JSON.stringify({ snapshot: { state: 'error', message: '状态未知' } }))).result, '状态未知');
});

test('legacy completed edit fallback requires explicit run, normalized path, exact full contents and uniqueness', () => {
    const old = { ...activity('write_file', { path: 'file.txt', expectedContent: 'before', content: 'after' }, 'File written.'), tool: undefined };
    const snapshot = { id: 'legacy-artifact', runId: 'run', path: 'C:\\Project\\file.txt', oldContent: 'before', newContent: 'after' };
    const context = { runId: 'run', directory: 'c:/project' };
    assert.equal(presentTool(old, [snapshot]).diffSource, undefined);
    assert.equal(presentTool(old, [snapshot], context).artifactId, snapshot.id);
    for (const wrong of [{ ...context, runId: 'other' }, { ...context, directory: 'C:/elsewhere' }]) assert.equal(presentTool(old, [snapshot], wrong).diffSource, undefined);
    for (const wrong of [{ ...snapshot, oldContent: 'before truncated' }, { ...snapshot, newContent: 'different' }]) assert.equal(presentTool(old, [wrong], context).diffSource, undefined);
    assert.equal(presentTool(old, [snapshot, { ...snapshot, id: 'duplicate' }], context).diffSource, undefined);
    const missingExplicit = activity('write_file', { path: 'file.txt', expectedContent: 'before', content: 'after' }, 'File written.');
    missingExplicit.tool.artifactId = 'missing';
    assert.equal(presentTool(missingExplicit, [snapshot], context).diffSource, undefined);
    const absolute = { ...old, content: JSON.stringify({ path: 'C:/PROJECT/./file.txt', expectedContent: 'before', content: 'after' }) + '\n\nFile written.' };
    assert.equal(presentTool(absolute, [snapshot], { runId: 'run' }).artifactId, snapshot.id);
    const posix = { ...old, content: JSON.stringify({ path: '/project/File.txt', expectedContent: 'before', content: 'after' }) + '\n\nFile written.' };
    assert.equal(presentTool(posix, [{ ...snapshot, path: '/project/file.txt' }], { runId: 'run' }).diffSource, undefined);
});

test('native tool metadata displays structured details and keeps results as plain text', () => {
    const command = {
        id: 'native:cmd-1', kind: 'tool', title: '原生命令', content: '# literal result', status: 'completed',
        tool: { name: 'native:commandExecution', arguments: { command: 'git status', cwd: 'D:/project' }, result: '# literal result' },
    };
    assert.deepEqual(presentTool(command), { title: '原生命令', toolName: 'commandExecution', usage: 'git status\n目录：D:/project', result: '# literal result' });

    const mcp = {
        id: 'native:mcp-1', kind: 'tool', title: 'Codex · mcpToolCall', status: 'completed',
        content: JSON.stringify({ id: 'mcp-1', type: 'mcpToolCall', status: 'completed', server: 'docs', tool: 'search', arguments: { query: 'schema' }, result: { content: [{ type: 'text', text: 'Found two pages.' }] } }),
    };
    const shown = presentTool(mcp);
    assert.equal(shown.title, 'MCP 工具');
    assert.match(shown.usage, /docs \/ search/);
    assert.match(shown.usage, /schema/);
    assert.equal(shown.result, 'Found two pages.');
});

test('legacy native raw JSON is projected, and old reasoning shows only its public summary', () => {
    const legacyCommand = {
        id: 'native:cmd-old', kind: 'tool', title: 'Codex · commandExecution', status: 'completed',
        content: JSON.stringify({ id: 'cmd-old', type: 'commandExecution', status: 'completed', command: 'Get-Location', cwd: 'D:/UAH', aggregatedOutput: 'D:/UAH', exitCode: 0 }),
    };
    assert.equal(presentTool(legacyCommand).usage, 'Get-Location\n目录：D:/UAH');
    assert.match(presentTool(legacyCommand).result, /退出代码：0/);

    const oldReasoning = {
        id: 'native:reasoning-old', kind: 'reasoning', content: JSON.stringify({
            id: 'reasoning-old', type: 'reasoning', summary: ['A public update.'],
            content: [{ type: 'reasoning_text', text: 'PRIVATE THOUGHT' }], encrypted_content: 'ENCRYPTED',
        }),
    };
    assert.equal(nativeReasoningSummary(oldReasoning), 'A public update.');
    assert.equal(nativeReasoningSummary({ ...oldReasoning, content: JSON.stringify({ type: 'reasoning', encrypted_content: 'ENCRYPTED' }) }), '公开推理摘要不可用。');
    assert.ok(!nativeReasoningSummary(oldReasoning).includes('PRIVATE'));
});
