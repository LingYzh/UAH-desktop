import assert from 'node:assert/strict';
import test from 'node:test';
import { streamAgentApi } from '../../src/runtime/api-transport.js';
import type { ApiConnection } from '../../src/shared/endpoints.js';
import type { AgentStreamEvent } from '../../src/shared/tool-protocol.js';
import { mergeUsageSnapshot, normalizeProviderUsage } from '../../src/runtime/context/usage-normalizer.js';

function sse(payload: unknown): string {
    return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

const fixtureConnection: ApiConnection = {
    id: 'usage-fixture', name: 'Usage fixture', protocol: 'openai-chat', baseUrl: 'http://127.0.0.1:32123/v1',
    models: ['model'], modelDetails: [], enabled: true, revision: 1, apiKey: '',
};

test('OpenAI Chat usage follows the official read/write input-details schema', () => {
    const result = normalizeProviderUsage('openai-chat', {
        prompt_tokens: 120,
        prompt_tokens_details: { cached_tokens: 80, cache_write_tokens: 24 },
        completion_tokens: 16,
        completion_tokens_details: { reasoning_tokens: 5 },
        total_tokens: 136,
    });
    assert.deepEqual(result.usage, {
        inputTokens: 120,
        outputTokens: 16,
        cachedInputTokens: 80,
        cacheCreationInputTokens: 24,
        totalTokens: 136,
    });
    assert.equal(result.inputTokensTotal, 120);
    assert.equal(result.inputCacheReadTokens, 80);
    assert.equal(result.inputCacheWriteTokens, 24);
    assert.equal(result.inputUncachedTokens, 16);
    assert.equal(result.reasoningTokens, 5);
    assert.equal(result.reportedTotalTokens, 136);
    assert.equal(result.coverage, 'complete');
    assert.deepEqual(result.diagnostics, []);
});

test('OpenAI Responses uses its separate official paths and does not invent cache write aliases', () => {
    const result = normalizeProviderUsage('openai-responses', {
        input_tokens: 100,
        input_tokens_details: { cached_tokens: 60, cache_write_tokens: 20, prompt_cache_write_tokens: 99 },
        output_tokens: 8,
        output_tokens_details: { reasoning_tokens: 2 },
        total_tokens: 108,
        cache_creation_input_tokens: 77,
    });
    assert.deepEqual(result.usage, {
        inputTokens: 100,
        outputTokens: 8,
        cachedInputTokens: 60,
        cacheCreationInputTokens: 20,
        totalTokens: 108,
    });
    assert.equal(result.inputUncachedTokens, 20);
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.diagnostics, [
        { code: 'usage.openai_cache_write_unrecognized', paths: ['cache_creation_input_tokens'] },
        { code: 'usage.openai_cache_write_unrecognized', paths: ['input_tokens_details.prompt_cache_write_tokens'] },
    ]);

    const missingWrite = normalizeProviderUsage('openai-responses', {
        input_tokens: 100, input_tokens_details: { cached_tokens: 60 }, output_tokens: 8, total_tokens: 108,
    });
    assert.equal(missingWrite.inputUncachedTokens, undefined);
    assert.equal(missingWrite.coverage, 'partial');
});

test('OpenAI cache read/write components cannot exceed total input', () => {
    const result = normalizeProviderUsage('openai-responses', {
        input_tokens: 100, input_tokens_details: { cached_tokens: 80, cache_write_tokens: 30 }, output_tokens: 8, total_tokens: 108,
    });
    assert.equal(result.inputUncachedTokens, undefined);
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.diagnostics, [
        { code: 'usage.cache_breakdown_mismatch', paths: ['input_tokens', 'input_tokens_details.cached_tokens', 'input_tokens_details.cache_write_tokens'] },
    ]);
});

test('DeepSeek proprietary cache counters are a fallback and are never added to cached_tokens', () => {
    const fallback = normalizeProviderUsage('openai-chat', {
        prompt_tokens: 150,
        prompt_cache_hit_tokens: 96,
        prompt_cache_miss_tokens: 54,
        completion_tokens: 4,
        total_tokens: 154,
    });
    assert.equal(fallback.usage.cachedInputTokens, 96);
    assert.equal(fallback.inputCacheReadTokens, 96);
    assert.equal(fallback.inputUncachedTokens, 54);
    assert.equal(fallback.coverage, 'partial');
    assert.deepEqual(fallback.diagnostics, []);

    const both = normalizeProviderUsage('openai-chat', {
        prompt_tokens: 150,
        prompt_tokens_details: { cached_tokens: 96 },
        prompt_cache_hit_tokens: 96,
        prompt_cache_miss_tokens: 54,
        completion_tokens: 4,
        total_tokens: 154,
    });
    assert.equal(both.usage.cachedInputTokens, 96);
    assert.equal(both.inputUncachedTokens, 54);
    assert.equal(both.diagnostics.length, 0);
});

