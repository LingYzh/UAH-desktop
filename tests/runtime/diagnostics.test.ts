import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { configureDiagnostics, createDiagnosticTrace, recordPromptAssembly } from '../../src/runtime/diagnostics';

const promptSummary = {
    runId: 'f037b6bc-27a0-4b56-9691-ec002b08145c',
    round: 2,
    profile: 'gpt',
    totalCharacters: 120,
    modules: [{ id: 'tools', version: 1, included: false, reason: 'not_available', characters: 0 }],
};

function createDirectory(): string {
    return mkdtempSync(join(tmpdir(), 'uah-diagnostics-test-'));
}

function cleanup(directory: string): void {
    const target = resolve(directory);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-diagnostics-test-')) {
        throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

function records(directory: string): Array<Record<string, unknown>> {
    return readFileSync(join(directory, 'logs', 'runtime.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

test('unconfigured diagnostics are a no-op for unit callers', () => {
    assert.doesNotThrow(() => {
        createDiagnosticTrace('models', 'openai-chat').event('request_start', { method: 'GET' });
        recordPromptAssembly('openai-chat', promptSummary);
    });
});

test('prompt assembly writes bounded metadata with independent request and run correlation', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    configureDiagnostics(directory);
    recordPromptAssembly('openai-responses', promptSummary);
    recordPromptAssembly('openai-responses', { ...promptSummary, round: 3 });
    const saved = records(directory);
    assert.deepEqual(saved[0].fields, promptSummary);
    assert.equal(saved[0].event, 'prompt.assembled');
    assert.equal(saved[0].operation, 'prompt');
    assert.equal(saved[0].protocol, 'openai-responses');
    assert.match(saved[0].requestId as string, /^[0-9a-f-]{36}$/);
    assert.notEqual(saved[0].requestId, saved[1].requestId);
    assert.notEqual(saved[0].requestId, promptSummary.runId);
    assert.equal((saved[1].fields as Record<string, unknown>).round, 3);
});

test('prompt assembly excludes hostile objects, text, paths and extra properties', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    configureDiagnostics(directory);
    const secret = 'secret-api-key-must-not-appear';
    const malicious = {
        ...promptSummary,
        instructions: secret,
        model: secret,
        provider: secret,
        path: 'D:/private/file',
        toJSON() { throw new Error('Must not serialize input'); },
        modules: [
            { ...promptSummary.modules[0], instructions: secret, body: { secret }, toJSON() { return secret; } },
            { ...promptSummary.modules[0], id: 'D:/private/file' },
            { ...promptSummary.modules[0], reason: `request failed ${secret}` },
            { ...promptSummary.modules[0], id: { toString() { return secret; } } },
            Object.defineProperty({}, 'id', { get() { throw new Error(secret); } }),
        ],
    };
    assert.doesNotThrow(() => recordPromptAssembly('https://private.test/key', malicious as never));
    assert.doesNotThrow(() => recordPromptAssembly('anthropic', new Proxy({}, { getOwnPropertyDescriptor() { throw new Error(secret); } }) as never));
    const saved = records(directory);
    assert.deepEqual(saved[0].fields, promptSummary);
    assert.equal(saved[0].protocol, 'unknown');
    const raw = readFileSync(join(directory, 'logs', 'runtime.jsonl'), 'utf8');
    for (const text of [secret, 'instructions', 'provider', 'model', 'D:/private', 'private.test']) {
        assert.equal(raw.includes(text), false);
    }
});

test('prompt assembly discards invalid values and caps module codes and count', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    configureDiagnostics(directory);
    recordPromptAssembly('anthropic', {
        runId: 'non-uuid-secret', round: -1, profile: 'untrusted', totalCharacters: Infinity,
        modules: [
            { ...promptSummary.modules[0], version: NaN },
            { ...promptSummary.modules[0], characters: -1 },
            { ...promptSummary.modules[0], included: 'true' },
            { ...promptSummary.modules[0], reason: 'a'.repeat(101) },
            { ...promptSummary.modules[0], id: 'a'.repeat(101) },
        ],
    } as never);
    recordPromptAssembly('anthropic', { ...promptSummary, modules: Array.from({ length: 40 }, () => ({ ...promptSummary.modules[0], id: 'a'.repeat(100), reason: 'b'.repeat(100) })) });
    recordPromptAssembly('anthropic', { runId: {}, round: NaN, profile: {}, totalCharacters: -Infinity, modules: {} } as never);
    const saved = records(directory);
    assert.deepEqual(saved[0].fields, { modules: [] });
    assert.equal(((saved[1].fields as Record<string, unknown>).modules as unknown[]).length, 32);
    assert.deepEqual(saved[2].fields, { modules: [] });
});

test('prompt assembly shares rotation and filesystem fail-safe', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    configureDiagnostics(directory, { maxBytes: 600 });
    for (let round = 0; round < 20; round += 1) {
        recordPromptAssembly('openai-chat', { ...promptSummary, round });
    }
    const names = readdirSync(join(directory, 'logs')).sort();
    assert.deepEqual(names, ['runtime.1.jsonl', 'runtime.2.jsonl', 'runtime.3.jsonl', 'runtime.jsonl']);
    for (const name of names) {
        assert.ok(readFileSync(join(directory, 'logs', name)).byteLength <= 600);
    }
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = ((...messages: unknown[]) => warnings.push(messages)) as typeof console.warn;
    t.after(() => { console.warn = originalWarn; });
    const blockingFile = join(directory, 'blocked');
    writeFileSync(blockingFile, 'block');
    configureDiagnostics(blockingFile);
    assert.doesNotThrow(() => {
        recordPromptAssembly('openai-chat', promptSummary);
        recordPromptAssembly('openai-chat', promptSummary);
    });
    assert.deepEqual(warnings, [['Runtime diagnostics unavailable.']]);
});

