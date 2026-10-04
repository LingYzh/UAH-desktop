import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunRecord } from '../../src/shared/contracts';
import { KnowledgeService, parseKnowledgeTool } from '../../src/runtime/knowledge-service';
import { executeKnowledgeTool } from '../../src/runtime/knowledge-tools';
import { MemoryRenameError, MemoryStoreError } from '../../src/runtime/memory-store';

test('memory tools use real activation approval, host provenance, CAS, and deletion effects', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uah-memory-tools-'));
    try {
        const directory = join(root, 'project'); await mkdir(directory);
        const service = new KnowledgeService(join(root, 'home'));
        let approved = false; let approvals = 0; let dispatches = 0;
        let run = { id: 'run', sessionId: 'session', effective: { permissionMode: 'bypass' }, activities: [] } as unknown as RunRecord;
        const invoke = (name: string, args: Record<string, unknown>) => executeKnowledgeTool({ id: 'tool', name, arguments: JSON.stringify(args) }, {
            service, directory, targets: [], signal: new AbortController().signal, current: () => run,
            dispatch: () => { dispatches++; }, acquire: async () => {},
            approve: async () => { approvals++; return approved; }, redact: text => text.replaceAll('secret-token', '[REDACTED]'),
        });
        const data = { scope: 'user', title: 'Preferred language', slug: 'preferred-language', body: 'Use Chinese, secret-token', kind: 'preference', status: 'active', pinned: true };
        const denied = await invoke('save_memory', data);
        assert.equal(denied.isError, true); assert.equal(dispatches, 0); assert.equal(approvals, 1);
        assert.equal((await service.memory.list(directory)).entries.length, 0);
        approved = true;
        const saved = await invoke('save_memory', data); assert.equal(saved.isError, undefined);
        const first = JSON.parse(saved.content);
        assert.match(first.path, /\d{4}-\d{2}-\d{2}-preferred-language\.md$/);
        assert.equal(first.source.origin, 'user'); assert.equal(first.source.runId, 'run');
        assert.equal(first.status, 'active'); assert.equal(saved.outcome.effectState, 'confirmed');
        assert.equal((await service.memory.snapshot(directory)).pinned[0].body, 'Use Chinese, [REDACTED]');
        const { slug: _slug, ...updateData } = data;
        const stale = await invoke('save_memory', { ...updateData, id: first.id, expectedHash: '0'.repeat(64) });
        assert.equal(stale.isError, true); assert.equal(stale.outcome.effectState, 'not_started');
        const forgotten = await invoke('forget_memory', { scope: 'user', id: first.id, expectedHash: first.hash });
        assert.equal(forgotten.isError, undefined); assert.equal(forgotten.outcome.effectState, 'confirmed');
        assert.match(JSON.parse(forgotten.content).path, /\d{4}-\d{2}-\d{2}-forgotten-memory\.md$/);
        assert.equal(forgotten.outcome.resources?.length, 2);
        assert.equal((await service.memory.snapshot(directory)).pinned.length, 0);
        const repeated = await invoke('save_memory', { scope: 'user', title: 'Different title', body: 'Use Chinese, [REDACTED]', kind: 'preference' });
        assert.equal(repeated.isError, true); assert.equal(repeated.outcome.effectState, 'not_started');
        const before = dispatches;
        run = { ...run, parentRunId: 'parent' };
        assert.equal((await invoke('save_memory', data)).isError, true); assert.equal(dispatches, before);
        run = { ...run, parentRunId: undefined, effective: { ...run.effective, permissionMode: 'readonly' } };
        assert.equal((await invoke('save_memory', data)).isError, true); assert.equal(dispatches, before);
    } finally { await rm(root, { recursive: true, force: true }); }
});

