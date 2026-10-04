import type { RunRecord } from '../shared/contracts';
import type { ApiConnection, ApiProtocol } from '../shared/endpoints';
import type { RequestIdentity, RequestSnapshot, UsageRecord, JsonValue } from '../shared/harness-contracts';
import type { ApiUsage } from '../shared/tool-protocol';
import type { RequestObserver } from './api-transport';
import { RunJournal } from './run-journal';
import { redactJournalValue } from './journal-artifacts';
import { mergeUsageSnapshot, normalizeProviderUsage } from './context/usage-normalizer';

const ADAPTER_VERSION = 'uah-api-v1';
const REDACTION_POLICY_VERSION = 'uah-journal-v2';
const MAX_FRAME_BYTES = 16_000_000;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
type Frame = { event?: string; data: string };
type Leaf = { owner: Record<string, unknown>; key: string; text: string };

/** Mask character ranges across related text leaves before anything reaches disk.
 * Same-length masks preserve each frame's partition; opaque metadata is not joined.
 */
function maskSplitSecrets(values: unknown[], secret: string): boolean {
    if (!secret) return false;
    const channels = new Map<string, Leaf[]>();
    const visit = (value: unknown, channel = ''): void => {
        if (Array.isArray(value)) { value.forEach(item => visit(item, channel)); return; }
        if (!record(value)) return;
        const type = typeof value.type === 'string' ? value.type : '';
        const index = value.index ?? value.output_index;
        const scope = typeof index === 'number' ? `${channel}:${index}` : channel;
        for (const [key, child] of Object.entries(value)) {
            let category: string | undefined;
            if (['text', 'content'].includes(key)) category = 'text';
            else if (['thinking', 'reasoning_content'].includes(key)) category = 'reasoning';
            else if (['partial_json', 'arguments'].includes(key)) category = 'arguments';
            else if (key === 'delta' && /function_call_arguments\.delta$/.test(type)) category = 'arguments';
            else if (key === 'delta' && /(?:text|refusal|reasoning).*\.delta$/.test(type)) category = type.includes('reasoning') ? 'reasoning' : 'text';
            if (category && typeof child === 'string') {
                const name = `${scope}:${category}`;
                const leaves = channels.get(name) ?? []; leaves.push({ owner: value, key, text: child }); channels.set(name, leaves);
            } else visit(child, scope);
        }
    };
    values.forEach(value => visit(value));
    let changed = false;
    for (const leaves of channels.values()) {
        const joined = leaves.map(leaf => leaf.text).join('');
        const ranges: Array<{ start: number; end: number }> = [];
        for (let at = joined.indexOf(secret); at >= 0; at = joined.indexOf(secret, at + 1)) ranges.push({ start: at, end: at + secret.length });
        if (!ranges.length) continue;
        changed = true;
        let offset = 0;
        for (const leaf of leaves) {
            let masked = leaf.text;
            for (const range of ranges) {
                const start = Math.max(0, range.start - offset); const end = Math.min(masked.length, range.end - offset);
                if (start < end) masked = masked.slice(0, start) + '*'.repeat(end - start) + masked.slice(end);
            }
            leaf.owner[leaf.key] = masked; offset += leaf.text.length;
        }
    }
    return changed;
}

function sanitize(value: unknown, secret: string): { value: JsonValue; changed: boolean } {
    const clone: unknown = structuredClone(value);
    const splitChanged = maskSplitSecrets([clone], secret);
    const result = redactJournalValue(clone, secret ? [secret] : []);
    return { value: result.value, changed: splitChanged || result.changed };
}

