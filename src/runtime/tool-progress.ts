import { createHash } from 'node:crypto';
import type { ToolOutcome, ToolProgressState } from '../shared/harness-contracts';

export interface ToolProgressObservation {
    name: string;
    arguments: string;
    outcome: ToolOutcome;
    content: string;
}
export type ToolProgressSnapshot = ToolProgressState;

/** Serialize complete JSON deterministically without invoking getters or toJSON. */
function canonical(value: unknown, depth = 0): string {
    if (depth > 128) throw new TypeError('Progress evidence is too deeply nested.');
    if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
    if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
    if (!value || typeof value !== 'object') throw new TypeError('Invalid progress evidence.');
    const array = Array.isArray(value);
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('Invalid progress evidence.');
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) throw new TypeError('Invalid progress evidence.');
    const entries: Array<[string, unknown]> = [];
    for (const key of keys) {
        if (array && key === 'length') continue;
        if (typeof key !== 'string') throw new TypeError('Invalid progress evidence.');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !('value' in descriptor)) throw new TypeError('Invalid progress evidence.');
        if (array && (!/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length)) throw new TypeError('Invalid progress evidence.');
        entries.push([key, descriptor.value]);
    }
    entries.sort(([a], [b]) => array ? Number(a) - Number(b) : a < b ? -1 : a > b ? 1 : 0);
    return array ? `[${entries.map(([, item]) => canonical(item, depth + 1)).join(',')}]`
        : `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`).join(',')}}`;
}
function argumentsFingerprint(raw: string): { json: string } | { raw: string } {
    try { return { json: canonical(JSON.parse(raw)) }; }
    catch { return { raw }; }
}
function fingerprint(batch: ToolProgressObservation[]): string {
    const serialized = canonical(batch.map(item => ({
        name: item.name,
        arguments: argumentsFingerprint(item.arguments),
        status: item.outcome.status,
        errorCode: item.outcome.errorCode,
        exitCode: item.outcome.exitCode,
        effectState: item.outcome.effectState,
        // Resource ordering is evidence-set ordering; invocation and wall-clock IDs are absent.
        resources: item.outcome.resources.map(resource => canonical(resource)).sort(),
        artifactRefs: item.outcome.artifactRefs,
        content: item.content,
    })));
    return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

/** Per-run failure accounting only. It never authorizes retries or reverses effects. */
export class ToolProgressGovernor {
    private failedBatches = 0;
    private repeatedFailureBatches = 0;
    private lastFailureFingerprint: string | null = null;

    observe(batch: ToolProgressObservation[]): ToolProgressSnapshot {
        if (!Array.isArray(batch) || batch.length === 0) throw new TypeError('A nonempty tool batch is required.');
        const failed = batch.some(item => item.outcome.status === 'failed' || item.outcome.status === 'denied');
        const repeatEligible = batch.every(item => (item.outcome.status === 'failed' || item.outcome.status === 'denied')
            && item.outcome.effectState === 'not_started');
        // Calculate before mutating counters so invalid evidence cannot consume a batch.
        const nextFingerprint = repeatEligible ? fingerprint(batch) : null;
        if (failed) this.failedBatches++;
        if (nextFingerprint !== null) {
            this.repeatedFailureBatches = this.lastFailureFingerprint === nextFingerprint ? this.repeatedFailureBatches + 1 : 1;
            this.lastFailureFingerprint = nextFingerprint;
        } else this.resetStreak();
        return this.snapshot();
    }

    resetStreak(): void {
        this.repeatedFailureBatches = 0;
        this.lastFailureFingerprint = null;
    }

    snapshot(): ToolProgressState {
        return { failedBatches: this.failedBatches, repeatedFailureBatches: this.repeatedFailureBatches,
            lastFailureFingerprint: this.lastFailureFingerprint,
            stopCode: this.repeatedFailureBatches >= 3 ? 'no_progress' : this.failedBatches >= 6 ? 'model_corrections' : null };
    }
}
