import { randomUUID } from 'node:crypto';
import type { ApiProtocol } from '../../shared/endpoints';
import type { RunRecord, Snapshot } from '../../shared/contracts';
import type { JsonValue, TranscriptPayloads } from '../../shared/harness-contracts';
import { visibleRootRuns, displayedReply } from '../../shared/conversation-history';
import type { RuntimeStore } from '../store';
import type { RunJournal } from '../run-journal';
import type { ContextEntry, ContextSurface } from './contracts';
import { contextHash, projectRuntimeSections, type RuntimeSection } from './projection';
import { portableHistory } from './portable-history';

/** Session identity is not an agent identity: children in UAH share their parent's session. */
export function contextOwner(run: RunRecord): string { return run.parentRunId ? `child:${run.id}` : 'primary'; }
export { replayDomain, contextRoute } from './replay-domain';
/** Revision guard only, not a source for reconstructing V2 model messages. */
export function contextSourceFingerprint(snapshot: Snapshot, run: RunRecord, includeCurrent = false): string {
    if (run.parentRunId) return contextHash({ input: run.input, inherited: run.contextMessages ?? [] });
    let roots = visibleRootRuns(snapshot.runs, run.sessionId);
    const index = roots.findIndex(item => item.id === run.id);
    if (index >= 0) roots = roots.slice(0, index + (includeCurrent ? 1 : 0));
    const limit = run.effective.modelParameters?.historyTurns;
    if (limit !== undefined) roots = limit === 0 ? [] : roots.slice(-limit);
    const session = snapshot.sessions.find(item => item.id === run.sessionId);
    return contextHash({ historyLimit: limit ?? null, branch: { source: session?.branchFromRunId ?? null,
        messages: session?.branchHistory?.map(turn => turn.messages) ?? session?.branchMessages ?? [] }, roots: roots.map(item => ({ id: item.id,
        input: item.input, reply: displayedReply(item), history: item.history ?? null,
        interruption: ['failed', 'stopped'].includes(item.state) ? item.state : null,
        steering: item.steering?.map(value => ({ id: value.id, input: value.input })) ?? [],
        plan: item.plan ? { id: item.plan.id, version: item.plan.version, content: item.plan.content } : null })) });
}

interface StoredItem { schemaVersion: 2; protocol: ApiProtocol; routeKey: string; item: unknown }
export class ContextEngine {
    readonly ownerId: string;
    readonly routeKey: string;
    private surface: ContextSurface | undefined;
    private items: unknown[] = [];
    private entries: ContextEntry[] = [];
    private itemHashes: string[] = [];
    private needsRewrite = false;
    readonly restored: boolean;
    readonly restoreReason: string;
    constructor(private readonly store: RuntimeStore, private readonly journal: RunJournal,
        private readonly run: RunRecord, private readonly protocol: ApiProtocol, routeKey: string, sourceFingerprint: string) {
        this.ownerId = contextOwner(run); this.routeKey = routeKey;
        this.surface = store.readContextSurface(run.sessionId, this.ownerId);
        let restored = false;
        let reason = this.surface ? 'history_or_route_changed' : 'legacy_import';
        if (this.surface?.sourceFingerprint === sourceFingerprint && this.surface.coverage === 'complete') {
            try {
                this.entries = store.readContextEntries(run.sessionId, this.ownerId, this.surface.entryIds);
                let sourceProtocol: ApiProtocol | undefined;
                this.items = this.entries.map(entry => {
                    const data = JSON.parse(journal.artifactStore(run.sessionId).read(entry.content).toString('utf8')) as StoredItem;
                    if (data.schemaVersion !== 2 || data.routeKey !== this.surface!.routeKey
                        || sourceProtocol !== undefined && sourceProtocol !== data.protocol) throw new Error('Context replay domain mismatch');
                    sourceProtocol = data.protocol;
                    return data.item;
                });
                restored = true; reason = 'restored';
                if (this.surface.routeKey !== routeKey && sourceProtocol) {
                    this.items = portableHistory(sourceProtocol, protocol, this.items);
                    this.needsRewrite = true; reason = 'portable_replay';
                }
            } catch { this.items = []; this.entries = []; restored = false; this.needsRewrite = false; reason = 'artifact_unavailable'; }
        }
        this.itemHashes = this.items.map(contextHash);
        this.restored = restored; this.restoreReason = reason;
    }
    get history(): unknown[] { return structuredClone(this.items); }
    get state(): ContextSurface | undefined { return this.surface && structuredClone(this.surface); }

