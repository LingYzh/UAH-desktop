import test from 'node:test';
import assert from 'node:assert/strict';
import { parseCommand } from '../../src/shared/contracts';
import { parseJournalQuery } from '../../src/shared/journal-view';

test('recovery IPC requires explicit bounded input and an exact review fingerprint', () => {
    const base = { runId: 'run', fingerprint: 'a'.repeat(64) };
    assert.deepEqual(parseCommand({ type: 'resume-run', ...base, input: '继续' }), { type: 'resume-run', ...base, input: '继续' });
    assert.deepEqual(parseCommand({ type: 'reconcile-run', ...base, note: '已核对命令退出及文件版本' }), { type: 'reconcile-run', ...base, note: '已核对命令退出及文件版本' });
    for (const type of ['resume-run', 'reconcile-run']) {
        const field = type === 'resume-run' ? 'input' : 'note';
        for (const bad of ['', ' ', null, undefined, 1, 'x'.repeat(type === 'resume-run' ? 20001 : 4001)]) {
            assert.throws(() => parseCommand({ type, ...base, [field]: bad }));
        }
        for (const fingerprint of ['a'.repeat(63), 'A'.repeat(64), 'z'.repeat(64), null]) assert.throws(() => parseCommand({ type, ...base, fingerprint, [field]: 'confirmed' }));
        assert.throws(() => parseCommand({ type, ...base, [field]: 'confirmed', confirmed: true }));
    }
    assert.deepEqual(parseJournalQuery({ action: 'recovery', sessionId: 'session', runId: 'run' }), { action: 'recovery', sessionId: 'session', runId: 'run' });
    for (const runId of ['', '../other', 'run\n', null]) assert.throws(() => parseJournalQuery({ action: 'recovery', sessionId: 'session', runId }));
    assert.throws(() => parseJournalQuery({ action: 'recovery', sessionId: 'session', runId: 'run', approve: true }));
});
