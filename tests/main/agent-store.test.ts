import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { AgentStore } from '../../src/main/agent-store';
import {
    defaultAgentSettings,
    DEFAULT_PRIMARY_AGENT_INSTRUCTIONS,
    parseAgentCommand,
    parseAgentSettings,
    type AgentSettings,
} from '../../src/shared/agents';
import { additionalDefaultProfiles, conditionalPromptUpgrades, defaultClaudeSubagent, defaultGptSubagent, LEGACY_CLAUDE_INSTRUCTIONS, LEGACY_GPT_INSTRUCTIONS } from '../../src/shared/agent-presets';
import { defaultModelParameters } from '../../src/shared/model-parameters';

function createHarness(): { root: string; store: AgentStore } {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-'));
    return { root, store: new AgentStore(root) };
}

function cleanup(root: string): void {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-agent-store-test-')) {
        throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

function versionOneSettings() {
    return {
        revision: 14,
        profiles: [
            {
                id: 'primary-custom',
                name: 'Custom primary',
                description: 'kept description',
                instructions: 'kept instructions',
                enabled: true,
                kind: 'primary',
                model: { endpointId: 'primary-endpoint', modelId: 'primary-model' },
                parameters: { ...defaultModelParameters(), temperature: 0.42, maxOutputTokens: 321 },
                sandboxMode: 'workspace-write',
                allowDelegation: false,
            },
            {
                id: 'child-custom',
                name: 'Custom child',
                description: 'child description',
                instructions: 'child instructions',
                enabled: false,
                kind: 'subagent',
                model: { endpointId: 'child-endpoint', modelId: 'child-model' },
                parameters: { ...defaultModelParameters(), reasoningEffort: 'high' },
                sandboxMode: 'inherit',
                allowDelegation: false,
            },
        ],
        subagents: {
            enabled: true,
            maxConcurrentThreads: 9,
            maxDepth: 4,
            defaultModel: { endpointId: 'unbound-global-endpoint', modelId: 'unbound-global-model' },
            defaultReasoningEffort: 'xhigh',
            inheritHistory: true,
            allowModelOverride: false,
            allowReasoningOverride: false,
            timeoutSeconds: 900,
        },
    };
}

function versionTwoSettings() {
    return {
        revision: 28,
        profiles: [
            {
                id: 'primary-v2',
                name: 'Primary v2',
                description: '',
                instructions: 'Preserve the profile',
                enabled: true,
                kind: 'primary',
                permissionMode: 'auto',
                allowDelegation: true,
            },
            {
                id: 'child-v2',
                name: 'Child v2',
                description: 'optional model survives',
                instructions: '',
                enabled: true,
                kind: 'subagent',
                permissionMode: 'inherit',
                model: { endpointId: 'child-endpoint', modelId: 'child-model' },
                allowDelegation: false,
            },
            {
                id: 'child-without-model-v2',
                name: 'Child without model v2',
                description: '',
                instructions: '',
                enabled: true,
                kind: 'subagent',
                permissionMode: 'readonly',
                allowDelegation: false,
            },
        ],
        subagents: {
            enabled: true,
            maxConcurrentThreads: 5,
            maxDepth: 2,
            inheritHistory: true,
            timeoutSeconds: 600,
        },
    };
}

function installDatabase(root: string, version: 1 | 2 | 3 | 4 | 5 | 6 | 7, document: unknown, rowRevision?: number): string {
    const documentJson = JSON.stringify(document);
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    database.exec(`
        CREATE TABLE agent_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            revision INTEGER NOT NULL CHECK (revision >= 0),
            document_json TEXT NOT NULL CHECK (json_valid(document_json))
        );
        PRAGMA user_version = ${version};
    `);
    const revision = rowRevision ?? (document as { revision: number }).revision;
    database.prepare('INSERT INTO agent_settings (id, revision, document_json) VALUES (1, ?, ?)').run(revision, documentJson);
    database.close();
    return documentJson;
}

function primarySettings(): AgentSettings {
    const value = defaultAgentSettings(); value.profiles = value.profiles.slice(0, 1); return value;
}

test('provides permission-free orchestration defaults and parses only the closed schema', () => {
    const defaults = defaultAgentSettings();
    assert.deepEqual(defaults, {
        revision: 0,
        profiles: [{
            id: 'default',
            name: '默认助手',
            description: '',
            instructions: conditionalPromptUpgrades().find(upgrade => upgrade.id === 'default')!.instructions,
            enabled: true,
            kind: 'primary',
            allowDelegation: true,
        }, ...additionalDefaultProfiles(), defaultClaudeSubagent(), defaultGptSubagent()],
        subagents: {
            enabled: true,
            maxConcurrentThreads: 6,
            maxDepth: 1,
            inheritHistory: false,
            timeoutSeconds: 300,
        },
    });
    assert.deepEqual(parseAgentSettings(defaults), defaults);
    assert.deepEqual(defaults.profiles.map(profile => profile.id), ['default', 'claude-default', 'gpt-default', 'coding-general', 'claude-subagent-default', 'gpt-subagent-default']);
    const gptChild = defaults.profiles.find(profile => profile.id === 'gpt-subagent-default')!;
    assert.equal(gptChild.kind, 'subagent'); assert.equal('model' in gptChild && gptChild.model, null); assert.equal(gptChild.allowDelegation, false);
    assert.deepEqual(parseAgentCommand({ type: 'get' }), { type: 'get' });
    assert.deepEqual(parseAgentCommand({ type: 'save', settings: defaults }), { type: 'save', settings: defaults });

    const renamed = structuredClone(defaults);
    renamed.profiles[0].id = 'primary-main';
    assert.equal(parseAgentSettings(renamed).profiles[0].id, 'primary-main');
    assert.throws(() => parseAgentSettings({ ...defaults, apiKey: 'secret' }), /字段无效/);
    assert.throws(() => parseAgentCommand({ type: 'get', settings: defaults }), /字段无效/);
    assert.throws(() => parseAgentCommand({ type: 'save', settings: defaults, key: 'secret' }), /字段无效/);
    assert.throws(() => parseAgentCommand({ type: 'unknown' }), /未知智能体操作/);

    const childWithoutModel = {
        ...defaults.profiles[0],
        id: 'child',
        kind: 'subagent' as const,
    };
    const parsedChild = parseAgentSettings({ ...defaults, profiles: [...defaults.profiles, childWithoutModel] });
    assert.equal(parsedChild.profiles.at(-1)!.kind, 'subagent');
    assert.equal('model' in parsedChild.profiles.at(-1)!, false);
});

test('rejects session permission fields, removed profile fields, primary models, and out-of-bounds values', () => {
    const defaults = primarySettings();
    const primary = defaults.profiles[0];
    const child = {
        ...primary,
        id: 'child',
        kind: 'subagent',
        model: null,
    };
    const invalidSettings: unknown[] = [
        { ...defaults, profiles: [] },
        { ...defaults, profiles: [{ ...primary, enabled: false }] },
        { ...defaults, profiles: [primary, { ...primary }] },
        { ...defaults, profiles: Array.from({ length: 101 }, (_, index) => ({ ...primary, id: `p-${index}` })) },
        { ...defaults, profiles: [{ ...primary, name: 'n'.repeat(101) }] },
        { ...defaults, profiles: [{ ...primary, description: 'd'.repeat(2001) }] },
        { ...defaults, profiles: [{ ...primary, instructions: 'i'.repeat(32_001) }] },
        { ...defaults, profiles: [{ ...primary, model: null }] },
        { ...defaults, profiles: [{ ...primary, parameters: defaultModelParameters() }] },
        { ...defaults, profiles: [{ ...primary, sandboxMode: 'inherit' }] },
        { ...defaults, profiles: [{ ...primary, permissionMode: 'readonly' }] },
        { ...defaults, profiles: [primary, { ...child, permissionMode: 'inherit' }] },
        { ...defaults, profiles: [primary, { ...child, permissionMode: 'accept-edits' }] },
        { ...defaults, profiles: [primary, { ...child, model: { endpointId: 'endpoint', modelId: 'model', apiKey: 'secret' } }] },
        { ...defaults, subagents: { ...defaults.subagents, maxConcurrentThreads: 0 } },
        { ...defaults, subagents: { ...defaults.subagents, maxDepth: 9 } },
        { ...defaults, subagents: { ...defaults.subagents, timeoutSeconds: 3601 } },
        { ...defaults, subagents: { ...defaults.subagents, allowModelOverride: true } },
        { ...defaults, profiles: [primary, { ...child, instructions: 'x'.repeat(32_000) }, ...Array.from({ length: 32 }, (_, index) => ({ ...child, id: `large-${index}`, instructions: 'x'.repeat(32_000) }))] },
    ];

    for (const invalid of invalidSettings) assert.throws(() => parseAgentSettings(invalid));
});

test('copies validated profiles and accepts inclusive setting bounds', () => {
    const input = primarySettings();
    const child = {
        ...input.profiles[0],
        id: 'child',
        kind: 'subagent' as const,
        model: { endpointId: 'endpoint', modelId: 'model' },
    };
    input.profiles.push(child);
    input.subagents = { ...input.subagents, maxConcurrentThreads: 32, maxDepth: 8, timeoutSeconds: 3600 };
    const parsed = parseAgentSettings(input);
    if (parsed.profiles[1].kind !== 'subagent' || !parsed.profiles[1].model) throw new Error('Expected child model.');
    parsed.profiles[1].model.modelId = 'changed';
    assert.equal(child.model.modelId, 'model');
    assert.deepEqual(parseAgentSettings(input), input);
});

test('saves with optimistic revisions and rejects stale updates without overwriting', (t) => {
    const harness = createHarness();
    t.after(() => {
        harness.store.close();
        cleanup(harness.root);
    });
    const loaded = harness.store.get();
    const changed = structuredClone(loaded);
    changed.profiles[0].name = 'Renamed';
    const saved = harness.store.save(changed);
    assert.equal(saved.revision, 1);
    assert.equal(harness.store.get().profiles[0].name, 'Renamed');
    assert.throws(() => harness.store.save(loaded), /已被修改/);
    assert.equal(harness.store.get().revision, 1);
});

test('resolves enabled primary profiles and rejects disabled or subagent profiles', (t) => {
    const harness = createHarness();
    t.after(() => {
        harness.store.close();
        cleanup(harness.root);
    });
    const settings = harness.store.get();
    settings.profiles = [
        { ...settings.profiles[0], id: 'disabled', enabled: false },
        { ...settings.profiles[0], id: 'ready', name: 'Ready' },
        { ...settings.profiles[0], id: 'child', name: 'Child', kind: 'subagent' },
    ];
    harness.store.save(settings);

    assert.equal(harness.store.resolve('ready').name, 'Ready');
    assert.throws(() => harness.store.resolve('disabled'), /已停用/);
    assert.throws(() => harness.store.resolve('child'), /主智能体配置/);
    assert.throws(() => harness.store.resolve('missing'), /不存在/);
});

test('migrates v1 through v8, retaining every recovery archive and incrementing each revision', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-'));
    t.after(() => cleanup(root));
    const originalV1 = installDatabase(root, 1, versionOneSettings());

    const migratedStore = new AgentStore(root);
    const migrated = migratedStore.get();
    const expectedV3 = {
        revision: 17,
        profiles: [
            {
                id: 'primary-custom',
                name: 'Custom primary',
                description: 'kept description',
                instructions: 'kept instructions',
                enabled: true,
                kind: 'primary',
                allowDelegation: true,
            },
            {
                id: 'child-custom',
                name: 'Custom child',
                description: 'child description',
                instructions: 'child instructions',
                enabled: false,
                kind: 'subagent',
                model: { endpointId: 'child-endpoint', modelId: 'child-model' },
                allowDelegation: false,
            },
        ],
        subagents: {
            enabled: true,
            maxConcurrentThreads: 9,
            maxDepth: 4,
            inheritHistory: true,
            timeoutSeconds: 900,
        },
    };
    assert.deepEqual(migrated, { ...expectedV3, revision: 21, profiles: [...expectedV3.profiles, ...additionalDefaultProfiles(), defaultClaudeSubagent(), defaultGptSubagent()] });
    migratedStore.close();

    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
    const archivedV1 = database.prepare('SELECT source_version, document_json FROM agent_settings_legacy WHERE id = 1').get() as { source_version: number; document_json: string };
    const archivedV2 = database.prepare('SELECT source_version, document_json FROM agent_settings_legacy_v2 WHERE id = 1').get() as { source_version: number; document_json: string };
    const archivedV3 = database.prepare('SELECT document_json FROM agent_settings_legacy_v3 WHERE id = 1').get() as { document_json: string };
    const archivedV4 = database.prepare('SELECT document_json FROM agent_settings_legacy_v4 WHERE id = 1').get() as { document_json: string };
    const archivedV5 = database.prepare('SELECT document_json FROM agent_settings_legacy_v5 WHERE id = 1').get() as { document_json: string };
    const archivedV6 = database.prepare('SELECT document_json FROM agent_settings_legacy_v6 WHERE id = 1').get() as { document_json: string };
    const archivedV7 = database.prepare('SELECT document_json FROM agent_settings_legacy_v7 WHERE id = 1').get() as { document_json: string };
    assert.equal(version.user_version, 8);
    assert.equal(archivedV1.source_version, 1);
    assert.equal(archivedV1.document_json, originalV1);
    assert.equal(archivedV2.source_version, 2);
    assert.deepEqual(JSON.parse(archivedV3.document_json), { ...expectedV3, revision: 16 });
    assert.deepEqual(JSON.parse(archivedV4.document_json), expectedV3);
    assert.deepEqual(JSON.parse(archivedV5.document_json), { ...expectedV3, revision: 18, profiles: [...expectedV3.profiles, ...additionalDefaultProfiles()] });
    assert.deepEqual(JSON.parse(archivedV6.document_json), { ...expectedV3, revision: 19, profiles: [...expectedV3.profiles, ...additionalDefaultProfiles(), defaultClaudeSubagent()] });
    assert.deepEqual(JSON.parse(archivedV7.document_json), { ...expectedV3, revision: 20, profiles: [...expectedV3.profiles, ...additionalDefaultProfiles(), defaultClaudeSubagent(), defaultGptSubagent()] });
    assert.deepEqual(JSON.parse(archivedV2.document_json), {
        revision: 15,
        profiles: [
            {
                id: 'primary-custom',
                name: 'Custom primary',
                description: 'kept description',
                instructions: 'kept instructions',
                enabled: true,
                allowDelegation: true,
                kind: 'primary',
                permissionMode: 'accept-edits',
            },
            {
                id: 'child-custom',
                name: 'Custom child',
                description: 'child description',
                instructions: 'child instructions',
                enabled: false,
                allowDelegation: false,
                kind: 'subagent',
                permissionMode: 'inherit',
                model: { endpointId: 'child-endpoint', modelId: 'child-model' },
            },
        ],
        subagents: expectedV3.subagents,
    });
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM agent_settings_legacy').get() as { count: number }).count, 1);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM agent_settings_legacy_v2').get() as { count: number }).count, 1);
    database.close();

    const reopened = new AgentStore(root);
    assert.deepEqual(reopened.get(), migrated);
    reopened.close();
});

