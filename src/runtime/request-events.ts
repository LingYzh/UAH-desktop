interface CorrelatedEvent {
    type: string;
    run: { runId: string };
    payload: unknown;
}
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Follow host invocation identities, never arbitrary IDs embedded in tool output or user text. */
export function requestEvents<T extends CorrelatedEvent>(events: readonly T[], requestId: string, attemptId?: string): T[] {
    const matches = (value: unknown): boolean => {
        const identity = record(value);
        return identity?.requestId === requestId && (attemptId === undefined || identity.attemptId === attemptId);
    };
    const direct = (event: T) => {
        const payload = record(event.payload);
        return payload !== undefined && (matches(payload) || matches(payload.identity) || matches(payload.usage));
    };
    const invocations = new Set<string>();
    const key = (runId: string, invocationId: string) => JSON.stringify([runId, invocationId]);
    for (const event of events) {
        if (!direct(event)) continue;
        const payload = record(event.payload)!;
        const identities = event.type === 'tool.batch' && Array.isArray(payload.invocations) ? payload.invocations
            : event.type === 'tool.dispatch' ? [payload.identity] : [];
        for (const value of identities) {
            const identity = record(value);
            if (matches(identity) && typeof identity?.invocationId === 'string') invocations.add(key(event.run.runId, identity.invocationId));
        }
    }
    return events.filter(event => {
        if (direct(event)) return true;
        if (!['tool.result', 'approval.requested', 'approval.decided'].includes(event.type)) return false;
        const invocationId = record(event.payload)?.invocationId;
        return typeof invocationId === 'string' && invocations.has(key(event.run.runId, invocationId));
    });
}
