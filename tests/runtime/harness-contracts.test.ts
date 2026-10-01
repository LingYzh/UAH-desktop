import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
    HARNESS_SCHEMA_VERSION,
    projectLegacyRunState,
    projectLegacyToolResult,
    toolCallKey,
    type ArtifactReference,
    type HarnessRunState,
    type InvocationIdentity,
    type ToolOutcome,
    type TranscriptEvent,
    type UsageRecord,
} from '../../src/shared/harness-contracts';
import type { RunState } from '../../src/shared/contracts';

interface HarnessFixture {
    schemaVersion: 1;
    description: string;
    artifactCases: ArtifactReference[];
    toolCases: Array<{
        id: string;
        identity: InvocationIdentity;
        runState: HarnessRunState;
        expectedLegacyRunState: RunState;
        outcome: ToolOutcome;
        expectedLegacyToolResult: { id: string; content: string; isError: boolean };
    }>;
    eventOrdering: {
        events: TranscriptEvent[];
        legacyRunSequences: Array<{ runId: string; sequence: number }>;
        expectedSessionSeq: number[];
    };
    usageCases: Array<{
        id: string;
        snapshots: UsageRecord[];
        expected: {
            effectiveCounters: UsageRecord['counters'];
            uniqueAttemptCount: number;
            acceptedRevisions: number[];
            duplicateSnapshotIndexes: number[];
            knownInputTokensSubtotal: number;
            unknownCounterFields: string[];
        };
    }>;
    unknownUsageCase: {
        snapshot: UsageRecord;
        expected: { unknownAttemptCount: number; knownInputTokensSubtotal: null; unknownCounterFields: string[] };
    };
    connectionTestCase: {
        snapshot: UsageRecord;
        expected: {
            applicationKnownInputTokensSubtotal: number;
            sessionKnownInputTokensSubtotal: null;
            sessionAttemptCount: number;
        };
    };
}

// Local test typing plus the targeted assertions below, not a production import validator.
const source = readFileSync(new URL('../fixtures/harness-v1.json', import.meta.url), 'utf8');
const fixture = JSON.parse(source) as HarnessFixture;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test('all v1 run states have the frozen legacy display projection', () => {
    const mappings = {
        waiting_model: 'running',
        waiting_approval: 'approval',
        waiting_resource: 'running',
        running_tools: 'running',
        stopping: 'stopping',
        suspended_budget: 'failed',
        recording_failed: 'failed',
        needs_reconciliation: 'failed',
        completed: 'completed',
        failed: 'failed',
        cancelled: 'stopped',
    } satisfies Record<HarnessRunState, RunState>;
    for (const [state, expected] of Object.entries(mappings)) {
        assert.equal(projectLegacyRunState(state as HarnessRunState), expected);
    }
});

test('confirmed write and cancelled unknown effect retain machine states across legacy projection', () => {
    assert.deepEqual(fixture.toolCases.map(sample => sample.id), [
        'written-recording-failed', 'cancelled-effect-unknown',
    ]);
    const [written, cancelled] = fixture.toolCases;
    assert.equal(written.outcome.status, 'succeeded');
    assert.equal(written.outcome.effectState, 'confirmed');
    assert.equal(written.outcome.recordingState, 'failed');
    assert.equal(written.outcome.resources[0].afterHash, 'b'.repeat(64));
    assert.equal(cancelled.outcome.status, 'cancelled');
    assert.equal(cancelled.outcome.effectState, 'possible');
    assert.equal(cancelled.outcome.resources[0].afterHash, null);
    assert.equal(cancelled.outcome.exitCode, null);
    assert.equal(cancelled.outcome.time.durationMs, null);
    for (const sample of fixture.toolCases) {
        const before = clone(sample);
        assert.equal(sample.outcome.retryClass, 'reconcile_first');
        assert.deepEqual(projectLegacyToolResult(sample.identity.toolCallId, sample.outcome), sample.expectedLegacyToolResult);
        assert.equal(projectLegacyRunState(sample.runState), sample.expectedLegacyRunState);
        assert.deepEqual(sample, before, 'display mapping must not rewrite durable evidence');
    }
});