test('migrates an existing v2 document and preserves it in its own recovery archive', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-'));
    t.after(() => cleanup(root));
    const originalV2 = installDatabase(root, 2, versionTwoSettings());

    const migratedStore = new AgentStore(root);
    const migrated = migratedStore.get();
    assert.equal(migrated.revision, 34);
    assert.deepEqual(migrated.profiles.slice(0, 3), [
        {
            id: 'primary-v2',
            name: 'Primary v2',
            description: '',
            instructions: 'Preserve the profile',
            enabled: true,
            allowDelegation: true,
            kind: 'primary',
        },
        {
            id: 'child-v2',
            name: 'Child v2',
            description: 'optional model survives',
            instructions: '',
            enabled: true,
            allowDelegation: false,
            kind: 'subagent',
            model: { endpointId: 'child-endpoint', modelId: 'child-model' },
        },
        {
            id: 'child-without-model-v2',
            name: 'Child without model v2',
            description: '',
            instructions: '',
            enabled: true,
            allowDelegation: false,
            kind: 'subagent',
        },
    ]);
    migratedStore.close();

    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    const archived = database.prepare('SELECT source_version, document_json FROM agent_settings_legacy_v2 WHERE id = 1').get() as { source_version: number; document_json: string };
    assert.equal(archived.source_version, 2);
    assert.equal(archived.document_json, originalV2);
    assert.equal((database.prepare('SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = \'table\' AND name = \'agent_settings_legacy\'').get() as { count: number }).count, 0);
    database.close();

    const reopened = new AgentStore(root);
    assert.deepEqual(reopened.get(), migrated);
    reopened.close();
});

