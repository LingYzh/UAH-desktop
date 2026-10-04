import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { assessCompiledRequest, createUsageAnchor } from '../../src/runtime/context/meter';
import { compactablePrefix } from '../../src/runtime/context/compaction';
import { ContextEngine, contextRoute } from '../../src/runtime/context/engine';
import { RuntimeStore } from '../../src/runtime/store';
import { RunJournal } from '../../src/runtime/run-journal';
import type { RunRecord, SessionRecord } from '../../src/shared/contracts';
import type { ApiConnection } from '../../src/shared/endpoints';

const timestamp = '2026-10-05T00:00:00.000Z';
const effective = { runtimeId: 'api', modelId: 'model-a', agentId: 'context-scaling', policyVersion: 1 };

function removeFixture(root: string, prefix: string): void {
    const target = resolve(root);
    assert.equal(dirname(target), resolve(tmpdir()));
    assert.ok(basename(target).startsWith(prefix));
    rmSync(target, { recursive: true, force: true });
    assert.equal(readdirSync(dirname(target)).some(name => name === basename(target)), false);
}

function fixtureRecords(): { session: SessionRecord; run: RunRecord } {
    const session: SessionRecord = { id: 'context-scaling-session', title: 'Context scaling fixture', directory: null,
        requested: effective, createdAt: timestamp };
    const run: RunRecord = { id: 'context-scaling-run', sessionId: session.id, turnId: 'context-scaling-turn', state: 'completed',
        input: 'Exercise context persistence.', output: 'Fixture complete.', effective, sequence: 1, createdAt: timestamp };
    return { session, run };
}

function readJsonArtifacts(root: string, sessionId: string): string[] {
    const sessionFolder = join(root, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
    const files = (directory: string): string[] => {
        const found: string[] = [];
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const path = join(directory, entry.name);
            if (entry.isDirectory()) found.push(...files(path));
            else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'manifest.json') found.push(path);
        }
        return found;
    };
    return files(sessionFolder);
}

test('provider usage anchors calibrate only for the same route header and unchanged history prefix', () => {
    const original = {
        model: 'model-a',
        instructions: 'stable system instructions',
        tools: [{ type: 'function', name: 'read_file' }],
        input: [{ role: 'user', content: 'first request' }, { role: 'assistant', content: 'first answer' }],
    };
    const serialized = JSON.stringify(original);
    const baseline = assessCompiledRequest(serialized);
    const reportedInputTokens = Math.round(baseline.inputEstimatedTokens * 1.2);
    const anchor = createUsageAnchor(serialized, reportedInputTokens);
    assert.ok(anchor, 'a plausible provider usage value should create an anchor');

    const appended = JSON.stringify({ ...original, input: [...original.input, { role: 'user', content: 'appended request' }] });
    const calibrated = assessCompiledRequest(appended, undefined, undefined, anchor);
    assert.equal(calibrated.estimator, 'provider-anchor-delta-v1');
    assert.equal(calibrated.estimateConfidence, 'calibrated');
    assert.ok(calibrated.inputEstimatedTokens > Math.ceil(anchor.inputTokens * 1.05));

    const changedRoute = JSON.stringify({ ...original, model: 'model-b' });
    const changedHeader = JSON.stringify({ ...original, instructions: 'changed system instructions' });
    const changedPrefix = JSON.stringify({ ...original, input: [{ role: 'user', content: 'edited first request' }, ...original.input.slice(1)] });
    for (const changed of [changedRoute, changedHeader, changedPrefix]) {
        const assessment = assessCompiledRequest(changed, undefined, undefined, anchor);
        assert.equal(assessment.estimator, 'compiled-json-heuristic-v1');
        assert.equal(assessment.estimateConfidence, 'low');
    }
});

test('provider anchors reject invalid counts but do not mistake JSON density for provider token price', () => {
    const serialized = JSON.stringify({ model: 'model-a', input: [{ role: 'user', content: 'small fixture' }] });
    const estimated = assessCompiledRequest(serialized).inputEstimatedTokens;
    for (const reported of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
        assert.equal(createUsageAnchor(serialized, reported), undefined, `unexpectedly accepted ${reported} input tokens`);
    }
    assert.ok(createUsageAnchor(serialized, Math.round(estimated * 1.1)));
    const largeEnvelope = JSON.stringify({ model: 'model-a', input: [{ type: 'reasoning', encrypted_content: 'opaque'.repeat(10000) }] });
    const reported = 4000;
    const anchor = createUsageAnchor(largeEnvelope, reported)!;
    assert.ok(anchor);
    assert.equal(assessCompiledRequest(largeEnvelope, 32000, undefined, anchor).inputEstimatedTokens, 4200);
});

