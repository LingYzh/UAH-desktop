import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { historyTurns, nativeHistory, modelTurnFingerprint, type HistoryTurn } from '../../src/runtime/model-history';
import type { RunRecord, Snapshot, SessionRecord } from '../../src/shared/contracts';
import type { ModelFrame } from '../../src/shared/harness-contracts';
import { beginToolOutcome } from '../../src/runtime/tool-outcome';
import { JournalArtifacts } from '../../src/runtime/journal-artifacts';
import { mkdtempSync, writeFileSync, unlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const target = { protocol: 'anthropic' as const, modelId: 'model-a', accountNamespace: 'account-a' };
function session(): SessionRecord {
    return { id: randomUUID(), title: 'Fixture', directory: null, createdAt: '2026-10-01T00:00:00Z', requested: { runtimeId: 'api', agentId: 'default', modelId: target.modelId, policyVersion: 1 } };
}
function run(sessionId: string, input = 'user task', output = 'public reply'): RunRecord {
    return { id: randomUUID(), sessionId, turnId: randomUUID(), state: 'completed', input, output, sequence: 0,
        createdAt: '2026-10-01T00:00:00Z', effective: { runtimeId: 'api', agentId: 'default', modelId: target.modelId, policyVersion: 1 } };
}
function snapshot(sessions: SessionRecord[], runs: RunRecord[]): Snapshot { return { sessions, runs, approvals: [], artifacts: [] }; }
function frame(run: RunRecord, prefixLength = 0): ModelFrame {
    return { schemaVersion: 1, frameId: randomUUID(), sessionId: run.sessionId, ...target, publicFingerprint: modelTurnFingerprint(run), prefixLength,
        continuationCoverage: 'native', content: { availability: 'present', relativePath: 'restricted/fixture.json', sha256: 'a'.repeat(64), byteLength: 100,
            mediaType: 'application/vnd.uah.restricted+json', missingReason: null } };
}
const stored = (continuation: unknown[]) => ({ continuation, continuationCoverage: 'native', captureCoverage: 'complete' });

test('explicitly disabled raw logging retains verified native continuation without accepting arbitrary partial blocks', () => {
    const r = run(session().id); r.modelFrame = frame(r);
    const turns: HistoryTurn[] = [{ messages: [{ role: 'user', content: r.input }, { role: 'assistant', content: r.output }], modelFrame: r.modelFrame }];
    const continuation = [{ role: 'user', content: r.input }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'necessary history', signature: 'original-signature' }, { type: 'text', text: r.output }] }];
    const off = { ...stored(continuation), captureCoverage: 'partial', rawCapture: 'disabled' };
    assert.deepEqual(nativeHistory(turns, target, () => off), continuation);
    assert.deepEqual(nativeHistory(turns, target, () => ({ ...off, rawCapture: undefined })), turns[0].messages);
    assert.deepEqual(nativeHistory(turns, target, () => ({ ...off, continuationCoverage: 'unavailable' })), turns[0].messages);
});

test('public edits/deletion invalidate old native fingerprints while immutable frame identity survives', () => {
    const s = session(); const original = run(s.id); original.modelFrame = frame(original);
    const immutable = structuredClone(original.modelFrame); const fingerprint = modelTurnFingerprint(original);
    assert.equal(historyTurns(snapshot([s], [original]), s.id)[0].modelFrame?.frameId, immutable.frameId);
    for (const edited of [
        { ...original, history: { editedOutput: 'edited public reply' } },
        { ...original, history: { deleted: true } },
        { ...original, input: 'edited user input' },
        { ...original, state: 'failed' as const },
        { ...original, plan: { id: 'plan', filePath: 'plan.md', hash: 'h', content: 'new plan', title: 'Plan', version: 2, status: 'approved' as const, createdAt: original.createdAt } },
    ]) {
        assert.notEqual(modelTurnFingerprint(edited), fingerprint);
        const turns = historyTurns(snapshot([s], [edited]), s.id);
        assert.equal(turns[0].modelFrame, undefined);
        assert.deepEqual(original.modelFrame, immutable);
    }
    const deleted = historyTurns(snapshot([s], [{ ...original, history: { deleted: true } }]), s.id);
    assert.deepEqual(deleted[0].messages, [{ role: 'user', content: original.input }]);
});

