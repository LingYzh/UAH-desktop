import assert from 'node:assert/strict';
import test from 'node:test';
import { ToolProgressGovernor, type ToolProgressObservation } from '../../src/runtime/tool-progress';
import type { ToolOutcome } from '../../src/shared/harness-contracts';

function item(overrides: Partial<ToolProgressObservation> = {}, outcome: Partial<ToolOutcome> = {}): ToolProgressObservation {
    return { name: 'read_file', arguments: '{"path":"missing"}', content: 'File is missing.',
        outcome: { schemaVersion: 1, status: 'failed', effectState: 'not_started', recordingState: 'durable',
            retryClass: 'safe', idempotencyKey: null, errorCode: 'NOT_FOUND', exitCode: null, preview: '',
            artifactRefs: [], truncation: { truncated: false, reason: null }, resources: [],
            time: { processEpochId: 'epoch', startedAt: 'now', finishedAt: 'later', durationMs: 1 }, ...outcome }, ...overrides };
}
const hash = (value: ToolProgressObservation) => new ToolProgressGovernor().observe([value]).lastFailureFingerprint;

test('three identical failed batches stop for no progress; order and full content contribute', () => {
    const governor = new ToolProgressGovernor();
    assert.equal(governor.observe([item()]).repeatedFailureBatches, 1);
    assert.equal(governor.observe([item()]).stopCode, null);
    const third = governor.observe([item()]);
    assert.equal(third.stopCode, 'no_progress'); assert.equal(third.failedBatches, 3);
    assert.match(third.lastFailureFingerprint!, /^[a-f0-9]{64}$/);
    const a = item(); const b = item({ name: 'other', content: 'other failure' });
    const first = new ToolProgressGovernor().observe([a, b]);
    const reverse = new ToolProgressGovernor().observe([b, a]);
    assert.notEqual(first.lastFailureFingerprint, reverse.lastFailureFingerprint);
    assert.notEqual(hash(item({ content: 'x'.repeat(100000) + 'a' })), hash(item({ content: 'x'.repeat(100000) + 'b' })));
});

test('recursive JSON key order and resource order are stable while clocks and execution IDs are excluded', () => {
    const a = item({ arguments: '{"z":1,"nested":{"b":2,"a":[{"y":2,"x":1}]}}' }, {
        resources: [{ uri: 'b', beforeHash: null, afterHash: 'b' }, { uri: 'a', beforeHash: 'a', afterHash: null }],
        executionEvidence: { executionId: 'one', treeExited: true, outputDrained: true, terminationReason: null, stdoutBytes: 0, stderrBytes: 0 },
    });
    const b = structuredClone(a); b.arguments = '{"nested":{"a":[{"x":1,"y":2}],"b":2},"z":1}';
    b.outcome.resources.reverse(); b.outcome.time = { processEpochId: 'another', startedAt: 'changed', finishedAt: null, durationMs: 99 };
    b.outcome.executionEvidence!.executionId = 'two'; b.outcome.idempotencyKey = 'random-invocation';
    assert.equal(hash(a), hash(b));
    assert.equal(hash(item({ arguments: '{"__proto__":{"b":2,"a":1},"x":1}' })),
        hash(item({ arguments: '{"x":1,"__proto__":{"a":1,"b":2}}' })));
});

test('changed arguments, resources, artifacts, errors, exit codes, names and content reset the repetition streak', () => {
    const changes = [item({ arguments: '{"path":"new"}' }), item({ name: 'write_file' }), item({ content: 'new evidence' }),
        item({}, { resources: [{ uri: 'missing', beforeHash: 'different', afterHash: null, hashKind: 'raw_bytes' }] }),
        item({}, { artifactRefs: [{ mediaType: 'application/octet-stream', availability: 'present', relativePath: 'artifacts/new.bin', sha256: 'a'.repeat(64), byteLength: 1, missingReason: null }] }),
        item({}, { errorCode: 'PERMISSION_DENIED' }), item({}, { exitCode: 1 }), item({}, { status: 'denied' })];
    for (const changed of changes) {
        const governor = new ToolProgressGovernor(); governor.observe([item()]); governor.observe([item()]);
        const next = governor.observe([changed]); assert.equal(next.repeatedFailureBatches, 1); assert.equal(next.stopCode, null);
        assert.notEqual(next.lastFailureFingerprint, hash(item()));
    }
});

