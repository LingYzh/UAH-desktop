import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, parse, relative, resolve } from 'node:path';
import type { ArtifactReference, ToolProgressState, TranscriptManifest, UsageCounters, UsageRecord } from '../shared/harness-contracts';
import { redactJournalValue } from './journal-artifacts';
import { requestEvents } from './request-events';

export interface OfflineLimits {
    maxManifestBytes: number;
    maxTranscriptBytes: number;
    maxArtifactBytes: number;
    maxTotalBytes: number;
    maxEvents: number;
    maxFiles: number;
    maxJsonDepth: number;
    maxJsonNodes: number;
}
export const DEFAULT_OFFLINE_LIMITS: Readonly<OfflineLimits> = Object.freeze({
    maxManifestBytes: 16 * 1024 * 1024, maxTranscriptBytes: 128 * 1024 * 1024,
    maxArtifactBytes: 32 * 1024 * 1024, maxTotalBytes: 256 * 1024 * 1024,
    maxEvents: 100_000, maxFiles: 10_000, maxJsonDepth: 64, maxJsonNodes: 2_000_000,
});

/** Unknown v1 types are retained as data. This module has no network or executor. */
export interface OfflineEvent {
    schemaVersion: 1; eventId: string; sessionSeq: number; timestamp: string; processEpochId: string;
    run: { sessionId: string; runId: string; parentRunId: string | null; rootRunId: string; turnId: string };
    type: string; payload: Record<string, unknown>;
}
export interface ValidationReport {
    sessionId: string; targetSeq: number; durableSeq: number; eventCount: number;
    artifactCount: number; presentArtifacts: number; partial: boolean; warnings: string[];
}
interface Loaded {
    directory: string; manifest: TranscriptManifest; events: OfflineEvent[];
    refs: ArtifactReference[]; artifacts: Map<string, Buffer>; report: ValidationReport; limits: OfflineLimits;
}
const TYPES = new Set(['message.accepted', 'history.revised', 'history.frame', 'history.branch', 'run.state', 'request.intent', 'request.sent',
    'request.dispatch', 'request.retry', 'provider.frame', 'response.native', 'artifact.created', 'response.started', 'response.delta',
    'response.terminal', 'tool.batch', 'approval.decided', 'approval.requested', 'tool.dispatch', 'tool.result',
    'usage.snapshot', 'budget.updated', 'progress.updated', 'context.admission', 'plan.version', 'permission.changed', 'control.requested', 'control.applied', 'delegation.delivery',
    'context.compaction', 'recording.checkpoint', 'recovery.reviewed', 'recovery.resumed', 'goal.verified']);
