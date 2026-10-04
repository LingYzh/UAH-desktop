import assert from 'node:assert/strict';
import test from 'node:test';
import { portableHistory } from '../../src/runtime/context/portable-history';
import type { ApiProtocol } from '../../src/shared/endpoints';

const protocols: ApiProtocol[] = ['openai-chat', 'openai-responses', 'anthropic'];

const chatHistory = [
    { role: 'user', content: 'Read two files.' },
    {
        id: 'provider-message-1', role: 'assistant', content: 'I will inspect both.',
        reasoning_content: 'private chain of thought', signature: 'private signature',
        tool_calls: [
            { id: 'chat-call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
            { id: 'chat-call-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        ],
    },
    { role: 'tool', tool_call_id: 'chat-call-a', content: 'A' },
    { role: 'tool', tool_call_id: 'chat-call-b', content: 'B', is_error: true },
    { id: 'provider-message-2', role: 'assistant', content: 'The second read failed.' },
];

function calls(history: readonly unknown[]): Array<Record<string, unknown>> {
    return history.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        if (Array.isArray(value.tool_calls)) return value.tool_calls as Array<Record<string, unknown>>;
        if (value.type === 'function_call') return [value];
        if (Array.isArray(value.content)) return value.content.filter(block => block && typeof block === 'object'
            && ((block as Record<string, unknown>).type === 'tool_use')) as Array<Record<string, unknown>>;
        return [];
    });
}

function resultIds(history: readonly unknown[]): string[] {
    return history.flatMap(item => {
        if (!item || typeof item !== 'object') return [];
        const value = item as Record<string, unknown>;
        if (value.role === 'tool' && typeof value.tool_call_id === 'string') return [value.tool_call_id];
        if (value.type === 'function_call_output' && typeof value.call_id === 'string') return [value.call_id];
        if (Array.isArray(value.content)) return value.content.filter(block => block && typeof block === 'object'
            && (block as Record<string, unknown>).type === 'tool_result')
            .flatMap(block => typeof (block as Record<string, unknown>).tool_use_id === 'string'
                ? [(block as Record<string, unknown>).tool_use_id as string] : []);
        return [];
    });
}

function semantic(history: readonly unknown[]): { text: string[]; callNames: string[]; resultCount: number; errors: number } {
    const text: string[] = [];
    const callNames: string[] = [];
    let resultCount = 0;
    let errors = 0;
    for (const item of history) {
        if (!item || typeof item !== 'object') continue;
        const value = item as Record<string, unknown>;
        if ((value.role === 'user' || value.role === 'assistant') && typeof value.content === 'string') text.push(value.content);
        if (value.role === 'assistant' && Array.isArray(value.content)) for (const block of value.content) {
            if (!block || typeof block !== 'object') continue;
            const part = block as Record<string, unknown>;
            if (['text', 'input_text', 'output_text'].includes(String(part.type)) && typeof part.text === 'string') text.push(part.text);
        }
        for (const call of calls([value])) {
            const fn = call.function && typeof call.function === 'object' ? call.function as Record<string, unknown> : undefined;
            if (typeof call.name === 'string') callNames.push(call.name);
            else if (typeof fn?.name === 'string') callNames.push(fn.name);
        }
        if (value.role === 'tool' || value.type === 'function_call_output') resultCount += 1;
        if (value.is_error === true || value.status === 'failed') errors += 1;
        if (Array.isArray(value.content)) for (const block of value.content) if (block && typeof block === 'object') {
            const part = block as Record<string, unknown>;
            if (part.type === 'tool_result') { resultCount += 1; if (part.is_error === true) errors += 1; }
        }
    }
    return { text, callNames, resultCount, errors };
}

test('portable history projects every wire protocol and keeps visible semantics', () => {
    for (const target of protocols) {
        const projected = portableHistory('openai-chat', target, chatHistory);
        assert.deepEqual(semantic(projected), {
            text: ['Read two files.', 'I will inspect both.', 'The second read failed.'],
            callNames: ['read_file', 'read_file'], resultCount: 2, errors: 1,
        });
        assert.equal(calls(projected).length, 2);
        assert.equal(resultIds(projected).length, 2);
    }
});

test('parallel calls retain one batch and deterministic mapped ids across a roundtrip', () => {
    const anthropic = portableHistory('openai-chat', 'anthropic', chatHistory);
    const assistant = anthropic.find(item => item && typeof item === 'object'
        && (item as Record<string, unknown>).role === 'assistant') as Record<string, unknown>;
    const blocks = assistant.content as Array<Record<string, unknown>>;
    assert.deepEqual(blocks.filter(block => block.type === 'tool_use').map(block => block.name), ['read_file', 'read_file']);
    const mapped = blocks.filter(block => block.type === 'tool_use').map(block => block.id);
    assert.equal(new Set(mapped).size, 2);
    for (const id of mapped) assert.match(String(id), /^[A-Za-z0-9_-]{1,64}$/);
    assert.deepEqual(resultIds(anthropic), mapped);

    const roundtrip = portableHistory('anthropic', 'openai-chat', anthropic);
    assert.deepEqual(calls(roundtrip).map(call => call.id), mapped);
    assert.deepEqual(resultIds(roundtrip), mapped);
    assert.deepEqual(portableHistory('openai-chat', 'anthropic', chatHistory), anthropic);
});

test('private reasoning, encrypted content, signatures, and provider response ids are removed', () => {
    const source = [
        { role: 'user', content: 'hello', id: 'user-provider-id' },
        { type: 'reasoning', id: 'reasoning-provider-id', encrypted_content: 'secret', summary: [{ type: 'summary_text', text: 'private' }] },
        { type: 'message', id: 'assistant-provider-id', role: 'assistant', content: [
            { type: 'output_text', text: 'visible' }, { type: 'reasoning_text', text: 'private' },
        ] },
    ];
    for (const target of protocols) {
        const output = portableHistory('openai-responses', target, source);
        const serialized = JSON.stringify(output);
        assert.doesNotMatch(serialized, /provider-id|encrypted_content|reasoning_text|summary_text/);
        assert.match(serialized, /visible/);
    }
});

test('paired read errors remain errors in all target protocols', () => {
    const source = [
        { role: 'assistant', content: null, tool_calls: [{ id: 'read', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'read', content: 'ENOENT: no such file', is_error: true },
    ];
    const chat = portableHistory('openai-chat', 'openai-chat', source) as Array<Record<string, unknown>>;
    assert.equal(chat[1].is_error, true);
    const responses = portableHistory('openai-chat', 'openai-responses', source) as Array<Record<string, unknown>>;
    assert.equal(responses[1].status, 'failed');
    const anthropic = portableHistory('openai-chat', 'anthropic', source) as Array<Record<string, unknown>>;
    const result = (anthropic[1].content as Array<Record<string, unknown>>)[0];
    assert.equal(result.is_error, true);
    assert.equal(result.content, 'ENOENT: no such file');
});

test('dangling, duplicate, mismatched, and unsupported history is rejected', () => {
    assert.throws(() => portableHistory('openai-chat', 'anthropic', [
        { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    ]), /no result/);
    assert.throws(() => portableHistory('openai-chat', 'anthropic', [
        { role: 'tool', tool_call_id: 'unknown', content: 'not allowed' },
    ]), /unknown call/);
    assert.throws(() => portableHistory('openai-chat', 'anthropic', [
        { role: 'assistant', content: null, tool_calls: [
            { id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } },
            { id: 'call', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        ] },
    ]), /duplicate tool call/);
    assert.throws(() => portableHistory('anthropic', 'openai-chat', [
        { role: 'assistant', content: [{ type: 'image', source: { type: 'base64' } }] },
    ]), /unsupported Anthropic block image/);
});