    snapshots(sections: readonly RuntimeSection[]): { messages: unknown[]; hashes: Record<string, string> } {
        return projectRuntimeSections(this.protocol, sections, this.items.length ? this.surface?.snapshotHashes ?? {} : {});
    }

    /** Caller supplies only closed tool exchanges. Artifacts precede the atomic SQLite/outbox commit. */
    persist(history: readonly unknown[], options: {
        sourceFingerprint: string; reason: string; snapshotHashes?: Record<string, string>;
        instructionHash?: string; toolManifestHash?: string; metadata?: JsonValue;
        compaction?: TranscriptPayloads['context.compaction'];
    }): ContextSurface {
        let common = 0;
        const hashes = history.map(contextHash);
        while (!this.needsRewrite && common < this.items.length && common < history.length && this.itemHashes[common] === hashes[common]) common++;
        const replacement = common < this.items.length || (!this.restored && this.entries.length === 0 && !!this.surface);
        const policyChanged = !!this.surface && (
            options.instructionHash !== undefined && options.instructionHash !== this.surface.instructionHash
            || options.toolManifestHash !== undefined && options.toolManifestHash !== this.surface.toolManifestHash);
        const entries = this.entries.slice(0, common);
        const added: ContextEntry[] = [];
        let coverage = this.surface?.coverage ?? 'complete';
        if (replacement) coverage = 'complete';
        for (let index = common; index < history.length; index++) {
            const saved = this.journal.artifactStore(this.run.sessionId).save({ schemaVersion: 2,
                protocol: this.protocol, routeKey: this.routeKey,
                generation: (this.surface?.epoch ?? 0) + (replacement || policyChanged ? 1 : 0),
                item: history[index] }, this.journal.knownSecrets(this.run.sessionId), true);
            if (saved.redacted) coverage = 'partial';
            const entry: ContextEntry = { id: randomUUID(), sessionId: this.run.sessionId, ownerId: this.ownerId,
                kind: 'message', content: saved.ref, sourceRunId: this.run.id };
            added.push(entry); entries.push(entry);
        }
        const next: ContextSurface = { schemaVersion: 2, sessionId: this.run.sessionId, ownerId: this.ownerId,
            revision: (this.surface?.revision ?? 0) + 1, epoch: (this.surface?.epoch ?? 0) + (replacement || policyChanged ? 1 : 0),
            routeKey: this.routeKey, entryIds: entries.map(entry => entry.id),
            snapshotHashes: options.snapshotHashes ?? (replacement ? {} : this.surface?.snapshotHashes ?? {}),
            instructionHash: options.instructionHash ?? this.surface?.instructionHash ?? '',
            toolManifestHash: options.toolManifestHash ?? this.surface?.toolManifestHash ?? '',
            sourceFingerprint: options.sourceFingerprint, lastRunId: this.run.id, coverage,
            ...(options.metadata !== undefined ? { metadata: options.metadata } : this.surface?.metadata !== undefined ? { metadata: this.surface.metadata } : {}) };
        const savedState = this.journal.saveContent(this.run.sessionId, next);
        const timestamp = new Date().toISOString();
        const run = this.journal.identity(this.run);
        this.journal.commit({ contextUpdates: [{ expectedRevision: this.surface?.revision ?? null, surface: next, entries: added }] }, [
            { run, timestamp, type: 'context.surface', payload: { ownerId: this.ownerId, revision: next.revision, epoch: next.epoch,
                reason: options.reason, state: savedState.ref, entries: added.map(entry => entry.content) } },
            ...(options.compaction ? [{ run, timestamp, type: 'context.compaction' as const, payload: options.compaction }] : []),
        ]);
        this.surface = next; this.items = structuredClone([...history]); this.itemHashes = hashes; this.entries = entries; this.needsRewrite = false;
        return structuredClone(next);
    }
}
