import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    parseEndpointDraft,
    type ApiConnection,
    type EndpointDraft,
    type EndpointRecord,
    type ProviderCatalogEntry,
} from '../shared/endpoints';

const SCHEMA_VERSION = 5;
const MAX_ENDPOINTS = 100;

export interface EndpointCipher {
    isEncryptionAvailable(): boolean;
    encryptString(value: string): Buffer;
    decryptString(value: Buffer): string;
}

interface StoredEndpoint extends EndpointRecord {
    keyBlob: Buffer | null;
}

function databaseError(): Error {
    return new Error('端点数据库数据无效。');
}

function keyError(): Error {
    return new Error('端点密钥不可用。');
}

function validateId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError('端点标识无效。');
    }
    return value.trim();
}

function validateRevision(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        throw new TypeError('端点版本无效。');
    }
    return value as number;
}

export class EndpointStore {
    private readonly database: DatabaseSync;
    private closed = false;

    constructor(dataDirectory: string, private readonly cipher: EndpointCipher) {
        const directory = resolve(dataDirectory);
        mkdirSync(directory, { recursive: true });
        this.database = new DatabaseSync(resolve(directory, 'endpoints.sqlite'));
        try {
            this.database.exec('PRAGMA foreign_keys = ON;');
            this.database.exec('PRAGMA journal_mode = WAL;');
            this.database.exec('PRAGMA synchronous = FULL;');
            this.initializeSchema();
        } catch (error) {
            try { this.database.close(); } catch { /* Preserve the initialization error. */ }
            this.closed = true;
            throw error;
        }
    }

    list(): EndpointRecord[] {
        this.assertOpen();
        return this.readEndpoints().map(({ keyBlob: _keyBlob, ...endpoint }) => endpoint);
    }

    listProviders(): ProviderCatalogEntry[] {
        this.assertOpen();
        return this.readEndpoints()
            .filter(endpoint => endpoint.enabled && endpoint.models.length > 0)
            .map(endpoint => ({
                id: endpoint.id,
                providerId: endpoint.providerId ?? endpoint.id,
                name: endpoint.name,
                models: [...endpoint.models],
                runtimeId: 'api',
            }));
    }