test('does not reset or partially migrate a corrupt v1 revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-'));
    try {
        installDatabase(root, 1, versionOneSettings(), 13);
        assert.throws(() => new AgentStore(root), /数据库数据无效/);
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
        const archiveCount = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'agent_settings_legacy'").get() as { count: number };
        const row = database.prepare('SELECT revision FROM agent_settings WHERE id = 1').get() as { revision: number };
        assert.equal(version.user_version, 1);
        assert.equal(archiveCount.count, 0);
        assert.equal(row.revision, 13);
        database.close();
    } finally {
        cleanup(root);
    }
});

test('does not reset or archive a corrupt v2 revision', () => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-'));
    try {
        const originalV2 = versionTwoSettings();
        installDatabase(root, 2, originalV2, originalV2.revision - 1);
        assert.throws(() => new AgentStore(root), /数据库数据无效/);
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        const version = database.prepare('PRAGMA user_version').get() as { user_version: number };
        const archiveCount = database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'agent_settings_legacy_v2'").get() as { count: number };
        const row = database.prepare('SELECT revision, document_json FROM agent_settings WHERE id = 1').get() as { revision: number; document_json: string };
        assert.equal(version.user_version, 2);
        assert.equal(archiveCount.count, 0);
        assert.equal(row.revision, originalV2.revision - 1);
        assert.equal(row.document_json, JSON.stringify(originalV2));
        database.close();
    } finally {
        cleanup(root);
    }
});

