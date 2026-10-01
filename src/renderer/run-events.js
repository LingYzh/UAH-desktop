const incrementalTypes = new Set(['delta', 'activity-delta', 'run-state']);
const validSequence = value => Number.isSafeInteger(value) && value >= 0;
const activeStates = new Set(['running', 'approval', 'cancelRequested', 'stopping']);

/** Older full snapshots remain valid while scoped snapshots supply their own summary. */
export function overviewForSnapshot(snapshot) {
    if (snapshot.overview) return snapshot.overview;
    const rootStates = {}; const latestStates = {}; const activeRunIds = [];
    for (const run of snapshot.runs) {
        const entry = { id: run.id, state: run.state };
        latestStates[run.sessionId] = entry;
        if (!run.parentRunId) rootStates[run.sessionId] = entry;
        if (activeStates.has(run.state)) activeRunIds.push(run.id);
    }
    return { rootStates, latestStates, activeRunIds };
}

function updateOverview(snapshot, run) {
    if (!snapshot.overview) return;
    for (const key of ['rootStates', 'latestStates']) {
        const entry = snapshot.overview[key]?.[run.sessionId];
        if (entry?.id === run.id) entry.state = run.state;
    }
    const active = new Set(snapshot.overview.activeRunIds);
    if (activeStates.has(run.state)) active.add(run.id); else active.delete(run.id);
    snapshot.overview.activeRunIds = [...active];
}

/** Mutates only the matching run. A refresh repairs any identity/sequence/offset gap. */
export function applyRunEvent(snapshot, event) {
    if (!event || !event.runId || !event.sessionId) return 'refresh';
    if (Object.hasOwn(snapshot, 'viewSessionId') && event.sessionId !== snapshot.viewSessionId) {
        if (event.type === 'delta' || event.type === 'activity-delta') return 'ignored';
        return 'refresh';
    }
    const index = snapshot.runs.findIndex(run => run.id === event.runId && run.sessionId === event.sessionId);
    if (index < 0 || !snapshot.sessions.some(session => session.id === event.sessionId)) return 'refresh';
    const run = snapshot.runs[index];
    if (!validSequence(event.sequence) || !validSequence(run.sequence)) return 'refresh';
    if (event.sequence <= run.sequence) return 'ignored';
    if (event.turnId !== run.turnId || !incrementalTypes.has(event.type)) return 'refresh';
    if (event.sequence !== run.sequence + 1) return 'refresh';
    const payload = event.payload;
    if (!payload || typeof payload !== 'object') return 'refresh';
    if (event.type === 'run-state') {
        const replacement = payload.run;
        if (!replacement || replacement.id !== run.id || replacement.sessionId !== run.sessionId
            || replacement.turnId !== run.turnId || replacement.sequence !== event.sequence) return 'refresh';
        snapshot.runs[index] = replacement;
        updateOverview(snapshot, replacement);
        return 'applied';
    }
    if (run.state !== 'running' || typeof payload.text !== 'string') return 'refresh';
    const activities = run.activities || [];
    if (event.type === 'delta') {
        if (typeof run.output !== 'string' || payload.offset !== run.output.length) return 'refresh';
        let activity;
        if (payload.activityId !== undefined) {
            if (typeof payload.activityId !== 'string' || !payload.activityId) return 'refresh';
            activity = activities.find(item => item.id === payload.activityId);
            if (activity && (activity.kind !== 'text' || typeof activity.content !== 'string')) return 'refresh';
            if (payload.activityOffset !== (activity?.content.length ?? 0)) return 'refresh';
            if (!activity) activity = { id: payload.activityId, kind: 'text', title: '', content: '', status: 'completed' };
        } else if (payload.activityOffset !== undefined || run.effective?.runtimeId === 'api') {
            return 'refresh';
        }
        // Validate both offsets before changing either projection.
        run.output += payload.text;
        if (activity) {
            if (!activities.includes(activity)) activities.push(activity);
            activity.content += payload.text;
            run.activities = activities;
        }
    } else {
        if (payload.kind !== 'reasoning' || typeof payload.activityId !== 'string' || !payload.activityId
            || typeof payload.title !== 'string') return 'refresh';
        let activity = activities.find(item => item.id === payload.activityId);
        if (activity && (activity.kind !== 'reasoning' || typeof activity.content !== 'string')) return 'refresh';
        if (payload.offset !== (activity?.content.length ?? 0)) return 'refresh';
        if (!activity) {
            activity = { id: payload.activityId, kind: 'reasoning', title: payload.title, content: '', status: 'running' };
            activities.push(activity);
        }
        activity.title = payload.title;
        activity.content += payload.text;
        run.activities = activities;
    }
    run.sequence = event.sequence;
    return 'applied';
}

/** Preserve newer streamed runs when an earlier snapshot reply arrives late.
 * Incoming membership remains authoritative for session/run deletion. */
export function mergeRunSnapshot(current, incoming, expectedView) {
    if (Object.hasOwn(incoming, 'viewSessionId') && expectedView !== undefined && incoming.viewSessionId !== expectedView) return current;
    if (current.viewSessionId !== incoming.viewSessionId) return incoming;
    const localRuns = new Map(current.runs.map(run => [JSON.stringify([run.sessionId, run.id]), run]));
    const merged = {
        ...incoming,
        runs: incoming.runs.map(run => {
            const local = localRuns.get(JSON.stringify([run.sessionId, run.id]));
            return local && validSequence(local.sequence) && validSequence(run.sequence) && local.sequence > run.sequence
                ? local : run;
        }),
    };
    if (merged.overview) {
        merged.overview = structuredClone(merged.overview);
        for (const run of merged.runs) updateOverview(merged, run);
    }
    return merged;
}