const COUNTERS = ['inputTokens', 'outputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'totalTokens'] as const;

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label}`);
    return value as Record<string, unknown>;
}
function text(value: unknown, label: string): string {
    if (typeof value !== 'string' || !value) throw new Error(`Invalid ${label}`);
    return value;
}
function integer(value: unknown, label: string, minimum = 0): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${label}`);
    return value;
}
function canonical(value: unknown): string {
    if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
    return JSON.stringify(value);
}
function safeRelative(path: string): void {
    if (!path || /[\\:\u0000]/.test(path) || path.split('/').some(part => !part || part === '.' || part === '..'
        || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe artifact path: ${path}`);
}
function plainPath(path: string, file = false): void {
    const absolute = resolve(path); const root = parse(absolute).root;
    let cursor = root;
    const parts = absolute.slice(root.length).split(/[\\/]/).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
        cursor = join(cursor, parts[i]);
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink()) throw new Error(`Unsafe symbolic link: ${cursor}`);
        const final = i === parts.length - 1;
        if (final && file) {
            if (!stat.isFile() || stat.nlink !== 1) throw new Error(`Unsafe linked or non-regular file: ${cursor}`);
        } else if (!stat.isDirectory()) throw new Error(`Unsafe directory: ${cursor}`);
    }
}
function pathExists(path: string): boolean {
    try { lstatSync(path); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function boundedRead(path: string, maximum: number): Buffer {
    plainPath(path, true);
    const stat = lstatSync(path);
    if (stat.size > maximum) throw new Error(`Offline file exceeds byte limit: ${path}`);
    const bytes = readFileSync(path);
    if (bytes.length > maximum || bytes.length !== stat.size) throw new Error(`Offline file changed during read: ${path}`);
    return bytes;
}
function parseJson(bytes: Buffer | string, limits: OfflineLimits, label: string): unknown {
    let value: unknown;
    try {
        const source = typeof bytes === 'string' ? bytes : new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        value = JSON.parse(source);
    } catch (error) { throw new Error(`Invalid JSON in ${label}`, { cause: error }); }
    const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
    let nodes = 0;
    while (stack.length) {
        const item = stack.pop()!;
        if (++nodes > limits.maxJsonNodes || item.depth > limits.maxJsonDepth) throw new Error(`JSON complexity limit in ${label}`);
        if (item.value && typeof item.value === 'object') {
            for (const child of Object.values(item.value)) stack.push({ value: child, depth: item.depth + 1 });
        }
    }
    return value;
}
function artifactRef(value: Record<string, unknown>): ArtifactReference | null {
    if (!['present', 'missing', 'external_reference_only'].includes(String(value.availability))) return null;
    const mediaType = text(value.mediaType, 'artifact mediaType');
    if (value.availability === 'external_reference_only') {
        if (value.relativePath !== null || value.sha256 !== null || value.byteLength !== null) throw new Error('Invalid external artifact');
        return { availability: 'external_reference_only', mediaType, relativePath: null, sha256: null, byteLength: null,
            externalReference: text(value.externalReference, 'externalReference'), missingReason: text(value.missingReason, 'missingReason') };
    }
    const relativePath = text(value.relativePath, 'artifact relativePath'); safeRelative(relativePath);
    const sha256 = value.sha256;
    if (!(value.availability === 'missing' && sha256 === null) && (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256))) throw new Error('Invalid artifact hash');
    const byteLength = value.byteLength === null && value.availability === 'missing' ? null : integer(value.byteLength, 'artifact byteLength');
    if (value.availability === 'present') {
        if (value.missingReason !== null) throw new Error('Invalid present artifact');
        return { availability: 'present', mediaType, relativePath, sha256: sha256 as string, byteLength: byteLength!, missingReason: null };
    }
    return { availability: 'missing', mediaType, relativePath, sha256: sha256 as string | null, byteLength, missingReason: text(value.missingReason, 'missingReason') };
}
function discoverRefs(value: unknown): ArtifactReference[] {
    const refs: ArtifactReference[] = []; const pending: unknown[] = [value];
    while (pending.length) {
        const current = pending.pop();
        if (!current || typeof current !== 'object') continue;
        if (!Array.isArray(current)) {
            const ref = artifactRef(current as Record<string, unknown>);
            if (ref) { refs.push(ref); continue; }
        }
        for (const child of Object.values(current)) pending.push(child);
    }
    return refs;
}
function envelope(value: unknown, sessionId: string, seq: number): OfflineEvent {
    const e = object(value, 'event');
    if (e.schemaVersion !== 1) throw new Error('Unsupported event schema version');
    if (integer(e.sessionSeq, 'sessionSeq', 1) !== seq) throw new Error(`Non-contiguous transcript sequence: expected ${seq}`);
    text(e.eventId, 'eventId'); text(e.processEpochId, 'processEpochId'); text(e.type, 'event type');
    if (!Number.isFinite(Date.parse(text(e.timestamp, 'timestamp')))) throw new Error('Invalid event timestamp');
    const run = object(e.run, 'run');
    if (run.sessionId !== sessionId) throw new Error('Event session mismatch');
    text(run.runId, 'runId'); text(run.rootRunId, 'rootRunId'); text(run.turnId, 'turnId');
    if (run.parentRunId !== null) text(run.parentRunId, 'parentRunId');
    object(e.payload, 'event payload');
    return e as unknown as OfflineEvent;
}
function load(directory: string, overrides: Partial<OfflineLimits> = {}): Loaded {
    const limits = { ...DEFAULT_OFFLINE_LIMITS, ...overrides };
    for (const value of Object.values(limits)) integer(value, 'offline limit', 1);
    directory = resolve(directory); plainPath(directory);
    const manifestBytes = boundedRead(join(directory, 'manifest.json'), limits.maxManifestBytes);
    const raw = object(parseJson(manifestBytes, limits, 'manifest'), 'manifest');
    if (raw.schemaVersion !== 1) throw new Error('Unsupported manifest schema version');
    const sessionId = text(raw.sessionId, 'sessionId');
    const targetSeq = integer(raw.exportedSeq, 'exportedSeq'); const durableSeq = integer(raw.durableSeq, 'durableSeq');
    if (targetSeq > durableSeq || targetSeq > limits.maxEvents) throw new Error('Invalid or excessive manifest watermark');
    if (!Array.isArray(raw.artifacts) || !Array.isArray(raw.segments) || !Array.isArray(raw.retainedRanges)) throw new Error('Invalid manifest arrays');
    if (raw.segments.length + 2 > limits.maxFiles) throw new Error('Offline segment-count limit exceeded');
    if (!['complete', 'partial', 'legacy_partial'].includes(String(raw.captureCoverage))
        || !['native', 'public_only', 'unavailable'].includes(String(raw.continuationCoverage))
        || !['stopped', 'needs_reconciliation', 'eligible_for_review'].includes(String(raw.recovery))) throw new Error('Invalid manifest coverage');
    text(raw.redactionPolicyVersion, 'redactionPolicyVersion');
    for (const range of raw.retainedRanges) {
        const r = object(range, 'retained range'); const first = integer(r.firstSeq, 'firstSeq', 1); const last = integer(r.lastSeq, 'lastSeq', 1);
        if (first > last || last > durableSeq) throw new Error('Invalid retained range');
    }
    if (targetSeq && !raw.retainedRanges.some(range => { const r = object(range, 'retained range'); return r.firstSeq === 1 && Number(r.lastSeq) >= targetSeq; })) throw new Error('Manifest does not retain the target transcript range');
    const logParts: Buffer[] = [], segmentPaths = new Set<string>();
    let segmentEnd = 0, transcriptBytes = 0;
    for (const value of raw.segments) {
        const segment = object(value, 'segment');
        const path = text(segment.relativePath, 'segment path'); safeRelative(path);
        if (!path.startsWith('segments/') || !path.endsWith('.jsonl') || segmentPaths.has(path.toLowerCase())) throw new Error('Invalid or duplicate segment path');
        segmentPaths.add(path.toLowerCase());
        const first = integer(segment.firstSeq, 'segment firstSeq', 1), last = integer(segment.lastSeq, 'segment lastSeq', 1);
        if (first !== segmentEnd + 1 || last < first || last > targetSeq) throw new Error('Segment ranges are not contiguous within the export watermark');
        if (typeof segment.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(segment.sha256)) throw new Error('Invalid segment hash');
        const bytes = boundedRead(join(directory, path), limits.maxTranscriptBytes - transcriptBytes);
        if (!bytes.length || bytes.at(-1) !== 10 || createHash('sha256').update(bytes).digest('hex') !== segment.sha256.toLowerCase()) throw new Error('Segment integrity mismatch');
        let rows = 0;
        for (let offset = bytes.indexOf(10); offset !== -1; offset = bytes.indexOf(10, offset + 1)) rows++;
        if (rows !== last - first + 1) throw new Error('Segment row count does not match declared range');
        logParts.push(bytes); transcriptBytes += bytes.length; segmentEnd = last;
    }
    const tail = boundedRead(join(directory, 'transcript.jsonl'), limits.maxTranscriptBytes - transcriptBytes);
    logParts.push(tail);
    const logBytes = Buffer.concat(logParts);
    if (logBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) throw new Error('Transcript BOM is not permitted');
    const events: OfflineEvent[] = []; const ids = new Set<string>(); let offset = 0;
    const warnings: string[] = [];
    for (let seq = 1; seq <= targetSeq; seq++) {
        const end = logBytes.indexOf(10, offset);
        if (end < 0) throw new Error('Transcript target has a missing or incomplete row');
        let line: string;
        try { line = new TextDecoder('utf-8', { fatal: true }).decode(logBytes.subarray(offset, end)); }
        catch { throw new Error('Invalid transcript UTF-8'); }
        offset = end + 1;
        if (!line || line.includes('\r')) throw new Error('Transcript must contain canonical LF JSON rows');
        const event = envelope(parseJson(line, limits, `event ${seq}`), sessionId, seq);
        if (ids.has(event.eventId)) throw new Error('Duplicate transcript eventId');
        ids.add(event.eventId); events.push(event);
        if (!TYPES.has(event.type)) warnings.push(`unknown_event:${event.type}`);
    }
    if (offset < logBytes.length) warnings.push('ignored_tail_after_target');
    if (targetSeq < durableSeq) warnings.push('jsonl_lags_durable');
    const refs = new Map<string, ArtifactReference>();
    for (const value of raw.artifacts) {
        const ref = artifactRef(object(value, 'manifest artifact'));
        if (!ref) throw new Error('Invalid manifest artifact'); refs.set(canonical(ref), ref);
    }
    for (const event of events) for (const ref of discoverRefs(event.payload)) {
        if (!refs.has(canonical(ref))) throw new Error(`Artifact reference missing from manifest at seq ${event.sessionSeq}`);
    }
    if (refs.size + 2 + raw.segments.length > limits.maxFiles) throw new Error('Offline file-count limit exceeded');
    const artifacts = new Map<string, Buffer>(); const paths = new Map<string, string>();
    let totalBytes = manifestBytes.length + logBytes.length;
    if (totalBytes > limits.maxTotalBytes) throw new Error('Offline total byte limit exceeded');
    for (const ref of refs.values()) {
        if (ref.availability !== 'present') { warnings.push(`artifact_${ref.availability}`); continue; }
        const previous = paths.get(ref.relativePath);
        if (previous && previous !== ref.sha256) throw new Error('Conflicting artifact hashes for the same path');
        paths.set(ref.relativePath, ref.sha256);
        let bytes = artifacts.get(ref.relativePath);
        if (!bytes) {
            if (ref.byteLength > limits.maxArtifactBytes || totalBytes + ref.byteLength > limits.maxTotalBytes) throw new Error('Offline artifact byte limit exceeded');
            try { bytes = boundedRead(join(directory, ref.relativePath), limits.maxArtifactBytes); }
            catch (error) { throw new Error(`Artifact missing or unsafe: ${ref.relativePath}`, { cause: error }); }
            totalBytes += bytes.length; artifacts.set(ref.relativePath, bytes);
        }
        if (bytes.length !== ref.byteLength || createHash('sha256').update(bytes).digest('hex').toLowerCase() !== ref.sha256.toLowerCase()) throw new Error(`Artifact integrity mismatch: ${ref.relativePath}`);
    }
    // Public JSON can itself contain references. Validate the entire graph before
    // exporting it; opaque native blocks remain uninterpreted.
    const checked = new Map<string, number>(); const visiting = new Set<string>();
    const verifyClosure = (ref: ArtifactReference, depth: number): number => {
        const key = canonical(ref);
        if (visiting.has(key)) throw new Error('Cyclic public artifact references');
        if (depth > limits.maxJsonDepth) throw new Error('Public artifact reference depth limit exceeded');
        const cached = checked.get(key);
        if (cached !== undefined) {
            if (depth + cached > limits.maxJsonDepth) throw new Error('Public artifact reference depth limit exceeded');
            return cached;
        }
        visiting.add(key);
        let height = 0;
        if (ref.availability === 'present' && !restricted(ref) && (ref.mediaType === 'application/json' || ref.mediaType.endsWith('+json'))) {
            const value = parseJson(artifacts.get(ref.relativePath)!, limits, 'public artifact references');
            for (const child of discoverRefs(value)) {
                if (!refs.has(canonical(child))) throw new Error(`Nested artifact reference missing from manifest: ${ref.relativePath}`);
                height = Math.max(height, 1 + verifyClosure(child, depth + 1));
            }
        }
        visiting.delete(key); checked.set(key, height);
        return height;
    };
    for (const ref of refs.values()) verifyClosure(ref, 0);
    const manifest = raw as unknown as TranscriptManifest;
    const report = { sessionId, targetSeq, durableSeq, eventCount: events.length,
        artifactCount: refs.size, presentArtifacts: artifacts.size,
        partial: manifest.captureCoverage !== 'complete' || warnings.length > 0, warnings: [...new Set(warnings)] };
    return { directory, manifest, events, refs: [...refs.values()], artifacts, report, limits };
}

export function validateTranscript(directory: string, limits?: Partial<OfflineLimits>): ValidationReport {
    return load(directory, limits).report;
}

/** Runtime maintenance uses the same validated transitive closure as export.
 * This is deliberately read-only; callers must quiesce the owning session. */
export function retainedArtifactPaths(directory: string): string[] {
    const loaded = load(directory);
    if (loaded.report.warnings.length || loaded.manifest.captureCoverage === 'legacy_partial') {
        throw new Error('旧记录、未知事件、缺失引用或未追平的日志不能执行引用清理。');
    }
    return [...loaded.manifest.segments.map(segment => segment.relativePath),
        ...loaded.refs.flatMap(ref => ref.relativePath === null ? [] : [ref.relativePath])];
}

export interface UsageStats {
    attempts: number; unknownAttempts: number; knownSubtotals: UsageCounters;
    records: UsageRecord[]; byDay: Array<{ day: string; attempts: number; unknownAttempts: number; knownSubtotals: UsageCounters }>;
}
export function usageStats(events: OfflineEvent[]): UsageStats {
    const revisions = new Map<string, Map<number, string>>();
    const latest = new Map<string, { usage: UsageRecord; timestamp: string }>();
    for (const event of events) {
        if (event.type !== 'usage.snapshot') continue;
        const raw = object(event.payload.usage, 'usage');
        if (raw.schemaVersion !== 1) throw new Error('Unsupported usage schema');
        const key = JSON.stringify([text(raw.accountNamespace, 'accountNamespace'), text(raw.requestId, 'requestId'), text(raw.attemptId, 'attemptId')]);
        const revision = integer(raw.revision, 'usage revision');
        const counters = object(raw.counters, 'usage counters');
        for (const field of COUNTERS) if (counters[field] !== null && counters[field] !== undefined) integer(counters[field], field);
        const normalized = { ...raw, counters: Object.fromEntries(COUNTERS.map(field => [field, counters[field] ?? null])) } as unknown as UsageRecord;
        const signature = canonical(normalized);
        let seen = revisions.get(key); if (!seen) { seen = new Map(); revisions.set(key, seen); }
        const previous = seen.get(revision);
        if (previous && previous !== signature) throw new Error(`Conflicting usage revision for ${key}`);
        seen.set(revision, signature);
        if (!latest.has(key) || latest.get(key)!.usage.revision < revision) latest.set(key, { usage: normalized, timestamp: event.timestamp });
    }
    const totals = (): UsageCounters => ({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheCreationInputTokens: 0, totalTokens: 0 });
    const knownSubtotals = totals();
    const days = new Map<string, UsageStats['byDay'][number]>(); let unknownAttempts = 0;
    for (const { usage, timestamp } of latest.values()) {
        const unknown = usage.source === 'unavailable' || usage.completeness !== 'complete' || COUNTERS.some(field => usage.counters[field] === null);
        if (unknown) unknownAttempts++;
        const day = new Date(timestamp).toISOString().slice(0, 10);
        let daily = days.get(day); if (!daily) { daily = { day, attempts: 0, unknownAttempts: 0, knownSubtotals: totals() }; days.set(day, daily); }
        daily.attempts++; if (unknown) daily.unknownAttempts++;
        for (const field of COUNTERS) if (usage.counters[field] !== null) {
            const sum = knownSubtotals[field]! + usage.counters[field]!;
            if (!Number.isSafeInteger(sum)) throw new Error('Usage total exceeds safe integer range');
            knownSubtotals[field] = sum; daily.knownSubtotals[field] = daily.knownSubtotals[field]! + usage.counters[field]!;
        }
    }
    return { attempts: latest.size, unknownAttempts, knownSubtotals, records: [...latest.values()].map(item => item.usage), byDay: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)) };
}
export function statsTranscript(directory: string, limits?: Partial<OfflineLimits>): UsageStats & { validation: ValidationReport } {
    const loaded = load(directory, limits); return { validation: loaded.report, ...usageStats(loaded.events) };
}
export function usageCsv(stats: UsageStats): string {
    const header = ['day', 'attempts', 'unknownAttempts', ...COUNTERS].join(',');
    return header + '\n' + stats.byDay.map(row => [row.day, row.attempts, row.unknownAttempts, ...COUNTERS.map(field => row.knownSubtotals[field] ?? '')].join(',')).join('\n') + (stats.byDay.length ? '\n' : '');
}
export function traceTranscript(directory: string, requestId: string, limits?: Partial<OfflineLimits>): { validation: ValidationReport; events: OfflineEvent[] } {
    const loaded = load(directory, limits);
    return { validation: loaded.report, events: requestEvents(loaded.events, requestId) };
}
export function replayTranscript(directory: string, limits?: Partial<OfflineLimits>) {
    const loaded = load(directory, limits);
    type Steering = { id: string; expectedStepId: string; input: string; status: 'queued' | 'applied' };
    const runs = new Map<string, { runId: string; parentRunId: string | null; rootRunId: string; state: string | null; steering: Steering[]; toolProgress?: ToolProgressState; resumeOfRunId?: string }>();
    const recoveryReviews: Array<{ reviewId: string; throughSeq: number; runIds: string[]; evidence: unknown }> = [];
    const goalVerifications: Array<{ runId: string; verificationId: string; method: 'user_review'; evidence: unknown; freshness: 'not_checked_offline' }> = [];
    const blocks = new Map<string, { runId: string; requestId: string; attemptId: string; blockId: string; text: string }>();
    const messages: Array<{ messageId: string; revision: number; role: string; text: string | null; runId?: string; controlId?: string; status?: 'queued' | 'applied' }> = [];
    const revisions = new Map<string, { revision: number; deleted: boolean; text: string | null }>();
    const branches: Array<{ sourceRunId: string; turns: unknown[] | null }> = [];
    const publicJson = (value: unknown): unknown => {
        const ref = artifactRef(object(value, 'public content'));
        if (!ref || ref.availability !== 'present' || restricted(ref)) return null;
        return parseJson(loaded.artifacts.get(ref.relativePath)!, loaded.limits, 'public content');
    };
    for (const event of loaded.events) {
        const prior = runs.get(event.run.runId);
        if (prior && (prior.parentRunId !== event.run.parentRunId || prior.rootRunId !== event.run.rootRunId)) throw new Error('Conflicting replay run identity');
        if (!prior) runs.set(event.run.runId, { runId: event.run.runId, parentRunId: event.run.parentRunId, rootRunId: event.run.rootRunId, state: null, steering: [] });
        if (event.type === 'run.state') runs.get(event.run.runId)!.state = text(event.payload.state, 'run state');
        if (event.type === 'recovery.resumed') {
            runs.get(event.run.runId)!.resumeOfRunId = text(event.payload.sourceRunId, 'resume source');
        }
        if (event.type === 'recovery.reviewed') {
            const throughSeq = integer(event.payload.throughSeq, 'recovery boundary');
            if (throughSeq >= event.sessionSeq || !Array.isArray(event.payload.runIds) || !event.payload.runIds.length) throw new Error('Invalid recovery review boundary');
            recoveryReviews.push({ reviewId: text(event.payload.reviewId, 'review identity'), throughSeq,
                runIds: event.payload.runIds.map(id => text(id, 'reviewed run')), evidence: publicJson(event.payload.evidence) });
        }
        if (event.type === 'goal.verified') {
            if (event.payload.method !== 'user_review') throw new Error('Invalid goal verification method');
            goalVerifications.push({ runId: event.run.runId, verificationId: text(event.payload.verificationId, 'verification identity'),
                method: 'user_review', evidence: publicJson(event.payload.evidence), freshness: 'not_checked_offline' });
        }
        if (event.type === 'progress.updated') {
            const state = object(event.payload.state, 'tool progress');
            const failedBatches = integer(state.failedBatches, 'failed batches');
            const repeatedFailureBatches = integer(state.repeatedFailureBatches, 'repeated failure batches');
            const fingerprint = state.lastFailureFingerprint;
            const stopCode = state.stopCode;
            if (repeatedFailureBatches > failedBatches
                || !(fingerprint === null || typeof fingerprint === 'string' && /^[a-f0-9]{64}$/.test(fingerprint))
                || ![null, 'no_progress', 'model_corrections'].includes(stopCode as string | null)) throw new Error('Invalid tool progress state');
            runs.get(event.run.runId)!.toolProgress = { failedBatches, repeatedFailureBatches,
                lastFailureFingerprint: fingerprint as string | null, stopCode: stopCode as ToolProgressState['stopCode'] };
        }
        if (event.type === 'control.requested' && event.payload.action === 'steer') {
            const value = event.payload.content ? publicJson(event.payload.content) : null;
            // Missing/restricted content remains unavailable under the normal artifact rules.
            // Its input and control identity cannot be reconstructed from the event alone.
            if (value !== null) {
                const body = object(value, 'steering content');
                const id = text(body.id, 'steering id');
                const expectedStepId = text(body.expectedStepId, 'steering step');
                const input = text(body.input, 'steering input');
                if (body.status !== 'queued' || expectedStepId !== event.payload.expectedStepId) throw new Error('Invalid steering content');
                const steering = runs.get(event.run.runId)!.steering;
                const existing = steering.find(entry => entry.id === id);
                if (existing && (existing.expectedStepId !== expectedStepId || existing.input !== input)) throw new Error('Conflicting steering identity');
                if (!existing) {
                    steering.push({ id, expectedStepId, input, status: 'queued' });
                    messages.push({ messageId: `steer:${JSON.stringify([event.run.runId, id])}`, revision: 1, role: 'user', text: input,
                        runId: event.run.runId, controlId: id, status: 'queued' });
                }
            }
        }
        if (event.type === 'control.applied' && event.payload.action === 'steer') {
            if (!Array.isArray(event.payload.controlIds)) throw new Error('Invalid applied steering ids');
            const ids = new Set(event.payload.controlIds.map(id => text(id, 'applied steering id')));
            for (const entry of runs.get(event.run.runId)!.steering) {
                if (!ids.has(entry.id)) continue;
                entry.status = 'applied';
                const message = messages.find(item => item.runId === event.run.runId && item.controlId === entry.id);
                if (message) message.status = 'applied';
            }
        }
        if (event.type === 'history.branch') {
            const value = publicJson(event.payload.content);
            if (value !== null && !Array.isArray(value)) throw new Error('Invalid branch history');
            branches.push({ sourceRunId: text(event.payload.sourceRunId, 'branch source'), turns: value as unknown[] | null });
        }
        if (event.type === 'history.revised') {
            const id = text(event.payload.messageId, 'revision message');
            const revision = integer(event.payload.revision, 'revision');
            const value = event.payload.content ? publicJson(event.payload.content) : null;
            const body = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).text : null;
            if (body !== null && typeof body !== 'string') throw new Error('Invalid revision text');
            if (!revisions.has(id) || revisions.get(id)!.revision < revision) revisions.set(id, { revision, deleted: event.payload.deleted === true, text: body as string | null });
        }
        if (event.type === 'response.delta') {
            const p = event.payload;
            if (p.offsetUnit !== 'utf16' || typeof p.text !== 'string') throw new Error('Invalid public delta');
            const requestId = text(p.requestId, 'requestId'); const attemptId = text(p.attemptId, 'attemptId'); const blockId = text(p.blockId, 'blockId');
            const key = JSON.stringify([event.run.runId, requestId, attemptId, blockId]);
            let block = blocks.get(key); if (!block) { block = { runId: event.run.runId, requestId, attemptId, blockId, text: '' }; blocks.set(key, block); }
            if (integer(p.offset, 'delta offset') !== block.text.length) throw new Error('Public delta offset gap or overlap');
            block.text += p.text;
        }
        if (event.type === 'message.accepted') {
            const ref = artifactRef(object(event.payload.content, 'message content'));
            let content: string | null = null;
            if (ref?.availability === 'present' && !restricted(ref)) {
                const bytes = loaded.artifacts.get(ref.relativePath)!;
                if (ref.mediaType === 'application/json' || ref.mediaType.endsWith('+json')) {
                    const value = object(parseJson(bytes, loaded.limits, 'message artifact'), 'message artifact');
                    if (typeof value.text === 'string') content = value.text;
                } else if (ref.mediaType.startsWith('text/')) content = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            }
            messages.push({ messageId: text(event.payload.messageId, 'messageId'), revision: integer(event.payload.revision, 'message revision'), role: text(event.payload.role, 'message role'), text: content });
        }
    }
    for (const run of runs.values()) {
        const seen = new Set<string>(); let cursor: typeof run | undefined = run;
        while (cursor) { if (seen.has(cursor.runId)) throw new Error('Cyclic replay task tree'); seen.add(cursor.runId); cursor = cursor.parentRunId ? runs.get(cursor.parentRunId) : undefined; }
    }
    const replies = [...runs.values()].map(run => {
        const revision = revisions.get(run.runId);
        const original = [...blocks.values()].filter(block => block.runId === run.runId).map(block => block.text).join('');
        return { runId: run.runId, revision: revision?.revision ?? 0, deleted: revision?.deleted ?? false,
            text: revision?.deleted ? '' : revision ? revision.text : original };
    });
    return { validation: loaded.report, messages, blocks: [...blocks.values()], replies, branches, recoveryReviews, goalVerifications, runs: [...runs.values()], usage: usageStats(loaded.events) };
}
function restricted(ref: ArtifactReference): boolean {
    return ref.mediaType.includes('vnd.uah.restricted') || (ref.relativePath !== null && ref.relativePath.split('/')[0] === 'restricted');
}
function replaceRefs(value: unknown, replacements: Map<string, ArtifactReference>): unknown {
    if (!value || typeof value !== 'object') return value;
    if (!Array.isArray(value)) {
        const ref = artifactRef(value as Record<string, unknown>);
        if (ref) return replacements.get(canonical(ref)) ?? (restricted(ref) && ref.availability !== 'external_reference_only'
            ? { ...ref, availability: 'missing', missingReason: 'share_redacted' } : ref);
    }
    if (Array.isArray(value)) return value.map(child => replaceRefs(child, replacements));
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, replaceRefs(child, replacements)]));
}
function syncedWrite(path: string, bytes: Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    plainPath(dirname(path));
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
}
export function exportTranscript(directory: string, destination: string, mode: 'full' | 'share' = 'full', limits?: Partial<OfflineLimits>): ValidationReport & { destination: string; mode: 'full' | 'share' } {
    if (mode !== 'full' && mode !== 'share') throw new Error('Invalid transcript export mode');
    const loaded = load(directory, limits); destination = resolve(destination);
    const nested = (a: string, b: string) => { const rel = relative(a, b); return !rel || (!rel.startsWith('..' + '\\') && !rel.startsWith('../') && rel !== '..' && !isAbsolute(rel)); };
    if (nested(loaded.directory, destination) || nested(destination, loaded.directory)) throw new Error('Export source and destination must not overlap');
    if (pathExists(destination)) throw new Error('Export destination already exists');
    plainPath(dirname(destination));
    const temporary = join(dirname(destination), `.uah-transcript-export-${randomUUID()}`);
    mkdirSync(temporary); plainPath(temporary);
    try {
        const replacements = new Map<string, ArtifactReference>(); const output = new Map<string, Buffer>();
        const visiting = new Set<string>();
        const transform = (ref: ArtifactReference, depth = 0): ArtifactReference => {
            const key = canonical(ref); const cached = replacements.get(key);
            if (cached) return cached;
            if (visiting.has(key)) throw new Error('Cyclic public artifact references');
            if (depth > loaded.limits.maxJsonDepth) throw new Error('Public artifact reference depth limit exceeded');
            visiting.add(key);
            let replacement = ref;
            if (mode === 'share' && restricted(ref) && ref.availability !== 'external_reference_only') {
                replacement = { ...ref, availability: 'missing', missingReason: 'share_redacted' };
            } else if (ref.availability === 'present') {
                let bytes = loaded.artifacts.get(ref.relativePath)!;
                if (mode === 'share' && (ref.mediaType === 'application/json' || ref.mediaType.endsWith('+json'))) {
                    const value = parseJson(bytes, loaded.limits, 'share artifact');
                    // Child hashes/paths must be final before the parent is serialized.
                    for (const child of discoverRefs(value)) transform(child, depth + 1);
                    const transformed = replaceRefs(value, replacements);
                    const redacted = redactJournalValue(transformed);
                    bytes = Buffer.from(JSON.stringify(redacted.value), 'utf8');
                    if (!bytes.equals(loaded.artifacts.get(ref.relativePath)!)) {
                        const sha256 = createHash('sha256').update(bytes).digest('hex');
                        replacement = { ...ref, relativePath: `artifacts/${sha256}.json`, sha256, byteLength: bytes.length };
                    }
                } else if (mode === 'share' && ref.mediaType.startsWith('text/')) {
                    const redacted = redactJournalValue(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                    bytes = Buffer.from(String(redacted.value), 'utf8');
                    if (!bytes.equals(loaded.artifacts.get(ref.relativePath)!)) {
                        const sha256 = createHash('sha256').update(bytes).digest('hex');
                        replacement = { ...ref, relativePath: `artifacts/${sha256}.txt`, sha256, byteLength: bytes.length };
                    }
                }
                if (replacement.availability === 'present') output.set(replacement.relativePath, bytes);
            }
            replacements.set(key, replacement); visiting.delete(key);
            return replacement;
        };
        for (const ref of loaded.refs) transform(ref);
        let events = loaded.events; let refs = loaded.refs.map(ref => replacements.get(canonical(ref))!);
        if (mode === 'share') {
            events = redactJournalValue(replaceRefs(events, replacements)).value as unknown as OfflineEvent[];
            refs = redactJournalValue(refs).value as unknown as ArtifactReference[];
        }
        const manifest: TranscriptManifest = { ...loaded.manifest, durableSeq: loaded.report.targetSeq, exportedSeq: loaded.report.targetSeq,
            segments: [], artifacts: refs, retainedRanges: loaded.report.targetSeq ? [{ firstSeq: 1, lastSeq: loaded.report.targetSeq }] : [],
            captureCoverage: mode === 'share' || loaded.report.partial ? (loaded.manifest.captureCoverage === 'legacy_partial' ? 'legacy_partial' : 'partial') : loaded.manifest.captureCoverage,
            continuationCoverage: mode === 'share' ? 'unavailable' : loaded.manifest.continuationCoverage,
            recovery: 'stopped', redactionPolicyVersion: mode === 'share' ? 'offline-share-v1' : loaded.manifest.redactionPolicyVersion };
        for (const [path, bytes] of output) { safeRelative(path); syncedWrite(join(temporary, path), bytes); }
        syncedWrite(join(temporary, 'transcript.jsonl'), Buffer.from(events.map(event => JSON.stringify(event) + '\n').join(''), 'utf8'));
        syncedWrite(join(temporary, 'manifest.json'), Buffer.from(JSON.stringify(manifest) + '\n', 'utf8'));
        const report = validateTranscript(temporary, loaded.limits);
        if (pathExists(destination)) throw new Error('Export destination appeared during export');
        plainPath(dirname(destination)); renameSync(temporary, destination);
        return { ...report, destination, mode };
    } catch (error) {
        // Only remove our unique staging directory after verifying its exact parent and identity.
        if (dirname(temporary) === dirname(destination) && temporary.startsWith(join(dirname(destination), '.uah-transcript-export-')) && existsSync(temporary)) {
            plainPath(temporary); rmSync(temporary, { recursive: true, force: true });
        }
        throw error;
    }
}
