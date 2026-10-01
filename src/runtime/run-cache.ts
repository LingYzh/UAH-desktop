import type { RunRecord } from '../shared/contracts';

/** Bounded terminal history cache. Live and unpersistable failure views stay resident. */
export class RunCache {
    private readonly records = new Map<string, RunRecord>();
    private readonly lru = new Map<string, true>();
    private readonly revisions = new Map<string, number>();
    private readonly failedViews = new Set<string>();

    constructor(private readonly load: (id: string) => RunRecord | undefined,
        private readonly loadSession: (id: string) => RunRecord[], private readonly terminalLimit = 128) {
        if (!Number.isSafeInteger(terminalLimit) || terminalLimit < 1) throw new TypeError('Invalid terminal cache limit');
    }

    get(id: string): RunRecord | undefined {
        const found = this.records.get(id);
        if (found) { this.touch(found); return found; }
        const saved = this.load(id);
        if (saved) { this.records.set(id, saved); this.touch(saved); }
        return saved;
    }

    has(id: string): boolean { return this.get(id) !== undefined; }

    set(id: string, run: RunRecord): void {
        if (id !== run.id) throw new Error('Run cache identity mismatch');
        this.records.set(id, run);
        this.revisions.set(run.sessionId, this.revision(run.sessionId) + 1);
        // A failed authority commit can leave the only truthful final view in memory.
        if (run.harnessState === 'recording_failed') this.failedViews.add(id);
        this.touch(run);
    }

    revision(sessionId: string): number { return this.revisions.get(sessionId) ?? 0; }

    forSession(sessionId: string): RunRecord[] { return this.overlay(this.loadSession(sessionId), sessionId); }

    /** Overlay buffered live deltas without retaining each historical record read by a query. */
    overlay(saved: RunRecord[], sessionId?: string): RunRecord[] {
        const result = saved.map(run => this.records.get(run.id) ?? run);
        const known = new Set(saved.map(run => run.id));
        for (const run of this.records.values()) if (!known.has(run.id) && (sessionId === undefined || run.sessionId === sessionId)) result.push(run);
        return result;
    }

    residentCount(): number { return this.records.size; }
    forgetSession(sessionId: string): void {
        for (const [id, run] of this.records) if (run.sessionId === sessionId) { this.records.delete(id); this.lru.delete(id); this.failedViews.delete(id); }
        this.revisions.delete(sessionId);
    }
    residentRecords(): RunRecord[] { return [...this.records.values()]; }

    private touch(run: RunRecord): void {
        this.lru.delete(run.id);
        if (['completed', 'failed', 'stopped'].includes(run.state) && !this.failedViews.has(run.id)) this.lru.set(run.id, true);
        while (this.lru.size > this.terminalLimit) {
            const oldest = this.lru.keys().next().value!;
            this.lru.delete(oldest); this.records.delete(oldest);
        }
    }
}
