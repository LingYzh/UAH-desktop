import assert from 'node:assert/strict';
import test from 'node:test';
import { assessCompiledRequest } from '../../src/runtime/context/meter';
import { compactablePrefix } from '../../src/runtime/context/compaction';
import { planCache } from '../../src/runtime/context/cache-planner';
import { contextHash, inspectRequest, projectRuntimeSections } from '../../src/runtime/context/projection';
import { prepareAgentRequest, streamAgentApi } from '../../src/runtime/api-transport';
import type { ApiConnection, ApiProtocol } from '../../src/shared/endpoints';

const tool = {
    name: 'read_file', description: 'Read a file',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
};

function connection(protocol: ApiProtocol, baseUrl = 'http://127.0.0.1:8787/v1', apiKey = 'fixture-secret'): ApiConnection {
    return { id: 'endpoint-fixture', name: 'Offline fixture', protocol, baseUrl, models: ['model'], enabled: true, revision: 1, apiKey };
}

test('prepared requests freeze the exact body for all three wire protocols', () => {
    const messages = [{ role: 'user' as const, content: 'hello' }, { role: 'assistant' as const, content: 'reply' }];
    for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) {
        const prepared = prepareAgentRequest(connection(protocol), 'model', messages, { instructions: 'stable system', tools: [tool] });
        assert.equal(Object.isFrozen(prepared), true);
        assert.equal(Object.isFrozen(prepared.body), true);
        assert.equal(prepared.serialized, JSON.stringify(prepared.body));
        assert.equal(prepared.history.length, 2);
        if (protocol === 'openai-chat') {
            assert.deepEqual(prepared.body.messages, [{ role: 'system', content: 'stable system' }, ...messages]);
            assert.deepEqual(prepared.body.tools, [{ type: 'function', function: tool }]);
        } else if (protocol === 'openai-responses') {
            assert.deepEqual(prepared.body.input, messages);
            assert.equal(prepared.body.instructions, 'stable system');
            assert.deepEqual(prepared.body.tools, [{ type: 'function', ...tool, strict: false }]);
            assert.deepEqual(prepared.body.include, ['reasoning.encrypted_content']);
        } else {
            assert.deepEqual(prepared.body.messages, messages);
            assert.equal(prepared.body.system, 'stable system');
            assert.deepEqual(prepared.body.tools, [{ name: tool.name, description: tool.description, input_schema: tool.parameters }]);
        }
    }
});

test('prepared request rejects a credential route change before any transport I/O', async () => {
    const original = connection('openai-chat');
    const prepared = prepareAgentRequest(original, 'model', [{ role: 'user', content: 'offline' }], { tools: [] });
    let requested = false;
    const pending = streamAgentApi(connection('openai-chat', original.baseUrl, 'changed-secret'), 'model',
        [{ role: 'user', content: 'offline' }], undefined, {
            tools: [], preparedRequest: prepared,
            observer: { prepared: () => undefined, dispatch: () => { requested = true; }, responseStarted: () => undefined,
                providerEvent: () => undefined, terminal: () => undefined },
        });
    await assert.rejects(async () => { for await (const _event of pending) { /* route check must fail first */ } }, /模型服务返回的数据无效/);
    assert.equal(requested, false);
});

test('moving cache markers preserves semantic prefix evidence', () => {
    const first = { model: 'model', instructions: 'stable', tools: [], input: [{ role: 'user', content: [
        { type: 'input_text', text: 'a', prompt_cache_breakpoint: { mode: 'explicit' } },
        { type: 'input_text', text: 'b' },
    ] }] };
    const moved = { model: 'model', instructions: 'stable', tools: [], input: [{ role: 'user', content: [
        { type: 'input_text', text: 'a' }, { type: 'input_text', text: 'b', prompt_cache_breakpoint: { mode: 'explicit' } },
    ] }] };
    const previous = inspectRequest(first, 'openai-responses', 'request-a');
    const current = inspectRequest(moved, 'openai-responses', 'request-b', previous);
    assert.equal(current.retainedSegments, current.segments.length);
    assert.equal(current.appendOnly, true);
    assert.equal(current.firstChanged, null);
});

test('unknown gateways receive no guessed cache fields', () => {
    const input = { model: 'model', messages: [{ role: 'user', content: 'hello' }], tools: [] };
    const planned = planCache(connection('openai-chat', 'https://gateway.example'), 'model', input);
    assert.equal(planned.plan.profile, 'unknown');
    assert.deepEqual(planned.body, input);
    assert.doesNotMatch(JSON.stringify(planned.body), /cache_control|prompt_cache_breakpoint|prompt_cache_options/);
});

