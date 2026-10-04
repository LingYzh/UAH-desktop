/** Provider identity plus exact result and artifact evidence are required to prune. */
export interface RecoverableResult {
    toolCallId: string;
    invocationId: string;
    result: string;
    hashes: readonly string[];
}

/** Any provider ID reused by another invocation is ambiguous and is excluded. */
export function indexRecoverableResults(entries: readonly RecoverableResult[], dispatches: readonly Pick<RecoverableResult, 'toolCallId' | 'invocationId'>[] = entries): ReadonlyMap<string, { result: string; hashes: readonly string[] }> {
    const values = new Map<string, { invocationId: string; result: string; hashes: string }>();
    const conflicts = new Set<string>();
    const dispatchedInvocations = new Map<string, Set<string>>();
    for (const dispatch of dispatches) {
        if (!dispatch.toolCallId || !dispatch.invocationId) continue;
        const invocations = dispatchedInvocations.get(dispatch.toolCallId) ?? new Set<string>();
        invocations.add(dispatch.invocationId);
        dispatchedInvocations.set(dispatch.toolCallId, invocations);
    }
    for (const [toolCallId, invocations] of dispatchedInvocations) if (invocations.size > 1) conflicts.add(toolCallId);
    for (const entry of entries) {
        if (!entry.toolCallId || !entry.invocationId || !entry.hashes.length) continue;
        const key = entry.toolCallId;
        if (dispatchedInvocations.get(key)?.size !== 1 || !dispatchedInvocations.get(key)?.has(entry.invocationId)) continue;
        const hashes = JSON.stringify([...new Set(entry.hashes)].sort());
        const previous = values.get(key);
        if (previous && (previous.invocationId !== entry.invocationId || previous.result !== entry.result || previous.hashes !== hashes)) conflicts.add(key);
        else values.set(key, { invocationId: entry.invocationId, result: entry.result, hashes });
    }
    return new Map([...values].filter(([key]) => !conflicts.has(key)).map(([key, value]) => [key, {
        result: value.result, hashes: JSON.parse(value.hashes) as string[],
    }]));
}

/** Deterministic replacement only for old successful results with authorized public artifacts. */
export function pruneArchivedResults(history: readonly unknown[], recoverable: ReadonlyMap<string, { result: string; hashes: readonly string[] }>): unknown[] | undefined {
    let changed = false;
    const shorten = (value: unknown, toolCallId: unknown, isError = false) => {
        if (typeof value !== 'string' || value.length < 16000 || isError || typeof toolCallId !== 'string') return value;
        const entry = recoverable.get(toolCallId);
        if (!entry || entry.result !== value || !entry.hashes.length) return value;
        changed = true;
        return value.slice(0, 2000) + '\n[UAH archived successful tool result: middle omitted. Original public artifacts remain available with read_artifact_range; SHA-256: '
            + entry.hashes.join(', ') + '. This is a historical result, do not replay the tool.]\n' + value.slice(-1000);
    };
    const result = structuredClone([...history]) as Array<Record<string, unknown>>;
    for (const item of result.slice(0, Math.max(0, result.length - 6))) {
        if (item.role === 'tool') item.content = shorten(item.content, item.tool_call_id, item.is_error === true);
        if (item.type === 'function_call_output') item.output = shorten(item.output, item.call_id, item.is_error === true);
        if (Array.isArray(item.content)) for (const block of item.content) {
            if (block && typeof block === 'object' && block.type === 'tool_result') block.content = shorten(block.content, block.tool_use_id, block.is_error === true);
        }
    }
    return changed ? result : undefined;
}