test('persists current settings and reports corrupted documents instead of resetting them', (t) => {
    const harness = createHarness();
    t.after(() => cleanup(harness.root));
    const changed = harness.store.get();
    changed.profiles[0].instructions = 'Keep the user configuration';
    const saved = harness.store.save(changed);
    harness.store.close();

    const reopened = new AgentStore(harness.root);
    assert.deepEqual(reopened.get(), saved);
    reopened.close();

    const database = new DatabaseSync(join(harness.root, 'agents.sqlite'));
    database.prepare("UPDATE agent_settings SET document_json = '{\"unexpected\":true}' WHERE id = 1").run();
    database.close();
    assert.throws(() => new AgentStore(harness.root), /数据库数据无效/);

    const verify = new DatabaseSync(join(harness.root, 'agents.sqlite'));
    const row = verify.prepare('SELECT document_json FROM agent_settings WHERE id = 1').get() as { document_json: string };
    assert.equal(row.document_json, '{"unexpected":true}');
    verify.close();
});

test('rejects operations after close', (t) => {
    const harness = createHarness();
    t.after(() => cleanup(harness.root));
    harness.store.close();
    assert.throws(() => harness.store.get(), /已关闭/);
    assert.throws(() => harness.store.save(defaultAgentSettings()), /已关闭/);
    assert.throws(() => harness.store.resolve('default'), /已关闭/);
});

