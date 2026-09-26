import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import type {
    ApprovalIdentity,
    ApprovalRecord,
    RuntimeEvent,
    Snapshot,
} from '../../src/shared/contracts.js';
import { parseCommand } from '../../src/shared/contracts.js';
import { Supervisor } from '../../src/runtime/supervisor.js';

interface Harness {
    root: string;
    dataDirectory: string;
    projectDirectory: string;
    events: RuntimeEvent[];
    supervisor: Supervisor;
}

function createHarness(delayMs = 0): Harness {
    const root = mkdtempSync(join(tmpdir(), 'uah-runtime-test-'));
    const dataDirectory = join(root, 'data');
    const projectDirectory = join(root, 'project');
    mkdirSync(dataDirectory, { recursive: true });
    mkdirSync(projectDirectory, { recursive: true });
    const events: RuntimeEvent[] = [];
    const supervisor = new Supervisor({
        dataDirectory,
        onEvent: (event) => events.push(event),
        delayMs,
    });
    return { root, dataDirectory, projectDirectory, events, supervisor };
}

function cleanupHarness(harness: Harness): void {
    const target = resolve(harness.root);
    if (
        dirname(target) !== resolve(tmpdir()) ||
        !basename(target).startsWith('uah-runtime-test-')
    ) {
        throw new Error(`Refusing to recursively remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

async function waitForSnapshot(
    supervisor: Supervisor,
    predicate: (snapshot: Snapshot) => boolean,
    timeoutMs = 5_000,
): Promise<Snapshot> {
    const end = Date.now() + timeoutMs;
    let latest = await supervisor.execute({ type: 'snapshot' });
    while (!predicate(latest) && Date.now() < end) {
        await delay(5);
        latest = await supervisor.execute({ type: 'snapshot' });
    }
    assert.equal(predicate(latest), true, 'snapshot did not reach the expected state');
    return latest;
}

async function createSession(
    supervisor: Supervisor,
    directory: string | null,
    title = 'Runtime regression',
): Promise<string> {
    const snapshot = await supervisor.execute({ type: 'create-session', title, directory });
    const session = snapshot.sessions.at(-1);
    assert.ok(session);
    return session.id;
}

function getRun(snapshot: Snapshot, runId: string) {
    const run = snapshot.runs.find((item) => item.id === runId);
    assert.ok(run, `run ${runId} should exist`);
    return run;
}

function getPendingApproval(snapshot: Snapshot, runId: string): ApprovalRecord {
    const approval = snapshot.approvals.find(
        (item) => item.runId === runId && item.status === 'pending',
    );
    assert.ok(approval, `run ${runId} should have a pending approval`);
    return approval;
}

function approvalIdentity(approval: ApprovalRecord): ApprovalIdentity {
    return {
        runtimeId: approval.runtimeId,
        sessionId: approval.sessionId,
        runId: approval.runId,
        turnId: approval.turnId,
        requestId: approval.requestId,
        policyVersion: approval.policyVersion,
    };
}

test('parseCommand rejects unknown fields, malformed values, and incomplete approval identity', () => {
    assert.throws(() => parseCommand({ type: 'snapshot', surprise: true }), /unknown surprise/);
    assert.throws(
        () =>
            parseCommand({
                type: 'resolve-approval',
                decision: 'approve',
                identity: {
                    runtimeId: 'local-verification',
                    sessionId: 'session',
                    runId: 'run',
                    turnId: 'turn',
                    requestId: 'request',
                    policyVersion: 1,
                    extra: 'rejected',
                },
            }),
        /unknown extra/,
    );
    assert.throws(
        () => parseCommand({ type: 'start-run', sessionId: 'session', input: '   ' }),
        /must not be empty/,
    );
});

test('streams through local verification, binds approval identity, and stores an immutable snapshot', async () => {
    const harness = createHarness(0);
    try {
        const sessionId = await createSession(harness.supervisor, harness.projectDirectory);
        const started = await harness.supervisor.execute({
            type: 'start-run',
            sessionId,
            input: 'Create a small verification artifact.',
        });
        const startedRun = started.runs.at(-1);
        assert.ok(startedRun);
        assert.equal(startedRun.state, 'running');

        const waiting = await waitForSnapshot(harness.supervisor, (snapshot) =>
            snapshot.approvals.some((approval) => approval.runId === startedRun.id),
        );
        const approval = getPendingApproval(waiting, startedRun.id);
        assert.match(approval.summary, /不调用 AI 模型/);

        await assert.rejects(
            harness.supervisor.execute({
                type: 'resolve-approval',
                identity: { ...approvalIdentity(approval), sessionId: 'another-session' },
                decision: 'approve',
            }),
            /identity does not match/,
        );

        const completed = await harness.supervisor.execute({
            type: 'resolve-approval',
            identity: approvalIdentity(approval),
            decision: 'approve',
        });
        const finalRun = getRun(completed, startedRun.id);
        assert.equal(finalRun.state, 'completed');
        assert.match(finalRun.output, /不调用模型，也不读取凭据/);
        assert.equal(completed.artifacts.length, 1);

        const artifact = completed.artifacts[0];
        assert.equal(artifact.oldContent, null);
        assert.equal(readFileSync(artifact.path, 'utf8'), artifact.newContent);
        assert.equal(
            artifact.hash,
            createHash('sha256').update(artifact.newContent, 'utf8').digest('hex'),
        );

        const artifactText = artifact.newContent;
        writeFileSync(artifact.path, 'changed on disk after the run');
        const reopened = await harness.supervisor.execute({ type: 'snapshot' });
        assert.equal(reopened.artifacts[0].newContent, artifactText);
        assert.equal(reopened.artifacts[0].hash, artifact.hash);
        assert.equal(readFileSync(artifact.path, 'utf8'), 'changed on disk after the run');

        await assert.rejects(
            harness.supervisor.execute({
                type: 'resolve-approval',
                identity: approvalIdentity(approval),
                decision: 'approve',
            }),
            /no longer pending/,
        );

        const runEvents = harness.events.filter((event) => event.runId === startedRun.id);
        assert.ok(runEvents.length > 5, 'the local adapter should produce multiple stream events');
        for (let index = 1; index < runEvents.length; index += 1) {
            assert.ok(runEvents[index].sequence > runEvents[index - 1].sequence);
        }
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('rejects same-session overlap and competing directory leases', async () => {
    const harness = createHarness(100);
    try {
        const sharedSession = await createSession(harness.supervisor, null, 'Chat only');
        const first = await harness.supervisor.execute({
            type: 'start-run',
            sessionId: sharedSession,
            input: 'first chat-only run',
        });
        const firstRun = first.runs.at(-1);
        assert.ok(firstRun);
        await assert.rejects(
            harness.supervisor.execute({
                type: 'start-run',
                sessionId: sharedSession,
                input: 'second chat-only run',
            }),
            /Session already has an active run/,
        );

        const sameDirectoryA = await createSession(
            harness.supervisor,
            harness.projectDirectory,
            'Directory A',
        );
        const sameDirectoryB = await createSession(
            harness.supervisor,
            harness.projectDirectory,
            'Directory B',
        );
        await harness.supervisor.execute({
            type: 'start-run',
            sessionId: sameDirectoryA,
            input: 'lease holder',
        });
        await assert.rejects(
            harness.supervisor.execute({
                type: 'start-run',
                sessionId: sameDirectoryB,
                input: 'lease conflict',
            }),
            /Directory is already in use/,
        );
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('stopping during streaming prevents later deltas, approval, and file writes', async () => {
    const harness = createHarness(15);
    try {
        const sessionId = await createSession(harness.supervisor, harness.projectDirectory);
        const started = await harness.supervisor.execute({
            type: 'start-run',
            sessionId,
            input: 'cancel the verification run safely',
        });
        const run = started.runs.at(-1);
        assert.ok(run);
        await waitForSnapshot(harness.supervisor, (snapshot) => getRun(snapshot, run.id).output.length > 0);

        const stopped = await harness.supervisor.execute({ type: 'stop-run', runId: run.id });
        assert.equal(getRun(stopped, run.id).state, 'stopped');
        const eventCountAfterStop = harness.events.filter((event) => event.runId === run.id).length;
        await delay(75);
        const final = await harness.supervisor.execute({ type: 'snapshot' });
        assert.equal(getRun(final, run.id).state, 'stopped');
        assert.equal(
            harness.events.filter((event) => event.runId === run.id).length,
            eventCountAfterStop,
            'no delayed event may arrive after the stopped state',
        );
        assert.equal(final.approvals.some((approval) => approval.runId === run.id), false);
        assert.equal(final.artifacts.some((artifact) => artifact.runId === run.id), false);
        assert.deepEqual(readdirSync(harness.projectDirectory), []);

        const states = harness.events
            .filter(
                (event): event is Extract<RuntimeEvent, { type: 'run-state' }> =>
                    event.runId === run.id && event.type === 'run-state',
            )
            .map((event) => event.payload.run.state);
        assert.deepEqual(states.slice(-3), ['cancelRequested', 'stopping', 'stopped']);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('restart stops active runs, expires approvals, and rejects their old identities', async () => {
    const harness = createHarness(0);
    let reopened: Supervisor | undefined;
    try {
        const sessionId = await createSession(harness.supervisor, harness.projectDirectory);
        const started = await harness.supervisor.execute({
            type: 'start-run',
            sessionId,
            input: 'wait for a restart recovery check',
        });
        const run = started.runs.at(-1);
        assert.ok(run);
        const waiting = await waitForSnapshot(harness.supervisor, (snapshot) =>
            snapshot.approvals.some((approval) => approval.runId === run.id),
        );
        const approval = getPendingApproval(waiting, run.id);
        await harness.supervisor.shutdown();

        reopened = new Supervisor({
            dataDirectory: harness.dataDirectory,
            onEvent: () => undefined,
            delayMs: 0,
        });
        const recovered = await reopened.execute({ type: 'snapshot' });
        assert.equal(getRun(recovered, run.id).state, 'stopped');
        assert.equal(recovered.approvals.find((item) => item.requestId === approval.requestId)?.status, 'expired');
        assert.equal(recovered.artifacts.length, 0);
        await assert.rejects(
            reopened.execute({
                type: 'resolve-approval',
                identity: approvalIdentity(approval),
                decision: 'approve',
            }),
            /no longer pending/,
        );
        assert.deepEqual(readdirSync(harness.projectDirectory), []);
    } finally {
        if (reopened) {
            await reopened.shutdown();
        }
        cleanupHarness(harness);
    }
});

test('chat-only runs complete without approval or disk writes', async () => {
    const harness = createHarness(0);
    try {
        const sessionId = await createSession(harness.supervisor, null);
        const started = await harness.supervisor.execute({
            type: 'start-run',
            sessionId,
            input: 'no project directory is attached',
        });
        const run = started.runs.at(-1);
        assert.ok(run);
        const completed = await waitForSnapshot(harness.supervisor, (snapshot) =>
            ['completed', 'failed', 'stopped'].includes(getRun(snapshot, run.id).state),
        );
        assert.equal(getRun(completed, run.id).state, 'completed');
        assert.equal(completed.approvals.length, 0);
        assert.equal(completed.artifacts.length, 0);
        assert.match(getRun(completed, run.id).output, /local-verification/);
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('a write conflict fails safely without overwriting the existing file', async () => {
    const harness = createHarness(0);
    try {
        const sessionId = await createSession(harness.supervisor, harness.projectDirectory);
        const started = await harness.supervisor.execute({
            type: 'start-run',
            sessionId,
            input: 'must not overwrite an existing output file',
        });
        const run = started.runs.at(-1);
        assert.ok(run);
        const waiting = await waitForSnapshot(harness.supervisor, (snapshot) =>
            snapshot.approvals.some((approval) => approval.runId === run.id),
        );
        const approval = getPendingApproval(waiting, run.id);
        writeFileSync(approval.path, 'preserve existing contents');

        const failed = await harness.supervisor.execute({
            type: 'resolve-approval',
            identity: approvalIdentity(approval),
            decision: 'approve',
        });
        assert.equal(getRun(failed, run.id).state, 'failed');
        assert.equal(failed.approvals.find((item) => item.requestId === approval.requestId)?.status, 'expired');
        assert.equal(failed.artifacts.length, 0);
        assert.equal(readFileSync(approval.path, 'utf8'), 'preserve existing contents');
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});

test('Windows directory case aliases share a lease and junction paths are rejected', async (context) => {
    if (process.platform !== 'win32') {
        context.skip('Windows path identity and reparse points are platform-specific');
        return;
    }

    const harness = createHarness(100);
    let junctionPath: string | undefined;
    try {
        const caseAlias = join(
            dirname(harness.projectDirectory),
            basename(harness.projectDirectory).toUpperCase(),
        );
        const sessionA = await createSession(
            harness.supervisor,
            harness.projectDirectory,
            'Original case',
        );
        const sessionB = await createSession(harness.supervisor, caseAlias, 'Case alias');
        await harness.supervisor.execute({
            type: 'start-run',
            sessionId: sessionA,
            input: 'hold the canonical directory lease',
        });
        await assert.rejects(
            harness.supervisor.execute({
                type: 'start-run',
                sessionId: sessionB,
                input: 'case alias must share the same lease',
            }),
            /Directory is already in use/,
        );

        junctionPath = join(harness.root, 'project-junction');
        symlinkSync(harness.projectDirectory, junctionPath, 'junction');
        await assert.rejects(
            createSession(harness.supervisor, junctionPath, 'Junction should be rejected'),
            /symbolic link or reparse point/,
        );
    } finally {
        await harness.supervisor.shutdown();
        if (junctionPath) {
            try {
                rmSync(junctionPath, { recursive: false, force: true });
            } catch {
                // The enclosing temporary directory is independently validated before removal.
            }
        }
        cleanupHarness(harness);
    }
});

test('snapshot reads detect altered artifact bytes and missing immutable rows', async () => {
    const harness = createHarness(0);
    try {
        const sessionId = await createSession(harness.supervisor, harness.projectDirectory);
        const started = await harness.supervisor.execute({
            type: 'start-run',
            sessionId,
            input: 'store snapshot bytes for integrity checks',
        });
        const run = started.runs.at(-1);
        assert.ok(run);
        const waiting = await waitForSnapshot(harness.supervisor, (snapshot) =>
            snapshot.approvals.some((approval) => approval.runId === run.id),
        );
        const approval = getPendingApproval(waiting, run.id);
        const saved = await harness.supervisor.execute({
            type: 'resolve-approval',
            identity: approvalIdentity(approval),
            decision: 'approve',
        });
        const artifact = saved.artifacts[0];
        assert.ok(artifact);

        const database = new DatabaseSync(join(harness.dataDirectory, 'runtime.sqlite'));
        const artifactRow = database
            .prepare('SELECT data FROM artifacts WHERE id = ?')
            .get(artifact.id) as { data: string };
        const eventRow = database
            .prepare("SELECT id, data FROM events WHERE type = 'artifact-created' AND run_id = ?")
            .get(artifact.runId) as { id: number; data: string };
        database.close();

        const corruptedArtifact = JSON.parse(artifactRow.data) as { newContent: string };
        corruptedArtifact.newContent = `${corruptedArtifact.newContent}tampered`;
        const corruptedEvent = JSON.parse(eventRow.data) as {
            payload: { artifact: { newContent: string } };
        };
        corruptedEvent.payload.artifact.newContent = corruptedArtifact.newContent;
        const corruptDatabase = new DatabaseSync(join(harness.dataDirectory, 'runtime.sqlite'));
        corruptDatabase
            .prepare('UPDATE artifacts SET data = ? WHERE id = ?')
            .run(JSON.stringify(corruptedArtifact), artifact.id);
        corruptDatabase
            .prepare('UPDATE events SET data = ? WHERE id = ?')
            .run(JSON.stringify(corruptedEvent), eventRow.id);
        corruptDatabase.close();
        await assert.rejects(
            harness.supervisor.execute({ type: 'snapshot' }),
            /Artifact snapshot integrity check failed/,
        );

        const deleteDatabase = new DatabaseSync(join(harness.dataDirectory, 'runtime.sqlite'));
        deleteDatabase.prepare('DELETE FROM artifacts WHERE id = ?').run(artifact.id);
        deleteDatabase.close();
        await assert.rejects(
            harness.supervisor.execute({ type: 'snapshot' }),
            /Artifact snapshot is missing/,
        );
    } finally {
        await harness.supervisor.shutdown();
        cleanupHarness(harness);
    }
});