test('writes correlated, valid diagnostic records', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    configureDiagnostics(directory);
    const trace = createDiagnosticTrace('models', 'openai-chat');
    trace.event('request_start', { method: 'GET', route: '/v1/models' });
    trace.event('response_complete', { status: 200, elapsedMs: 12, bytes: 48, count: 1 });

    const saved = records(directory);
    assert.equal(saved.length, 2);
    assert.equal(saved[0].requestId, trace.id);
    assert.equal(saved[1].requestId, trace.id);
    assert.equal(saved[0].operation, 'models');
    assert.equal(saved[0].protocol, 'openai-chat');
    assert.equal(saved[0].event, 'request_start');
    assert.deepEqual(saved[0].fields, { method: 'GET', route: '/v1/models' });
    assert.deepEqual(saved[1].fields, { status: 200, elapsedMs: 12, bytes: 48, count: 1 });
    assert.equal(typeof saved[0].time, 'string');
    assert.ok(!Number.isNaN(Date.parse(saved[0].time as string)));
});

test('whitelists diagnostic fields and never persists untrusted secret-shaped values', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    configureDiagnostics(directory);
    const secret = 'secret-api-key-must-not-appear';
    const fields = {
        status: 401,
        method: 'GET',
        route: '/v1/models',
        reason: `request failed ${secret}`,
        outcome: `https://example.test/${secret}`,
        bytes: Number.NaN,
        prompt: secret,
        body: { apiKey: secret },
        headers: { authorization: `Bearer ${secret}` },
        model: 'model-name',
        nested: { secret },
    };
    createDiagnosticTrace('test', 'untrusted-protocol').event('request failed', fields as never);

    const [saved] = records(directory);
    assert.equal(saved.protocol, 'unknown');
    assert.equal(saved.event, 'invalid');
    assert.deepEqual(saved.fields, { status: 401, method: 'GET', route: '/v1/models' });
    const raw = readFileSync(join(directory, 'logs', 'runtime.jsonl'), 'utf8');
    assert.equal(raw.includes(secret), false);
    assert.equal(raw.includes('authorization'), false);
    assert.equal(raw.includes('model-name'), false);
});

test('rotates diagnostics into four bounded files', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    configureDiagnostics(directory, { maxBytes: 500 });
    const trace = createDiagnosticTrace('stream', 'openai-responses');
    for (let index = 0; index < 20; index += 1) {
        trace.event('chunk', { index, bytes: 32, outcome: 'complete' });
    }

    const names = readdirSync(join(directory, 'logs')).sort();
    assert.deepEqual(names, ['runtime.1.jsonl', 'runtime.2.jsonl', 'runtime.3.jsonl', 'runtime.jsonl']);
    for (const name of names) {
        assert.ok(readFileSync(join(directory, 'logs', name)).byteLength <= 500);
    }
});

test('diagnostic filesystem failures do not interrupt callers', (t) => {
    const directory = createDirectory();
    t.after(() => cleanup(directory));
    const originalWarn = console.warn;
    const warnings: unknown[][] = [];
    console.warn = ((...messages: unknown[]) => warnings.push(messages)) as typeof console.warn;
    t.after(() => { console.warn = originalWarn; });
    const blockingFile = join(directory, 'not-a-directory');
    writeFileSync(blockingFile, 'block');
    configureDiagnostics(blockingFile);
    assert.doesNotThrow(() => {
        createDiagnosticTrace('stream', 'anthropic').event('request_start', { method: 'POST' });
        createDiagnosticTrace('stream', 'anthropic').event('request_complete', { status: 200 });
    });
    assert.deepEqual(warnings, [['Runtime diagnostics unavailable.']]);
});