test('custom compaction budget can select a large plain-text prefix while retaining a whole tool batch', () => {
    const history: unknown[] = [];
    for (let index = 0; index < 64; index++) {
        history.push({ role: 'user', content: `historical request ${index}: ${'u'.repeat(5_000)}` });
        history.push({ role: 'assistant', content: `historical response ${index}: ${'a'.repeat(5_000)}` });
    }
    const tail = [
        { role: 'assistant', content: null, tool_calls: [
            { id: 'tail-call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } },
            { id: 'tail-call-b', type: 'function', function: { name: 'read_file', arguments: '{"path":"b.txt"}' } },
        ] },
        { role: 'tool', tool_call_id: 'tail-call-a', content: 'A result' },
        { role: 'tool', tool_call_id: 'tail-call-b', content: 'B result' },
    ];
    history.push(...tail);
    assert.ok(Buffer.byteLength(JSON.stringify(history)) > 500_000, 'fixture history should exceed 500 KB');
    const tailTokens = tail.reduce((tokens, item) => tokens + Math.ceil(Buffer.byteLength(JSON.stringify(item)) / 3), 0);
    const retainTokens = tailTokens + 1;
    const defaultBoundary = compactablePrefix(history, 64_000, retainTokens);
    const customBoundary = compactablePrefix(history, 400_000, retainTokens);
    const prefixBytes = (boundary: number) => history.slice(0, boundary).reduce<number>((total, item) =>
        total + Buffer.byteLength(JSON.stringify(item)), 0);

    assert.ok(customBoundary > defaultBoundary, 'a larger byte budget should select a longer prefix');
    assert.ok(prefixBytes(customBoundary) > 64_000, 'custom budget should permit more than 64 KB of plain text');
    assert.ok(prefixBytes(customBoundary) <= 400_000);
    assert.ok(customBoundary <= history.length - tail.length, 'prefix must end before the protected tool batch');
    assert.deepEqual(history.slice(-tail.length), tail, 'the protected tail must retain the entire parallel tool batch');
});

test('context persistence and restoration keep hundreds of appended items linear across restart', t => {
    const root = join(tmpdir(), `uah-context-scaling-${process.pid}-${Date.now()}`);
    const { session, run } = fixtureRecords();
    const runs = new Map([[run.id, run]]);
    let store: RuntimeStore | undefined;
    let journal: RunJournal | undefined;
    try {
        store = new RuntimeStore(root);
        store.commit({ sessions: [session], runs: [run] });
        journal = new RunJournal(store, root, id => runs.get(id), () => {});
        let engine = new ContextEngine(store, journal, run, 'openai-responses', 'route-scaling', 'source-scaling');
        const history: unknown[] = [];
        const batchTimes: Array<{ through: number; persistMs: number; artifactFiles: number }> = [];
        let batchStarted = performance.now();

        for (let index = 1; index <= 240; index++) {
            history.push({ role: 'assistant', content: `unique context item ${index}` });
            engine.persist(history, { sourceFingerprint: 'source-scaling', reason: 'append' });

            if (index === 80 || index === 160 || index === 240) {
                const surface = store.readContextSurface(session.id, 'primary');
                assert.ok(surface);
                assert.equal(surface.entryIds.length, index, `active context entry count at ${index}`);
                assert.equal(new Set(surface.entryIds).size, index, `entry IDs at ${index} must be unique`);
                const artifactFiles = readJsonArtifacts(root, session.id);
                assert.equal(artifactFiles.length, index * 2,
                    `one item artifact and one surface snapshot per persist at ${index}; files: ${artifactFiles.map(path => path.slice(path.lastIndexOf('\\') + 1)).join(', ')}`);
                batchTimes.push({ through: index, persistMs: performance.now() - batchStarted, artifactFiles: artifactFiles.length });
                batchStarted = performance.now();
            }

            if (index === 160) {
                journal.close();
                store.close();
                store = new RuntimeStore(root);
                journal = new RunJournal(store, root, id => runs.get(id), () => {});
                const restoreStarted = performance.now();
                engine = new ContextEngine(store, journal, run, 'openai-responses', 'route-scaling', 'source-scaling');
                const restoreMs = performance.now() - restoreStarted;
                assert.equal(engine.restored, true);
                assert.equal(engine.restoreReason, 'restored');
                assert.deepEqual(engine.history, history, 'restart must restore each persisted item exactly once');
                t.diagnostic(`context scaling benchmark ${JSON.stringify({ restoredItems: history.length, restoreMs: Number(restoreMs.toFixed(2)) })}`);
            }
        }

        const restoredHistory = engine.history;
        assert.deepEqual(restoredHistory, history);
        const texts = restoredHistory.map(item => (item as { content: string }).content);
        assert.equal(texts.length, 240);
        assert.equal(new Set(texts).size, 240, 'continued history must have no duplicate items');
        const surface = store.readContextSurface(session.id, 'primary');
        assert.ok(surface);
        assert.equal(surface.entryIds.length, 240);
        assert.equal(readJsonArtifacts(root, session.id).length, 480);
        t.diagnostic(`context scaling benchmark ${JSON.stringify(batchTimes.map(sample => ({ ...sample,
            persistMs: Number(sample.persistMs.toFixed(2)) })) )}`);
    } finally {
        journal?.close();
        store?.close();
        removeFixture(root, 'uah-context-scaling-');
    }
});

test('a changed provider route keeps portable history but disqualifies its provider usage anchor', t => {
    const root = join(tmpdir(), `uah-context-route-anchor-${process.pid}-${Date.now()}`);
    const { session, run } = fixtureRecords();
    const connection: ApiConnection = { id: 'fixture-endpoint', name: 'Fixture', protocol: 'openai-responses',
        baseUrl: 'https://api.example.invalid/v1', models: ['model-a', 'model-b'], enabled: true, revision: 1, apiKey: 'fixture-key' };
    const history = [{ role: 'user', content: 'portable request' },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'portable answer' }] }];
    const serialized = JSON.stringify({ model: 'model-a', input: history });
    const estimated = assessCompiledRequest(serialized).inputEstimatedTokens;
    const anchor = createUsageAnchor(serialized, Math.round(estimated * 1.1));
    assert.ok(anchor);
    const storedAnchor = JSON.parse(JSON.stringify(anchor)) as Record<string, string | number>;
    const runs = new Map([[run.id, run]]);
    const store = new RuntimeStore(root);
    let journal = new RunJournal(store, root, id => runs.get(id), () => {});
    try {
        store.commit({ sessions: [session], runs: [run] });
        const originalRoute = contextRoute(connection, 'model-a');
        new ContextEngine(store, journal, run, 'openai-responses', originalRoute, 'source-scaling').persist(history, {
            sourceFingerprint: 'source-scaling', reason: 'initial', metadata: { usageAnchor: storedAnchor },
        });

        journal.close();
        store.close();
        const restartedStore = new RuntimeStore(root);
        journal = new RunJournal(restartedStore, root, id => runs.get(id), () => {});
        try {
            const changedRoute = contextRoute(connection, 'model-b');
            const portable = new ContextEngine(restartedStore, journal, run, 'openai-responses', changedRoute, 'source-scaling');
            assert.equal(portable.restored, true);
            assert.equal(portable.restoreReason, 'portable_replay');
            assert.match(JSON.stringify(portable.history), /portable request|portable answer/);
            const reusableAnchor = (contextEngine: ContextEngine) => contextEngine.restoreReason === 'restored'
                ? (contextEngine.state?.metadata as { usageAnchor?: unknown } | undefined)?.usageAnchor
                : undefined;
            assert.equal(reusableAnchor(portable), undefined, 'usage calibration must be discarded when the provider route changes');
            const sameRoute = new ContextEngine(restartedStore, journal, run, 'openai-responses', originalRoute, 'source-scaling');
            const sameRouteAnchor = reusableAnchor(sameRoute);
            assert.notEqual(sameRouteAnchor, undefined, 'the matching route should retain its provider usage anchor');
        } finally {
            journal.close();
            restartedStore.close();
        }
    } finally {
        // The original store was closed before the restarted handles were opened.
        removeFixture(root, 'uah-context-route-anchor-');
    }
});
