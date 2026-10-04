import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import type { RunRecord, Snapshot } from '../../src/shared/contracts.js';
import type { NativeAttachmentPayload } from '../../src/shared/attachments.js';
import type { ArtifactReference } from '../../src/shared/harness-contracts.js';
import type { ApiConnection } from '../../src/shared/endpoints.js';
import { NATIVE_CODEX_ENDPOINT_ID } from '../../src/shared/native-codex.js';
import { parseNativeInput } from '../../src/shared/native-codex-commands.js';
import type { ExtensionRuntimeBundle } from '../../src/shared/extension-runtime.js';
import { Supervisor } from '../../src/runtime/supervisor.js';
import { validateTranscript } from '../../src/runtime/transcript-offline.js';

const fixturePath = join(process.cwd(), 'tests', 'fixtures', 'codex-app-server-fixture.mjs');
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);

interface Harness {
    root: string;
    dataDirectory: string;
    projectDirectory: string;
    recordFile: string;
    supervisor: Supervisor;
    bundle: ExtensionRuntimeBundle;
    setScenario(scenario: Record<string, unknown>): void;
}

function createHarness(scenario: Record<string, unknown> = {}): Harness {
    const root = mkdtempSync(join(tmpdir(), 'uah-native-attachments-test-'));
    const dataDirectory = join(root, 'data');
    const projectDirectory = join(root, 'project');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    const recordFile = join(root, 'app-server.jsonl');
    const bundle: ExtensionRuntimeBundle = {
        connectors: [],
        skills: [],
        native: {
            enabled: true,
            command: process.execPath,
            args: [fixturePath, JSON.stringify({ ...scenario, recordFile })],
            model: 'gpt-fixture',
            revision: 1,
        },
    };
    let currentBundle = bundle;
    const supervisor = new Supervisor({
        dataDirectory,
        resolveExtensions: async () => structuredClone(currentBundle),
        resolveConnection: async (id): Promise<ApiConnection> => {
            if (id !== 'fixture-api') throw new Error(`Unexpected API endpoint ${id}`);
            return {
                id,
                name: 'Attachment API fixture',
                protocol: 'openai-chat',
                baseUrl: 'http://127.0.0.1:10081',
                models: ['api-fixture'],
                enabled: true,
                revision: 1,
                apiKey: 'fixture-only-key',
            };
        },
        onEvent: () => undefined,
        delayMs: 0,
    });
    return {
        root, dataDirectory, projectDirectory, recordFile, supervisor, bundle,
        setScenario(nextScenario) {
            currentBundle = structuredClone(bundle);
            currentBundle.native.args = [fixturePath, JSON.stringify({ ...nextScenario, recordFile })];
        },
    };
}