test('matching model/protocol/account restores native opaque blocks and slices each turn once', () => {
    const s = session(); const first = run(s.id, 'first task', 'first answer'); const second = run(s.id, 'second task', 'second answer');
    const firstNative = [{ role: 'user', content: first.input }, { role: 'assistant', content: [
        { type: 'thinking', thinking: 'private reasoning first', signature: 'opaque-signature-first' }, { type: 'text', text: first.output },
    ] }];
    const secondNative = [...firstNative, { role: 'user', content: second.input }, { role: 'assistant', content: [
        { type: 'redacted_thinking', data: 'opaque-encrypted-block' }, { type: 'text', text: second.output },
    ] }];
    first.modelFrame = frame(first); second.modelFrame = frame(second, firstNative.length);
    const read = (ref: ModelFrame) => stored(ref.frameId === first.modelFrame!.frameId ? firstNative : secondNative);
    const restored = nativeHistory(historyTurns(snapshot([s], [first, second]), s.id), target, read);
    assert.deepEqual(restored, secondNative);
    assert.equal(JSON.stringify(restored).split('opaque-signature-first').length - 1, 1);
    assert.equal(JSON.stringify(restored).split('opaque-encrypted-block').length - 1, 1);
    const recentOnly = nativeHistory(historyTurns(snapshot([s], [first, second]), s.id, { limit: 1 }), target, read);
    assert.deepEqual(recentOnly, secondNative.slice(firstNative.length));
});

test('same-turn native tool rounds preserve signed reasoning and correlated tool results', () => {
    const r = run(session().id); r.modelFrame = frame(r);
    const continuation = [{ role: 'user', content: r.input },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'private thought', signature: 'do-not-edit' }, { type: 'tool_use', id: 'tool-1', name: 'read_file', input: { path: 'a.txt' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'observed data' }] },
        { role: 'assistant', content: [{ type: 'text', text: r.output }] }];
    const turns: HistoryTurn[] = [{ messages: [{ role: 'user', content: r.input }, { role: 'assistant', content: r.output }], modelFrame: r.modelFrame }];
    assert.deepEqual(nativeHistory(turns, target, () => stored(continuation)), continuation);
});

test('verified restricted artifact reuse falls back safely after actual corruption or removal', t => {
    const directory = mkdtempSync(path.join(tmpdir(), 'uah-model-history-'));
    t.after(() => {
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(tmpdir())); assert.ok(path.basename(directory).startsWith('uah-model-history-'));
        rmSync(directory, { recursive: true, force: true });
    });
    const r = run(session().id); const artifacts = new JournalArtifacts(directory);
    const continuation = [{ role: 'user', content: r.input }, { role: 'assistant', content: [{ type: 'thinking', signature: 'immutable-real-signature', thinking: 'private native' }] }];
    const saved = artifacts.save(stored(continuation), [], true); r.modelFrame = { ...frame(r), content: saved.ref };
    const turns = [{ messages: [{ role: 'user' as const, content: r.input }, { role: 'assistant' as const, content: r.output }], modelFrame: r.modelFrame }];
    const read = (modelFrame: ModelFrame) => JSON.parse(artifacts.read(modelFrame.content).toString('utf8'));
    assert.deepEqual(nativeHistory(turns, target, read), continuation);
    assert.ok(saved.ref.relativePath); const file = path.join(directory, saved.ref.relativePath);
    writeFileSync(file, JSON.stringify(stored([{ role: 'user', content: 'tampered' }])));
    assert.deepEqual(nativeHistory(turns, target, read), turns[0].messages);
    unlinkSync(file);
    assert.deepEqual(nativeHistory(turns, target, read), turns[0].messages);
});