test('success, cancellation, running and possible/confirmed/reconciled effects clear streaks without refunds', () => {
    const interruptions = [item({}, { status: 'succeeded' }), item({}, { status: 'cancelled' }), item({}, { status: 'running' }),
        item({}, { effectState: 'possible' }), item({}, { effectState: 'confirmed' }), item({}, { effectState: 'reconciled' })];
    for (const interruption of interruptions) {
        const governor = new ToolProgressGovernor(); governor.observe([item()]); governor.observe([item()]);
        const state = governor.observe([interruption]); assert.equal(state.repeatedFailureBatches, 0); assert.equal(state.lastFailureFingerprint, null);
        assert.equal(state.failedBatches, interruption.outcome.status === 'failed' ? 3 : 2);
        assert.equal(governor.observe([item()]).repeatedFailureBatches, 1);
    }
    const mixed = new ToolProgressGovernor(); mixed.observe([item()]);
    const state = mixed.observe([item(), item({}, { status: 'cancelled' }), item({}, { status: 'succeeded' })]);
    assert.equal(state.failedBatches, 2); assert.equal(state.repeatedFailureBatches, 0);
});

test('failure accounting counts each batch once and stops after six cumulative corrections', () => {
    const governor = new ToolProgressGovernor();
    for (let n = 1; n <= 6; n++) {
        const state = governor.observe([item({ content: String(n) }), item({ content: String(n) })]);
        assert.equal(state.failedBatches, n); assert.equal(state.stopCode, n === 6 ? 'model_corrections' : null);
        governor.observe([item({}, { status: 'succeeded' })]);
    }
    assert.equal(governor.snapshot().stopCode, 'model_corrections');
});

test('no progress takes priority at six failures and steer reset preserves cumulative count', () => {
    const governor = new ToolProgressGovernor();
    for (let n = 0; n < 3; n++) governor.observe([item({ content: String(n) })]);
    for (let n = 0; n < 3; n++) governor.observe([item({ content: 'same' })]);
    assert.equal(governor.snapshot().stopCode, 'no_progress');
    governor.resetStreak(); assert.deepEqual(governor.snapshot(), { failedBatches: 6, repeatedFailureBatches: 0, lastFailureFingerprint: null, stopCode: 'model_corrections' });
    const earlier = new ToolProgressGovernor(); earlier.observe([item()]); earlier.observe([item()]); earlier.resetStreak();
    assert.equal(earlier.observe([item()]).repeatedFailureBatches, 1); assert.equal(earlier.snapshot().failedBatches, 3);
});

test('snapshots cannot mutate accounting, empty batches are rejected without mutation', () => {
    const governor = new ToolProgressGovernor(); const state = governor.observe([item()]);
    state.failedBatches = 999; state.lastFailureFingerprint = 'tampered'; state.repeatedFailureBatches = 99; state.stopCode = 'no_progress';
    assert.equal(governor.snapshot().failedBatches, 1); assert.equal(governor.observe([item()]).repeatedFailureBatches, 2);
    const before = governor.snapshot(); assert.throws(() => governor.observe([]), TypeError); assert.deepEqual(governor.snapshot(), before);
});

test('large, deep and invalid parameters safely use deterministic complete raw fallback', () => {
    const deep = '['.repeat(10000) + '0' + ']'.repeat(10000);
    const governor = new ToolProgressGovernor();
    for (let n = 0; n < 3; n++) governor.observe([item({ arguments: deep })]);
    assert.equal(governor.snapshot().stopCode, 'no_progress');
    assert.notEqual(hash(item({ arguments: deep })), hash(item({ arguments: deep.replace('0', '1') })));
    assert.notEqual(hash(item({ arguments: 'invalid JSON ' })), hash(item({ arguments: 'invalid JSON' })));
    assert.equal(hash(item({ arguments: '{"text":"' + 'x'.repeat(1024 * 1024) + '"}' })), hash(item({ arguments: '{ "text": "' + 'x'.repeat(1024 * 1024) + '" }' })));
});
