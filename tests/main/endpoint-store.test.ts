import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { EndpointStore, type EndpointCipher } from '../../src/main/endpoint-store';
import type { EndpointDraft } from '../../src/shared/endpoints';

const testCipher: EndpointCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value) {
        return Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0xa5));
    },
    decryptString(value) {
        return Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('utf8');
    },
};

function draft(overrides: Partial<EndpointDraft> = {}): EndpointDraft {
    return {
        id: null,
        name: 'Local API',
        protocol: 'openai-responses',
        baseUrl: 'https://api.example.test/v1',
        models: ['example-model'],
        enabled: false,
        revision: 0,
        apiKey: null,
        ...overrides,
    };
}

function edit(record: {
    id: string;
    name: string;
    protocol: EndpointDraft['protocol'];
    baseUrl: string;
    models: string[];
    modelDetails?: EndpointDraft['modelDetails'];
    modelOverrides?: EndpointDraft['modelOverrides'];
    modelParameters?: EndpointDraft['modelParameters'];
    enabled: boolean;
    revision: number;
}, overrides: Partial<EndpointDraft> = {}): EndpointDraft {
    return draft({
        id: record.id,
        name: record.name,
        protocol: record.protocol,
        baseUrl: record.baseUrl,
        models: record.models,
    ...(record.modelDetails === undefined ? {} : { modelDetails: record.modelDetails }),
    ...(record.modelOverrides === undefined ? {} : { modelOverrides: record.modelOverrides }),
    ...(record.modelParameters === undefined ? {} : { modelParameters: record.modelParameters }),
        enabled: record.enabled,
        revision: record.revision,
        ...overrides,
    });
}

function createHarness(cipher = testCipher): { root: string; store: EndpointStore } {
    const root = mkdtempSync(join(tmpdir(), 'uah-endpoint-store-test-'));
    return { root, store: new EndpointStore(root, cipher) };
}

