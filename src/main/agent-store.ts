import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    defaultAgentSettings,
    DEFAULT_PRIMARY_AGENT_INSTRUCTIONS,
    parseAgentSettings,
    type AgentProfile,
    type AgentSettings,
} from '../shared/agents';
import { parseAgentSettingsV2 } from '../shared/agents-v2';
import { parseLegacyAgentSettings } from '../shared/agents-legacy';
import { additionalDefaultProfiles, conditionalPromptUpgrades, defaultClaudeSubagent, defaultGptSubagent, LEGACY_CLAUDE_INSTRUCTIONS, LEGACY_GPT_INSTRUCTIONS } from '../shared/agent-presets';

const SCHEMA_VERSION = 8;

interface StoredSettingsRow {
    revision: number;
    document_json: string;
}

function databaseDataError(): Error {
    return new Error('智能体数据库数据无效。');
}

function validateProfileId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new TypeError('智能体标识无效。');
    }
    return value.trim();
}

export class AgentStore {
    private readonly database: DatabaseSync;
    private closed = false;

    constructor(dataDirectory: string) {
        const directory = resolve(dataDirectory);
        mkdirSync(directory, { recursive: true });
        this.database = new DatabaseSync(resolve(directory, 'agents.sqlite'));
        try {
            this.database.exec('PRAGMA journal_mode = WAL;');
            this.database.exec('PRAGMA synchronous = FULL;');
            this.initializeSchema();
            this.readSettings();
        } catch (error) {
            this.database.close();
            this.closed = true;
            throw error;
        }
    }

    get(): AgentSettings {
        this.assertOpen();
        return this.readSettings();
    }

    save(value: AgentSettings): AgentSettings {
        this.assertOpen();
        const settings = parseAgentSettings(value);
        return this.transaction(() => {
            const current = this.readSettings();
            if (settings.revision !== current.revision) {
                throw new Error('智能体配置已被修改，请重新加载后再保存。');
            }
            if (current.revision === Number.MAX_SAFE_INTEGER) {
                throw new Error('智能体配置版本已达到上限。');
            }
            const saved = parseAgentSettings({ ...settings, revision: current.revision + 1 });
            const result = this.database.prepare(
                'UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?',
            ).run(saved.revision, JSON.stringify(saved), current.revision);
            if (Number(result.changes) !== 1) {
                throw new Error('智能体配置已被修改，请重新加载后再保存。');
            }
            return saved;
        });
    }

    resolve(id: string): AgentProfile {
        this.assertOpen();
        const profileId = validateProfileId(id);
        const profile = this.readSettings().profiles.find((item) => item.id === profileId);
        if (!profile) throw new Error('智能体不存在。');
        if (profile.kind !== 'primary') throw new Error('只能解析主智能体配置。');
        if (!profile.enabled) throw new Error('智能体已停用。');
        return profile;
    }

    close(): void {
        if (this.closed) return;
        this.database.close();
        this.closed = true;
    }

    private initializeSchema(): void {
        const versionRow = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
        const version = Number(versionRow.user_version);
        if (!Number.isSafeInteger(version) || version < 0 || version > SCHEMA_VERSION) {
            throw new Error('智能体数据库版本不受支持。');
        }
        if (version === SCHEMA_VERSION) return;

        for (;;) {
            this.database.exec('BEGIN EXCLUSIVE;');
            try {
                const lockedVersionRow = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
                const lockedVersion = Number(lockedVersionRow.user_version);
                if (lockedVersion === SCHEMA_VERSION) {
                    this.database.exec('COMMIT;');
                    return;
                }
                if (lockedVersion === 0) {
                    this.initializeEmptyDatabase();
                } else if (lockedVersion === 1) {
                    this.migrateVersionOne();
                } else if (lockedVersion === 2) {
                    this.migrateVersionTwo();
                } else if (lockedVersion === 3) {
                    this.migrateVersionThree();
                } else if (lockedVersion === 4) {
                    this.migrateVersionFour();
                } else if (lockedVersion === 5) {
                    this.migrateVersionFive();
                } else if (lockedVersion === 6) {
                    this.migrateVersionSix();
                } else if (lockedVersion === 7) {
                    this.migrateVersionSeven();
                } else {
                    throw new Error('智能体数据库版本不受支持。');
                }
                this.database.exec('COMMIT;');
            } catch (error) {
                try {
                    this.database.exec('ROLLBACK;');
                } catch {
                    // Keep the migration error.
                }
                throw error;
            }
        }
    }