test('official cache planning retains an old frontier and caps writes', () => {
    const endpoint = connection('anthropic', 'https://api.anthropic.com');
    const firstInput: Record<string, unknown> = { model: 'model', messages: [
        { role: 'user', content: 'first' }, { role: 'assistant', content: 'reply' },
    ], tools: [] };
    const first = planCache(endpoint, 'model', firstInput);
    const oldFrontier = first.plan.candidates[0];
    assert(oldFrontier);
    const secondInput: Record<string, unknown> = { model: 'model', messages: [
        ...(firstInput.messages as unknown[]), { role: 'user', content: 'second' },
    ], tools: [] };
    const second = planCache(endpoint, 'model', secondInput, oldFrontier);
    assert.equal(second.plan.profile, 'anthropic-blocks');
    assert.equal(second.plan.previousRetained, true);
    assert.equal(second.plan.maxWritesPerRequest, 4);
    assert.equal(second.plan.candidates.some(item => item.message === oldFrontier.message && item.block === oldFrontier.block
        && item.prefixHash === oldFrontier.prefixHash), true);
    const marked = JSON.stringify(second.body).match(/cache_control/g) ?? [];
    assert.equal(marked.length <= second.plan.maxWritesPerRequest, true);
    assert.equal(marked.length, 2);
});

test('runtime section projection distinguishes ABA changes and emits clear tombstones', () => {
    const first = projectRuntimeSections('openai-chat', [{ id: 'context.memory', content: 'A' }], {});
    const second = projectRuntimeSections('openai-chat', [{ id: 'context.memory', content: 'B' }], first.hashes);
    const third = projectRuntimeSections('openai-chat', [{ id: 'context.memory', content: 'A' }], second.hashes);
    assert.equal(first.messages.length, 1);
    assert.equal(second.messages.length, 1);
    assert.equal(third.messages.length, 1);
    assert.equal(String((third.messages[0] as { content: string }).content).includes('"content":"A"'), true);
    const cleared = projectRuntimeSections('openai-chat', [], { 'context.memory': contextHash('A') });
    assert.equal(String((cleared.messages[0] as { content: string }).content).includes('"content":null'), true);
    assert.equal(cleared.hashes['context.memory'], undefined);
});

test('meter estimates 64k English and Chinese separately and counts opaque body bytes', () => {
    const english = assessCompiledRequest('a'.repeat(64_000));
    const chinese = assessCompiledRequest('中'.repeat(64_000));
    assert.equal(english.bodyBytes, 64_000);
    assert.equal(chinese.bodyBytes, 192_000);
    assert(english.inputEstimatedTokens < english.bodyBytes);
    assert(chinese.inputEstimatedTokens < chinese.bodyBytes);
    assert(chinese.inputEstimatedTokens > english.inputEstimatedTokens);
    assert(chinese.inputEstimatedTokens / chinese.bodyBytes > 0.3);
    const opaque = JSON.stringify({ input: [{ type: 'reasoning', encrypted_content: 'x'.repeat(100_000), signature: '签名' }] });
    const plain = assessCompiledRequest(JSON.stringify({ input: [] }));
    const opaqueAssessment = assessCompiledRequest(opaque);
    assert.equal(opaqueAssessment.bodyBytes, Buffer.byteLength(opaque, 'utf8'));
    assert(opaqueAssessment.bodyBytes > plain.bodyBytes);
    assert(opaqueAssessment.inputEstimatedTokens > plain.inputEstimatedTokens);
});

test('compaction boundary never splits a parallel tool batch and respects the protected tail', () => {
    const history = [
        { role: 'user', content: 'old request' },
        { role: 'assistant', content: null, tool_calls: [
            { id: 'a', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { id: 'b', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ] },
        { role: 'tool', tool_call_id: 'a', content: 'A' },
        { role: 'tool', tool_call_id: 'b', content: 'B' },
        { role: 'assistant', content: 'old completed' },
        { role: 'user', content: 'middle request' },
        { role: 'assistant', content: 'middle completed' },
        { role: 'user', content: 'current request' },
        { role: 'assistant', content: 'current answer' },
        { role: 'user', content: 'protected tail' },
    ];
    const boundary = compactablePrefix(history, 64_000);
    assert(boundary >= 5);
    assert(boundary <= history.length - 1);
    assert.notEqual(boundary, 2);
    assert.notEqual(boundary, 3);
    assert.equal(compactablePrefix(history, 1), 0);
});