test('DeepSeek conflicting standard and proprietary counters stay diagnosable and partial', () => {
    const result = normalizeProviderUsage('openai-chat', {
        prompt_tokens: 150,
        prompt_tokens_details: { cached_tokens: 80 },
        prompt_cache_hit_tokens: 96,
        prompt_cache_miss_tokens: 54,
        completion_tokens: 4,
        total_tokens: 154,
    });
    assert.equal(result.usage.cachedInputTokens, 80, 'standard cached_tokens is the deterministic primary');
    assert.equal(result.inputUncachedTokens, 54, 'the provider miss counter remains visible');
    assert.equal(result.coverage, 'partial');
    assert.deepEqual(result.diagnostics, [
        { code: 'usage.deepseek_cache_conflict', paths: ['prompt_tokens_details.cached_tokens', 'prompt_cache_hit_tokens'] },
    ]);
});

test('DeepSeek hit and miss totals are checked without guessing a missing input total', () => {
    const result = normalizeProviderUsage('openai-chat', {
        prompt_cache_hit_tokens: 96,
        prompt_cache_miss_tokens: 54,
        completion_tokens: 4,
    });
    assert.equal(result.usage.inputTokens, undefined);
    assert.equal(result.inputUncachedTokens, 54);
    assert.equal(result.coverage, 'partial');

    const mismatch = normalizeProviderUsage('openai-chat', {
        prompt_tokens: 149,
        prompt_cache_hit_tokens: 96,
        prompt_cache_miss_tokens: 54,
        completion_tokens: 4,
        total_tokens: 153,
    });
    assert.equal(mismatch.inputUncachedTokens, 54);
    assert.deepEqual(mismatch.diagnostics, [
        { code: 'usage.deepseek_cache_total_mismatch', paths: ['prompt_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens'] },
    ]);
});

test('Anthropic keeps disjoint input, cache-read and cache-creation components in the total', () => {
    const result = normalizeProviderUsage('anthropic', {
        input_tokens: 20,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 30,
        output_tokens: 6,
    });
    assert.deepEqual(result.usage, {
        inputTokens: 120,
        outputTokens: 6,
        cachedInputTokens: 70,
        cacheCreationInputTokens: 30,
    });
    assert.equal(result.inputUncachedTokens, 20);
    assert.equal(result.coverage, 'complete');

    const noCacheFields = normalizeProviderUsage('anthropic', { input_tokens: 20, output_tokens: 6 });
    assert.deepEqual(noCacheFields.usage, { inputTokens: 20, outputTokens: 6 });
    assert.equal(noCacheFields.inputCacheReadTokens, undefined);
    assert.equal(noCacheFields.inputCacheWriteTokens, undefined);
    assert.equal(noCacheFields.coverage, 'partial');
});

test('cumulative streaming snapshots update counters without summing repeated values', () => {
    const first = mergeUsageSnapshot({}, {
        input_tokens: 20,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 30,
        output_tokens: 2,
    });
    const second = mergeUsageSnapshot(first, { output_tokens: 6 });
    assert.deepEqual(second, {
        input_tokens: 20,
        cache_read_input_tokens: 70,
        cache_creation_input_tokens: 30,
        output_tokens: 6,
    });
    assert.deepEqual(normalizeProviderUsage('anthropic', second).usage, {
        inputTokens: 120,
        outputTokens: 6,
        cachedInputTokens: 70,
        cacheCreationInputTokens: 30,
    });

    const invalid = mergeUsageSnapshot(second, { output_tokens: '6', input_tokens: null });
    assert.deepEqual(invalid, second);
});

test('missing or invalid usage keeps coverage honest and never fabricates zeros', () => {
    const missing = normalizeProviderUsage('openai-chat', undefined);
    assert.deepEqual(missing.usage, {});
    assert.equal(missing.coverage, 'unknown');
    assert.deepEqual(missing.diagnostics, []);

    const invalid = normalizeProviderUsage('openai-chat', {
        prompt_tokens: -1,
        completion_tokens: 1.5,
        total_tokens: '3',
        prompt_tokens_details: { cached_tokens: null },
    });
    assert.deepEqual(invalid.usage, {});
    assert.equal(invalid.coverage, 'partial');
    assert.equal(invalid.diagnostics.length, 4);
});

test('stream usageEvents emits one compatible snapshot for DeepSeek and official OpenAI cache fields', async () => {
    const source = sse({ choices: [{ delta: { content: 'Done' }, finish_reason: 'stop' }] })
        + sse({ choices: [], usage: {
            prompt_tokens: 150,
            prompt_tokens_details: { cached_tokens: 96, cache_write_tokens: 12 },
            prompt_cache_hit_tokens: 96,
            prompt_cache_miss_tokens: 54,
            completion_tokens: 4,
            total_tokens: 154,
        } }) + sse('[DONE]');
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response(source, { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch;
    try {
        const events: AgentStreamEvent[] = [];
        for await (const event of streamAgentApi(fixtureConnection, 'model', [{ role: 'user', content: 'hello' }])) events.push(event);
        assert.deepEqual(events.filter(item => item.type === 'usage'), [{ type: 'usage', usage: {
            inputTokens: 150,
            outputTokens: 4,
            cachedInputTokens: 96,
            cacheCreationInputTokens: 12,
            totalTokens: 154,
        } }]);
        assert.equal(events.at(-1)?.type, 'complete');
    } finally {
        globalThis.fetch = originalFetch;
    }
});
