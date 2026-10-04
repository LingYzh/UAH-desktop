import assert from 'node:assert/strict';
import test from 'node:test';
import { appendBoundedNativeText, displayBoundedNativeText, nativeReasoningSummary, NATIVE_ACTIVITY_TEXT_LIMIT_BYTES, projectNativeItem } from '../../src/runtime/native-activity.js';

test('native completed operations preserve failing exit codes and tool success flags', () => {
    assert.equal(projectNativeItem({ id: 'failed-command', type: 'commandExecution', status: 'completed', exitCode: 1 }, 'completed')?.status, 'failed');
    assert.equal(projectNativeItem({ id: 'failed-dynamic', type: 'dynamicToolCall', status: 'completed', success: false }, 'completed')?.status, 'failed');
});

test('native reasoning displays the public summary and ignores private content fields', () => {
    const item = {
        id: 'reasoning-1', type: 'reasoning',
        summary: ['Inspect the available evidence.', { type: 'summary_text', text: 'Choose the smallest safe change.' }],
        content: [{ type: 'reasoning_text', text: 'PRIVATE INTERNAL REASONING' }],
        encrypted_content: 'ENCRYPTED INTERNAL REASONING',
    };
    const activity = projectNativeItem(item, 'completed');
    assert.equal(nativeReasoningSummary(item), 'Inspect the available evidence.\n\nChoose the smallest safe change.');
    assert.equal(activity?.kind, 'reasoning');
    assert.equal(activity?.content, 'Inspect the available evidence.\n\nChoose the smallest safe change.');
    assert.ok(!activity?.content.includes('PRIVATE'));
});

test('native command activity exposes the command, directory, output, and exit code', () => {
    const activity = projectNativeItem({
        id: 'command-1', type: 'commandExecution', status: 'completed',
        command: 'git status', cwd: 'D:/project', aggregatedOutput: 'working tree clean', exitCode: 0,
    }, 'completed');
    assert.equal(activity?.tool?.name, 'native:commandExecution');
    assert.deepEqual(activity?.tool?.arguments, { command: 'git status', cwd: 'D:/project' });
    assert.equal(activity?.tool?.result, 'working tree clean\n退出代码：0');
});

test('MCP and dynamic tool activities expose structured arguments and plain text results', () => {
    const mcp = projectNativeItem({
        id: 'mcp-1', type: 'mcpToolCall', status: 'completed', server: 'docs', tool: 'search',
        arguments: { query: 'native schema' }, result: { content: [{ type: 'text', text: 'Found two pages.' }] },
    }, 'completed');
    assert.equal(mcp?.tool?.name, 'native:mcpToolCall');
    assert.deepEqual(mcp?.tool?.arguments, { server: 'docs', tool: 'search', arguments: { query: 'native schema' } });
    assert.equal(mcp?.tool?.result, 'Found two pages.');

    const dynamic = projectNativeItem({
        id: 'dynamic-1', type: 'dynamicToolCall', status: 'failed', success: false, tool: 'uah_read_skill',
        arguments: { id: 'review' }, contentItems: [{ type: 'inputText', text: 'Skill lookup failed.' }],
    }, 'completed');
    assert.equal(dynamic?.tool?.name, 'native:dynamicToolCall');
    assert.deepEqual(dynamic?.tool?.arguments, { tool: 'uah_read_skill', arguments: { id: 'review' } });
    assert.equal(dynamic?.tool?.result, 'Skill lookup failed.');
    assert.equal(dynamic?.tool?.isError, true);
    assert.equal(dynamic?.status, 'failed');
});

test('file changes and unknown items remain readable without fabricated artifacts', () => {
    const change = projectNativeItem({
        id: 'file-1', type: 'fileChange', status: 'completed',
        changes: [{ path: 'src/app.ts', kind: { type: 'update', move_path: 'src/renamed.ts' }, diff: '@@ -1 +1 @@\n-old\n+new' }],
    }, 'completed');
    assert.equal(change?.tool?.name, 'native:fileChange');
    assert.deepEqual(change?.tool?.arguments, { changes: [{ path: 'src/app.ts', kind: { type: 'update', move_path: 'src/renamed.ts' } }] });
    assert.equal(change?.tool?.result, 'update · src/app.ts → src/renamed.ts\n@@ -1 +1 @@\n-old\n+new');
    assert.equal(change?.tool?.artifactId, undefined);

    const unknown = projectNativeItem({ id: 'future-1', type: 'futureNativeItem', status: 'completed', value: 'visible' }, 'completed');
    assert.equal(unknown?.tool?.name, 'native:futureNativeItem');
    assert.match(unknown?.tool?.result ?? '', /"value": "visible"/);
    assert.equal(projectNativeItem({ id: 'message-1', type: 'agentMessage', text: 'duplicate body' }, 'completed'), null);
    assert.equal(projectNativeItem({ id: 'plan-1', type: 'plan', text: 'duplicate plan body' }, 'completed'), null);
});

test('native streaming text is UTF-8 bounded and marks truncation explicitly', () => {
    const bounded = appendBoundedNativeText({ text: '', truncated: false }, `${'中'.repeat(NATIVE_ACTIVITY_TEXT_LIMIT_BYTES)}tail`);
    assert.equal(bounded.truncated, true);
    assert.ok(Buffer.byteLength(bounded.text, 'utf8') < NATIVE_ACTIVITY_TEXT_LIMIT_BYTES);
    const displayed = displayBoundedNativeText(bounded.text, bounded.truncated);
    assert.match(displayed, /原生输出已截断/);
    assert.ok(Buffer.byteLength(displayed, 'utf8') <= NATIVE_ACTIVITY_TEXT_LIMIT_BYTES);
});
