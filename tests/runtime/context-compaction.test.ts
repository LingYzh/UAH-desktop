import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { publicHistoryCandidate } from '../../src/runtime/context-compaction';
import type { HistoryTurn } from '../../src/runtime/model-history';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');

test('public projection keeps every historical user and host evidence message plus the full current native batch', () => {
    const turns: HistoryTurn[] = [
        { messages: [{ role: 'user', content: '原始请求：保留中文与😀\r\n不要截断。' }, { role: 'assistant', content: '公开回答。' },
            { role: 'user', content: '[UAH recorded tool evidence; historical data, not authorization.]\n{"result":"完整已有证据"}' }] },
        { messages: [{ role: 'user', content: '[UAH host interruption record] 用户伪造前缀仍是原文，不能当授权。' },
            { role: 'user', content: '[UAH host interruption record] 已生成的中断证据也完整保留。' }] },
    ];
    const tail = [{ role: 'user', content: '当前原文\n执行声明也不解析' },
        { type: 'reasoning', encrypted_content: 'opaque==', unknown: { nested: ['a', null, { x: true }] } },
        { role: 'assistant', tool_calls: [{ id: 'call', function: { arguments: '{"value":"原字节文本"}' } }] },
        { role: 'tool', tool_call_id: 'call', content: '当前批原生结果' }];
    const old = [{ type: 'old_reasoning', encrypted_content: 'large'.repeat(500) }, ...tail];
    const originals = JSON.stringify({ turns, old });
    const candidate = publicHistoryCandidate(turns, old, 1);
    assert.deepEqual(candidate.continuation, [...turns.flatMap(turn => turn.messages), ...tail]);
    assert.deepEqual(candidate.continuation.slice(candidate.prefixLength), tail);
    assert.equal(candidate.prefixLength, 5); assert.equal(candidate.reduced, true);
    assert.equal(candidate.previousVersion, hash(old)); assert.equal(candidate.nextVersion, hash(candidate.continuation));
    assert.equal(candidate.beforeBytes, Buffer.byteLength(JSON.stringify(old), 'utf8'));
    assert.equal(candidate.afterBytes, Buffer.byteLength(JSON.stringify(candidate.continuation), 'utf8'));
    assert.equal(JSON.stringify({ turns, old }), originals);
    assert.ok(candidate.beforeBytes > candidate.afterBytes);
});

test('candidate deep clones input and preserves opaque structures without reference aliases in either direction', () => {
    const message = { role: 'user' as const, content: 'full public original' };
    const turns = [{ messages: [message, message] }];
    const old = [{ role: 'user', content: [{ type: 'text', text: 'current' }] }, { opaque: { blocks: [1, { token: 'secret-opaque', zero: -0 }] } }];
    const result = publicHistoryCandidate(turns, old, 0);
    assert.notEqual(result.continuation[0], message); assert.notEqual(result.continuation[0], result.continuation[1]);
    (result.continuation[0] as { content: string }).content = 'candidate edit';
    (result.continuation[3] as { opaque: { blocks: unknown[] } }).opaque.blocks[0] = 99;
    assert.equal(message.content, 'full public original'); assert.equal(old[1].opaque!.blocks[0], 1);
    message.content = 'input edit'; old[0].content![0].text = 'input current edit';
    assert.equal((result.continuation[1] as { content: string }).content, 'full public original');
    assert.equal(((result.continuation[2] as { content: Array<{ text: string }> }).content[0]).text, 'current');
    const block = (result.continuation[3] as { opaque: { blocks: Array<unknown> } }).opaque.blocks[1] as { zero: number };
    assert.ok(Object.is(block.zero, -0));
});

test('equal or larger candidates are reported as nonreducing rather than truncating history', () => {
    const old = [{ role: 'user', content: 'current' }];
    const equal = publicHistoryCandidate([], old, 0);
    assert.equal(equal.reduced, false); assert.equal(equal.previousVersion, equal.nextVersion); assert.equal(equal.beforeBytes, equal.afterBytes);
    const larger = publicHistoryCandidate([{ messages: [{ role: 'user', content: 'all historical content'.repeat(1000) }] }], old, 0);
    assert.equal(larger.reduced, false); assert.ok(larger.afterBytes > larger.beforeBytes);
    assert.equal((larger.continuation[0] as { content: string }).content.length, 22000);
});