    private initializeEmptyDatabase(): void {
        const objects = this.database.prepare(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type IN ('table', 'index', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'",
        ).get() as { count: number };
        if (Number(objects.count) !== 0) throw databaseDataError();

        const initial = defaultAgentSettings();
        this.database.exec(`
            CREATE TABLE agent_settings (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                revision INTEGER NOT NULL CHECK (revision >= 0),
                document_json TEXT NOT NULL CHECK (json_valid(document_json))
            );
        `);
        this.database.prepare(
            'INSERT INTO agent_settings (id, revision, document_json) VALUES (1, ?, ?)',
        ).run(initial.revision, JSON.stringify(initial));
        this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }

    private migrateVersionThree(): void {
        const row = this.database.prepare('SELECT revision, document_json FROM agent_settings WHERE id = 1').get() as StoredSettingsRow | undefined;
        if (!row || typeof row.document_json !== 'string' || Buffer.byteLength(row.document_json, 'utf8') > 1_048_576) throw databaseDataError();
        let previous: AgentSettings;
        try { previous = parseAgentSettings(JSON.parse(row.document_json)); } catch { throw databaseDataError(); }
        if (!Number.isSafeInteger(row.revision) || row.revision !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) throw databaseDataError();
        const oldDefaults = defaultAgentSettings();
        oldDefaults.profiles = oldDefaults.profiles.slice(0, 1);
        oldDefaults.profiles[0].instructions = '';
        oldDefaults.subagents.enabled = false;
        const untouchedDefaults = previous.revision === 0
            && previous.profiles.length === 1
            && Object.keys(oldDefaults.profiles[0]).every(key => previous.profiles[0][key as keyof AgentProfile] === oldDefaults.profiles[0][key as keyof AgentProfile])
            && Object.keys(oldDefaults.subagents).every(key => previous.subagents[key as keyof AgentSettings['subagents']] === oldDefaults.subagents[key as keyof AgentSettings['subagents']]);
        const migrated = parseAgentSettings({ ...previous, revision: previous.revision + 1,
            profiles: previous.profiles.map(profile => profile.kind === 'primary' && profile.id === 'default' && !profile.instructions.trim()
                ? { ...profile, instructions: DEFAULT_PRIMARY_AGENT_INSTRUCTIONS } : profile),
            subagents: { ...previous.subagents, ...(untouchedDefaults ? { enabled: true } : {}) },
        });
        this.database.exec(`CREATE TABLE agent_settings_legacy_v3 (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            source_version INTEGER NOT NULL CHECK (source_version = 3),
            document_json TEXT NOT NULL CHECK (json_valid(document_json))
        );`);
        this.database.prepare('INSERT INTO agent_settings_legacy_v3 (id, source_version, document_json) VALUES (1, 3, ?)').run(row.document_json);
        const result = this.database.prepare('UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?').run(migrated.revision, JSON.stringify(migrated), row.revision);
        if (Number(result.changes) !== 1) throw databaseDataError();
        this.database.exec('PRAGMA user_version = 4;');
    }

    private migrateVersionFour(): void {
        const row = this.database.prepare('SELECT revision, document_json FROM agent_settings WHERE id = 1').get() as StoredSettingsRow | undefined;
        if (!row || typeof row.document_json !== 'string' || Buffer.byteLength(row.document_json, 'utf8') > 1_048_576) throw databaseDataError();
        let previous: AgentSettings;
        try { previous = parseAgentSettings(JSON.parse(row.document_json)); } catch { throw databaseDataError(); }
        if (!Number.isSafeInteger(row.revision) || row.revision !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) throw databaseDataError();
        const incremented = { ...previous, revision: previous.revision + 1 };
        // At the exact document limit, a growing revision cannot displace user data.
        const revisionFits = Buffer.byteLength(JSON.stringify(incremented), 'utf8') <= 1_048_576;
        let migrated = revisionFits ? parseAgentSettings(incremented) : previous;
        for (const profile of additionalDefaultProfiles()) {
            if (!revisionFits) break;
            if (migrated.profiles.some(item => item.id === profile.id) || migrated.profiles.length >= 100) continue;
            const candidate = { ...migrated, profiles: [...migrated.profiles, profile] };
            if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 1_048_576) continue;
            migrated = parseAgentSettings(candidate);
        }
        this.database.exec(`CREATE TABLE agent_settings_legacy_v4 (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            source_version INTEGER NOT NULL CHECK (source_version = 4),
            document_json TEXT NOT NULL CHECK (json_valid(document_json))
        );`);
        this.database.prepare('INSERT INTO agent_settings_legacy_v4 (id, source_version, document_json) VALUES (1, 4, ?)').run(row.document_json);
        const result = this.database.prepare('UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?').run(migrated.revision, JSON.stringify(migrated), row.revision);
        if (Number(result.changes) !== 1) throw databaseDataError();
        this.database.exec('PRAGMA user_version = 5;');
    }

