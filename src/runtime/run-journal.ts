import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RunRecord } from '../shared/contracts';
import type { TranscriptEvent, TranscriptPayloads, RunIdentity } from '../shared/harness-contracts';
import { RuntimeStore, type StoreCommit } from './store';
import { TranscriptWriter, type TranscriptFlushResult } from './transcript-writer';
import { JournalArtifacts, redactJournalValue } from './journal-artifacts';

type Pending = { run: RunIdentity; type: keyof TranscriptPayloads; payload: TranscriptPayloads[keyof TranscriptPayloads]; timestamp: string };
const epoch = randomUUID();

/** Single synchronous SQLite writer; only text deltas may wait in this bounded batch. */
export class RunJournal {
    private readonly writer: TranscriptWriter;
    private readonly artifacts = new Map<string, JournalArtifacts>();
    private pending: Pending[] = [];
    private pendingRuns = new Map<string, RunRecord>();
    private pendingBytes = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private failed = false;
    private readonly health = new Map<string, TranscriptFlushResult>();
    private readonly secrets = new Map<string, Set<string>>();
    constructor(private readonly store: RuntimeStore, private readonly directory: string,
        private readonly lookup: (id: string) => RunRecord | undefined,
        private readonly onFailure: (runs: RunRecord[]) => void) {
        const legacySessionIds = store.readLegacyJournalSessionIds();
        this.writer = new TranscriptWriter(store, directory, { deriveCoverage: true, legacySessionIds });
    }
    identity(run: RunRecord): RunIdentity {
        let root = run;
        const seen = new Set<string>();
        while (root.parentRunId) {
            if (seen.has(root.id)) throw new Error('Cyclic run ancestry');
            seen.add(root.id);
            const parent = this.lookup(root.parentRunId);
            if (!parent || parent.sessionId !== run.sessionId) throw new Error('Missing run ancestry');
            root = parent;
        }
        return { sessionId: run.sessionId, runId: run.id, parentRunId: run.parentRunId ?? null, rootRunId: root.id, turnId: run.turnId };
    }
    registerSecret(sessionId: string, secret: string): void {
        if (!secret) return;
        const values = this.secrets.get(sessionId) ?? new Set<string>(); values.add(secret); this.secrets.set(sessionId, values);
    }
    knownSecrets(sessionId: string): readonly string[] { return [...(this.secrets.get(sessionId) ?? [])]; }
    private projectRun(run: RunRecord): RunRecord {
        const secrets = this.secrets.get(run.sessionId);
        if (!secrets?.size) return run;
        const visit = (value: unknown, streaming = false): unknown => {
            if (typeof value === 'string') {
                for (const secret of secrets) {
                    value = (value as string).split(secret).join('*'.repeat(secret.length));
                    // A materialized streaming view must not persist a key prefix
                    // that could be completed by a later delta.
                    for (let length = streaming ? Math.min(secret.length - 1, (value as string).length) : 0; length > 0; length--) {
                        if ((value as string).endsWith(secret.slice(0, length))) {
                            value = (value as string).slice(0, -length) + '*'.repeat(length); break;
                        }
                    }
                }
                return value;
            }
            if (Array.isArray(value)) return value.map(item => visit(item, streaming));
            if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, visit(item)]));
            return value;
        };
        // Identity, hashes, paths and persisted configuration are not streamed
        // text. Masking suffixes there would corrupt references and file checks.
        return { ...run, input: visit(run.input) as string, output: visit(run.output, !['completed', 'failed', 'stopped'].includes(run.state)) as string,
            ...(run.steering ? { steering: run.steering.map(item => ({ ...item, input: visit(item.input) as string })) } : {}),
            ...(run.error === undefined ? {} : { error: visit(run.error) as string }),
            ...(run.stopReason === undefined ? {} : { stopReason: visit(run.stopReason) as string }),
            ...(run.activities ? { activities: run.activities.map(activity => ({ ...activity,
                content: visit(activity.content, activity.kind === 'reasoning' && activity.status === 'running') as string,
                ...(activity.tool ? { tool: { ...activity.tool,
                    arguments: redactJournalValue(activity.tool.arguments, [...secrets]).value as Record<string, unknown>,
                    ...(activity.tool.outcome ? { outcome: { ...activity.tool.outcome, preview: visit(activity.tool.outcome.preview) as string } } : {}),
                    ...(activity.tool.result === undefined ? {} : { result: visit(activity.tool.result) as string }) } } : {}) })) } : {}) };
    }
    artifactStore(sessionId: string): JournalArtifacts {
        let store = this.artifacts.get(sessionId);
        if (!store) { store = new JournalArtifacts(join(this.directory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'))); this.artifacts.set(sessionId, store); }
        return store;
    }
    saveContent(sessionId: string, value: unknown) {
        return this.artifactStore(sessionId).save(value, [...(this.secrets.get(sessionId) ?? [])]);
    }
    event<K extends keyof TranscriptPayloads>(run: RunRecord, type: K, payload: TranscriptPayloads[K], changes: StoreCommit = {}): void {
        this.commit(changes, [{ run: this.identity(run), type, payload, timestamp: new Date().toISOString() }]);
    }
    delta(run: RunRecord, payload: TranscriptPayloads['response.delta']): void {
        this.assertHealthy();
        this.pending.push({ run: this.identity(run), type: 'response.delta', payload, timestamp: new Date().toISOString() });
        this.materialize(run, Buffer.byteLength(payload.text, 'utf8'));
    }
    materialize(run: RunRecord, bytes: number): void {
        this.assertHealthy();
        this.pendingRuns.set(run.id, structuredClone(run));
        this.pendingBytes += bytes;
        if (this.pendingBytes >= 16_384) this.flush();
        else if (!this.timer) {
            this.timer = setTimeout(() => {
                this.timer = undefined;
                try { this.flush(); } catch { /* onFailure has already notified the owning Supervisor. */ }
            }, 50);
            this.timer.unref();
        }
    }
    commit(changes: StoreCommit, extra: Pending[] = []): void {
        // After authority failure only an explicit failure projection may be retried;
        // admission remains latched off for this process even if this diagnostic commits.
        if (this.failed && !(changes.runs?.length
            && Object.keys(changes).every(key => ['runs', 'events'].includes(key))
            && changes.runs.every(run => run.harnessState === 'recording_failed' || run.state === 'failed')
            && (changes.events ?? []).every(event => event.type === 'run-state' && (event.payload.run.harnessState === 'recording_failed' || event.payload.run.state === 'failed'))
            && extra.every(event => (event.type === 'run.state' && ['failed', 'recording_failed'].includes((event.payload as TranscriptPayloads['run.state']).state))
                || (event.type === 'tool.result' && (event.payload as TranscriptPayloads['tool.result']).outcome.recordingState === 'failed')))) this.assertHealthy();
        clearTimeout(this.timer); this.timer = undefined;
        const pendingRuns = new Map(this.pendingRuns);
        for (const run of changes.runs ?? []) pendingRuns.set(run.id, run);
        const pending = [...this.pending, ...extra];
        const sequences = new Map<string, number>();
        const journal = pending.map(item => {
            const session = item.run.sessionId;
            const seq = sequences.get(session) ?? this.store.nextSessionSeq(session);
            sequences.set(session, seq + 1);
            const payload = redactJournalValue(item.payload, [...(this.secrets.get(session) ?? [])]).value;
            if (item.type === 'response.delta') {
                const source = item.payload as TranscriptPayloads['response.delta'];
                const clean = payload as unknown as TranscriptPayloads['response.delta'];
                if (source.text !== clean.text) clean.text = '*'.repeat(source.text.length);
            }
            return { schemaVersion: 1, eventId: randomUUID(), sessionSeq: seq, processEpochId: epoch, ...item, payload } as TranscriptEvent;
        });
        const runs = [...pendingRuns.values()].map(run => this.projectRun(run));
        const events = changes.events?.map(event => event.type === 'run-state' ? { ...event, payload: { run: this.projectRun(event.payload.run) } } : event);
        try { this.store.commit({ ...changes, runs, events, journal: [...(changes.journal ?? []), ...journal] }); }
        catch (error) { this.failed = true; this.onFailure([...pendingRuns.values()]); throw error; }
        this.pending = []; this.pendingRuns.clear(); this.pendingBytes = 0;
        // File projection may lag a healthy DB. D04 surfaces these watermarks in the UI.
        for (const session of sequences.keys()) this.health.set(session, this.writer.flush(session));
    }
    recordingHealth(sessionId: string) { return this.health.get(sessionId) ?? { status: 'healthy' as const, sessionId, ...this.store.journalWatermark(sessionId) }; }
    project(sessionId: string): string {
        // Diagnostics remain accessible after the authority admission latch trips.
        if (!this.failed) this.flush();
        this.health.set(sessionId, this.writer.flush(sessionId, { verifyArtifacts: true }));
        return this.writer.sessionDirectory(sessionId);
    }
    get authorityFailed(): boolean { return this.failed; }
    forgetSession(sessionId: string): void {
        if (this.pending.some(item => item.run.sessionId === sessionId) || [...this.pendingRuns.values()].some(run => run.sessionId === sessionId)) throw new Error('Cannot forget a buffered journal');
        this.writer.forgetSession(sessionId); this.artifacts.delete(sessionId); this.health.delete(sessionId); this.secrets.delete(sessionId);
    }
    admit(sessionId: string): void {
        this.assertHealthy();
        // Hard bounded outbox, separate from text batching/preview. Results may still be
        // recorded after this point; no new model sends or tool dispatch may begin.
        if (this.store.journalBacklog(sessionId).bytes >= 64 * 1024 * 1024) {
            this.health.set(sessionId, this.writer.flush(sessionId));
            if (this.store.journalBacklog(sessionId).bytes >= 64 * 1024 * 1024) throw new Error('Transcript export backlog reached 64 MiB; new execution suspended');
        }
    }
    flush(): void { if (this.pending.length || this.pendingRuns.size) this.commit({}); }
    close(): void { this.flush(); this.writer.close(); }
    private assertHealthy() { if (this.failed) throw new Error('Canonical journal unavailable; execution is suspended'); }
}
