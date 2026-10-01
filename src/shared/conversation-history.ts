import type { RunRecord, Snapshot } from './contracts';
import type { ApiMessage } from './endpoints';

export function boundedHistoryText(text: string, limit = 2000): string {
    return text.length <= limit ? text : text.slice(0, limit) + '\n[Host: truncated]';
}

/** Host evidence only: partial model answers and private reasoning are not completion facts. */
export function interruptedRunSummary(snapshot: Snapshot, run: RunRecord): string {
    const related = new Set([run.id]);
    for (let changed = true; changed;) {
        changed = false;
        for (const child of snapshot.runs) if (child.parentRunId && related.has(child.parentRunId) && !child.history?.deleted && !related.has(child.id)) { related.add(child.id); changed = true; }
    }
    const visible = snapshot.runs.filter(item => related.has(item.id) && !item.history?.deleted);
    const visibleIds = new Set(visible.map(item => item.id));
    const lines = [`[UAH host interruption record] Run ${run.id}: ${run.state}. Partial assistant output is not a completed answer.`];
    if (run.error) lines.push(`Error: ${boundedHistoryText(run.error)}`);
    if (run.stopReason) lines.push(`Stop reason: ${boundedHistoryText(run.stopReason)}`);
    for (const artifact of snapshot.artifacts.filter(item => visibleIds.has(item.runId))) {
        lines.push(`Persisted file snapshot: ${boundedHistoryText(artifact.path, 500)}; artifact=${artifact.id}; hash=${artifact.hash}; source run=${artifact.runId}. The write happened; current disk content is not verified.`);
    }
    for (const item of visible) {
        if (item.id !== run.id) lines.push(`Child ${item.id}: ${item.state}${item.error ? '; error=' + boundedHistoryText(item.error, 500) : ''}${item.stopReason ? '; stop reason=' + boundedHistoryText(item.stopReason, 500) : ''}.`);
        for (const activity of item.activities || []) {
            if (activity.tool?.name === 'run_command' && activity.status !== 'approval') lines.push(`Command activity ${activity.id}: ${activity.status}; execution or side effects may have occurred and are not verified. Do not automatically replay it.`);
            if (['write_file', 'apply_patch'].includes(activity.tool?.name ?? '') && !activity.tool?.artifactId && activity.status !== 'approval') lines.push(`Write activity ${activity.id}: ${activity.status}; no persisted artifact evidence; any modification is unconfirmed.`);
        }
    }
    return boundedHistoryText(lines.join('\n'), 12000);
}

/** Deleted replies retain their user turn; retry references hide only old attempts. */
export function visibleRootRuns(runs: RunRecord[], sessionId?: string): RunRecord[] {
    const roots = runs.filter(run => !run.parentRunId && (sessionId === undefined || run.sessionId === sessionId));
    const byId = new Map(roots.map(run => [run.id, run]));
    const retried = new Set(roots.filter(run => run.retryOfRunId && byId.get(run.retryOfRunId)?.sessionId === run.sessionId).map(run => run.retryOfRunId));
    return roots.filter(run => !retried.has(run.id));
}
export function latestVisibleRootRun(runs: RunRecord[], sessionId: string): RunRecord | undefined {
    return visibleRootRuns(runs, sessionId).at(-1);
}
export function displayedReply(run: RunRecord): string {
    if (run.history?.deleted) return '';
    const body = run.history?.editedOutput ?? run.output;
    const plan = run.plan?.content;
    if (!plan || body.includes(plan.trim())) return body;
    return body ? `${body}\n\n${plan}` : plan;
}
export function conversationMessages(snapshot: Snapshot, sessionId: string, options: {
    beforeRunId?: string; throughRunId?: string; historyTurns?: number; includeFailed?: boolean; combineInterruptedTurn?: boolean;
} = {}): ApiMessage[] {
    let roots = visibleRootRuns(snapshot.runs, sessionId);
    // Preserve snapshot insertion order, including a retry's predecessor cutoff.
    const cutoff = options.beforeRunId ?? options.throughRunId;
    if (cutoff) {
        const index = snapshot.runs.findIndex(run => run.id === cutoff);
        if (index < 0 || snapshot.runs[index].sessionId !== sessionId) throw new Error('历史截止运行不存在于当前会话。');
        roots = roots.filter(run => snapshot.runs.indexOf(run) < index + (options.throughRunId ? 1 : 0));
    }
    roots = roots.filter(run => run.state === 'completed' || (options.includeFailed && ['failed', 'stopped'].includes(run.state)));
    let turns: ApiMessage[][] = [];
    for (const message of snapshot.sessions.find(session => session.id === sessionId)?.branchMessages || []) {
        if (message.role === 'user' || turns.length === 0) turns.push([]);
        turns.at(-1)!.push(structuredClone(message));
    }
    for (const run of roots) {
        const turn: ApiMessage[] = [{ role: 'user', content: run.input }];
        for (const steer of run.steering ?? []) turn.push({ role: 'user', content: steer.input });
        if (!run.history?.deleted) {
            if (run.state === 'completed') turn.push({ role: 'assistant', content: displayedReply(run) });
            else {
                const summary = interruptedRunSummary(snapshot, run);
                // Branch snapshots have only role/content. Combine our generated notice here,
                // rather than recognizing a user-forgeable prefix when replaying messages.
                if (options.combineInterruptedTurn) turn[0].content += '\n\n' + summary;
                else turn.push({ role: 'user', content: summary });
            }
        }
        turns.push(turn);
    }
    if (options.historyTurns !== undefined) turns = options.historyTurns === 0 ? [] : turns.slice(-options.historyTurns);
    return turns.flat();
}