test('legacy tool success requires succeeded status and durable recording', () => {
    const statuses = ['succeeded', 'failed', 'denied', 'cancelled', 'running'] as const;
    const recordingStates = ['durable', 'pending', 'failed'] as const;
    for (const status of statuses) {
        for (const recordingState of recordingStates) {
            const outcome: ToolOutcome = { ...fixture.toolCases[0].outcome, status, recordingState };
            assert.deepEqual(projectLegacyToolResult('legacy-call', outcome), {
                id: 'legacy-call',
                content: outcome.preview,
                isError: status !== 'succeeded' || recordingState !== 'durable',
            });
        }
    }
});

test('tool call identities are attempt scoped and resist separator collisions', () => {
    const [first, second] = fixture.toolCases.map(sample => sample.identity);
    assert.equal(first.requestId, second.requestId);
    assert.equal(first.toolCallId, second.toolCallId);
    assert.notEqual(first.attemptId, second.attemptId);
    assert.notEqual(first.invocationId, second.invocationId);
    assert.notEqual(toolCallKey(first.attemptId, first.toolCallId), toolCallKey(second.attemptId, second.toolCallId));
    assert.equal(toolCallKey(first.attemptId, first.toolCallId), JSON.stringify([first.attemptId, first.toolCallId]));
    assert.notEqual(toolCallKey('a:b', 'c'), toolCallKey('a', 'b:c'));
    assert.notEqual(toolCallKey('a\",\"b', 'c'), toolCallKey('a', 'b\",\"c'));
    assert.deepEqual(JSON.parse(toolCallKey('attempt\\\"\n', 'call:[]')), ['attempt\\\"\n', 'call:[]']);
});

test('root and child events share one session order independent of legacy per-run sequence', () => {
    const { events, legacyRunSequences, expectedSessionSeq } = fixture.eventOrdering;
    assert.deepEqual(events.map(event => event.sessionSeq), expectedSessionSeq);
    assert.deepEqual(expectedSessionSeq, [1, 2, 3, 4]);
    assert.deepEqual(legacyRunSequences.map(entry => entry.sequence), [1, 1, 2, 2]);
    assert.equal(new Set(events.map(event => event.eventId)).size, 4);
    for (const [index, event] of events.entries()) {
        assert.equal(event.schemaVersion, HARNESS_SCHEMA_VERSION);
        assert.equal(event.run.sessionId, 'session-golden-1');
        assert.equal(event.run.rootRunId, 'run-root');
        assert.equal(event.run.runId, legacyRunSequences[index].runId);
        assert.equal(Object.hasOwn(event, 'sequence'), false);
        assert.equal(Object.hasOwn(event.run, 'sequence'), false);
        assert.equal(event.run.parentRunId, event.run.runId === 'run-child' ? 'run-root' : null);
    }
});

test('D04 usage acceptance vectors preserve cumulative snapshots and an identical repeated final', () => {
    // These assertions check vector integrity. No ledger/reducer is implemented or exercised here.
    assert.deepEqual(fixture.usageCases.map(sample => sample.snapshots[0].protocol), [
        'openai-chat', 'openai-responses', 'anthropic',
    ]);
    for (const { snapshots, expected } of fixture.usageCases) {
        assert.deepEqual(snapshots.map(record => record.counters.inputTokens), [2, 10, 15, 15]);
        assert.deepEqual(snapshots.map(record => record.revision), [1, 2, 3, 3]);
        assert.deepEqual(snapshots[3], snapshots[2]);
        assert.equal(new Set(snapshots.map(record => record.attemptId)).size, 1);
        assert.equal(new Set(snapshots.map(record => record.requestId)).size, 1);
        assert.deepEqual(expected.effectiveCounters, snapshots[2].counters);
        assert.equal(expected.knownInputTokensSubtotal, 15);
        assert.equal(expected.uniqueAttemptCount, 1);
        assert.deepEqual(expected.acceptedRevisions, [1, 2, 3]);
        assert.deepEqual(expected.duplicateSnapshotIndexes, [3]);
        for (const record of snapshots) {
            assert.equal(record.schemaVersion, HARNESS_SCHEMA_VERSION);
            assert.equal(record.source, 'provider');
            assert.equal(record.completeness, 'partial');
            assert.deepEqual(record.rawUsage, record.protocol === 'openai-chat'
                ? { prompt_tokens: record.counters.inputTokens }
                : { input_tokens: record.counters.inputTokens });
            assert.equal(record.purpose, 'agent');
            assert.deepEqual(record.scope, { kind: 'session', sessionId: 'session-golden-1', runId: 'run-root' });
            for (const field of expected.unknownCounterFields) {
                assert.equal(record.counters[field as keyof UsageRecord['counters']], null);
            }
        }
    }
});