function cleanup(root: string): void {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-endpoint-store-test-')) {
        throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

test('honors initial enablement, encrypts keys at rest, and persists without exposing them', (t) => {
    const harness = createHarness();
    t.after(() => cleanup(harness.root));
    const secret = 'secret-value-that-must-not-be-plaintext';
    assert.throws(() => harness.store.save(draft({ enabled: true, models: [] })), /至少.*模型/);

    const saved = harness.store.save(draft({ enabled: true, apiKey: secret }));
    assert.equal(saved.length, 1);
    assert.equal(saved[0].enabled, true);
    assert.equal(saved[0].hasKey, true);
    assert.equal('apiKey' in saved[0], false);
    assert.deepEqual(harness.store.list(), saved);

    harness.store.close();
    const bytes = readFileSync(join(harness.root, 'endpoints.sqlite'));
    assert.equal(bytes.includes(Buffer.from(secret, 'utf8')), false);

    const reopened = new EndpointStore(harness.root, testCipher);
    assert.deepEqual(reopened.list(), saved);
    reopened.close();
});

test('updates enabled endpoints, resolves ephemeral keys, and supports removal', (t) => {
    const harness = createHarness();
    t.after(() => {
        harness.store.close();
        cleanup(harness.root);
    });
    const original = harness.store.save(draft({ apiKey: 'retain-me' }))[0];

    const enabled = harness.store.save(edit(original, {
        enabled: true,
        apiKey: null,
    }))[0];
    assert.equal(enabled.revision, 1);
    assert.equal(enabled.enabled, true);
    assert.equal(harness.store.resolve(enabled.id).apiKey, 'retain-me');
    assert.equal(harness.store.preview(edit(enabled, { apiKey: null })).apiKey, 'retain-me');

    const discoveryDraft = edit(enabled, { models: [], apiKey: null });
    const preview = harness.store.preview(discoveryDraft);
    assert.deepEqual(preview.models, []);
    assert.equal(preview.apiKey, 'retain-me');
    assert.throws(() => harness.store.save(discoveryDraft), /至少一个模型/);
    assert.deepEqual(harness.store.list(), [enabled]);
    assert.deepEqual(harness.store.resolve(enabled.id).models, ['example-model']);
    assert.equal(harness.store.resolve(enabled.id).apiKey, 'retain-me');

    const removed = harness.store.save(edit(enabled, { apiKey: '' }))[0];
    assert.equal(removed.revision, 2);
    assert.equal(removed.hasKey, false);
    assert.equal(harness.store.resolve(removed.id).apiKey, '');
});

test('does not retain an existing key when the API host or protocol changes', (t) => {
    const harness = createHarness();
    t.after(() => {
        harness.store.close();
        cleanup(harness.root);
    });
    const created = harness.store.save(draft({ apiKey: 'host-bound-key' }))[0];
    const enabled = harness.store.save(edit(created, { enabled: true, apiKey: null }))[0];

    assert.throws(() => harness.store.save(edit(enabled, {
        baseUrl: 'https://different.example.test/v1',
        apiKey: null,
    })));
    assert.throws(() => harness.store.preview(edit(enabled, {
        protocol: 'anthropic',
        apiKey: null,
    })));
    assert.equal(harness.store.resolve(enabled.id).apiKey, 'host-bound-key');

    const changed = harness.store.save(edit(enabled, {
        baseUrl: 'https://different.example.test/v1',
        apiKey: 'replacement-key',
    }))[0];
    assert.equal(changed.revision, 2);
    assert.equal(harness.store.resolve(changed.id).apiKey, 'replacement-key');
});

test('rejects encryption-dependent saves when encryption is unavailable but permits keyless metadata', (t) => {
    const unavailable: EndpointCipher = {
        ...testCipher,
        isEncryptionAvailable: () => false,
    };
    const harness = createHarness(unavailable);
    t.after(() => {
        harness.store.close();
        cleanup(harness.root);
    });

    assert.throws(() => harness.store.save(draft({ apiKey: 'cannot-save-this' })), /密钥/);
    assert.deepEqual(harness.store.list(), []);
    const saved = harness.store.save(draft())[0];
    const enabled = harness.store.save(edit(saved, { enabled: true, apiKey: null }))[0];
    assert.equal(harness.store.resolve(enabled.id).apiKey, '');
});

test('enforces revisions and refuses missing deletion without mutating persisted endpoints', (t) => {
    const harness = createHarness();
    t.after(() => {
        harness.store.close();
        cleanup(harness.root);
    });
    const created = harness.store.save(draft())[0];
    const updated = harness.store.save(edit(created, { name: 'Renamed endpoint' }))[0];

    assert.throws(() => harness.store.delete(created.id, created.revision), /修改/);
    assert.throws(() => harness.store.preview(edit(created, { apiKey: null })), /修改/);
    assert.throws(() => harness.store.delete('missing-endpoint', 0), /不存在/);
    assert.deepEqual(harness.store.list(), [updated]);
});

test('persists optional model capabilities, preserves explicit false, and clears them with removed models', (t) => {
    const harness = createHarness();
    t.after(() => {
        harness.store.close();
        cleanup(harness.root);
    });
    const modelDetails: NonNullable<EndpointDraft['modelDetails']> = [{
        id: 'example-model',
        inputModalities: ['text', 'image', 'pdf'],
        outputModalities: ['text'],
        contextWindow: 128_000,
        maxOutputTokens: 4_096,
        tools: false,
        vision: false,
        reasoning: false,
        streaming: false,
        imageInput: false,
        pdfInput: false,
        audioInput: false,
        videoInput: false,
    }];
    const modelOverrides: NonNullable<EndpointDraft['modelOverrides']> = [{
        id: 'example-model',
        inputModalities: [],
        vision: true,
        imageInput: false,
    }];
    const created = harness.store.save(draft({ apiKey: 'capability-key', modelDetails, modelOverrides }))[0];
    assert.deepEqual(created.modelDetails, modelDetails);
    assert.deepEqual(created.modelOverrides, modelOverrides);
    const enabled = harness.store.save(edit(created, { enabled: true, apiKey: null }))[0];
    assert.deepEqual(harness.store.preview(edit(enabled, { apiKey: null })).modelDetails, modelDetails);
    assert.deepEqual(harness.store.resolve(enabled.id).modelDetails, modelDetails);

    harness.store.close();
    const reopened = new EndpointStore(harness.root, testCipher);
    assert.deepEqual(reopened.list()[0].modelDetails, modelDetails);
    assert.deepEqual(reopened.list()[0].modelOverrides, modelOverrides);
    const reopenedEnabled = reopened.list()[0];
    const discovered = reopened.save(edit(reopenedEnabled, {
        modelDetails: [{ ...modelDetails[0], contextWindow: 256_000 }],
        modelOverrides: reopenedEnabled.modelOverrides,
        apiKey: null,
    }))[0];
    assert.deepEqual(discovered.modelOverrides, modelOverrides);
    const clearedOverrides = reopened.save(edit(discovered, { modelOverrides: [], apiKey: null }))[0];
    assert.equal('modelOverrides' in clearedOverrides, false);
    const restoredOverrides = reopened.save(edit(clearedOverrides, { modelOverrides, apiKey: null }))[0];
    assert.deepEqual(restoredOverrides.modelOverrides, modelOverrides);
    assert.throws(() => reopened.save(edit(reopenedEnabled, {
        enabled: false,
        models: [],
        apiKey: null,
    })), /模型能力/);
    const cleared = reopened.save(edit(restoredOverrides, {
        enabled: false,
        models: [],
        modelDetails: [],
        modelOverrides: [],
        apiKey: null,
    }))[0];
    assert.equal('modelDetails' in cleared, false);
    assert.equal('modelOverrides' in cleared, false);
    reopened.close();
});

test('persists per-model generation parameters, preserves omitted settings, prunes removed models, and clears explicitly', (t) => {
    const harness = createHarness();
    let reopened: EndpointStore | undefined;
    t.after(() => {
        reopened?.close();
        harness.store.close();
        cleanup(harness.root);
    });
    const modelParameters: NonNullable<EndpointDraft['modelParameters']> = [
        {
            id: 'model-a',
            parameters: {
                temperature: 0.25,
                topP: null,
                maxOutputTokens: 2_000,
                reasoningEffort: 'high',
                thinkingBudget: 8_192,
                historyTurns: 30,
                timeoutSeconds: 90,
                stop: ['done'],
            },
        },
        {
            id: 'model-b',
            parameters: {
                temperature: null,
                topP: 0.8,
                maxOutputTokens: null,
                reasoningEffort: 'minimal',
                thinkingBudget: null,
                historyTurns: 12,
                timeoutSeconds: 45,
                stop: [],
            },
        },
    ];
    const created = harness.store.save(draft({
        models: ['model-a', 'model-b'],
        modelParameters,
        enabled: true,
        apiKey: 'model-parameter-key',
    }))[0];
    assert.deepEqual(created.modelParameters, modelParameters);

    // Existing callers that refresh/save a draft without the optional field keep settings for listed models.
    const omittedPreview = harness.store.preview(edit(created, { modelParameters: undefined, apiKey: null }));
    assert.deepEqual(omittedPreview.modelParameters, modelParameters);
    assert.equal(omittedPreview.apiKey, 'model-parameter-key');
    const refreshed = harness.store.save(edit(created, { modelParameters: undefined, name: 'Refreshed API', apiKey: null }))[0];
    assert.deepEqual(refreshed.modelParameters, modelParameters);
    assert.deepEqual(harness.store.resolve(refreshed.id).modelParameters, modelParameters);
    assert.equal(harness.store.resolve(refreshed.id).apiKey, 'model-parameter-key');

    const reducedPreview = harness.store.preview(edit(refreshed, {
        models: ['model-a'],
        modelParameters: undefined,
        apiKey: null,
    }));
    assert.deepEqual(reducedPreview.modelParameters, [modelParameters[0]]);
    const reduced = harness.store.save(edit(refreshed, {
        models: ['model-a'],
        modelParameters: undefined,
        apiKey: null,
    }))[0];
    assert.deepEqual(reduced.modelParameters, [modelParameters[0]]);

    harness.store.close();
    reopened = new EndpointStore(harness.root, testCipher);
    assert.deepEqual(reopened.list()[0].modelParameters, [modelParameters[0]]);
    assert.deepEqual(reopened.resolve(reduced.id).modelParameters, [modelParameters[0]]);
    assert.equal(reopened.resolve(reduced.id).apiKey, 'model-parameter-key');
    const clearedPreview = reopened.preview(edit(reopened.list()[0], {
        modelParameters: [],
        apiKey: null,
    }));
    assert.equal('modelParameters' in clearedPreview, false);
    const cleared = reopened.save(edit(reopened.list()[0], {
        modelParameters: [],
        apiKey: null,
    }))[0];
    assert.equal('modelParameters' in cleared, false);
    assert.equal('modelParameters' in reopened.resolve(cleared.id), false);
    reopened.close();
});

test('migrates v1 endpoint databases without losing keys, enablement, or revisions', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'uah-endpoint-store-test-'));
    const legacy = new DatabaseSync(join(root, 'endpoints.sqlite'));
    legacy.exec(`
        CREATE TABLE endpoints (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            protocol TEXT NOT NULL,
            base_url TEXT NOT NULL,
            models_json TEXT NOT NULL,
            enabled INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            key_blob BLOB
        );
        PRAGMA user_version = 1;
    `);
    legacy.prepare(
        'INSERT INTO endpoints (id, name, protocol, base_url, models_json, enabled, revision, key_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('legacy-endpoint', 'Legacy API', 'openai-chat', 'https://legacy.example.test/v1', JSON.stringify(['legacy-model']), 1, 7, testCipher.encryptString('legacy-key'));
    legacy.close();

    const store = new EndpointStore(root, testCipher);
    t.after(() => {
        store.close();
        cleanup(root);
    });
    const [migrated] = store.list();
    assert.deepEqual(migrated, {
        id: 'legacy-endpoint',
        name: 'Legacy API',
        protocol: 'openai-chat',
        baseUrl: 'https://legacy.example.test/v1',
        models: ['legacy-model'],
        enabled: true,
        revision: 7,
        hasKey: true,
    });
    assert.equal('modelDetails' in migrated, false);
    assert.equal(store.resolve(migrated.id).apiKey, 'legacy-key');
});

