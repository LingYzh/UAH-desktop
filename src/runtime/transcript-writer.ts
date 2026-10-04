import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
    readSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import type { ArtifactReference, TranscriptManifest } from '../shared/harness-contracts';
import { RuntimeStore } from './store';

export interface TranscriptFlushResult {
    sessionId: string;
    status: 'healthy' | 'degraded';
    durableSeq: number;
    exportedSeq: number;
    error?: string;
    captureCoverage?: TranscriptManifest['captureCoverage'];
    continuationCoverage?: TranscriptManifest['continuationCoverage'];
    recovery?: TranscriptManifest['recovery'];
    redactionPolicyVersion?: string;
}

export interface TranscriptWriterOptions {
    batchSize?: number;
    segmentBytes?: number;
    captureCoverage?: 'partial' | 'legacy_partial';
    deriveCoverage?: boolean;
    legacySessionIds?: ReadonlySet<string>;
}

interface CoverageFacts {
    requests: Map<string, { intent: boolean; snapshotComplete: boolean; terminalComplete: boolean; nativeComplete: boolean; incomplete: boolean; snapshotUsable: boolean; terminalObserved: boolean; nativeUsable: boolean }>;
    runs: Map<string, string | null>;
    dispatches: Set<string>;
    results: Set<string>;
    unknown: boolean;
    reconciliation: boolean;
    recordingFailed: boolean;
    missing: boolean;
    redactionPolicies: Set<string>;
}
const KNOWN_EVENTS = new Set(['message.accepted', 'history.revised', 'history.frame', 'history.branch', 'run.state', 'request.intent', 'request.sent',
    'request.dispatch', 'request.retry', 'provider.frame', 'response.native', 'artifact.created', 'response.started', 'response.delta',
    'response.terminal', 'tool.batch', 'approval.decided', 'approval.requested', 'tool.dispatch', 'tool.result',
    'usage.snapshot', 'budget.updated', 'progress.updated', 'context.admission', 'plan.version', 'permission.changed', 'control.requested', 'control.applied', 'delegation.delivery',
    'context.compaction', 'context.surface', 'context.request', 'recording.checkpoint', 'recovery.reviewed', 'recovery.resumed', 'goal.verified', 'native.event']);
const MAX_COVERAGE_JSON_BYTES = 16 * 1024 * 1024;
type Segment = TranscriptManifest['segments'][number];
interface RotationIndex { segments: Segment[]; signatures: string[]; firstSeq: number }

/** A disposable projection of SQLite facts. Synchronous, with one writer per data directory. */
export class TranscriptWriter {
    private readonly directory: string;
    private readonly batchSize: number;
    private readonly segmentBytes: number;
    private readonly rotations = new Map<string, RotationIndex>();
    private readonly coverage: 'partial' | 'legacy_partial';
    private readonly deriveCoverage: boolean;
    private readonly legacySessionIds: ReadonlySet<string>;
    private readonly sessions = new Set<string>();
    private readonly verified = new Map<string, string>();
    private readonly artifactIndexes = new Map<string, { seq: number; refs: Map<string, ArtifactReference> }>();
    private readonly coverageFacts = new Map<string, CoverageFacts>();
    private readonly checkedArtifacts = new Set<string>();
    private readonly artifactJson = new Map<string, Record<string, unknown>>();
    private closed = false;

    constructor(private readonly store: RuntimeStore, dataDirectory: string, options: TranscriptWriterOptions = {}) {
        this.directory = resolve(dataDirectory);
        this.batchSize = options.batchSize ?? 1000;
        this.segmentBytes = options.segmentBytes ?? 8 * 1024 * 1024;
        this.coverage = options.captureCoverage ?? 'partial';
        this.deriveCoverage = options.deriveCoverage ?? false;
        this.legacySessionIds = new Set(options.legacySessionIds ?? []);
        if (!Number.isSafeInteger(this.batchSize) || this.batchSize < 1) throw new Error('Invalid transcript batch size');
        if (!Number.isSafeInteger(this.segmentBytes) || this.segmentBytes < 1) throw new Error('Invalid transcript segment size');
    }

