import assert from 'node:assert/strict';
import test from 'node:test';
import { indexRecoverableResults, pruneArchivedResults } from '../../src/runtime/context/prune';

const text = 'original '.repeat(3000);
const hashes = ['a'.repeat(64)];
const tail = () => Array.from({ length: 6 }, (_, i) => ({ role: 'user', content: `tail ${i}` }));

test('old results prune only for their matching Chat, Responses, or Anthropic call identity', () => {
    const cases = [
        { toolCallId: 'chat-call', history: [{ role: 'tool', tool_call_id: 'chat-call', content: text }], path: ['0', 'content'] },
        { toolCallId: 'responses-call', history: [{ type: 'function_call_output', call_id: 'responses-call', output: text }], path: ['0', 'output'] },
        { toolCallId: 'anthropic-call', history: [{ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'anthropic-call', content: text }] }], path: ['0', 'content', '0', 'content'] },
    ];
    const entries = cases.map(({ toolCallId }) => ({ toolCallId, invocationId: `invocation-${toolCallId}`, result: text, hashes }));
    const index = indexRecoverableResults(entries);
    for (const [indexInCases, item] of cases.entries()) {
        const next = pruneArchivedResults([...item.history, ...tail()], index)! as any[];
        const atPath = item.path.reduce((value: any, key) => value[key], next);
        assert.ok(atPath.length < 4000);
        assert.match(atPath, /read_artifact_range/);
        const otherEntries = entries.filter((_, entryIndex) => entryIndex !== indexInCases);
        assert.equal(pruneArchivedResults([...item.history, ...tail()], indexRecoverableResults(otherEntries)), undefined);
    }
});

test('identical text from different call IDs does not authorize cross-pruning', () => {
    const history = [
        { role: 'tool', tool_call_id: 'first', content: text },
        { role: 'tool', tool_call_id: 'second', content: text },
        ...tail(),
    ];
    const index = indexRecoverableResults([{ toolCallId: 'first', invocationId: 'invocation-first', result: text, hashes }]);
    const next = pruneArchivedResults(history, index)! as any[];
    assert.ok(next[0].content.length < 4000);
    assert.equal(next[1].content, text);
});

test('a provider ID reused across protocols or requests is ambiguous even with identical evidence', () => {
    const first = { toolCallId: 'reused', invocationId: 'first-invocation', result: text, hashes };
    for (const second of [
        { toolCallId: 'reused', invocationId: 'other-protocol-call', result: text, hashes },
        { toolCallId: 'reused', invocationId: 'other-request-call', result: 'different result', hashes },
        { toolCallId: 'reused', invocationId: 'other-request-call', result: text, hashes: ['b'.repeat(64)] },
    ]) {
        const index = indexRecoverableResults([first, second]);
        assert.equal(index.size, 0);
        assert.equal(pruneArchivedResults([{ role: 'tool', tool_call_id: 'reused', content: text }, ...tail()], index), undefined);
    }
});

test('errors, mismatched text, and unindexed outputs remain intact', () => {
    const index = indexRecoverableResults([{ toolCallId: 'known', invocationId: 'successful-invocation', result: text, hashes }]);
    const history = [
        { role: 'user', content: [
            { type: 'tool_result', tool_use_id: 'known', is_error: true, content: text },
            { type: 'tool_result', tool_use_id: 'known', content: `${text} changed` },
        ] },
        ...tail(),
    ];
    assert.equal(pruneArchivedResults(history, index), undefined);
    assert.equal(pruneArchivedResults([{ role: 'tool', content: text }, ...tail()], index), undefined);
    const reusedByFailedCall = indexRecoverableResults([
        { toolCallId: 'known', invocationId: 'successful-invocation', result: text, hashes },
        { toolCallId: 'known', invocationId: 'failed-invocation', result: 'error '.repeat(4000), hashes: [] },
    ]);
    assert.equal(reusedByFailedCall.size, 0);
    assert.equal(pruneArchivedResults([{ role: 'tool', tool_call_id: 'known', content: text }, ...tail()], reusedByFailedCall), undefined);
});
