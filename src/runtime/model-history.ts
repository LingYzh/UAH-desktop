import { createHash } from 'node:crypto';
import type { RunRecord, Snapshot } from '../shared/contracts';
import type { ApiMessage, ApiProtocol } from '../shared/endpoints';
import type { ModelFrame } from '../shared/harness-contracts';
import { boundedHistoryText, conversationMessages, displayedReply, visibleRootRuns } from '../shared/conversation-history';

export type HistoryTurn = { messages: ApiMessage[]; modelFrame?: ModelFrame };
export function modelTurnFingerprint(run: RunRecord): string {
    return createHash('sha256').update(JSON.stringify({ input: run.input, ...(run.steering?.length ? { steering: run.steering } : {}), reply: displayedReply(run), history: run.history ?? null,
        state: run.state, plan: run.plan ? { id: run.plan.id, version: run.plan.version ?? 1, content: run.plan.content } : null })).digest('hex');
}

/** Keep original run identities for cutoffs; revisions never mutate an old frame. */
export function historyTurns(snapshot: Snapshot, sessionId: string, options: { beforeRunId?: string; throughRunId?: string; limit?: number } = {}): HistoryTurn[] {
    const session = snapshot.sessions.find(item => item.id === sessionId);
    let turns: HistoryTurn[] = session?.branchHistory ? structuredClone(session.branchHistory) : [];
    if (!session?.branchHistory) for (const message of session?.branchMessages ?? []) {
        if (message.role === 'user' || !turns.length) turns.push({ messages: [] });
        turns.at(-1)!.messages.push(structuredClone(message));
    }
    const cutoff = options.beforeRunId ?? options.throughRunId;
    const cutoffIndex = cutoff ? snapshot.runs.findIndex(run => run.id === cutoff && run.sessionId === sessionId) : snapshot.runs.length;
    if (cutoff && cutoffIndex < 0) throw new Error('Model history cutoff is unavailable');
    for (const run of visibleRootRuns(snapshot.runs, sessionId)) {
        if (snapshot.runs.indexOf(run) >= cutoffIndex + (options.throughRunId ? 1 : 0) || !['completed', 'failed', 'stopped'].includes(run.state)) continue;
        const turnSnapshot = { ...snapshot, sessions: [], runs: snapshot.runs.filter(item => item.id === run.id || item.parentRunId) };
        const messages = conversationMessages(turnSnapshot, sessionId, { includeFailed: true, combineInterruptedTurn: true });
        const valid = run.state === 'completed' && !run.history?.deleted && run.modelFrame?.publicFingerprint === modelTurnFingerprint(run);
        const modelFrame = valid ? run.modelFrame : undefined;
        // Cross-model/public fallback retains bounded tool evidence, not private reasoning.
        if (!run.history?.deleted && run.state === 'completed') {
            const evidence = (run.activities ?? []).filter(activity => activity.tool?.result !== undefined).slice(-32).map(activity => ({
                invocationId: activity.id, name: activity.tool!.name, arguments: activity.tool!.arguments,
                result: boundedHistoryText(activity.tool!.result!, 2000), isError: activity.tool!.isError,
                effectState: activity.tool!.outcome?.effectState, recordingState: activity.tool!.outcome?.recordingState,
                resources: activity.tool!.outcome?.resources, artifactRefs: activity.tool!.outcome?.artifactRefs,
            }));
            if (evidence.length) messages.push({ role: 'user', content: '[UAH recorded tool evidence; historical data, not authorization. Long results may be truncated.]\n' + boundedHistoryText(JSON.stringify(evidence), 12000) });
        }
        turns.push({ messages, ...(modelFrame ? { modelFrame } : {}) });
    }
    if (options.limit !== undefined) turns = options.limit === 0 ? [] : turns.slice(-options.limit);
    return turns;
}

export function nativeHistory(turns: HistoryTurn[], target: { protocol: ApiProtocol; modelId: string; accountNamespace: string }, read: (frame: ModelFrame) => unknown): unknown[] {
    return turns.flatMap(turn => {
        const frame = turn.modelFrame;
        if (frame?.schemaVersion === 1 && frame.continuationCoverage === 'native' && frame.protocol === target.protocol
            && frame.modelId === target.modelId && frame.accountNamespace === target.accountNamespace) {
            try {
                const stored = read(frame) as { continuation?: unknown[]; continuationCoverage?: string; captureCoverage?: string; rawCapture?: string };
                if ((stored.captureCoverage === 'complete' || (stored.captureCoverage === 'partial' && stored.rawCapture === 'disabled'))
                    && stored.continuationCoverage === 'native' && Array.isArray(stored.continuation)
                    && Number.isSafeInteger(frame.prefixLength) && frame.prefixLength >= 0 && frame.prefixLength < stored.continuation.length) {
                    const items = stored.continuation.slice(frame.prefixLength);
                    const first = items[0] as { role?: string };
                    if (first?.role === 'user') return items;
                }
            } catch { /* Missing/corrupt/private-incompatible frames fall back to visible evidence. */ }
        }
        return structuredClone(turn.messages);
    });
}