    private migrateVersionFive(): void {
        const row = this.database.prepare('SELECT revision, document_json FROM agent_settings WHERE id = 1').get() as StoredSettingsRow | undefined;
        if (!row || typeof row.document_json !== 'string' || Buffer.byteLength(row.document_json, 'utf8') > 1_048_576) throw databaseDataError();
        let previous: AgentSettings;
        try { previous = parseAgentSettings(JSON.parse(row.document_json)); } catch { throw databaseDataError(); }
        if (!Number.isSafeInteger(row.revision) || row.revision !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) throw databaseDataError();
        const incremented = { ...previous, revision: previous.revision + 1 };
        const revisionFits = Buffer.byteLength(JSON.stringify(incremented), 'utf8') <= 1_048_576;
        let migrated = revisionFits ? parseAgentSettings(incremented) : previous;
        if (revisionFits) {
            const claude = additionalDefaultProfiles().find(profile => profile.id === 'claude-default')!;
            const updated = { ...migrated, profiles: migrated.profiles.map(profile => profile.id === 'claude-default' && profile.kind === 'primary' && profile.instructions === LEGACY_CLAUDE_INSTRUCTIONS
                ? { ...profile, instructions: claude.instructions } : profile) };
            if (Buffer.byteLength(JSON.stringify(updated), 'utf8') <= 1_048_576) migrated = parseAgentSettings(updated);
            const child = defaultClaudeSubagent();
            if (migrated.profiles.length < 100 && !migrated.profiles.some(profile => profile.id === child.id)) {
                const appended = { ...migrated, profiles: [...migrated.profiles, child] };
                if (Buffer.byteLength(JSON.stringify(appended), 'utf8') <= 1_048_576) migrated = parseAgentSettings(appended);
            }
        }
        this.database.exec(`CREATE TABLE agent_settings_legacy_v5 (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            source_version INTEGER NOT NULL CHECK (source_version = 5),
            document_json TEXT NOT NULL CHECK (json_valid(document_json))
        );`);
        this.database.prepare('INSERT INTO agent_settings_legacy_v5 (id, source_version, document_json) VALUES (1, 5, ?)').run(row.document_json);
        const result = this.database.prepare('UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?').run(migrated.revision, JSON.stringify(migrated), row.revision);
        if (Number(result.changes) !== 1) throw databaseDataError();
        this.database.exec('PRAGMA user_version = 6;');
    }

    private migrateVersionSix(): void {
        const row = this.database.prepare('SELECT revision, document_json FROM agent_settings WHERE id = 1').get() as StoredSettingsRow | undefined;
        if (!row || typeof row.document_json !== 'string' || Buffer.byteLength(row.document_json, 'utf8') > 1_048_576) throw databaseDataError();
        let previous: AgentSettings;
        try { previous = parseAgentSettings(JSON.parse(row.document_json)); } catch { throw databaseDataError(); }
        if (!Number.isSafeInteger(row.revision) || row.revision !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) throw databaseDataError();
        const incremented = { ...previous, revision: previous.revision + 1 };
        const revisionFits = Buffer.byteLength(JSON.stringify(incremented), 'utf8') <= 1_048_576;
        let migrated = revisionFits ? parseAgentSettings(incremented) : previous;
        if (revisionFits) {
            const gpt = additionalDefaultProfiles().find(profile => profile.id === 'gpt-default')!;
            const updated = { ...migrated, profiles: migrated.profiles.map(profile => profile.id === 'gpt-default' && profile.kind === 'primary' && profile.instructions === LEGACY_GPT_INSTRUCTIONS
                ? { ...profile, instructions: gpt.instructions } : profile) };
            if (Buffer.byteLength(JSON.stringify(updated), 'utf8') <= 1_048_576) migrated = parseAgentSettings(updated);
            const child = defaultGptSubagent();
            if (migrated.profiles.length < 100 && !migrated.profiles.some(profile => profile.id === child.id)) {
                const appended = { ...migrated, profiles: [...migrated.profiles, child] };
                if (Buffer.byteLength(JSON.stringify(appended), 'utf8') <= 1_048_576) migrated = parseAgentSettings(appended);
            }
        }
        this.database.exec(`CREATE TABLE agent_settings_legacy_v6 (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            source_version INTEGER NOT NULL CHECK (source_version = 6),
            document_json TEXT NOT NULL CHECK (json_valid(document_json))
        );`);
        this.database.prepare('INSERT INTO agent_settings_legacy_v6 (id, source_version, document_json) VALUES (1, 6, ?)').run(row.document_json);
        const result = this.database.prepare('UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?').run(migrated.revision, JSON.stringify(migrated), row.revision);
        if (Number(result.changes) !== 1) throw databaseDataError();
        this.database.exec('PRAGMA user_version = 7;');
    }