    /** SHA-256 names support arbitrary session IDs without path interpretation. */
    sessionDirectory(sessionId: string): string {
        return join(this.directory, 'sessions', createHash('sha256').update(JSON.stringify(sessionId), 'utf8').digest('hex'));
    }

    private readonly artifactFailures = new Set<string>();
    flush(sessionId: string, options: { verifyArtifacts?: boolean } = {}): TranscriptFlushResult {
        if (this.closed) throw new Error('Transcript writer is closed');
        this.sessions.add(sessionId);
        const watermark = this.store.journalWatermark(sessionId);
        try {
            const artifacts = this.collectSessionArtifacts(sessionId, watermark.durableSeq);
            if (options.verifyArtifacts || this.artifactFailures.has(sessionId)) {
                try {
                    for (const ref of artifacts) if (ref.availability === 'present') {
                        this.checkedArtifacts.delete(JSON.stringify([sessionId, ref]));
                        this.verifyArtifact(sessionId, ref);
                    }
                    this.artifactFailures.delete(sessionId);
                } catch (error) { this.artifactFailures.add(sessionId); throw error; }
            }
            const directory = this.sessionDirectory(sessionId);
            this.assertSafePath(directory);
            mkdirSync(directory, { recursive: true });
            this.assertSafePath(directory);
            const file = join(directory, 'transcript.jsonl');
            this.assertSafePath(file);
            const signature = existsSync(file) ? this.signature(file) : null;
            let rotation = this.rotations.get(sessionId);
            const intact = rotation && this.segmentsIntact(directory, rotation, options.verifyArtifacts === true);
            if (!signature || this.verified.get(sessionId) !== signature || !intact) {
                // Recovery may scan all canonical rows and replace the flat projection before
                // rotating again. Existing segment files are reusable evidence, not input facts.
                const aligned = signature && !rotation?.segments.length ? this.verifyPrefix(file, sessionId, watermark.durableSeq) : null;
                if (aligned === null || aligned < watermark.exportedSeq) {
                    this.rebuild(file, sessionId, watermark.durableSeq);
                    this.store.markExported(sessionId, watermark.durableSeq);
                } else {
                    // A crash after fsync but before SQLite acknowledgement is safe to acknowledge.
                    const fd = this.open(file, 'r+');
                    try { fsyncSync(fd); } finally { closeSync(fd); }
                    this.store.markExported(sessionId, aligned);
                }
                rotation = { segments: [], signatures: [], firstSeq: 1 };
            }
            let exported = this.store.journalWatermark(sessionId).exportedSeq;
            while (exported < watermark.durableSeq) {
                const events = this.store.readJournal(sessionId, exported, this.batchSize);
                if (!events.length) throw new Error('Canonical journal has a missing range');
                const fd = this.open(file, 'a');
                try {
                    this.writeAll(fd, Buffer.from(events.map((event) => JSON.stringify(event) + '\n').join(''), 'utf8'));
                    fsyncSync(fd);
                } finally { closeSync(fd); }
                exported = events.at(-1)!.sessionSeq;
                this.store.markExported(sessionId, exported);
            }
            const current = this.store.journalWatermark(sessionId);
            const nextRotation = this.rotate(file, sessionId, current.durableSeq, rotation!);
            const coverage = this.manifestCoverage(sessionId, current.durableSeq);
            const manifest: TranscriptManifest = {
                schemaVersion: 1, sessionId, ...current,
                segments: nextRotation.segments, artifacts,
                retainedRanges: current.durableSeq ? [{ firstSeq: 1, lastSeq: current.durableSeq }] : [],
                ...coverage,
            };
            this.atomicWrite(join(directory, 'manifest.json'), (fd) => {
                this.writeAll(fd, Buffer.from(JSON.stringify(manifest) + '\n', 'utf8'));
            });
            this.verified.set(sessionId, this.signature(file));
            this.rotations.set(sessionId, nextRotation);
            return { sessionId, status: 'healthy', ...current, ...coverage };
        } catch (error) {
            this.verified.delete(sessionId);
            this.rotations.delete(sessionId);
            return {
                sessionId, status: 'degraded', ...this.store.journalWatermark(sessionId),
                captureCoverage: this.deriveCoverage && (!watermark.durableSeq || this.legacySessionIds.has(sessionId))
                    ? 'legacy_partial' : this.coverage,
                continuationCoverage: 'unavailable',
                recovery: this.coverageFacts.get(sessionId)?.reconciliation ? 'needs_reconciliation' : 'stopped',
                redactionPolicyVersion: 'unverified',
                error: error instanceof Error ? error.message : String(error),
            };
        }
    }

