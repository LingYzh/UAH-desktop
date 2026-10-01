import type { RunState } from './contracts';

export interface SnapshotView { sessionId: string | null; turnLimit?: number }
export interface HistoryWindow { total: number; limit: number; rootIds: string[]; hasFileChanges: boolean }
export interface WorkspaceOverview {
    rootStates: Record<string, { id: string; state: RunState }>;
    latestStates: Record<string, { id: string; state: RunState }>;
    activeRunIds: string[];
}

export function parseSnapshotView(value: unknown): SnapshotView | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
        || Reflect.ownKeys(value).some(key => key !== 'sessionId' && key !== 'turnLimit') || !Object.hasOwn(value, 'sessionId')) throw new TypeError('无效的会话视图。');
    const property = Object.getOwnPropertyDescriptor(value, 'sessionId')!;
    if (!('value' in property) || !property.enumerable) throw new TypeError('无效的会话视图。');
    const sessionId = property.value;
    if (sessionId !== null && (typeof sessionId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId))) throw new TypeError('无效的会话视图身份。');
    if (!Object.hasOwn(value, 'turnLimit')) return { sessionId };
    const limit = Object.getOwnPropertyDescriptor(value, 'turnLimit')!;
    if (!('value' in limit) || !limit.enumerable || sessionId === null || !Number.isSafeInteger(limit.value)
        || limit.value < 1 || limit.value > 100000) throw new TypeError('无效的历史窗口。');
    return { sessionId, turnLimit: limit.value };
}