/** Durable boundaries for one provider attempt; frame batching has an explicit crash-tail gap. */
export class RequestJournal {
    readonly observer: RequestObserver;
    private readonly frames: Frame[] | null;
    private readonly captureRaw: boolean;
    private frameBytes = 0;
    private rawUsage: JsonValue = null;
    private usageRevision = 0;
    private prepared = false;
    private dispatched = false;
    private terminalRecorded = false;
    private terminalStatus: 'completed' | 'failed' | 'cancelled' | null = null;
    private nativeRecorded = false;
    private responseRedacted = false;
    private textTail = '';
    private textOffset: number | null = null;
    private textBaseOffset: number | null = null;
    private textNextOffset: number | null = null;
    private textRun: RunRecord | null = null;
    constructor(private readonly journal: RunJournal, private readonly run: RunRecord,
        private readonly identity: RequestIdentity, private readonly connection: ApiConnection,
        private readonly options: { purpose?: UsageRecord['purpose']; scope?: UsageRecord['scope']; captureRaw?: boolean } = {}) {
        if (identity.sessionId !== run.sessionId || identity.runId !== run.id || identity.turnId !== run.turnId) throw new Error('Request identity mismatch');
        this.captureRaw = options.captureRaw !== false;
        this.frames = this.captureRaw ? [] : null;
        this.observer = {
            prepared: (body, protocol) => this.prepare(body, protocol),
            dispatch: () => {
                if (!this.prepared || this.dispatched || this.terminalRecorded) throw new Error('Invalid request dispatch boundary');
                this.journal.admit(this.run.sessionId);
                this.journal.event(this.run, 'request.dispatch', this.attempt()); this.dispatched = true;
            },
            responseStarted: () => {
                if (!this.dispatched || this.terminalRecorded) throw new Error('Invalid response boundary');
                this.journal.event(this.run, 'response.started', this.attempt());
            },
            providerEvent: event => this.frame(event),
            terminal: status => this.terminal(status),
        };
        // Even an attempt failing before preparation has an unknown usage ledger entry.
        this.usage({});
    }
    private attempt() { return { requestId: this.identity.requestId, attemptId: this.identity.attemptId }; }
    /** Hold only the secret-length tail so canonical deltas cannot persist a split key. */
    text(run: RunRecord, text: string, offset: number): void {
        if (this.terminalRecorded || run.id !== this.run.id || run.sessionId !== this.run.sessionId
            || !Number.isSafeInteger(offset) || offset < 0 || (this.textNextOffset !== null && offset !== this.textNextOffset)) {
            throw new Error('Invalid response text offset');
        }
        this.textOffset ??= offset;
        this.textBaseOffset ??= offset;
        this.textNextOffset = offset + text.length;
        this.textRun = run;
        const secret = this.connection.apiKey;
        const joined = this.textTail + text;
        let masked = joined;
        if (secret) {
            const indices: number[] = [];
            for (let at = joined.indexOf(secret); at >= 0; at = joined.indexOf(secret, at + 1)) indices.push(at);
            if (indices.length) this.responseRedacted = true;
            for (const at of indices) masked = masked.slice(0, at) + '*'.repeat(secret.length) + masked.slice(at + secret.length);
        }
        const safeLength = Math.max(0, masked.length - Math.max(0, secret.length - 1));
        if (safeLength) this.writeText(run, masked.slice(0, safeLength));
        this.textTail = masked.slice(safeLength);
    }
    private writeText(run: RunRecord, text: string): void {
        this.journal.delta(run, { ...this.attempt(), blockId: `${this.identity.attemptId}:text`,
            offset: this.textOffset! - this.textBaseOffset!, offsetUnit: 'utf16', text });
        this.textOffset! += text.length;
    }
    private prepare(body: Record<string, unknown>, protocol: ApiProtocol): void {
        if (this.prepared || this.terminalRecorded || protocol !== this.connection.protocol) throw new Error('Invalid request preparation');
        const clean = this.captureRaw ? sanitize(body, this.connection.apiKey) : { value: null, changed: false };
        const snapshot: RequestSnapshot = { schemaVersion: 1, identity: this.identity, protocol,
            adapterVersion: ADAPTER_VERSION, capturedAt: new Date().toISOString(), body: clean.value,
            artifacts: [], coverage: !this.captureRaw || clean.changed ? 'partial' : 'complete', redactionPolicyVersion: REDACTION_POLICY_VERSION,
            ...(!this.captureRaw ? { bodyCapture: 'disabled' as const } : {}) };
        const saved = this.journal.artifactStore(this.run.sessionId).save(snapshot, [this.connection.apiKey], true);
        this.journal.event(this.run, 'request.intent', { identity: this.identity, snapshot: saved.ref });
        this.prepared = true;
    }
    private frame(event: Frame): void {
        if (!this.dispatched || this.terminalRecorded) throw new Error('Provider frame outside request');
        const bytes = Buffer.byteLength(event.data, 'utf8') + Buffer.byteLength(event.event ?? '', 'utf8');
        if (this.frameBytes + bytes > MAX_FRAME_BYTES) throw new Error('Provider frame recording limit exceeded');
        this.frames?.push({ ...event }); this.frameBytes += bytes;
        let payload: unknown;
        try { payload = JSON.parse(event.data); } catch { return; } // DONE or malformed data still belongs in the frame artifact.
        if (!record(payload)) return;
        const raw = this.connection.protocol === 'openai-responses' && record(payload.response) ? payload.response.usage
            : this.connection.protocol === 'anthropic' && record(payload.message) ? payload.message.usage : payload.usage;
        if (record(raw)) this.rawUsage = sanitize(mergeUsageSnapshot(record(this.rawUsage) ? this.rawUsage : {}, raw), this.connection.apiKey).value;
    }
    usage(normalized: ApiUsage): void {
        const count = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
        const counters = { inputTokens: count(normalized.inputTokens), outputTokens: count(normalized.outputTokens),
            cachedInputTokens: count(normalized.cachedInputTokens), cacheCreationInputTokens: count(normalized.cacheCreationInputTokens), totalTokens: count(normalized.totalTokens) };
        const supplied = Object.values(counters).filter(value => value !== null).length;
        const evidence = normalizeProviderUsage(this.connection.protocol, this.rawUsage, normalized);
        const usage: UsageRecord = { schemaVersion: 1, ...this.attempt(), revision: ++this.usageRevision,
            purpose: this.options.purpose ?? 'agent', scope: this.options.scope ?? { kind: 'session', sessionId: this.run.sessionId, runId: this.run.id },
            protocol: this.connection.protocol, adapterVersion: ADAPTER_VERSION,
            source: this.rawUsage === null ? 'unavailable' : 'provider', completeness: supplied === 0 ? 'unknown' : evidence.coverage,
            rawUsage: this.rawUsage, counters, providerResponseId: null, accountNamespace: this.connection.id,
            normalization: { version: 1, sourcePaths: evidence.sourcePaths, diagnostics: evidence.diagnostics,
                inputUncachedTokens: evidence.inputUncachedTokens ?? null, reasoningTokens: evidence.reasoningTokens ?? null },
            reportedCost: null, estimatedCost: null };
        this.journal.event(this.run, 'usage.snapshot', { usage });
    }
    private terminal(status: 'completed' | 'failed' | 'cancelled'): void {
        if (this.terminalRecorded) throw new Error('Response terminal already recorded');
        if (this.textTail && this.textRun) {
            this.writeText(this.textRun, this.textTail);
            this.textTail = '';
        }
        const capturedFrames = this.frames;
        if (capturedFrames?.length) {
            const parsed: unknown[] = capturedFrames.map(frame => { try { return JSON.parse(frame.data); } catch { return frame.data; } });
            const splitChanged = maskSplitSecrets(parsed, this.connection.apiKey);
            let redacted = splitChanged;
            const frames = parsed.map((value, index) => {
                const clean = redactJournalValue(value, [this.connection.apiKey]); redacted ||= clean.changed;
                return { ...capturedFrames[index], data: typeof value === 'string' ? clean.value as string : JSON.stringify(clean.value) };
            });
            this.responseRedacted ||= redacted;
            const saved = this.journal.artifactStore(this.run.sessionId).save({ schemaVersion: 1, ...this.attempt(),
                encoding: 'application_sse_frames', frames, captureCoverage: status === 'completed' && !redacted ? 'complete' : 'partial', crashTailRisk: status !== 'completed',
                redacted, continuationCoverage: redacted ? 'unavailable' : 'native' }, [], true);
            this.journal.event(this.run, 'provider.frame', { ...this.attempt(), frame: saved.ref });
            capturedFrames.length = 0; this.frameBytes = 0;
        }
        this.journal.event(this.run, 'response.terminal', { ...this.attempt(), status, partial: !this.captureRaw || status !== 'completed' || this.responseRedacted });
        this.terminalRecorded = true;
        this.terminalStatus = status;
    }
    completed(continuation: unknown[]) {
        if (this.terminalStatus !== 'completed' || this.nativeRecorded) throw new Error('Invalid native continuation boundary');
        const clean = sanitize(continuation, this.connection.apiKey);
        const saved = this.journal.artifactStore(this.run.sessionId).save({ schemaVersion: 1, continuation: clean.value,
            continuationCoverage: clean.changed ? 'unavailable' : 'native', captureCoverage: !this.captureRaw || clean.changed ? 'partial' : 'complete',
            ...(!this.captureRaw ? { rawCapture: 'disabled' } : {}) }, [], true);
        this.journal.event(this.run, 'response.native', { ...this.attempt(), content: saved.ref });
        this.nativeRecorded = true;
        return { ref: saved.ref, continuationCoverage: clean.changed ? 'unavailable' as const : 'native' as const };
    }
}
