export const planStatusLabels = { draft: '草稿', proposed: '待审批', approved: '已批准', 'revision-requested': '已要求修订', archived: '历史版本' };

// Keep the exact plan in model history while showing the user's decision in the conversation.
export function planRunInput(run, snapshot) {
    const source = snapshot.runs.find(item => item.sessionId === run.sessionId && item.plan?.executionRunId === run.id);
    if (!source) return run.input;
    const plan = source.plan;
    const label = `${plan.title || '实施计划'} · v${plan.version || 1}`;
    if (plan.status === 'approved') return `已批准计划「${label}」，开始实施。`;
    if (plan.status === 'revision-requested') return `请修订计划「${label}」。\n\n${plan.feedback || ''}`;
    return run.input;
}

export function currentPlanRun(snapshot, sessionId) {
    const session = snapshot.sessions.find(item => item.id === sessionId);
    const runs = snapshot.runs.filter(run => run.sessionId === sessionId && !run.parentRunId && !run.history?.deleted && run.plan);
    return session?.activePlanRunId ? runs.find(run => run.id === session.activePlanRunId) : runs.at(-1);
}

export function planDocuments(snapshot, sessionId) {
    const documents = new Map();
    for (const run of snapshot.runs) {
        if (run.sessionId !== sessionId || run.parentRunId || run.history?.deleted || !run.plan) continue;
        const documentId = run.plan.documentId || run.plan.id;
        const document = documents.get(documentId) || { id: documentId, title: run.plan.title || '实施计划', versions: [] };
        document.title = run.plan.title || document.title;
        for (const version of [...(run.plan.history || []).map(item => ({ ...item, status: 'archived' })), run.plan]) {
            const entry = { ...version, runId: run.id, title: version.title || document.title, version: version.version || 1 };
            const index = document.versions.findIndex(item => item.id === entry.id);
            if (index < 0) document.versions.push(entry);
            else document.versions[index] = entry;
        }
        document.versions.sort((left, right) => left.version - right.version);
        documents.set(documentId, document);
    }
    return [...documents.values()];
}
