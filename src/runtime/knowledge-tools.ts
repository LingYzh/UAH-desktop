import { pathToFileURL } from 'node:url';
import type { RunRecord } from '../shared/contracts';
import type { MemoryWrite, MemoryScope } from '../shared/memory';
import type { ToolCall } from '../shared/tool-protocol';
import { KnowledgeService, knowledgeWriteTools, parseKnowledgeTool } from './knowledge-service';
import { beginToolOutcome } from './tool-outcome';
import { MemoryIndexUpdateError, MemoryRenameError, MemoryStoreError } from './memory-store';

export async function executeKnowledgeTool(call: ToolCall, options: {
    service: KnowledgeService; directory: string | null; targets: readonly string[]; signal: AbortSignal;
    current: () => RunRecord; dispatch: () => void; acquire: (mode: 'read' | 'write') => Promise<void>;
    approve: (summary: string, path: string) => Promise<boolean>; redact: (text: string) => string;
}) {
    const tracker = beginToolOutcome();
    try {
        const args = parseKnowledgeTool(call);
        const writes = knowledgeWriteTools.includes(call.name);
        const allowed = () => {
            const run = options.current();
            if (writes && (run.parentRunId || ['readonly', 'plan'].includes(run.effective.permissionMode ?? 'manual'))) throw new Error('当前角色或权限禁止发布记忆。');
            options.signal.throwIfAborted();
            return run;
        };
        let run = allowed();
        if (!writes) {
            await options.acquire('read'); options.dispatch();
            return tracker.finish({ content: options.redact(JSON.stringify(await options.service.readTool(call.name, args, options.directory, options.targets, options.signal))) });
        }
        const scope = args.scope as MemoryScope;
        if (!['user', 'project', 'private-project'].includes(scope)) throw new Error('记忆范围无效。');
        const directory = options.service.memory.directoryFor(options.directory, scope);
        const confirming = call.name === 'save_memory' && args.status === 'active';
        // Non-project stores lie outside the workspace's automatic edit grant.
        // Activation is a user confirmation, distinct from bypassing edit approval.
        if (confirming || (run.effective.permissionMode !== 'bypass' && (scope !== 'project' || (run.effective.permissionMode ?? 'manual') === 'manual'))) {
            if (!await options.approve(`${confirming ? '确认' : call.name === 'forget_memory' ? '遗忘' : '保存候选'} UAH ${scope} 记忆${args.pinned ? '并固定偏好' : ''}：${String(args.title ?? args.id)}${confirming ? `\n${options.redact(args.body as string)}` : ''}`, directory)) throw new Error('用户拒绝记忆操作。');
        }
        await options.acquire('write'); run = allowed();
        const source = { sessionId: run.sessionId, runId: run.id, origin: confirming ? 'user' as const : 'agent' as const,
            evidenceIds: (run.activities ?? []).filter(item => item.tool?.outcome?.status === 'succeeded').slice(-12).map(item => item.id) };
        if (call.name === 'save_memory') {
            if (args.id && !args.expectedHash) throw new Error('修改记忆前必须读取 expectedHash。');
            const write: MemoryWrite = { scope, title: options.redact(args.title as string), body: options.redact(args.body as string),
                kind: args.kind as MemoryWrite['kind'], status: confirming ? 'active' : 'candidate', pinned: args.pinned === true, source,
                ...(args.slug ? { slug: args.slug as string } : {}), ...(args.id ? { id: args.id as string } : {}), ...(args.expectedHash ? { expectedHash: args.expectedHash as string } : {}) };
            options.dispatch(); tracker.outcome.effectState = 'possible'; tracker.outcome.retryClass = 'reconcile_first';
            const entry = await options.service.memory.save(options.directory, write, options.signal);
            tracker.outcome.effectState = 'confirmed'; tracker.outcome.retryClass = 'never';
            tracker.outcome.resources = [{ uri: pathToFileURL(entry.path).href, beforeHash: write.expectedHash ?? null, afterHash: entry.hash, hashKind: 'raw_bytes' }];
            return tracker.finish({ content: JSON.stringify({ id: entry.id, path: entry.path, hash: entry.hash, status: entry.status, source: entry.source }) });
        }
        const entry = await options.service.memory.read(options.directory, scope, args.id as string);
        options.dispatch(); tracker.outcome.effectState = 'possible'; tracker.outcome.retryClass = 'reconcile_first';
        await options.service.memory.forget(options.directory, scope, args.id as string, args.expectedHash as string, options.signal);
        tracker.outcome.effectState = 'confirmed'; tracker.outcome.retryClass = 'never';
        const tombstone = await options.service.memory.read(options.directory, scope, args.id as string);
        tracker.outcome.resources = entry.path === tombstone.path
            ? [{ uri: pathToFileURL(entry.path).href, beforeHash: entry.hash, afterHash: tombstone.hash, hashKind: 'raw_bytes' }]
            : [{ uri: pathToFileURL(entry.path).href, beforeHash: entry.hash, afterHash: null, hashKind: 'raw_bytes' },
                { uri: pathToFileURL(tombstone.path).href, beforeHash: null, afterHash: tombstone.hash, hashKind: 'raw_bytes' }];
        return tracker.finish({ content: JSON.stringify({ id: args.id, path: tombstone.path, forgotten: true, hash: tombstone.hash }) });
    } catch (error) {
        if (tracker.outcome.effectState !== 'confirmed' && error instanceof MemoryStoreError && ['INVALID_INPUT', 'INVALID_SLUG', 'AMBIGUOUS_ID', 'UUID_FILENAME_MISMATCH', 'SCOPE_SCAN_LIMIT', 'FILENAME_EXHAUSTED', 'INVALID_ID', 'INVALID_HASH', 'EXPECTED_HASH_REQUIRED', 'UNEXPECTED_HASH', 'INVALID_SCOPE', 'DIRECTORY_REQUIRED', 'WRITE_CONFLICT', 'NOT_FOUND', 'UNOWNED_FILE', 'TOMBSTONED_CONTENT', 'ALREADY_DELETED'].includes(error.code)) {
            tracker.outcome.effectState = 'not_started'; tracker.outcome.retryClass = 'safe';
        }
        if (error instanceof MemoryIndexUpdateError || error instanceof MemoryRenameError) {
            tracker.outcome.effectState = 'confirmed'; tracker.outcome.retryClass = 'reconcile_first';
            const paths = error instanceof MemoryRenameError ? error.paths : [error.committedEntry.path];
            tracker.outcome.resources = paths.map(path => ({ uri: pathToFileURL(path).href, beforeHash: null,
                afterHash: path === error.committedEntry.path ? error.committedEntry.hash : null, hashKind: 'raw_bytes' }));
        }
        if (tracker.outcome.effectState === 'confirmed') tracker.outcome.retryClass = 'reconcile_first';
        tracker.outcome.status = options.signal.aborted ? 'cancelled' : 'failed';
        tracker.outcome.errorCode = 'MEMORY_TOOL_FAILED';
        return tracker.finish({ content: options.redact(error instanceof Error ? error.message : String(error)), isError: true });
    }
}