    drain(): TranscriptFlushResult[] {
        return [...this.sessions].map((sessionId) => this.flush(sessionId));
    }

    forgetSession(sessionId: string): void {
        this.sessions.delete(sessionId); this.verified.delete(sessionId); this.artifactIndexes.delete(sessionId);
        this.rotations.delete(sessionId);
        this.coverageFacts.delete(sessionId); this.artifactFailures.delete(sessionId);
        for (const key of this.checkedArtifacts) if (JSON.parse(key)[0] === sessionId) this.checkedArtifacts.delete(key);
        for (const key of this.artifactJson.keys()) if (JSON.parse(key)[0] === sessionId) this.artifactJson.delete(key);
    }

    close(): TranscriptFlushResult[] {
        if (this.closed) return [];
        const results = this.drain();
        this.closed = true;
        return results;
    }

    /** Compare exact UTF-8 canonical bytes, including identity, sequence and content.
     * Never interpret or execute event payloads from the projection. */
    private verifyPrefix(file: string, sessionId: string, durable: number): number | null {
        const fd = this.open(file, 'r');
        try {
            const size = statSync(file).size;
            let offset = 0;
            let seq = 0;
            while (seq < durable) {
                const events = this.store.readJournal(sessionId, seq, this.batchSize);
                if (!events.length) return null;
                for (const event of events) {
                    if (offset === size) return seq;
                    const expected = Buffer.from(JSON.stringify(event) + '\n', 'utf8');
                    if (size - offset < expected.length) return null;
                    const actual = Buffer.allocUnsafe(expected.length);
                    let read = 0;
                    while (read < actual.length) {
                        const count = readSync(fd, actual, read, actual.length - read, offset + read);
                        if (!count) return null;
                        read += count;
                    }
                    if (!actual.equals(expected)) return null;
                    offset += expected.length;
                    seq = event.sessionSeq;
                }
            }
            return offset === size ? seq : null;
        } finally { closeSync(fd); }
    }

    private rebuild(file: string, sessionId: string, durable: number): void {
        this.atomicWrite(file, (fd) => {
            let seq = 0;
            while (seq < durable) {
                const events = this.store.readJournal(sessionId, seq, this.batchSize);
                if (!events.length) throw new Error('Canonical journal has a missing range');
                this.writeAll(fd, Buffer.from(events.map((event) => JSON.stringify(event) + '\n').join(''), 'utf8'));
                seq = events.at(-1)!.sessionSeq;
            }
        });
    }