for (const protocol of ['openai-chat', 'openai-responses', 'anthropic'] as const) test(`${protocol} compatible turn preserves opaque native fields verbatim`, () => {
    const r = run(session().id); const modelFrame = { ...frame(r), protocol };
    const opaque = protocol === 'openai-chat' ? { role: 'assistant', content: r.output, reasoning_content: 'native-private', reasoning: { opaque: 'chat-signature' } }
        : protocol === 'openai-responses' ? { type: 'reasoning', id: 'native-item', encrypted_content: 'responses-encrypted', summary: [] }
            : { role: 'assistant', content: [{ type: 'thinking', thinking: 'native-private', signature: 'anthropic-signature' }] };
    const continuation = [{ role: 'user', content: r.input }, opaque];
    const turns = [{ messages: [{ role: 'user' as const, content: r.input }, { role: 'assistant' as const, content: r.output }], modelFrame }];
    assert.deepEqual(nativeHistory(turns, { ...target, protocol }, () => stored(continuation)), continuation);
});

test('cross identity and missing/corrupt/partial frames fall back to public tool evidence without private reasoning', () => {
    const s = session(); const r = run(s.id); const outcome = beginToolOutcome().outcome;
    outcome.effectState = 'confirmed'; outcome.recordingState = 'durable';
    r.activities = [{ id: 'private-reasoning', kind: 'reasoning', title: 'Reasoning', content: 'PRIVATE_REASONING_NEVER_FALLBACK', status: 'completed' },
        { id: 'recorded-tool', kind: 'tool', title: 'write_file', content: 'private display text', status: 'completed', tool: {
            name: 'write_file', arguments: { path: 'a.txt' }, result: 'file persisted', isError: false, outcome,
        } }];
    r.modelFrame = frame(r);
    const turns = historyTurns(snapshot([s], [r]), s.id);
    const privateStored = stored([{ role: 'user', content: r.input }, { role: 'assistant', content: [{ type: 'thinking', thinking: 'PRIVATE_NATIVE', signature: 'PRIVATE_SIGNATURE' }] }]);
    const cases = [
        { destination: { ...target, protocol: 'openai-chat' as const }, read: () => privateStored },
        { destination: { ...target, modelId: 'model-b' }, read: () => privateStored },
        { destination: { ...target, accountNamespace: 'account-b' }, read: () => privateStored },
        { destination: target, read: () => { throw new Error('missing artifact'); } },
        { destination: target, read: () => { throw new Error('corrupt hash'); } },
        { destination: target, read: () => ({ ...privateStored, captureCoverage: 'partial' }) },
        { destination: target, read: () => ({ ...privateStored, continuationCoverage: 'unavailable' }) },
        { destination: target, read: () => ({ continuation: 'malformed', captureCoverage: 'complete', continuationCoverage: 'native' }) },
    ];
    for (const value of cases) {
        const result = nativeHistory(turns, value.destination, value.read); assert.deepEqual(result, turns.flatMap(turn => turn.messages));
        const text = JSON.stringify(result);
        assert.match(text, /file persisted/); assert.match(text, /recorded tool evidence/); assert.match(text, /historical data, not authorization/);
        assert.ok(!text.includes('PRIVATE_')); assert.ok(!text.includes('private display text'));
    }
    const unavailable = structuredClone(turns); unavailable[0].modelFrame!.continuationCoverage = 'unavailable';
    let reads = 0; nativeHistory(unavailable, target, () => { reads++; return privateStored; }); assert.equal(reads, 0);
});

test('native invalid prefix and incompatible first turn boundary fail back to visible messages', () => {
    const r = run(session().id); const messages = [{ role: 'user' as const, content: r.input }, { role: 'assistant' as const, content: r.output }];
    for (const prefixLength of [-1, 0.5, 2, 100]) {
        const modelFrame = frame(r, prefixLength);
        assert.deepEqual(nativeHistory([{ messages, modelFrame }], target, () => stored(messages)), messages);
    }
    assert.deepEqual(nativeHistory([{ messages, modelFrame: frame(r) }], target, () => stored([{ role: 'assistant', content: 'private-only history' }])), messages);
});