function previousDefaults(): AgentSettings { const value = primarySettings(); value.profiles[0].instructions = ''; value.subagents.enabled = false; return value; }

test('v3 untouched builtin defaults receive prompt and orchestration exactly once with original archive', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const original = installDatabase(root, 3, previousDefaults());
    const store = new AgentStore(root); const migrated = store.get();
    assert.equal(migrated.revision, 5); assert.equal(migrated.profiles[0].instructions, conditionalPromptUpgrades().find(upgrade => upgrade.id === 'default')!.instructions); assert.equal(migrated.subagents.enabled, true); store.close();
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    const archive = database.prepare('SELECT source_version, document_json FROM agent_settings_legacy_v3 WHERE id = 1').get() as { source_version: number; document_json: string };
    assert.equal(archive.source_version, 3); assert.equal(archive.document_json, original); database.close();
    const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated); reopened.close();
    for (const phrase of ['list_agent_presets', 'spawn_agent', 'wait_agents', 'providerId', 'modelId', 'reasoningEffort', 'expectedContent', 'Plan', 'readonly']) assert.ok(DEFAULT_PRIMARY_AGENT_INSTRUCTIONS.includes(phrase));
});

test('v3 migration preserves saved disable choices, custom prompts and user-created agents', t => {
    const scenarios = [
        { revision: 5, instructions: '', customized: false },
        { revision: 0, instructions: 'My custom instructions', customized: false },
        { revision: 0, instructions: '', customized: true },
    ];
    for (const scenario of scenarios) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const original = previousDefaults(); original.revision = scenario.revision; original.profiles[0].instructions = scenario.instructions;
        if (scenario.customized) {
            original.subagents.maxDepth = 2;
            original.profiles.push({ ...original.profiles[0], id: 'user-primary', name: 'Custom primary', instructions: '', kind: 'primary' });
            original.profiles.push({ ...original.profiles[0], id: 'user-child', name: 'Custom child', instructions: 'Child instructions', kind: 'subagent' });
        }
        installDatabase(root, 3, original);
        const store = new AgentStore(root); const migrated = store.get();
        assert.equal(migrated.revision, scenario.revision + 5); assert.equal(migrated.subagents.enabled, false);
        assert.equal(migrated.profiles[0].instructions, scenario.instructions || conditionalPromptUpgrades().find(upgrade => upgrade.id === 'default')!.instructions);
        assert.deepEqual(migrated.profiles.slice(1), [...original.profiles.slice(1), ...additionalDefaultProfiles(), defaultClaudeSubagent(), defaultGptSubagent()]); store.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated); reopened.close();
    }
});

test('v3 migration validates source revision and rolls back without archive or reset', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = previousDefaults(); const original = installDatabase(root, 3, previous, 2);
    assert.throws(() => new AgentStore(root), /数据库数据无效/);
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    assert.equal((database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 3);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'agent_settings_legacy_v3'").get() as { count: number }).count, 0);
    assert.equal((database.prepare('SELECT document_json FROM agent_settings WHERE id = 1').get() as { document_json: string }).document_json, original); database.close();
});

test('v4 migration appends missing defaults once, preserves ID collisions/order/settings and never resurrects deletion', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = primarySettings(); previous.revision = 7; previous.subagents.enabled = false;
    previous.profiles.unshift({ ...previous.profiles[0], id: 'gpt-default', name: 'User owned', enabled: false, allowDelegation: false });
    const original = installDatabase(root, 4, previous);
    const store = new AgentStore(root); const migrated = store.get();
    assert.equal(migrated.revision, 11); assert.deepEqual(migrated.profiles.slice(0, 2), previous.profiles);
    assert.deepEqual(migrated.subagents, previous.subagents);
    assert.deepEqual(migrated.profiles.slice(2), [...additionalDefaultProfiles().filter(profile => profile.id !== 'gpt-default'), defaultClaudeSubagent(), defaultGptSubagent()]);
    store.close();
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 8);
    assert.equal((database.prepare('SELECT document_json FROM agent_settings_legacy_v4').get() as any).document_json, original); database.close();
    const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated);
    const deleted = reopened.get(); deleted.profiles = deleted.profiles.filter(profile => profile.id !== 'claude-default');
    const saved = reopened.save(deleted); reopened.close();
    const final = new AgentStore(root); assert.deepEqual(final.get(), saved); final.close();
});

