import type { Snapshot } from './contracts';

function legacyResult(content: string): string {
    let quoted = false; let escaped = false; let depth = 0;
    if (!content.trimStart().startsWith('{')) return content;
    for (let index = 0; index < content.length; index++) {
        const character = content[index];
        if (quoted) { if (escaped) escaped = false; else if (character === '\\') escaped = true; else if (character === '"') quoted = false; continue; }
        if (character === '"') quoted = true;
        else if (character === '{' || character === '[') depth++;
        else if (character === '}' || character === ']') {
            if (--depth === 0) return content.slice(index + 1).startsWith('\n\n') ? content.slice(index + 3) : '';
        }
    }
    return '';
}

/** Historical side effects, including children/retries; never use the net file diff. */
export function sessionHasFileChanges(snapshot: Snapshot, sessionId: string): boolean {
    if (snapshot.artifacts.some(artifact => artifact.sessionId === sessionId && artifact.oldContent !== artifact.newContent)) return true;
    return snapshot.runs.some(run => run.sessionId === sessionId && run.activities?.some(activity => {
        const name = activity.tool?.name ?? activity.title;
        const result = activity.tool?.result ?? legacyResult(activity.content);
        if (name === 'run_command') {
            if (!/Exit code: /.test(result) && /^\s*Command could not start\.\nUnsandboxed command:/.test(result)) return false;
            return activity.status === 'completed' || /Exit code: |Unsandboxed command:/.test(result);
        }
        if (name !== 'write_file') return false;
        if (activity.status === 'completed' && activity.tool?.isError !== true) return true;
        return /(?:^|\n\n)File written(?:\.|, but snapshot persistence failed\.)/.test(result)
            || /(?:^|\n\n)Write failed[^\n]*after modification began/.test(result);
    }));
}
