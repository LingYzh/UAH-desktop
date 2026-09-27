import assert from 'node:assert/strict';
import test from 'node:test';
import { presentTool, legacyToolMetadata } from '../../src/renderer/tool-presentation.js';

const activity = (name, args, result = '', status = 'completed') => ({ id: 'activity', kind: 'tool', title: name, content: `${JSON.stringify(args)}\n\n${result}`, status, tool: { name, arguments: args, result } });

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