test('v4 count capacity only adds fitting presets and never discards profiles', t => {
    for (const count of [99, 100]) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const previous = primarySettings(); previous.profiles = Array.from({ length: count }, (_, index) => ({ ...previous.profiles[0], id: `custom-${index}`, instructions: '' }));
        installDatabase(root, 4, previous); const store = new AgentStore(root); const migrated = store.get();
        assert.equal(migrated.profiles.length, 100); assert.deepEqual(migrated.profiles.slice(0, count), previous.profiles);
        assert.equal(migrated.revision, 4); store.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated); reopened.close();
    }
});

function exactCapacitySettings(revision: number): AgentSettings {
    const value = primarySettings(); value.revision = revision;
    value.profiles = Array.from({ length: 34 }, (_, index) => ({ ...value.profiles[0], id: `large-${index}`, instructions: '' }));
    let remaining = 1_048_576 - Buffer.byteLength(JSON.stringify(value), 'utf8');
    for (const profile of value.profiles) { const length = Math.min(remaining, 32000); profile.instructions = 'x'.repeat(length); remaining -= length; }
    assert.equal(remaining, 0); assert.equal(Buffer.byteLength(JSON.stringify(value), 'utf8'), 1_048_576);
    return parseAgentSettings(value);
}

test('v4 byte capacity preserves every field, including exact-limit revision digit growth', t => {
    for (const revision of [8, 9]) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const previous = exactCapacitySettings(revision); const original = installDatabase(root, 4, previous);
        const store = new AgentStore(root); const migrated = store.get();
        assert.deepEqual(migrated, { ...previous, revision: 9 }); store.close();
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 8);
        assert.equal((database.prepare('SELECT document_json FROM agent_settings_legacy_v4').get() as any).document_json, original); database.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated); reopened.close();
    }
});

test('v4 byte capacity appends a fitting preset without requiring room for the entire preset bundle', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = exactCapacitySettings(8); const first = additionalDefaultProfiles()[0];
    let space = Buffer.byteLength(JSON.stringify(first), 'utf8') + 1;
    for (const profile of [...previous.profiles].reverse()) { const trim = Math.min(space, profile.instructions.length); profile.instructions = profile.instructions.slice(trim); space -= trim; }
    assert.equal(space, 0); installDatabase(root, 4, previous);
    const store = new AgentStore(root); const migrated = store.get();
    assert.deepEqual(migrated.profiles, [...previous.profiles, first]);
    assert.equal(Buffer.byteLength(JSON.stringify(migrated), 'utf8'), 1_048_576); store.close();
});

test('v4 invalid documents/revisions roll back without archive or user data replacement', t => {
    for (const scenario of ['revision', 'schema', 'saturated'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const value = primarySettings(); if (scenario === 'saturated') value.revision = Number.MAX_SAFE_INTEGER;
        const document = scenario === 'schema' ? { ...value, unexpected: true } : value;
        const original = installDatabase(root, 4, document, scenario === 'revision' ? 2 : undefined);
        assert.throws(() => new AgentStore(root), /数据库数据无效/);
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 4);
        assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'agent_settings_legacy_v4'").get() as any).count, 0);
        assert.equal((database.prepare('SELECT document_json FROM agent_settings').get() as any).document_json, original); database.close();
    }
});

test('v5 updates only exact legacy Claude instructions and preserves user fields, custom text and deleted primary', t => {
    for (const scenario of ['legacy', 'custom', 'deleted', 'wrong-kind'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const previous = primarySettings(); previous.revision = 4; previous.subagents.enabled = false;
        if (scenario !== 'deleted') previous.profiles.push({ ...previous.profiles[0], id: 'claude-default', name: 'User name', description: 'User description', enabled: false, allowDelegation: false,
            kind: scenario === 'wrong-kind' ? 'subagent' : 'primary', instructions: scenario === 'custom' ? 'User customized instructions' : LEGACY_CLAUDE_INSTRUCTIONS });
        const original = installDatabase(root, 5, previous); const store = new AgentStore(root); const migrated = store.get();
        const expectedProfiles = previous.profiles.map(profile => scenario === 'legacy' && profile.id === 'claude-default' ? { ...profile, instructions: additionalDefaultProfiles()[0].instructions } : profile);
        assert.deepEqual(migrated, { ...previous, revision: 7, profiles: [...expectedProfiles, defaultClaudeSubagent(), defaultGptSubagent()] }); store.close();
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 8);
        assert.equal((database.prepare('SELECT document_json FROM agent_settings_legacy_v5').get() as any).document_json, original); database.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated);
        const removed = reopened.get(); removed.profiles = removed.profiles.filter(profile => !['claude-default', 'claude-subagent-default'].includes(profile.id));
        const saved = reopened.save(removed); reopened.close();
        const final = new AgentStore(root); assert.deepEqual(final.get(), saved); final.close();
    }
});