    save(value: EndpointDraft): EndpointRecord[] {
        this.assertOpen();
        const draft = parseEndpointDraft(value);
        return this.transaction(() => {
            if (draft.id === null) {
                this.assertEnabledModels(draft);
                const modelParameters = this.modelParametersForDraft(draft);
                const count = this.database.prepare('SELECT COUNT(*) AS count FROM endpoints').get() as { count: number };
                if (Number(count.count) >= MAX_ENDPOINTS) {
                    throw new Error(`端点数量不能超过 ${MAX_ENDPOINTS} 个。`);
                }
                const id = randomUUID();
                const providerId = draft.providerId ?? null;
                this.assertProviderNamespaceAvailable(providerId, undefined, id);
                const keyBlob = this.keyBlobFromDraft(draft.apiKey, null);
                this.database.prepare(
                    `INSERT INTO endpoints (id, provider_id, name, protocol, base_url, models_json, model_details_json, model_overrides_json, model_parameters_json, enabled, revision, key_blob)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                ).run(
                    id,
                    providerId,
                    draft.name,
                    draft.protocol,
                    draft.baseUrl,
                    JSON.stringify(draft.models),
                    JSON.stringify(draft.modelDetails ?? []),
                    JSON.stringify(draft.modelOverrides ?? []),
                    JSON.stringify(modelParameters),
                    draft.enabled ? 1 : 0,
                    0,
                    keyBlob,
                );
                return this.list();
            }

            const existing = this.readEndpoint(draft.id);
            if (!existing) {
                throw new Error('端点不存在。');
            }
            this.assertRevision(existing, draft.revision);
            this.assertEnabledModels(draft);
            const modelParameters = this.modelParametersForDraft(draft, existing);
            const providerId = draft.providerId === undefined ? existing.providerId ?? null : draft.providerId;
            this.assertProviderNamespaceAvailable(providerId, existing.id);
            const preserveKey = draft.apiKey === null;
            const keyBlob = this.keyBlobFromDraft(draft.apiKey, preserveKey ? existing.keyBlob : null);
            this.database.prepare(
                `UPDATE endpoints
                 SET provider_id = ?, name = ?, protocol = ?, base_url = ?, models_json = ?, model_details_json = ?, model_overrides_json = ?, model_parameters_json = ?, enabled = ?, revision = ?, key_blob = ?
                 WHERE id = ? AND revision = ?`,
            ).run(
                providerId,
                draft.name,
                draft.protocol,
                draft.baseUrl,
                JSON.stringify(draft.models),
                JSON.stringify(draft.modelDetails ?? []),
                JSON.stringify(draft.modelOverrides ?? []),
                JSON.stringify(modelParameters),
                draft.enabled ? 1 : 0,
                existing.revision + 1,
                keyBlob,
                existing.id,
                existing.revision,
            );
            return this.list();
        });
    }

    delete(id: string, revision: number): EndpointRecord[] {
        this.assertOpen();
        const endpointId = validateId(id);
        const endpointRevision = validateRevision(revision);
        return this.transaction(() => {
            const existing = this.readEndpoint(endpointId);
            if (!existing) {
                throw new Error('端点不存在。');
            }
            this.assertRevision(existing, endpointRevision);
            const result = this.database.prepare('DELETE FROM endpoints WHERE id = ? AND revision = ?')
                .run(endpointId, endpointRevision);
            if (result.changes !== 1) {
                throw new Error('端点已被其他操作修改。');
            }
            return this.list();
        });
    }

    resolve(id: string): ApiConnection {
        this.assertOpen();
        const requestedId = validateId(id);
        const endpoint = this.readEndpoint(requestedId) ?? this.readEndpointByProviderId(requestedId);
        if (!endpoint) {
            throw new Error('端点不存在。');
        }
        if (!endpoint.enabled || endpoint.models.length === 0) {
            throw new Error('端点未启用或尚未配置模型。');
        }
        return this.connection(endpoint, this.decryptKey(endpoint.keyBlob));
    }

    preview(value: EndpointDraft): ApiConnection {
        this.assertOpen();
        const draft = parseEndpointDraft(value);
        if (draft.id === null) {
            const id = randomUUID();
            return this.connection({
                id,
                ...(draft.providerId ? { providerId: draft.providerId } : {}),
                name: draft.name,
                protocol: draft.protocol,
                baseUrl: draft.baseUrl,
                models: draft.models,
                ...(draft.modelDetails?.length ? { modelDetails: draft.modelDetails } : {}),
                ...(draft.modelOverrides?.length ? { modelOverrides: draft.modelOverrides } : {}),
                ...(draft.modelParameters?.length ? { modelParameters: this.modelParametersForDraft(draft) } : {}),
                enabled: draft.enabled,
                revision: 0,
                hasKey: draft.apiKey !== null && draft.apiKey !== '',
            keyBlob: null,
        }, draft.apiKey ?? '');
        }

        const existing = this.readEndpoint(draft.id);
        if (!existing) {
            throw new Error('端点不存在。');
        }
        this.assertRevision(existing, draft.revision);
        const modelParameters = this.modelParametersForDraft(draft, existing);
        const previewProviderId = draft.providerId === undefined ? existing.providerId : draft.providerId;
        return this.connection({
            id: existing.id,
            ...(previewProviderId ? { providerId: previewProviderId } : {}),
            name: draft.name,
            protocol: draft.protocol,
            baseUrl: draft.baseUrl,
            models: draft.models,
            ...(draft.modelDetails?.length ? { modelDetails: draft.modelDetails } : {}),
            ...(draft.modelOverrides?.length ? { modelOverrides: draft.modelOverrides } : {}),
            ...(modelParameters.length ? { modelParameters } : {}),
            enabled: draft.enabled,
            revision: existing.revision,
            hasKey: draft.apiKey === null ? existing.keyBlob !== null : draft.apiKey !== '',
            keyBlob: null,
        }, draft.apiKey === null ? this.decryptKey(existing.keyBlob) : draft.apiKey);
    }

    close(): void {
        if (this.closed) {
            return;
        }
        this.database.close();
        this.closed = true;
    }

    private initializeSchema(): void {
        const row = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
        const version = Number(row.user_version);
        if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
            throw new Error('端点数据库版本不受支持。');
        }
        if (version === SCHEMA_VERSION) {
            return;
        }
        this.database.exec('BEGIN EXCLUSIVE;');
        try {
            if (version === 0) {
                this.database.exec(`
                    CREATE TABLE endpoints (
                        id TEXT PRIMARY KEY,
                        name TEXT NOT NULL,
                        protocol TEXT NOT NULL,
                        base_url TEXT NOT NULL,
                        models_json TEXT NOT NULL,
                        model_details_json TEXT NOT NULL DEFAULT '[]',
                        model_overrides_json TEXT NOT NULL DEFAULT '[]',
                        model_parameters_json TEXT NOT NULL DEFAULT '[]',
                        enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                        revision INTEGER NOT NULL CHECK (revision >= 0),
                        key_blob BLOB,
                        provider_id TEXT
                    );
                `);
            } else if (version === 1) {
                this.database.exec("ALTER TABLE endpoints ADD COLUMN model_details_json TEXT NOT NULL DEFAULT '[]';");
                this.database.exec('PRAGMA user_version = 2;');
                this.database.exec("ALTER TABLE endpoints ADD COLUMN model_overrides_json TEXT NOT NULL DEFAULT '[]';");
            } else if (version === 2) {
                this.database.exec("ALTER TABLE endpoints ADD COLUMN model_overrides_json TEXT NOT NULL DEFAULT '[]';");
            }
            if (version > 0 && version < 4) {
                this.database.exec("ALTER TABLE endpoints ADD COLUMN model_parameters_json TEXT NOT NULL DEFAULT '[]';");
            }
            if (version !== 0) {
                this.database.exec('ALTER TABLE endpoints ADD COLUMN provider_id TEXT;');
            }
            this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
            this.database.exec('COMMIT;');
        } catch (error) {
            try {
                this.database.exec('ROLLBACK;');
            } catch {
                // Preserve the original schema error.
            }
            throw error;
        }
    }

    private transaction<T>(operation: () => T): T {
        this.database.exec('BEGIN IMMEDIATE;');
        try {
            const result = operation();
            this.database.exec('COMMIT;');
            return result;
        } catch (error) {
            try {
                this.database.exec('ROLLBACK;');
            } catch {
                // Preserve the original write error.
            }
            throw error;
        }
    }

    private readEndpoints(): StoredEndpoint[] {
        const rows = this.database.prepare(
            'SELECT id, provider_id, name, protocol, base_url, models_json, model_details_json, model_overrides_json, model_parameters_json, enabled, revision, key_blob FROM endpoints ORDER BY rowid ASC',
        ).all() as Array<Record<string, unknown>>;
        if (rows.length > MAX_ENDPOINTS) {
            throw databaseError();
        }
        return rows.map((row) => this.parseStoredEndpoint(row));
    }

    private readEndpoint(id: string): StoredEndpoint | null {
        const row = this.database.prepare(
            'SELECT id, provider_id, name, protocol, base_url, models_json, model_details_json, model_overrides_json, model_parameters_json, enabled, revision, key_blob FROM endpoints WHERE id = ?',
        ).get(id) as Record<string, unknown> | undefined;
        return row ? this.parseStoredEndpoint(row) : null;
    }

    private readEndpointByProviderId(providerId: string): StoredEndpoint | null {
        const row = this.database.prepare(
            'SELECT id, provider_id, name, protocol, base_url, models_json, model_details_json, model_overrides_json, model_parameters_json, enabled, revision, key_blob FROM endpoints WHERE provider_id = ?',
        ).get(providerId) as Record<string, unknown> | undefined;
        return row ? this.parseStoredEndpoint(row) : null;
    }

    private parseStoredEndpoint(row: Record<string, unknown>): StoredEndpoint {
        try {
            if (typeof row.models_json !== 'string' || typeof row.model_details_json !== 'string'
                || typeof row.model_overrides_json !== 'string' || typeof row.model_parameters_json !== 'string'
                || typeof row.enabled !== 'number' || row.provider_id !== null && typeof row.provider_id !== 'string') {
                throw databaseError();
            }
            const draft = parseEndpointDraft({
                id: row.id,
                providerId: row.provider_id,
                name: row.name,
                protocol: row.protocol,
                baseUrl: row.base_url,
                models: JSON.parse(row.models_json),
                enabled: row.enabled === 1,
                revision: row.revision,
                apiKey: null,
                modelDetails: JSON.parse(row.model_details_json),
                modelOverrides: JSON.parse(row.model_overrides_json),
                modelParameters: JSON.parse(row.model_parameters_json),
            });
            if (row.enabled !== 0 && row.enabled !== 1) {
                throw databaseError();
            }
            const keyBlob = row.key_blob === null ? null : this.asBuffer(row.key_blob);
            return {
                id: draft.id!,
                ...(typeof draft.providerId === 'string' ? { providerId: draft.providerId } : {}),
                name: draft.name,
                protocol: draft.protocol,
                baseUrl: draft.baseUrl,
                models: draft.models,
                ...(draft.modelDetails?.length ? { modelDetails: draft.modelDetails } : {}),
                ...(draft.modelOverrides?.length ? { modelOverrides: draft.modelOverrides } : {}),
                ...(draft.modelParameters?.length ? { modelParameters: draft.modelParameters } : {}),
                enabled: draft.enabled,
                revision: draft.revision,
                hasKey: keyBlob !== null,
                keyBlob,
            };
        } catch {
            throw databaseError();
        }
    }

    private asBuffer(value: unknown): Buffer {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
            return Buffer.from(value);
        }
        throw databaseError();
    }

    private keyBlobFromDraft(apiKey: string | null, preserved: Buffer | null): Buffer | null {
        if (apiKey === null) {
            return preserved;
        }
        if (apiKey === '') {
            return null;
        }
        if (!this.cipher.isEncryptionAvailable()) {
            throw keyError();
        }
        try {
            return Buffer.from(this.cipher.encryptString(apiKey));
        } catch {
            throw keyError();
        }
    }

    private decryptKey(keyBlob: Buffer | null): string {
        if (keyBlob === null) {
            return '';
        }
        if (!this.cipher.isEncryptionAvailable()) {
            throw keyError();
        }
        try {
            return this.cipher.decryptString(keyBlob);
        } catch {
            throw keyError();
        }
    }

    private connection(endpoint: StoredEndpoint, apiKey: string): ApiConnection {
        return {
            id: endpoint.id,
            ...(endpoint.providerId ? { providerId: endpoint.providerId } : {}),
            name: endpoint.name,
            protocol: endpoint.protocol,
            baseUrl: endpoint.baseUrl,
            models: [...endpoint.models],
            ...(endpoint.modelDetails?.length ? { modelDetails: structuredClone(endpoint.modelDetails) } : {}),
            ...(endpoint.modelOverrides?.length ? { modelOverrides: structuredClone(endpoint.modelOverrides) } : {}),
            ...(endpoint.modelParameters?.length ? { modelParameters: structuredClone(endpoint.modelParameters) } : {}),
            enabled: endpoint.enabled,
            revision: endpoint.revision,
            apiKey,
        };
    }

    private assertRevision(endpoint: StoredEndpoint, revision: number): void {
        if (endpoint.revision !== revision) {
            throw new Error('端点已被其他操作修改。');
        }
    }

    private assertEnabledModels(draft: EndpointDraft): void {
        if (draft.enabled && draft.models.length === 0) {
            throw new Error('启用端点前必须配置至少一个模型。');
        }
    }

    private assertProviderNamespaceAvailable(providerId: string | null, ownId?: string, newInternalId?: string): void {
        const rows = this.database.prepare('SELECT id, provider_id FROM endpoints').all() as Array<{ id: unknown; provider_id: unknown }>;
        if (providerId !== null && newInternalId === providerId) {
            throw new Error('Provider ID 不能与内部端点 ID 冲突。');
        }
        for (const row of rows) {
            if (typeof row.id !== 'string') throw databaseError();
            const existingProviderId = row.provider_id;
            if (newInternalId && existingProviderId === newInternalId) {
                throw new Error('内部端点 ID 与现有 Provider ID 冲突。');
            }
            if (providerId === null) continue;
            if (row.id === providerId) throw new Error('Provider ID 不能与内部端点 ID 冲突。');
            if (row.id !== ownId && existingProviderId === providerId) throw new Error('Provider ID 已被其他端点使用。');
        }
    }

    private modelParametersForDraft(
        draft: EndpointDraft,
        existing?: StoredEndpoint,
    ): NonNullable<EndpointDraft['modelParameters']> {
        const supplied = draft.modelParameters;
        const source = supplied === undefined
            ? (existing?.modelParameters ?? []).filter(({ id }) => draft.models.includes(id))
            : supplied;
        return structuredClone(source);
    }

    private assertOpen(): void {
        if (this.closed) {
            throw new Error('Endpoint store is closed.');
        }
    }
}