function cleanupHarness(harness: Harness): void {
    const target = resolve(harness.root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-native-attachments-test-')) {
        throw new Error(`Refusing to recursively remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

async function createNativeSession(harness: Harness): Promise<string> {
    const snapshot = await harness.supervisor.execute({
        type: 'create-session',
        title: 'Native attachments fixture',
        directory: harness.projectDirectory,
        selection: { endpointId: NATIVE_CODEX_ENDPOINT_ID, modelId: 'gpt-fixture' },
    });
    const session = snapshot.sessions.at(-1);
    assert.ok(session);
    return session.id;
}

async function waitForSnapshot(supervisor: Supervisor, predicate: (snapshot: Snapshot) => boolean, timeoutMs = 8_000): Promise<Snapshot> {
    const end = Date.now() + timeoutMs;
    let snapshot = await supervisor.execute({ type: 'snapshot' });
    while (!predicate(snapshot) && Date.now() < end) {
        await delay(10);
        snapshot = await supervisor.execute({ type: 'snapshot' });
    }
    assert.equal(predicate(snapshot), true, `snapshot did not reach expected state: ${JSON.stringify(snapshot.runs.map(run => ({ id: run.id, state: run.state, error: run.error })))}`);
    return snapshot;
}

function getRun(snapshot: Snapshot, runId: string): RunRecord {
    const run = snapshot.runs.find(item => item.id === runId);
    assert.ok(run, `run ${runId} should exist`);
    return run;
}

function fixtureRecords(harness: Harness): Array<Record<string, unknown>> {
    try {
        return readFileSync(harness.recordFile, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
    } catch {
        return [];
    }
}

function turnInputs(harness: Harness): Array<Array<Record<string, unknown>>> {
    return fixtureRecords(harness).filter(record => record.method === 'fixture/turnRequest').map(record => {
        const params = record.params as { input?: unknown };
        return Array.isArray(params.input) ? params.input as Array<Record<string, unknown>> : [];
    });
}

function imagePayload(): NativeAttachmentPayload {
    return {
        id: randomUUID(), name: 'fixture.png', kind: 'image', size: PNG.length,
        mimeType: 'image/png', data: Buffer.from(PNG).toString('base64'),
    };
}

test('native attachment snapshots are sent from verified journal artifacts and survive offline export', async () => {
    const harness = createHarness();
    try {
        const sessionId = await createNativeSession(harness);
        const image = imagePayload();
        const textPath = join(harness.projectDirectory, 'notes.txt');
        const textSnapshot = 'TEXT_SNAPSHOT_BEFORE_EDIT';
        writeFileSync(textPath, textSnapshot, 'utf8');
        const text = readFileSync(textPath, 'utf8');
        const pdfPath = join(harness.projectDirectory, 'report.pdf');
        const pdfBytes = Buffer.from('%PDF-1.7\nPDF_CONTENT_MUST_NOT_BE_PARSED\n', 'utf8');
        writeFileSync(pdfPath, pdfBytes);
        const attachments: NativeAttachmentPayload[] = [
            image,
            { id: randomUUID(), name: 'notes.txt', kind: 'text', size: Buffer.byteLength(text), mimeType: 'text/plain', data: text },
            { id: randomUUID(), name: 'report.pdf', kind: 'file', size: statSync(pdfPath).size, mimeType: 'application/pdf', path: pdfPath },
        ];
        writeFileSync(textPath, 'TEXT_SOURCE_AFTER_SNAPSHOT', 'utf8');

        const started = await harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Inspect the attached material.', attachments });
        const pending = started.runs.at(-1);
        assert.ok(pending);
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === pending.id && run.state === 'completed'));
        const run = getRun(final, pending.id);
        assert.equal(run.state, 'completed');

        const stored = run.attachments as Array<Record<string, unknown>>;
        assert.equal(stored.length, 3);
        const imageBase64 = image.data;
        assert.ok(imageBase64);
        assert.equal(JSON.stringify(run).includes(imageBase64), false, 'base64 image bytes must not be stored on the run record');
        for (const attachment of stored) assert.equal(Object.hasOwn(attachment, 'data'), false);
        const imageRecord = stored.find(item => item.kind === 'image');
        const textRecord = stored.find(item => item.kind === 'text');
        const fileRecord = stored.find(item => item.kind === 'file');
        assert.ok(imageRecord?.artifact);
        assert.ok(textRecord?.artifact);
        assert.equal(fileRecord?.artifact, undefined, 'path-only files must not be read into the artifact store');
        assert.equal(fileRecord?.path, pdfPath);

        const imageRef = imageRecord.artifact as ArtifactReference;
        const textRef = textRecord.artifact as ArtifactReference;
        const artifactDirectory = join(harness.dataDirectory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
        assert.ok(imageRef.relativePath);
        const imageArtifactPath = join(artifactDirectory, imageRef.relativePath);
        assert.deepEqual(readFileSync(imageArtifactPath), Buffer.from(PNG), 'the image artifact must preserve exact source bytes');

        const firstInput = turnInputs(harness)[0];
        assert.ok(firstInput);
        const imageItem = firstInput.find(item => item.type === 'localImage');
        assert.ok(imageItem, 'native turn/start should contain a localImage item');
        assert.equal(imageItem.path, imageArtifactPath, 'native localImage must point at the verified artifact path');
        assert.deepEqual(readFileSync(String(imageItem.path)), Buffer.from(PNG));
        const textInput = firstInput.map(item => typeof item.text === 'string' ? item.text : '').join('\n');
        assert.match(textInput, /TEXT_SNAPSHOT_BEFORE_EDIT/);
        assert.equal(textInput.includes('TEXT_SOURCE_AFTER_SNAPSHOT'), false, 'native input must use the captured text snapshot');
        assert.match(textInput, /report\.pdf.*仅本地路径引用，内容尚未解析/);
        assert.ok(textInput.includes(JSON.stringify(pdfPath)), 'path-only PDF reference should retain the selected path');
        assert.equal(textInput.includes('PDF_CONTENT_MUST_NOT_BE_PARSED'), false);

        const destination = join(harness.root, 'attachment-export');
        harness.supervisor.journalExport(sessionId, destination, 'full');
        const validation = validateTranscript(destination);
        assert.equal(validation.warnings.length, 0);
        const manifest = JSON.parse(readFileSync(join(destination, 'manifest.json'), 'utf8')) as { artifacts: ArtifactReference[] };
        assert.ok(manifest.artifacts.some(ref => ref.sha256 === imageRef.sha256), 'image artifact must be reachable from the journal manifest');
        assert.ok(manifest.artifacts.some(ref => ref.sha256 === textRef.sha256), 'text snapshot must be reachable from the journal manifest');
        assert.equal(manifest.artifacts.some(ref => ref.sha256 === createHash('sha256').update(pdfBytes).digest('hex')), false);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('stopping and resuming a native goal does not replay a prior image attachment', async () => {
    const harness = createHarness({ hold: true, goalCompletionStatuses: ['active'] });
    try {
        const sessionId = await createNativeSession(harness);
        const started = await harness.supervisor.execute({
            type: 'start-run', sessionId, input: '/goal Resume the fixture goal.', attachments: [imagePayload()],
        });
        const original = started.runs.at(-1);
        assert.ok(original);
        await waitForSnapshot(harness.supervisor, snapshot => Boolean(snapshot.runs.find(run => run.id === original.id)?.native?.turnId));
        const stopped = await harness.supervisor.execute({ type: 'stop-run', runId: original.id, reason: 'Test attachment resume behavior.' });
        assert.equal(getRun(stopped, original.id).state, 'stopped');

        harness.setScenario({ hold: false, goalCompletionStatuses: ['complete'] });
        const resumedStart = await harness.supervisor.execute({ type: 'start-run', sessionId, input: '/goal resume' });
        const resumedPending = resumedStart.runs.at(-1);
        assert.ok(resumedPending);
        const final = await waitForSnapshot(harness.supervisor, snapshot => snapshot.runs.some(run => run.id === resumedPending.id && run.state === 'completed'));
        const resumed = getRun(final, resumedPending.id);
        assert.equal(resumed.attachments, undefined);
        assert.equal(resumed.native?.threadId, getRun(final, original.id).native?.threadId);

        const inputs = turnInputs(harness);
        assert.equal(inputs.length, 2);
        assert.equal(inputs[0]?.some(item => item.type === 'localImage'), true);
        assert.equal(inputs[1]?.some(item => item.type === 'localImage'), false, 'resumed turn should not resend the original image');
        assert.ok(fixtureRecords(harness).some(record => record.direction === 'client' && record.method === 'thread/resume'));
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('metadata-only native commands reject attachments without creating a run or native thread', async () => {
    for (const input of ['/goal', '/plan']) {
        const harness = createHarness();
        try {
            const sessionId = await createNativeSession(harness);
            await assert.rejects(
                harness.supervisor.execute({ type: 'start-run', sessionId, input, attachments: [imagePayload()] }),
                /此指令不发送模型请求/,
            );
            const snapshot = await harness.supervisor.execute({ type: 'snapshot' });
            assert.equal(snapshot.runs.some(run => run.sessionId === sessionId), false);
            assert.equal(fixtureRecords(harness).some(record => record.method === 'fixture/threadRequest' || record.method === 'fixture/turnRequest'), false);
        } finally {
            await harness.supervisor.shutdown();
            cleanupHarness(harness);
        }
    }
    assert.deepEqual(parseNativeInput('/goal'), { kind: 'goal', command: { type: 'get' }, task: '' });
    assert.deepEqual(parseNativeInput('/plan'), { kind: 'plan', mode: 'plan', task: '' });
});

test('API sessions reject native attachment payloads before creating a run', async () => {
    const harness = createHarness();
    try {
        const snapshot = await harness.supervisor.execute({
            type: 'create-session', title: 'API attachment fixture', directory: harness.projectDirectory,
            selection: { endpointId: 'fixture-api', modelId: 'api-fixture' },
        });
        const session = snapshot.sessions.at(-1);
        assert.ok(session);
        assert.equal(session.requested.runtimeId, 'api');
        await assert.rejects(
            harness.supervisor.execute({ type: 'start-run', sessionId: session.id, input: 'This API request must not receive attachments.', attachments: [imagePayload()] }),
            /附件仅支持原生 Codex/,
        );
        const after = await harness.supervisor.execute({ type: 'snapshot' });
        assert.equal(after.runs.some(run => run.sessionId === session.id), false);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('malformed attachment payloads are rejected before native run creation', async () => {
    const harness = createHarness();
    try {
        const sessionId = await createNativeSession(harness);
        const invalid = { ...imagePayload(), data: 'not base64' };
        await assert.rejects(
            harness.supervisor.execute({ type: 'start-run', sessionId, input: 'Reject invalid attachment data.', attachments: [invalid] }),
            /图片附件的 Base64 数据无效/,
        );
        const snapshot = await harness.supervisor.execute({ type: 'snapshot' });
        assert.equal(snapshot.runs.some(run => run.sessionId === sessionId), false);
        assert.equal(fixtureRecords(harness).some(record => record.method === 'fixture/threadRequest' || record.method === 'fixture/turnRequest'), false);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});
