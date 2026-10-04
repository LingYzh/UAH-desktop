export type MemoryScope = 'user' | 'project' | 'private-project';
export type MemoryKind = 'preference' | 'decision' | 'lesson' | 'checkpoint';
export type MemoryStatus = 'candidate' | 'active' | 'deleted';

export interface MemorySource {
    sessionId: string;
    runId: string;
    origin: 'user' | 'agent';
    evidenceIds: string[];
}

export interface MemoryEntry {
    id: string;
    title: string;
    body: string;
    scope: MemoryScope;
    kind: MemoryKind;
    status: MemoryStatus;
    pinned: boolean;
    createdAt: string;
    updatedAt: string;
    source: MemorySource | null;
    path: string;
    hash: string;
}

export type MemorySummary = Omit<MemoryEntry, 'body'>;

export interface MemoryWrite {
    id?: string;
    /** Optional ASCII filename slug; omitted slugs are derived from the title. */
    slug?: string;
    scope: MemoryScope;
    title: string;
    body: string;
    kind: MemoryKind;
    status: 'candidate' | 'active';
    pinned: boolean;
    expectedHash?: string;
    source: MemorySource;
}

/** A user-authored Markdown file without UAH memory metadata. */
export interface MemoryDocument {
    path: string;
    title: string;
    scope: MemoryScope;
    content: string;
    hash: string;
}

export interface MemoryListResult {
    entries: MemoryEntry[];
    documents: MemoryDocument[];
    warnings: string[];
}

export interface MemoryIndexSnapshot {
    scope: MemoryScope;
    path: string;
    content: string;
    hash: string;
    exists: boolean;
}

export interface MemorySnapshot {
    indexes: MemoryIndexSnapshot[];
    pinned: MemoryEntry[];
    warnings: string[];
}
