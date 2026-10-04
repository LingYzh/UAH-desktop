import type { ArtifactReference, JsonValue } from '../../shared/harness-contracts';

/** A durable, immutable reference to one context item. The referenced content is
 * kept in the artifact store; this contract deliberately carries no text body. */
export interface ContextEntry {
    id: string;
    sessionId: string;
    ownerId: string;
    kind: 'message' | 'runtime_snapshot' | 'summary';
    content: ArtifactReference;
    sourceRunId: string;
}

/** The owner-scoped ordered projection used to reconstruct a V2 request. */
export interface ContextSurface {
    schemaVersion: 2;
    sessionId: string;
    ownerId: string;
    revision: number;
    epoch: number;
    routeKey: string;
    entryIds: string[];
    snapshotHashes: Record<string, string>;
    instructionHash: string;
    toolManifestHash: string;
    sourceFingerprint: string;
    lastRunId: string;
    coverage: 'complete' | 'partial';
    metadata?: JsonValue;
}

/** A compare-and-swap replacement of an owner-scoped active surface. */
export interface ContextUpdate {
    expectedRevision: number | null;
    surface: ContextSurface;
    entries: ContextEntry[];
}