    private segmentHash(file: string): string {
        const fd = this.open(file, 'r');
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1) throw new Error('Unsafe transcript segment file');
            const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(64 * 1024);
            let offset = 0;
            while (offset < stat.size) {
                const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
                if (!count) throw new Error('Transcript segment changed during verification');
                hash.update(buffer.subarray(0, count)); offset += count;
            }
            const after = fstatSync(fd);
            if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Transcript segment changed during verification');
            return hash.digest('hex');
        } finally { closeSync(fd); }
    }

    private segmentsIntact(directory: string, index: RotationIndex, verifyHashes: boolean): boolean {
        for (let i = 0; i < index.segments.length; i++) {
            const segment = index.segments[i], file = join(directory, segment.relativePath);
            this.assertSafePath(file);
            if (!existsSync(file) || this.signature(file) !== index.signatures[i]) return false;
            if (verifyHashes && this.segmentHash(file) !== segment.sha256) return false;
        }
        return true;
    }

    private rotate(file: string, sessionId: string, durable: number, index: RotationIndex): RotationIndex {
        if (statSync(file).size < this.segmentBytes) return index;
        const directory = dirname(file), segmentDirectory = join(directory, 'segments');
        this.assertSafePath(segmentDirectory); mkdirSync(segmentDirectory, { recursive: true }); this.assertSafePath(segmentDirectory);
        const next: RotationIndex = { segments: [...index.segments], signatures: [...index.signatures], firstSeq: index.firstSeq };
        let seq = index.firstSeq - 1, chunks: Buffer[] = [], bytes = 0;
        while (seq < durable) {
            const events = this.store.readJournal(sessionId, seq, this.batchSize);
            if (!events.length) throw new Error('Canonical journal has a missing rotation range');
            for (const event of events) {
                if (event.sessionSeq !== seq + 1) throw new Error('Canonical journal rotation sequence gap');
                const line = Buffer.from(JSON.stringify(event) + '\n', 'utf8'); chunks.push(line); bytes += line.length; seq = event.sessionSeq;
                if (bytes < this.segmentBytes) continue;
                const body = Buffer.concat(chunks, bytes), sha256 = createHash('sha256').update(body).digest('hex');
                const segment: Segment = { relativePath: `segments/${next.firstSeq}-${seq}-${sha256}.jsonl`, firstSeq: next.firstSeq, lastSeq: seq, sha256 };
                const destination = join(directory, segment.relativePath); this.assertSafePath(destination);
                if (!existsSync(destination) || this.segmentHash(destination) !== sha256) this.atomicWrite(destination, fd => this.writeAll(fd, body));
                next.segments.push(segment); next.signatures.push(this.signature(destination)); next.firstSeq = seq + 1; chunks = []; bytes = 0;
            }
        }
        if (next.segments.length !== index.segments.length) this.atomicWrite(file, fd => { for (const chunk of chunks) this.writeAll(fd, chunk); });
        // Old, unreferenced projection segments are retained; SQLite remains authoritative.
        return next;
    }

    /** Reconstruct once from authoritative rows; later flushes visit only new payloads. */
    private collectSessionArtifacts(sessionId: string, durable: number): ArtifactReference[] {
        let index = this.artifactIndexes.get(sessionId);
        if (!index) {
            index = { seq: 0, refs: new Map() };
            this.artifactIndexes.set(sessionId, index);
        }
        while (index.seq < durable) {
            const events = this.store.readJournal(sessionId, index.seq, this.batchSize);
            if (!events.length) throw new Error('Canonical journal has a missing artifact index range');
            for (const event of events) {
                const pending: unknown[] = [event.payload];
                while (pending.length) {
                    const value = pending.pop();
                    if (!value || typeof value !== 'object') continue;
                    if (Array.isArray(value)) { for (const child of value) pending.push(child); continue; }
                    const record = value as Record<string, unknown>;
                    if (['present', 'missing', 'external_reference_only'].includes(String(record.availability))) {
                        const ref = this.validateArtifactReference(record);
                        if (this.deriveCoverage) {
                            if (ref.availability !== 'present') this.facts(sessionId).missing = true;
                            else this.verifyArtifact(sessionId, ref);
                        }
                        index.refs.set(JSON.stringify(ref), ref);
                    } else {
                        for (const child of Object.values(record)) pending.push(child);
                    }
                }
                if (this.deriveCoverage) this.observeCoverage(sessionId, event);
                index.seq = event.sessionSeq;
            }
        }
        return [...index.refs.values()];
    }

    private facts(sessionId: string): CoverageFacts {
        let facts = this.coverageFacts.get(sessionId);
        if (!facts) {
            facts = { requests: new Map(), runs: new Map(), dispatches: new Set(), results: new Set(),
                unknown: false, reconciliation: false, recordingFailed: false, missing: false, redactionPolicies: new Set() };
            this.coverageFacts.set(sessionId, facts);
        }
        return facts;
    }

    private observeCoverage(sessionId: string, event: import('../shared/harness-contracts').TranscriptEvent): void {
        const facts = this.facts(sessionId);
        if (!facts.runs.has(event.run.runId)) facts.runs.set(event.run.runId, null);
        if (!KNOWN_EVENTS.has(event.type)) { facts.unknown = true; return; }
        const payload = event.payload as unknown as Record<string, unknown>;
        if (event.type === 'run.state') {
            const state = typeof payload.state === 'string' ? payload.state : null;
            facts.runs.set(event.run.runId, state);
            facts.reconciliation ||= state === 'needs_reconciliation';
            facts.recordingFailed ||= state === 'recording_failed';
        }
        if (event.type === 'tool.dispatch') {
            const identity = payload.identity as Record<string, unknown> | undefined;
            if (typeof identity?.invocationId === 'string' && identity.invocationId) facts.dispatches.add(identity.invocationId);
            else facts.unknown = true;
        }
        if (event.type === 'tool.result') {
            if (typeof payload.invocationId === 'string' && payload.invocationId) facts.results.add(payload.invocationId);
            else facts.unknown = true;
            const outcome = payload.outcome as Record<string, unknown> | undefined;
            if (outcome?.recordingState !== 'durable') facts.recordingFailed = true;
            if ((outcome?.executionEvidence as Record<string, unknown> | undefined)?.outputRedacted === true) facts.missing = true;
        }
        const identity = (event.type === 'request.intent' ? payload.identity : event.type === 'usage.snapshot' ? payload.usage : payload) as Record<string, unknown> | undefined;
        if (!identity || typeof identity.requestId !== 'string' || typeof identity.attemptId !== 'string') return;
        const key = JSON.stringify([identity.requestId, identity.attemptId]);
        let request = facts.requests.get(key);
        if (!request) {
            request = { intent: false, snapshotComplete: false, terminalComplete: false, nativeComplete: false, incomplete: false, snapshotUsable: false, terminalObserved: false, nativeUsable: false };
            facts.requests.set(key, request);
        }
        if (event.type === 'request.intent') {
            request.intent = true;
            const ref = this.validateArtifactReference(payload.snapshot as Record<string, unknown>);
            if (ref.availability === 'present') {
                const snapshot = this.readArtifactJson(sessionId, ref);
                facts.redactionPolicies.add(typeof snapshot.redactionPolicyVersion === 'string' && snapshot.redactionPolicyVersion
                    ? snapshot.redactionPolicyVersion : 'unverified');
                const savedIdentity = snapshot.identity as Record<string, unknown> | undefined;
                const identityValid = snapshot.schemaVersion === 1
                    && savedIdentity?.requestId === identity.requestId && savedIdentity?.attemptId === identity.attemptId
                    && savedIdentity?.sessionId === sessionId && savedIdentity?.runId === event.run.runId;
                request.snapshotComplete = identityValid && snapshot.coverage === 'complete';
                request.snapshotUsable = identityValid && (request.snapshotComplete
                    || (snapshot.coverage === 'partial' && snapshot.bodyCapture === 'disabled' && snapshot.bodyAbsent === true));
                request.incomplete ||= !request.snapshotComplete;
            }
        }
        if (event.type === 'response.terminal') {
            request.terminalObserved = payload.status === 'completed';
            request.terminalComplete = payload.status === 'completed' && payload.partial === false;
            request.incomplete ||= !request.terminalComplete;
        }
        if (event.type === 'response.native') {
            const ref = this.validateArtifactReference(payload.content as Record<string, unknown>);
            if (ref.availability === 'present') {
                const native = this.readArtifactJson(sessionId, ref);
                request.nativeComplete = native.schemaVersion === 1 && native.captureCoverage === 'complete'
                    && native.continuationCoverage === 'native' && Array.isArray(native.continuation);
                request.nativeUsable = request.nativeComplete || (native.schemaVersion === 1 && native.captureCoverage === 'partial'
                    && native.rawCapture === 'disabled' && native.continuationCoverage === 'native' && Array.isArray(native.continuation));
                request.incomplete ||= !request.nativeComplete;
            }
        }
    }

    private manifestCoverage(sessionId: string, durable: number): Pick<TranscriptManifest, 'captureCoverage' | 'continuationCoverage' | 'recovery' | 'redactionPolicyVersion'> {
        if (!this.deriveCoverage) return { captureCoverage: this.coverage, continuationCoverage: 'unavailable', recovery: 'stopped', redactionPolicyVersion: 'unverified' };
        if (!durable) return { captureCoverage: 'legacy_partial', continuationCoverage: 'unavailable', recovery: 'stopped', redactionPolicyVersion: 'unverified' };
        const facts = this.facts(sessionId);
        const allRequests = facts.requests.size > 0 && [...facts.requests.values()].every(request => request.intent
            && request.snapshotComplete && request.terminalComplete && request.nativeComplete && !request.incomplete);
        const allRuns = facts.runs.size > 0 && [...facts.runs.values()].every(state => state !== null && ['completed', 'failed', 'cancelled'].includes(state));
        const nativeAvailable = facts.requests.size > 0 && [...facts.requests.values()].every(request => request.intent
            && (request.snapshotComplete ? request.terminalComplete && request.nativeComplete && !request.incomplete
                : request.snapshotUsable && request.terminalObserved && request.nativeUsable));
        const allResults = [...facts.dispatches].every(id => facts.results.has(id));
        const legacy = this.coverage === 'legacy_partial' || this.legacySessionIds.has(sessionId);
        const complete = allRequests && allRuns && allResults && !facts.unknown && !facts.missing && !facts.reconciliation && !facts.recordingFailed && !legacy;
        return { captureCoverage: legacy ? 'legacy_partial' : complete ? 'complete' : this.coverage,
            continuationCoverage: (allRequests || nativeAvailable) && !facts.unknown && !facts.missing && !facts.recordingFailed && !facts.reconciliation && !legacy ? 'native' : 'unavailable',
            recovery: facts.reconciliation || !allResults ? 'needs_reconciliation' : 'stopped',
            redactionPolicyVersion: facts.redactionPolicies.size === 1 ? [...facts.redactionPolicies][0] : 'unverified' };
    }

    private verifyArtifact(sessionId: string, ref: Extract<ArtifactReference, { availability: 'present' }>): void {
        const key = JSON.stringify([sessionId, ref]);
        if (this.checkedArtifacts.has(key)) return;
        const file = join(this.sessionDirectory(sessionId), ref.relativePath);
        this.assertSafePath(file);
        const fd = this.open(file, 'r');
        try {
            const stat = fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.size !== ref.byteLength) throw new Error('Coverage artifact size or link integrity mismatch');
            const hash = createHash('sha256'); const buffer = Buffer.allocUnsafe(64 * 1024); let offset = 0;
            while (offset < stat.size) {
                const count = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - offset), offset);
                if (!count) throw new Error('Coverage artifact changed during verification');
                hash.update(buffer.subarray(0, count)); offset += count;
            }
            if (hash.digest('hex').toLowerCase() !== ref.sha256.toLowerCase()) throw new Error('Coverage artifact hash integrity mismatch');
        } finally { closeSync(fd); }
        this.checkedArtifacts.add(key);
    }

    private readArtifactJson(sessionId: string, ref: Extract<ArtifactReference, { availability: 'present' }>): Record<string, unknown> {
        const key = JSON.stringify([sessionId, ref]);
        const cached = this.artifactJson.get(key); if (cached) return cached;
        if (ref.byteLength > MAX_COVERAGE_JSON_BYTES) throw new Error('Coverage artifact exceeds 16 MiB JSON limit');
        this.verifyArtifact(sessionId, ref);
        const fd = this.open(join(this.sessionDirectory(sessionId), ref.relativePath), 'r');
        let bytes: Buffer;
        try {
            const stat = fstatSync(fd);
            if (stat.size !== ref.byteLength || stat.nlink !== 1) throw new Error('Coverage artifact changed during read');
            bytes = Buffer.allocUnsafe(stat.size); let offset = 0;
            while (offset < bytes.length) {
                const count = readSync(fd, bytes, offset, bytes.length - offset, offset);
                if (!count) throw new Error('Coverage artifact read made no progress'); offset += count;
            }
        } finally { closeSync(fd); }
        if (createHash('sha256').update(bytes).digest('hex').toLowerCase() !== ref.sha256.toLowerCase()) throw new Error('Coverage JSON artifact hash integrity mismatch');
        const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid coverage JSON artifact');
        // Retain only coverage metadata, never complete request bodies/native text.
        const record = value as Record<string, unknown>;
        const rawIdentity = record.identity as Record<string, unknown> | undefined;
        const summary = { schemaVersion: record.schemaVersion, coverage: record.coverage, captureCoverage: record.captureCoverage,
            bodyCapture: record.bodyCapture, bodyAbsent: record.body === null, rawCapture: record.rawCapture,
            redactionPolicyVersion: record.redactionPolicyVersion,
            continuationCoverage: record.continuationCoverage, continuation: Array.isArray(record.continuation) ? [] : null,
            identity: rawIdentity ? { sessionId: rawIdentity.sessionId, runId: rawIdentity.runId,
                requestId: rawIdentity.requestId, attemptId: rawIdentity.attemptId } : undefined };
        this.artifactJson.set(key, summary);
        return summary;
    }

    private validateArtifactReference(record: Record<string, unknown>): ArtifactReference {
        if (typeof record.mediaType !== 'string' || !record.mediaType) throw new Error('Invalid artifact media type');
        const sha = record.sha256;
        const size = record.byteLength;
        const validHash = typeof sha === 'string' && /^[a-fA-F0-9]{64}$/.test(sha);
        const validSize = typeof size === 'number' && Number.isSafeInteger(size) && size >= 0;
        const missingReason = record.missingReason;
        if (record.availability === 'external_reference_only') {
            if (record.relativePath !== null || sha !== null || size !== null
                || typeof record.externalReference !== 'string' || !record.externalReference
                || typeof missingReason !== 'string' || !missingReason) throw new Error('Invalid external artifact reference');
            return { mediaType: record.mediaType, availability: 'external_reference_only', relativePath: null,
                sha256: null, byteLength: null, externalReference: record.externalReference, missingReason };
        }
        const path = record.relativePath;
        // Use a portable relative path grammar: no drive/UNC/ADS, separators, traversal or NUL.
        if (typeof path !== 'string' || !path || /[\\:\u0000]/.test(path)
            || path.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part))) {
            throw new Error('Artifact reference path escapes the session or is unsafe');
        }
        if (record.availability === 'present') {
            if (!validHash || !validSize || missingReason !== null) throw new Error('Invalid present artifact reference');
            return { mediaType: record.mediaType, availability: 'present', relativePath: path,
                sha256: sha as string, byteLength: size as number, missingReason: null };
        }
        if (!(sha === null || validHash) || !(size === null || validSize)
            || typeof missingReason !== 'string' || !missingReason) throw new Error('Invalid missing artifact reference');
        return { mediaType: record.mediaType, availability: 'missing', relativePath: path,
            sha256: sha as string | null, byteLength: size as number | null, missingReason };
    }

    private atomicWrite(file: string, write: (fd: number) => void): void {
        this.assertSafePath(file);
        const temporary = join(dirname(file), `.transcript-${randomUUID()}.tmp`);
        const fd = this.open(temporary, 'wx');
        try {
            try { write(fd); fsyncSync(fd); } finally { closeSync(fd); }
            this.assertSafePath(file);
            renameSync(temporary, file);
        } finally {
            if (existsSync(temporary)) unlinkSync(temporary);
        }
    }

    private open(file: string, mode: 'r' | 'r+' | 'a' | 'wx'): number {
        this.assertSafePath(file);
        const flags = {
            r: constants.O_RDONLY,
            'r+': constants.O_RDWR,
            a: constants.O_WRONLY | constants.O_APPEND,
            wx: constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
        }[mode];
        return openSync(file, flags | (constants.O_NOFOLLOW ?? 0), 0o600);
    }

    private assertSafePath(file: string): void {
        const absolute = resolve(file);
        const root = parse(absolute).root;
        let current = root;
        for (const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)) {
            current = join(current, part);
            try {
                if (lstatSync(current).isSymbolicLink()) throw new Error(`Transcript path contains a symbolic link: ${current}`);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            }
        }
    }

    private signature(file: string): string {
        const stat = statSync(file, { bigint: true });
        return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    }

    private writeAll(fd: number, buffer: Buffer): void {
        let offset = 0;
        while (offset < buffer.length) {
            const count = writeSync(fd, buffer, offset, buffer.length - offset);
            if (!count) throw new Error('Transcript write made no progress');
            offset += count;
        }
    }
}