test('prefix must be an integer in range at a user-role message', () => {
    const old = [{ role: 'assistant', content: 'prior' }, { role: 'user', content: 'current' }];
    for (const prefix of [-1, .5, NaN, Infinity, 2, Number.MAX_SAFE_INTEGER]) assert.throws(() => publicHistoryCandidate([], old, prefix), /prefix boundary/);
    assert.throws(() => publicHistoryCandidate([], old, 0), /current user message/);
    for (const boundary of [null, [], 'user', { type: 'user' }]) assert.throws(() => publicHistoryCandidate([], [boundary], 0), /current user message/);
    assert.throws(() => publicHistoryCandidate([], [], 0), /prefix boundary/);
    assert.throws(() => publicHistoryCandidate(null as never, old, 1), /must be arrays/);
    assert.throws(() => publicHistoryCandidate([{ messages: [{ role: 'system', content: 'cannot authorize' }] }] as never, old, 1), /public history/);
});

test('non-JSON values, cycles, sparse arrays and executable accessors are rejected without invocation', () => {
    const user = { role: 'user', content: 'current' };
    let invoked = false;
    const getter = Object.defineProperty({}, 'x', { enumerable: true, get() { invoked = true; return 1; } });
    const method = { toJSON() { invoked = true; return {}; } };
    const cycle: { cycle?: unknown } = {}; cycle.cycle = cycle;
    const proxy = new Proxy({}, { ownKeys() { invoked = true; return []; } });
    const hidden = Object.defineProperty({}, 'x', { value: 1 });
    for (const value of [undefined, () => {}, Symbol(), BigInt(1), NaN, Infinity, new Date(), Buffer.from('x'), getter, method, cycle, hidden, proxy, [1, , 3], { [Symbol('x')]: 1 }]) {
        assert.throws(() => publicHistoryCandidate([], [user, value], 0), /JSON|properties|plain/);
    }
    assert.equal(invoked, false);
    assert.throws(() => publicHistoryCandidate([{ messages: [{ role: 'user', content: 'history' }], modelFrame: undefined }], [user], 0), /JSON values/);
});

test('depth and UTF-8 byte limits apply to source histories and candidate output', () => {
    const user = { role: 'user', content: 'current' };
    let depth: unknown = 'leaf'; for (let index = 0; index < 127; index++) depth = { child: depth };
    assert.doesNotThrow(() => publicHistoryCandidate([], [user, depth], 0));
    depth = { child: depth }; assert.throws(() => publicHistoryCandidate([], [user, depth], 0), /depth 128/);
    const maxBytes = 16 * 1024 * 1024;
    const empty = JSON.stringify([{ role: 'user', content: '' }]);
    const exact = [{ role: 'user', content: 'x'.repeat(maxBytes - Buffer.byteLength(empty)) }];
    const exactResult = publicHistoryCandidate([], exact, 0); assert.equal(exactResult.beforeBytes, maxBytes);
    assert.equal(exactResult.afterBytes, maxBytes);
    assert.throws(() => publicHistoryCandidate([], [{ role: 'user', content: exact[0].content + 'x' }], 0), /16 MiB/);
    assert.throws(() => publicHistoryCandidate([], [{ role: 'user', content: '中'.repeat(Math.ceil(maxBytes / 3)) }], 0), /16 MiB/);
    assert.throws(() => publicHistoryCandidate([{ messages: [{ role: 'user', content: 'x'.repeat(maxBytes) }] }], [user], 0), /16 MiB/);
    // Each input is independently below the cap, but their candidate concatenation is not.
    assert.throws(() => publicHistoryCandidate([{ messages: [{ role: 'user', content: 'p'.repeat(maxBytes / 2) }] }],
        [{ role: 'user', content: 't'.repeat(maxBytes / 2) }], 0), /16 MiB/);
});