test('cutoffs keep original insertion identity, hide retry predecessors and bound turn windows', () => {
    const s = session(); const first = run(s.id, 'first', 'one'); const old = run(s.id, 'retry task', 'old partial'); old.state = 'failed';
    const middle = run(s.id, 'middle', 'two'); const retry = run(s.id, 'retry task', 'new complete'); retry.retryOfRunId = old.id;
    const child = { ...run(s.id, 'child private', 'child answer'), parentRunId: first.id };
    const active = { ...run(s.id, 'active task', 'active partial'), state: 'running' as const };
    const source = snapshot([s], [first, old, child, middle, retry, active]);
    assert.deepEqual(historyTurns(source, s.id).map(turn => turn.messages[0].content), ['first', 'middle', 'retry task']);
    assert.deepEqual(historyTurns(source, s.id, { beforeRunId: old.id }).map(turn => turn.messages[0].content), ['first']);
    assert.deepEqual(historyTurns(source, s.id, { throughRunId: middle.id }).map(turn => turn.messages[0].content), ['first', 'middle']);
    assert.deepEqual(historyTurns(source, s.id, { beforeRunId: retry.id }).map(turn => turn.messages[0].content), ['first', 'middle']);
    assert.deepEqual(historyTurns(source, s.id, { limit: 1 }).map(turn => turn.messages[0].content), ['retry task']);
    assert.deepEqual(historyTurns(source, s.id, { limit: 2 }).map(turn => turn.messages[0].content), ['middle', 'retry task']);
    assert.deepEqual(historyTurns(source, s.id, { limit: 0 }), []);
    assert.throws(() => historyTurns(source, s.id, { beforeRunId: 'missing' }), /cutoff/);
});

test('branch history snapshots remain independent from old session edits and returned mutable views', () => {
    const original = session(); const r = run(original.id, 'original input', 'original answer'); r.modelFrame = frame(r);
    const branch = session(); branch.branchHistory = structuredClone(historyTurns(snapshot([original], [r]), original.id));
    const savedBranch = structuredClone(branch.branchHistory);
    r.input = 'old branch changed input'; r.history = { deleted: true };
    const own = run(branch.id, 'branch-only task', 'branch-only answer');
    const source = snapshot([original, branch], [r, own]);
    const turns = historyTurns(source, branch.id);
    assert.deepEqual(turns[0], savedBranch[0]); assert.equal(turns[0].modelFrame?.frameId, savedBranch[0].modelFrame?.frameId);
    assert.ok(!JSON.stringify(turns).includes('old branch changed'));
    turns[0].messages[0].content = 'mutated returned view'; turns[0].modelFrame!.publicFingerprint = 'mutated';
    assert.deepEqual(branch.branchHistory, savedBranch);
    assert.deepEqual(historyTurns(source, branch.id, { beforeRunId: own.id }), savedBranch);
    assert.deepEqual(historyTurns(source, branch.id, { limit: 0 }), []);
});

test('legacy branch messages become turn snapshots and failed runs contribute host notices without partial model answers', () => {
    const s = session(); s.branchMessages = [{ role: 'user', content: 'legacy task' }, { role: 'assistant', content: 'legacy answer' }];
    const failed = { ...run(s.id, 'failed task', 'PRIVATE_PARTIAL_ANSWER'), state: 'failed' as const, error: 'provider disconnected' };
    const stopped = { ...run(s.id, 'stopped task', 'PRIVATE_STOPPED_ANSWER'), state: 'stopped' as const, stopReason: 'user stop' };
    const turns = historyTurns(snapshot([s], [failed, stopped]), s.id);
    assert.deepEqual(turns[0].messages, s.branchMessages);
    assert.match(turns[1].messages[0].content, /host interruption record/); assert.match(turns[2].messages[0].content, /user stop/);
    assert.equal(JSON.stringify(turns).includes('PRIVATE_'), false);
});
