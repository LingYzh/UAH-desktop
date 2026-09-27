import test from 'node:test';
import assert from 'node:assert/strict';
import { effectiveModelDetails, normalizeBaseUrl, parseEndpointCommand, parseEndpointDraft } from '../../src/shared/endpoints';
import { defaultModelParameters, parseModelParameters } from '../../src/shared/model-parameters';
import { parseCommand } from '../../src/shared/contracts';

test('endpoint URLs permit explicit API paths and loopback HTTP but reject credential/redirect ambiguity', () => {
    assert.equal(normalizeBaseUrl('https://example.com/custom/v1/'), 'https://example.com/custom/v1');
    assert.equal(normalizeBaseUrl('http://127.0.0.1:8888/v1'), 'http://127.0.0.1:8888/v1');
    assert.equal(normalizeBaseUrl('http://[::1]:8888/v1/'), 'http://[::1]:8888/v1');
    for (const url of ['file:///test', 'http://example.com/v1', 'https://user:secret@example.com', 'https://example.com?api_key=secret', 'https://example.com/#fragment', 'https://example.com\n.evil']) {
        assert.throws(() => normalizeBaseUrl(url));
    }
});

test('endpoint IPC validates exact fields, key format, bounded model lists and revisions', () => {
    const draft = { id: null, name: 'Fixture', protocol: 'openai-chat', baseUrl: 'https://example.com/v1', models: ['model', 'model'], enabled: false, revision: 0, apiKey: null };
    assert.deepEqual(parseEndpointDraft(draft).models, ['model']);
    assert.deepEqual(parseEndpointCommand({ type: 'list' }), { type: 'list' });
    for (const invalid of [
        { type: 'list', secret: 'x' },
        { type: 'delete', id: 'id', revision: -1 },
        { type: 'save', draft: { ...draft, apiKey: 'key\r\nheader' } },
        { type: 'save', draft: { ...draft, headers: {} } },
        { type: 'save', draft: { ...draft, protocol: 'unimplemented' } },
        { type: 'save', draft: { ...draft, models: Array(501).fill('x') } },
    ]) assert.throws(() => parseEndpointCommand(invalid));
});

test('endpoint model capabilities accept only declared metadata for listed models', () => {
    const draft = {
        id: null,
        name: 'Fixture',
        protocol: 'openai-chat',
        baseUrl: 'https://example.com/v1',
        models: ['model'],
        enabled: false,
        revision: 0,
        apiKey: null,
        modelDetails: [{
            id: 'model',
            inputModalities: ['text', 'image', 'pdf'],
            outputModalities: ['text'],
            contextWindow: 64_000,
            maxOutputTokens: 2_000,
            tools: false,
            vision: false,
            reasoning: false,
            streaming: false,
            imageInput: false,
            pdfInput: false,
            audioInput: false,
            videoInput: false,
        }],
    };
    assert.deepEqual(parseEndpointDraft(draft).modelDetails, draft.modelDetails);
    for (const invalid of [
        { ...draft, modelDetails: [{ id: 'other' }] },
        { ...draft, modelDetails: [{ id: 'model', provider: 'untrusted' }] },
        { ...draft, modelDetails: [{ id: 'model', inputModalities: ['text', 'text'] }] },
        { ...draft, modelDetails: [{ id: 'model', contextWindow: 0 }] },
        { ...draft, modelDetails: [{ id: 'model', tools: 'false' }] },
        { ...draft, modelDetails: [{ id: 'model', pdfInput: 'false' }] },
        { ...draft, modelDetails: [{ id: 'model' }, { id: 'model' }] },
        { ...draft, models: [], modelDetails: [{ id: 'model' }] },
    ]) assert.throws(() => parseEndpointDraft(invalid));
});