test('unknown usage and costs stay null, with connection tests scoped to the application', () => {
    const { snapshot: unknown, expected } = fixture.unknownUsageCase;
    assert.equal(unknown.source, 'unavailable');
    assert.equal(unknown.completeness, 'unknown');
    assert.equal(unknown.rawUsage, null);
    assert.equal(unknown.providerResponseId, null);
    assert.equal(unknown.reportedCost, null);
    assert.equal(unknown.estimatedCost, null);
    assert.deepEqual(Object.values(unknown.counters), [null, null, null, null, null]);
    assert.deepEqual(expected.unknownCounterFields, Object.keys(unknown.counters));
    assert.equal(expected.knownInputTokensSubtotal, null);
    assert.equal(expected.unknownAttemptCount, 1);
    const connection = fixture.connectionTestCase;
    assert.equal(connection.snapshot.purpose, 'connection_test');
    assert.deepEqual(connection.snapshot.scope, { kind: 'application' });
    assert.equal(Object.hasOwn(connection.snapshot.scope, 'sessionId'), false);
    assert.equal(Object.hasOwn(connection.snapshot.scope, 'runId'), false);
    assert.equal(connection.expected.applicationKnownInputTokensSubtotal, 3);
    assert.equal(connection.expected.sessionKnownInputTokensSubtotal, null);
    assert.equal(connection.expected.sessionAttemptCount, 0);
});

test('external and missing artifacts preserve unknown bytes without inventing local evidence', () => {
    const [external, missing] = fixture.artifactCases;
    assert.equal(external.availability, 'external_reference_only');
    assert.equal(external.relativePath, null);
    assert.equal(external.sha256, null);
    assert.equal(external.byteLength, null);
    if (external.availability !== 'external_reference_only') assert.fail('external reference sample required');
    assert.equal(external.externalReference, 'provider-file:synthetic-file-1');
    assert.equal(missing.availability, 'missing');
    assert.equal(missing.sha256, null);
    assert.equal(missing.byteLength, null);
    assert.ok(missing.missingReason);
    assert.deepEqual(clone(fixture.artifactCases), fixture.artifactCases);
});

test('golden JSON roundtrip preserves IDs, event order, null unknowns and raw provider usage', () => {
    assert.equal(fixture.schemaVersion, HARNESS_SCHEMA_VERSION);
    assert.match(fixture.description, /D04 acceptance vectors/);
    assert.deepEqual(clone(fixture), fixture);
    // IDs and null fields must be retained explicitly in portable JSON, not dropped as undefined.
    for (const sample of fixture.toolCases) {
        assert.deepEqual(Object.keys(sample.identity).sort(), [
            'sessionId', 'runId', 'parentRunId', 'rootRunId', 'turnId', 'stepId',
            'requestId', 'attemptId', 'toolCallId', 'invocationId',
        ].sort());
        assert.equal(sample.outcome.schemaVersion, HARNESS_SCHEMA_VERSION);
    }
    assert.equal(clone(fixture.unknownUsageCase.snapshot).counters.totalTokens, null);
});
