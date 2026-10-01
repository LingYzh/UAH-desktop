import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { RuntimeStore } from '../../src/runtime/store';
import { Supervisor } from '../../src/runtime/supervisor';
import type { TranscriptEvent, UsageRecord } from '../../src/shared/harness-contracts';

test('journal UI uses the same highest usage revision as offline statistics and rejects contradictory revisions', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'uah-journal-usage-view-'));
    const store = new RuntimeStore(directory);
    const effective = { runtimeId: 'api', modelId: 'fixture', agentId: 'default', policyVersion: 1 };
    const timestamp = new Date().toISOString();
    const identity = { sessionId: 'session', runId: 'run', rootRunId: 'run', parentRunId: null, turnId: 'turn' };
    const usage = (revision: number, inputTokens: number): UsageRecord => ({ schemaVersion: 1, requestId: 'request', attemptId: 'attempt', revision,
        purpose: 'agent', scope: { kind: 'session', sessionId: 'session', runId: 'run' }, protocol: 'openai-chat', adapterVersion: 'fixture',
        source: 'provider', completeness: 'complete', rawUsage: null, counters: { inputTokens, outputTokens: 1, totalTokens: inputTokens + 1, cachedInputTokens: 0, cacheCreationInputTokens: 0 },
        providerResponseId: null, accountNamespace: 'fixture', reportedCost: null, estimatedCost: null });
    const event = (sessionSeq: number, revision: number, tokens: number): TranscriptEvent => ({ schemaVersion: 1, eventId: randomUUID(), sessionSeq,
        timestamp, processEpochId: 'fixture', run: identity, type: 'usage.snapshot', payload: { usage: usage(revision, tokens) } });
    store.commit({ sessions: [{ id: 'session', title: 'fixture', directory: null, requested: effective, createdAt: timestamp }],
        runs: [{ id: 'run', sessionId: 'session', turnId: 'turn', state: 'completed', input: '', output: '', sequence: 1, effective, createdAt: timestamp }],
        journal: [event(1, 3, 20), { ...event(2, 3, 20), type: 'response.terminal', payload: { requestId: 'request', attemptId: 'attempt', status: 'completed', partial: false } }, event(3, 1, 2), event(4, 2, 12)] });
    store.close();
    const supervisor = new Supervisor({ dataDirectory: directory, onEvent: () => {} });
    try {
        const summary = supervisor.journalView({ action: 'summary', sessionId: 'session' });
        assert.ok(summary.requests); assert.equal(summary.requests.length, 1);
        assert.equal(summary.requests[0].inputTokens, 20); assert.equal(summary.requests[0].status, 'completed');
        const update = new RuntimeStore(directory);
        try { update.commit({ journal: [event(5, 3, 21)] }); } finally { update.close(); }
        assert.throws(() => supervisor.journalView({ action: 'summary', sessionId: 'session' }), /Conflicting usage revision/);
    } finally {
        await supervisor.shutdown();
        const target = resolve(directory); assert.equal(dirname(target), resolve(tmpdir())); assert.ok(basename(target).startsWith('uah-journal-usage-view-'));
        rmSync(target, { recursive: true, force: true });
    }
});