test('v5 keeps colliding child IDs and respects count and exact byte capacity', t => {
    for (const scenario of ['collision', 'room-count', 'full-count', 'full-bytes', 'digit-growth'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const previous = scenario === 'full-bytes' ? exactCapacitySettings(8) : scenario === 'digit-growth' ? exactCapacitySettings(9) : primarySettings();
        if (scenario === 'collision') previous.profiles.push({ ...previous.profiles[0], id: 'claude-subagent-default', name: 'User primary with reserved ID', instructions: 'Keep custom role' });
        if (scenario === 'full-count' || scenario === 'room-count') previous.profiles = Array.from({ length: scenario === 'room-count' ? 99 : 100 }, (_, index) => ({ ...previous.profiles[0], id: `user-${index}`, instructions: '' }));
        const original = installDatabase(root, 5, previous); const store = new AgentStore(root); const migrated = store.get();
        assert.deepEqual(migrated, { ...previous, revision: ['digit-growth', 'full-bytes'].includes(scenario) ? 9 : previous.revision + 3,
            ...(scenario === 'room-count' ? { profiles: [...previous.profiles, defaultClaudeSubagent()] } : scenario === 'collision' ? { profiles: [...previous.profiles, defaultGptSubagent()] } : {}) }); store.close();
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        assert.equal((database.prepare('SELECT document_json FROM agent_settings_legacy_v5').get() as any).document_json, original); database.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated); reopened.close();
    }
});

test('v5 corrupt documents roll back before archive or partial preset updates', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = primarySettings(); const original = installDatabase(root, 5, previous, 2);
    assert.throws(() => new AgentStore(root), /数据库数据无效/);
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 5);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'agent_settings_legacy_v5'").get() as any).count, 0);
    assert.equal((database.prepare('SELECT document_json FROM agent_settings').get() as any).document_json, original); database.close();
});

test('v6 upgrades only exact legacy GPT primary instructions and archives original metadata and disabled choices', t => {
    for (const scenario of ['legacy', 'custom', 'near-match', 'deleted', 'wrong-kind'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const previous = primarySettings(); previous.revision = 4; previous.subagents.enabled = false;
        if (scenario !== 'deleted') previous.profiles.push({ ...previous.profiles[0], id: 'gpt-default', name: 'User name', description: 'User description', enabled: false, allowDelegation: false,
            kind: scenario === 'wrong-kind' ? 'subagent' : 'primary', instructions: scenario === 'custom' ? 'User GPT customization' : scenario === 'near-match' ? `${LEGACY_GPT_INSTRUCTIONS}\n` : LEGACY_GPT_INSTRUCTIONS });
        const original = installDatabase(root, 6, previous); const store = new AgentStore(root); const migrated = store.get();
        const expected = previous.profiles.map(profile => scenario === 'legacy' && profile.id === 'gpt-default'
            ? { ...profile, instructions: additionalDefaultProfiles().find(item => item.id === 'gpt-default')!.instructions } : profile);
        assert.deepEqual(migrated, { ...previous, revision: 6, profiles: [...expected, defaultGptSubagent()] }); store.close();
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 8);
        assert.equal((database.prepare('SELECT document_json FROM agent_settings_legacy_v6').get() as any).document_json, original); database.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated);
        const deleted = reopened.get(); deleted.profiles = deleted.profiles.filter(profile => !['gpt-default', 'gpt-subagent-default'].includes(profile.id));
        const saved = reopened.save(deleted); reopened.close();
        const final = new AgentStore(root); assert.deepEqual(final.get(), saved); final.close();
    }
});

test('v6 preserves GPT child ID collisions and user data at profile/byte capacities', t => {
    for (const scenario of ['collision', 'room-count', 'full-count', 'full-bytes', 'digit-growth'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const previous = scenario === 'full-bytes' ? exactCapacitySettings(8) : scenario === 'digit-growth' ? exactCapacitySettings(9) : primarySettings();
        if (scenario === 'collision') previous.profiles.push({ ...previous.profiles[0], id: 'gpt-subagent-default', name: 'User role', enabled: false, instructions: 'Do not replace' });
        if (scenario === 'full-count' || scenario === 'room-count') previous.profiles = Array.from({ length: scenario === 'room-count' ? 99 : 100 }, (_, index) => ({ ...previous.profiles[0], id: `user-${index}`, instructions: '' }));
        const original = installDatabase(root, 6, previous); const store = new AgentStore(root); const migrated = store.get();
        assert.deepEqual(migrated, { ...previous, revision: ['digit-growth', 'full-bytes'].includes(scenario) ? 9 : previous.revision + 2,
            ...(scenario === 'room-count' ? { profiles: [...previous.profiles, defaultGptSubagent()] } : {}) }); store.close();
        const database = new DatabaseSync(join(root, 'agents.sqlite'));
        assert.equal((database.prepare('SELECT document_json FROM agent_settings_legacy_v6').get() as any).document_json, original); database.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated); reopened.close();
    }
});

