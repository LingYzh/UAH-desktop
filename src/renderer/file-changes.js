const windowsAbsolute = value => /^[a-z]:[\\/]/i.test(value) || /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
const absolute = value => windowsAbsolute(value) || value.startsWith('/');

/** Comparison only. Never change the path displayed or persisted in an artifact. */
export function filePathKey(value, directory) {
    if (typeof value !== 'string' || !value) return null;
    if (!absolute(value)) {
        if (typeof directory !== 'string' || !absolute(directory)) return null;
        value = `${directory.replace(/[\\/]$/, '')}/${value}`;
    }
    const windows = windowsAbsolute(value);
    if (windows) value = value.replace(/\\/g, '/');
    const prefix = windows && value.startsWith('//') ? '//' : value.startsWith('/') ? '/' : '';
    const segments = [];
    for (const part of value.slice(prefix.length).split('/')) {
        if (!part || part === '.') continue;
        if (part === '..') { if (segments.length > (windows ? value.startsWith('//') ? 2 : 1 : 0)) segments.pop(); }
        else segments.push(part);
    }
    const key = prefix + segments.join('/');
    return windows ? key.toLowerCase() : key;
}

/** Actual snapshots only: no filesystem access, proposals, or computed statistics. */
export function roundFileChanges(run, snapshot) {
    const included = new Set([run.id]);
    const sessionRuns = new Map((snapshot.runs || []).filter(item => item.sessionId === run.sessionId).map(item => [item.id, item]));
    let attempt = run;
    while (attempt.retryOfRunId && sessionRuns.has(attempt.retryOfRunId) && !included.has(attempt.retryOfRunId)) {
        attempt = sessionRuns.get(attempt.retryOfRunId);
        included.add(attempt.id);
    }
    const children = new Map();
    for (const item of snapshot.runs || []) {
        if (item.sessionId !== run.sessionId || !item.parentRunId) continue;
        const entries = children.get(item.parentRunId) || [];
        entries.push(item.id); children.set(item.parentRunId, entries);
    }
    const queue = [...included];
    for (let index = 0; index < queue.length; index++) {
        for (const id of children.get(queue[index]) || []) if (!included.has(id)) { included.add(id); queue.push(id); }
    }
    const artifacts = (snapshot.artifacts || []).map((artifact, index) => ({ artifact, index }))
        .filter(({ artifact }) => artifact.sessionId === run.sessionId && included.has(artifact.runId))
        .sort((left, right) => (Date.parse(left.artifact.createdAt) || 0) - (Date.parse(right.artifact.createdAt) || 0) || left.index - right.index);
    const changes = new Map();
    for (const { artifact } of artifacts) {
        const key = filePathKey(artifact.path) ?? artifact.path;
        const previous = changes.get(key);
        if (previous) {
            previous.latestArtifactId = artifact.id;
            previous.artifactIds.push(artifact.id);
            previous.newContent = artifact.newContent;
            previous.createdAt = artifact.createdAt;
            previous.hash = artifact.hash;
        } else changes.set(key, { ...artifact, runId: run.id, latestArtifactId: artifact.id, artifactIds: [artifact.id] });
    }
    return [...changes.values()].filter(change => change.oldContent !== change.newContent);
}