test('model generation parameters use bounded strict plain data and documented defaults', () => {
    const defaults = defaultModelParameters();
    assert.deepEqual(defaults, {
        temperature: null,
        topP: null,
        maxOutputTokens: null,
        reasoningEffort: 'default',
        thinkingBudget: null,
        historyTurns: 50,
        timeoutSeconds: 60,
        stop: [],
    });
    const boundaryValues = {
        temperature: 2,
        topP: 0,
        maxOutputTokens: 1_000_000,
        reasoningEffort: 'ultra',
        thinkingBudget: 999_999,
        historyTurns: 0,
        timeoutSeconds: 600,
        stop: ['', 's'.repeat(200)],
    } as const;
    assert.deepEqual(parseModelParameters(boundaryValues), boundaryValues);

    for (const invalid of [
        { ...defaults, extra: true },
        { ...defaults, reasoningEffort: 'unknown' },
        { ...defaults, temperature: -0.01 },
        { ...defaults, topP: 1.01 },
        { ...defaults, maxOutputTokens: 1.5 },
        { ...defaults, maxOutputTokens: 1_000_001 },
        { ...defaults, thinkingBudget: 1023 },
        { ...defaults, historyTurns: 101 },
        { ...defaults, timeoutSeconds: 4 },
        { ...defaults, stop: ['a', 'b', 'c', 'd', 'e'] },
        { ...defaults, stop: ['s'.repeat(201)] },
    ]) {
        assert.throws(() => parseModelParameters(invalid));
    }

    const inherited = Object.assign(Object.create({ inherited: true }), defaults);
    assert.throws(() => parseModelParameters(inherited));
    const accessor = { ...defaults };
    Object.defineProperty(accessor, 'temperature', { get: () => null, enumerable: true });
    assert.throws(() => parseModelParameters(accessor));
});

test('endpoint model parameters must be unique settings for listed model IDs', () => {
    const parameters = defaultModelParameters();
    const draft = {
        id: null,
        name: 'Fixture',
        protocol: 'openai-chat',
        baseUrl: 'https://example.com/v1',
        models: ['model'],
        enabled: false,
        revision: 0,
        apiKey: null,
        modelParameters: [{ id: 'model', parameters }],
    };
    assert.deepEqual(parseEndpointDraft(draft).modelParameters, draft.modelParameters);
    assert.equal(parseEndpointDraft({ ...draft, modelParameters: undefined }).modelParameters, undefined);
    assert.deepEqual(parseEndpointDraft({ ...draft, modelParameters: [] }).modelParameters, []);

    for (const invalid of [
        { ...draft, modelParameters: [{ id: 'other', parameters }] },
        { ...draft, modelParameters: [{ id: 'model', parameters }, { id: 'model', parameters }] },
        { ...draft, modelParameters: [{ id: 'model', parameters, source: 'agent' }] },
        { ...draft, modelParameters: [{ id: 'model', parameters: { ...parameters, extra: true } }] },
        { ...draft, models: [], modelParameters: [{ id: 'model', parameters }] },
        { ...draft, modelParameters: Array(501).fill({ id: 'model', parameters }) },
    ]) {
        assert.throws(() => parseEndpointDraft(invalid));
    }
});

test('manual capability overrides merge field-by-field and preserve explicit empty arrays and false', () => {
    const merged = effectiveModelDetails({
        modelDetails: [{ id: 'model', inputModalities: ['text', 'image'], tools: true, vision: false, imageInput: true }],
        modelOverrides: [{ id: 'model', inputModalities: [], tools: false, imageInput: false }],
    }, 'model');
    assert.deepEqual(merged, { id: 'model', inputModalities: [], tools: false, vision: false, imageInput: false });
    assert.deepEqual(effectiveModelDetails({}, 'unknown'), { id: 'unknown' });
});

test('runtime selection accepts IDs only and never arbitrary connection configuration', () => {
    const command = { type: 'create-session', title: 'API', directory: null, selection: { endpointId: 'endpoint', modelId: 'model' } };
    assert.deepEqual(parseCommand(command), command);
    assert.throws(() => parseCommand({ ...command, selection: { ...command.selection, apiKey: 'secret' } }));
    assert.throws(() => parseCommand({ ...command, selection: { ...command.selection, baseUrl: 'https://example.com' } }));
    assert.throws(() => parseCommand({ ...command, selection: undefined }));
    const turn = { type: 'start-run', sessionId: 'session', input: 'next', selection: command.selection };
    assert.deepEqual(parseCommand(turn), turn);
    assert.deepEqual(parseCommand({ ...turn, selection: null }), { ...turn, selection: null });
    assert.throws(() => parseCommand({ ...turn, selection: { ...command.selection, baseUrl: 'https://example.com' } }));
});