test('migrates v2 endpoint databases while preserving discovered capability details', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'uah-endpoint-store-test-'));
    const legacy = new DatabaseSync(join(root, 'endpoints.sqlite'));
    const details = [{ id: 'v2-model', inputModalities: ['text'], tools: false }];
    legacy.exec(`
        CREATE TABLE endpoints (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            protocol TEXT NOT NULL,
            base_url TEXT NOT NULL,
            models_json TEXT NOT NULL,
            model_details_json TEXT NOT NULL DEFAULT '[]',
            enabled INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            key_blob BLOB
        );
        PRAGMA user_version = 2;
    `);
    legacy.prepare(
        'INSERT INTO endpoints (id, name, protocol, base_url, models_json, model_details_json, enabled, revision, key_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('v2-endpoint', 'V2 API', 'openai-chat', 'https://v2.example.test/v1', JSON.stringify(['v2-model']), JSON.stringify(details), 0, 4, null);
    legacy.close();

    const store = new EndpointStore(root, testCipher);
    t.after(() => {
        store.close();
        cleanup(root);
    });
    const [migrated] = store.list();
    assert.deepEqual(migrated.modelDetails, details);
    assert.equal('modelOverrides' in migrated, false);
    assert.equal(migrated.revision, 4);
});

test('migrates v3 endpoint databases with empty per-model generation settings', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'uah-endpoint-store-test-'));
    const legacy = new DatabaseSync(join(root, 'endpoints.sqlite'));
    legacy.exec(`
        CREATE TABLE endpoints (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            protocol TEXT NOT NULL,
            base_url TEXT NOT NULL,
            models_json TEXT NOT NULL,
            model_details_json TEXT NOT NULL DEFAULT '[]',
            model_overrides_json TEXT NOT NULL DEFAULT '[]',
            enabled INTEGER NOT NULL,
            revision INTEGER NOT NULL,
            key_blob BLOB
        );
        PRAGMA user_version = 3;
    `);
    legacy.prepare(
        'INSERT INTO endpoints (id, name, protocol, base_url, models_json, enabled, revision, key_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run('v3-endpoint', 'V3 API', 'openai-chat', 'https://v3.example.test/v1', JSON.stringify(['v3-model']), 0, 9, null);
    legacy.close();

    const store = new EndpointStore(root, testCipher);
    t.after(() => {
        store.close();
        cleanup(root);
    });
    const [migrated] = store.list();
    assert.equal(migrated.id, 'v3-endpoint');
    assert.equal(migrated.revision, 9);
    assert.equal('modelParameters' in migrated, false);
    assert.throws(() => store.resolve(migrated.id), /未启用/);
    const migratedDb = new DatabaseSync(join(root, 'endpoints.sqlite'));
    assert.equal((migratedDb.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, 4);
    assert.equal((migratedDb.prepare('SELECT model_parameters_json FROM endpoints WHERE id = ?').get(migrated.id) as { model_parameters_json: string }).model_parameters_json, '[]');
    migratedDb.close();
});