test('knowledge schemas reject forged state and malformed ranges before dispatch', () => {
    const parse = (name: string, args: unknown) => parseKnowledgeTool({ id: 'test', name, arguments: JSON.stringify(args) });
    assert.throws(() => parse('save_memory', { scope: 'project', title: 'x', body: 'y', kind: 'lesson', status: 'active', pinned: true }));
    assert.throws(() => parse('save_memory', { scope: 'project', title: 'x', body: 'y', kind: 'made-up' }));
    for (const slug of ['../escape', 'Upper-case', 'a'.repeat(81), 'bad--slug']) {
        assert.throws(() => parse('save_memory', { scope: 'project', title: 'x', body: 'y', kind: 'lesson', slug }));
    }
    assert.throws(() => parse('save_memory', { scope: 'project', title: 'x', body: 'y', kind: 'lesson', slug: 'new-name', id: 'existing' }));
    assert.throws(() => parse('read_context', { sourceId: 'x', offset: -1 }));
    assert.throws(() => parse('read_context', { sourceId: 'x', expectedHash: 'bogus' }));
    assert.throws(() => parse('save_memory', { scope: 'project', title: 'x', body: 'y', kind: 'lesson', source: { origin: 'user' } }));
});

test('partial tombstone rename failure reports committed effects and requires reconciliation', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uah-memory-rename-outcome-'));
    try {
        const directory = join(root, 'project'); await mkdir(directory);
        const service = new KnowledgeService(join(root, 'home'));
        const entry = await service.memory.save(directory, { scope: 'project', title: 'Build notes', body: 'Use the project build.',
            kind: 'lesson', status: 'candidate', pinned: false, source: { sessionId: 'session', runId: 'run', origin: 'agent', evidenceIds: [] } });
        const target = join(directory, '.memory', '2026-10-04-forgotten-memory.md');
        const committed = { ...entry, title: '已遗忘记忆', body: '', status: 'deleted' as const, hash: 'a'.repeat(64) };
        service.memory.forget = async () => { throw new MemoryRenameError(committed, target, [entry.path, target], new Error('rename failed')); };
        const result = await executeKnowledgeTool({ id: 'forget', name: 'forget_memory', arguments: JSON.stringify({ scope: 'project', id: entry.id, expectedHash: entry.hash }) }, {
            service, directory, targets: [], signal: new AbortController().signal,
            current: () => ({ id: 'run', sessionId: 'session', effective: { permissionMode: 'bypass' }, activities: [] }) as unknown as RunRecord,
            dispatch: () => {}, acquire: async () => {}, approve: async () => true, redact: text => text,
        });
        assert.equal(result.isError, true);
        assert.equal(result.outcome.effectState, 'confirmed');
        assert.equal(result.outcome.retryClass, 'reconcile_first');
        assert.equal(result.outcome.resources.length, 2);
        assert.equal(result.outcome.resources[0].afterHash, committed.hash);
        assert.equal(result.outcome.resources[1].afterHash, null);
        assert.match(result.content, /墓碑已保存/);

        const read = service.memory.read.bind(service.memory);
        let reads = 0;
        service.memory.read = async (...args) => {
            if (++reads === 2) throw new MemoryStoreError('Concurrent removal after commit', 'NOT_FOUND');
            return read(...args);
        };
        service.memory.forget = async () => {};
        const postCommitReadFailure = await executeKnowledgeTool({ id: 'forget-again', name: 'forget_memory', arguments: JSON.stringify({ scope: 'project', id: entry.id, expectedHash: entry.hash }) }, {
            service, directory, targets: [], signal: new AbortController().signal,
            current: () => ({ id: 'run', sessionId: 'session', effective: { permissionMode: 'bypass' }, activities: [] }) as unknown as RunRecord,
            dispatch: () => {}, acquire: async () => {}, approve: async () => true, redact: text => text,
        });
        assert.equal(postCommitReadFailure.isError, true);
        assert.equal(postCommitReadFailure.outcome.effectState, 'confirmed');
        assert.equal(postCommitReadFailure.outcome.retryClass, 'reconcile_first');
    } finally { await rm(root, { recursive: true, force: true }); }
});