    private migrateVersionSeven(): void {
        const row = this.database.prepare('SELECT revision, document_json FROM agent_settings WHERE id = 1').get() as StoredSettingsRow | undefined;
        if (!row || typeof row.document_json !== 'string' || Buffer.byteLength(row.document_json, 'utf8') > 1_048_576) throw databaseDataError();
        let previous: AgentSettings;
        try { previous = parseAgentSettings(JSON.parse(row.document_json)); } catch { throw databaseDataError(); }
        if (!Number.isSafeInteger(row.revision) || row.revision !== previous.revision || previous.revision >= Number.MAX_SAFE_INTEGER) throw databaseDataError();
        const incremented = { ...previous, revision: previous.revision + 1 };
        const revisionFits = Buffer.byteLength(JSON.stringify(incremented), 'utf8') <= 1_048_576;
        let migrated = revisionFits ? parseAgentSettings(incremented) : previous;
        if (revisionFits) {
            for (const upgrade of conditionalPromptUpgrades()) {
                const candidate = { ...migrated, profiles: migrated.profiles.map(profile => profile.id === upgrade.id && profile.kind === upgrade.kind && profile.instructions === upgrade.previousInstructions
                    ? { ...profile, instructions: upgrade.instructions } : profile) };
                if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= 1_048_576) migrated = parseAgentSettings(candidate);
            }
        }
        this.database.exec(`CREATE TABLE agent_settings_legacy_v7 (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            source_version INTEGER NOT NULL CHECK (source_version = 7),
            document_json TEXT NOT NULL CHECK (json_valid(document_json))
        );`);
        this.database.prepare('INSERT INTO agent_settings_legacy_v7 (id, source_version, document_json) VALUES (1, 7, ?)').run(row.document_json);
        const result = this.database.prepare('UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?').run(migrated.revision, JSON.stringify(migrated), row.revision);
        if (Number(result.changes) !== 1) throw databaseDataError();
        this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`);
    }

    private migrateVersionOne(): void {
        let row: StoredSettingsRow | undefined;
        try {
            row = this.database.prepare(
                'SELECT revision, document_json FROM agent_settings WHERE id = 1',
            ).get() as StoredSettingsRow | undefined;
        } catch {
            throw databaseDataError();
        }
        if (!row || typeof row.document_json !== 'string'
            || new TextEncoder().encode(row.document_json).byteLength > 1_048_576) {
            throw databaseDataError();
        }

        let legacy: ReturnType<typeof parseLegacyAgentSettings>;
        try {
            const parsed: unknown = JSON.parse(row.document_json);
            legacy = parseLegacyAgentSettings(parsed);
        } catch {
            throw databaseDataError();
        }
        if (!Number.isSafeInteger(row.revision) || row.revision !== legacy.revision) throw databaseDataError();
        if (legacy.revision >= Number.MAX_SAFE_INTEGER) throw databaseDataError();

        const profiles = legacy.profiles.map((profile) => {
            const permissionMode = profile.sandboxMode === 'read-only'
                ? 'readonly'
                : profile.sandboxMode === 'workspace-write'
                    ? 'accept-edits'
                    : profile.kind === 'primary' ? 'readonly' : 'inherit';
            if (profile.kind === 'primary') {
                return {
                    id: profile.id,
                    name: profile.name,
                    description: profile.description,
                    instructions: profile.instructions,
                    enabled: profile.enabled,
                    kind: 'primary',
                    permissionMode: permissionMode === 'inherit' ? 'readonly' : permissionMode,
                    // Primary delegation was added after the original setting was introduced.
                    allowDelegation: true,
                };
            }
            return {
                id: profile.id,
                name: profile.name,
                description: profile.description,
                instructions: profile.instructions,
                enabled: profile.enabled,
                kind: 'subagent',
                permissionMode,
                model: profile.model,
                allowDelegation: profile.allowDelegation,
            };
        });
        const migrated = parseAgentSettingsV2({
            revision: legacy.revision + 1,
            profiles,
            subagents: {
                enabled: legacy.subagents.enabled,
                maxConcurrentThreads: legacy.subagents.maxConcurrentThreads,
                maxDepth: legacy.subagents.maxDepth,
                inheritHistory: legacy.subagents.inheritHistory,
                timeoutSeconds: legacy.subagents.timeoutSeconds,
            },
        });

        this.database.exec(`
            CREATE TABLE agent_settings_legacy (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                source_version INTEGER NOT NULL CHECK (source_version = 1),
                document_json TEXT NOT NULL CHECK (json_valid(document_json))
            );
        `);
        this.database.prepare(
            'INSERT INTO agent_settings_legacy (id, source_version, document_json) VALUES (1, 1, ?)',
        ).run(row.document_json);
        const result = this.database.prepare(
            'UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?',
        ).run(migrated.revision, JSON.stringify(migrated), row.revision);
        if (Number(result.changes) !== 1) throw databaseDataError();
        this.database.exec('PRAGMA user_version = 2;');
    }

    private migrateVersionTwo(): void {
        let row: StoredSettingsRow | undefined;
        try {
            row = this.database.prepare(
                'SELECT revision, document_json FROM agent_settings WHERE id = 1',
            ).get() as StoredSettingsRow | undefined;
        } catch {
            throw databaseDataError();
        }
        if (!row || typeof row.document_json !== 'string'
            || new TextEncoder().encode(row.document_json).byteLength > 1_048_576) {
            throw databaseDataError();
        }

        let legacy: ReturnType<typeof parseAgentSettingsV2>;
        try {
            const parsed: unknown = JSON.parse(row.document_json);
            legacy = parseAgentSettingsV2(parsed);
        } catch {
            throw databaseDataError();
        }
        if (!Number.isSafeInteger(row.revision) || row.revision !== legacy.revision) throw databaseDataError();
        if (legacy.revision >= Number.MAX_SAFE_INTEGER) throw databaseDataError();

        const profiles: AgentProfile[] = legacy.profiles.map((profile) => {
            const base = {
                id: profile.id,
                name: profile.name,
                description: profile.description,
                instructions: profile.instructions,
                enabled: profile.enabled,
                allowDelegation: profile.allowDelegation,
            };
            return profile.kind === 'primary'
                ? { ...base, kind: 'primary' as const }
                : {
                    ...base,
                    kind: 'subagent' as const,
                    ...('model' in profile ? { model: profile.model } : {}),
                };
        });
        const migrated = parseAgentSettings({
            revision: legacy.revision + 1,
            profiles,
            subagents: legacy.subagents,
        });

        this.database.exec(`
            CREATE TABLE agent_settings_legacy_v2 (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                source_version INTEGER NOT NULL CHECK (source_version = 2),
                document_json TEXT NOT NULL CHECK (json_valid(document_json))
            );
        `);
        this.database.prepare(
            'INSERT INTO agent_settings_legacy_v2 (id, source_version, document_json) VALUES (1, 2, ?)',
        ).run(row.document_json);
        const result = this.database.prepare(
            'UPDATE agent_settings SET revision = ?, document_json = ? WHERE id = 1 AND revision = ?',
        ).run(migrated.revision, JSON.stringify(migrated), row.revision);
        if (Number(result.changes) !== 1) throw databaseDataError();
        this.database.exec('PRAGMA user_version = 3;');
    }

    private readSettings(): AgentSettings {
        const row = this.database.prepare(
            'SELECT revision, document_json FROM agent_settings WHERE id = 1',
        ).get() as StoredSettingsRow | undefined;
        if (!row || typeof row.document_json !== 'string') throw databaseDataError();

        let value: unknown;
        try {
            value = JSON.parse(row.document_json);
        } catch {
            throw databaseDataError();
        }
        let settings: AgentSettings;
        try {
            settings = parseAgentSettings(value);
        } catch {
            throw databaseDataError();
        }
        if (!Number.isSafeInteger(row.revision) || settings.revision !== row.revision) throw databaseDataError();
        return settings;
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
                // Preserve the original operation error.
            }
            throw error;
        }
    }

    private assertOpen(): void {
        if (this.closed) throw new Error('智能体数据库已关闭。');
    }
}
