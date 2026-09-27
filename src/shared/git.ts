export interface GitQuery {
    directory: string | null;
    kind: 'status' | 'diff' | 'log';
    staged?: boolean;
    path?: string;
}

export interface GitSnapshot {
    state: 'ready' | 'no-directory' | 'not-repository' | 'unavailable' | 'error';
    directory: string | null;
    root?: string;
    branch?: string;
    head?: string;
    upstream?: string;
    ahead?: number;
    behind?: number;
    files: Array<{ path: string; originalPath?: string; indexStatus: string; worktreeStatus: string; untracked: boolean }>;
    truncated: boolean;
    capturedAt: string;
    message?: string;
}

export interface GitResult {
    snapshot: GitSnapshot;
    diff?: string;
    commits?: Array<{ hash: string; shortHash: string; date: string; subject: string }>;
    truncated?: boolean;
}

/** Pure validation; directory authorization and filesystem containment belong to the host. */
export function parseGitQuery(value: unknown): GitQuery {
    const invalid = () => { throw new Error('Git 查询参数无效。'); };
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid();
    const keys = Reflect.ownKeys(value);
    if (keys.some(key => typeof key !== 'string' || !['directory', 'kind', 'staged', 'path'].includes(key)
        || !('value' in Object.getOwnPropertyDescriptor(value, key)!))) return invalid();
    const source = value as Record<string, unknown>;
    if (!Object.hasOwn(source, 'directory') || !Object.hasOwn(source, 'kind')
        || (source.directory !== null && (typeof source.directory !== 'string' || !source.directory.length
            || source.directory.length > 4096 || /[\x00-\x1f\x7f]/.test(source.directory)
            || !/^(?:[a-z]:[\\/]|\\\\[^\\]+\\|\/)/i.test(source.directory)))
        || typeof source.kind !== 'string' || !['status', 'diff', 'log'].includes(source.kind)
        || (Object.hasOwn(source, 'staged') && typeof source.staged !== 'boolean')) return invalid();
    if (Object.hasOwn(source, 'path') && (typeof source.path !== 'string' || !source.path.length
        || source.path.length > 4096 || /[\x00-\x1f\x7f:]/.test(source.path)
        || /^[\\/]/.test(source.path) || source.path.split(/[\\/]/).some(part => part === '..'))) return invalid();
    return { directory: source.directory as string | null, kind: source.kind as GitQuery['kind'],
        ...(Object.hasOwn(source, 'staged') ? { staged: source.staged as boolean } : {}),
        ...(Object.hasOwn(source, 'path') ? { path: source.path as string } : {}) };
}