test('v6 corrupt revision rolls back without an archive or partial GPT replacement', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = primarySettings(); const original = installDatabase(root, 6, previous, 2);
    assert.throws(() => new AgentStore(root), /数据库数据无效/);
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 6);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'agent_settings_legacy_v6'").get() as any).count, 0);
    assert.equal((database.prepare('SELECT document_json FROM agent_settings').get() as any).document_json, original); database.close();
});

function versionSevenSettings(): AgentSettings {
    // Use the explicitly retained v7 texts, never the new factory instructions.
    return { revision: 4, subagents: { ...defaultAgentSettings().subagents, enabled: false }, profiles: conditionalPromptUpgrades().map(upgrade => ({
        id: upgrade.id, kind: upgrade.kind, name: `Saved ${upgrade.id}`, description: 'User metadata', instructions: upgrade.previousInstructions,
        enabled: upgrade.id === 'default', allowDelegation: false, ...(upgrade.kind === 'subagent' ? { model: null } : {}),
    })) };
}

test('v7 exact default texts upgrade together without changing metadata/order/disabled states or reviving deletion', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = versionSevenSettings(); const original = installDatabase(root, 7, previous);
    const store = new AgentStore(root); const migrated = store.get();
    const expected = previous.profiles.map(profile => ({ ...profile, instructions: conditionalPromptUpgrades().find(upgrade => upgrade.id === profile.id)!.instructions }));
    assert.deepEqual(migrated, { ...previous, revision: 5, profiles: expected }); store.close();
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 8);
    assert.equal((database.prepare('SELECT document_json FROM agent_settings_legacy_v7').get() as any).document_json, original); database.close();
    const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated);
    const deleted = reopened.get(); deleted.profiles = deleted.profiles.slice(0, 1); const saved = reopened.save(deleted); reopened.close();
    const final = new AgentStore(root); assert.deepEqual(final.get(), saved); final.close();
});

test('v7 customized text, wrong role, foreign IDs and missing presets are never overwritten or restored', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = versionSevenSettings();
    previous.profiles = previous.profiles.filter(profile => profile.id !== 'claude-subagent-default');
    previous.profiles[0].instructions += '\n';
    const claude = previous.profiles.find(profile => profile.id === 'claude-default')!;
    claude.kind = 'subagent';
    const gpt = previous.profiles.find(profile => profile.id === 'gpt-default')!;
    gpt.id = 'user-gpt';
    const originalProfiles = structuredClone(previous.profiles);
    installDatabase(root, 7, previous); const store = new AgentStore(root); const migrated = store.get();
    assert.equal(migrated.profiles.length, previous.profiles.length);
    assert.deepEqual(migrated.profiles.slice(0, 3), originalProfiles.slice(0, 3));
    for (const profile of migrated.profiles.slice(3)) assert.equal(profile.instructions, conditionalPromptUpgrades().find(upgrade => upgrade.id === profile.id)!.instructions);
    store.close(); const reopened = new AgentStore(root); assert.deepEqual(reopened.get(), migrated); reopened.close();
});

test('v7 migration does not displace user data at byte limit or growing revision and adds no profiles at count limit', t => {
    for (const scenario of ['bytes', 'digit-growth', 'count'] as const) {
        const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
        const previous = scenario === 'digit-growth' ? exactCapacitySettings(9) : scenario === 'bytes' ? exactCapacitySettings(8) : primarySettings();
        if (scenario === 'count') previous.profiles = Array.from({ length: 100 }, (_, index) => ({ ...previous.profiles[0], id: `custom-${index}`, instructions: '' }));
        installDatabase(root, 7, previous); const store = new AgentStore(root);
        assert.deepEqual(store.get(), { ...previous, revision: scenario === 'digit-growth' ? 9 : previous.revision + 1 }); store.close();
        const reopened = new AgentStore(root); assert.deepEqual(reopened.get().profiles, previous.profiles); reopened.close();
    }
});

test('v7 invalid revision rolls back without archive or any conditional prompt edits', t => {
    const root = mkdtempSync(join(tmpdir(), 'uah-agent-store-test-')); t.after(() => cleanup(root));
    const previous = versionSevenSettings(); const original = installDatabase(root, 7, previous, 2);
    assert.throws(() => new AgentStore(root), /数据库数据无效/);
    const database = new DatabaseSync(join(root, 'agents.sqlite'));
    assert.equal((database.prepare('PRAGMA user_version').get() as any).user_version, 7);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'agent_settings_legacy_v7'").get() as any).count, 0);
    assert.equal((database.prepare('SELECT document_json FROM agent_settings').get() as any).document_json, original); database.close();
});
