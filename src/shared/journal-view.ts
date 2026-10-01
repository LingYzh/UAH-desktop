export type JournalQuery =
    | { action: 'purge-review'; sessionId: string }
    | { action: 'purge-confirm'; sessionId: string; fingerprint: string; confirmation: '永久删除' }
    | { action: 'purge-retry'; sessionId: string }
    | { action: 'cleanup-review'; sessionId: string }
    | { action: 'cleanup-confirm'; sessionId: string; fingerprint: string }
    | { action: 'verification'; sessionId: string; runId: string }
    | { action: 'recovery'; sessionId: string; runId: string }
    | { action: 'summary'; sessionId: string }
    | { action: 'request'; sessionId: string; requestId: string; attemptId?: string }
    | { action: 'open'; sessionId: string }
    | { action: 'export'; sessionId: string; mode: 'full' | 'share' };

export type JournalViewQuery = Extract<JournalQuery, { action: 'summary' | 'request' | 'recovery' | 'verification' | 'cleanup-review' | 'cleanup-confirm' | 'purge-review' }>;
export interface JournalSummary {
    sessionId: string;
    health: { status: 'healthy' | 'degraded' | 'failed'; durableSeq: number; exportedSeq: number; error?: string };
    coverage: 'complete' | 'partial' | 'legacy_partial';
    requests: Array<{ requestId: string; attemptId: string; runId: string; timestamp: string; status: string; inputTokens: number | null; outputTokens: number | null }>;
    nextAfter?: number;
    truncated?: boolean;
}
export interface JournalRequestDetail { requestId: string; attemptId: string; snapshot: unknown; events: unknown[] }
export interface JournalExportResult { destination: string; partial: boolean; targetSeq: number; mode: 'full' | 'share' }

const identity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(value);
function plainFields(value: unknown): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new TypeError('无效的日志查询。');
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !('value' in Object.getOwnPropertyDescriptor(value, key)!)) throw new TypeError('无效的日志查询。');
    }
    return value as Record<string, unknown>;
}
export function parseJournalQuery(value: unknown): JournalQuery {
    const query = plainFields(value);
    const allowed = query.action === 'purge-confirm' ? ['action', 'sessionId', 'fingerprint', 'confirmation'] : query.action === 'cleanup-confirm' ? ['action', 'sessionId', 'fingerprint'] : query.action === 'recovery' || query.action === 'verification' ? ['action', 'sessionId', 'runId'] : ['summary', 'open', 'cleanup-review', 'purge-review', 'purge-retry'].includes(String(query.action)) ? ['action', 'sessionId'] : query.action === 'request' ? ['action', 'sessionId', 'requestId', ...(Object.hasOwn(query, 'attemptId') ? ['attemptId'] : [])] : query.action === 'export' ? ['action', 'sessionId', 'mode'] : [];
    if (!allowed.length || Reflect.ownKeys(query).length !== allowed.length || allowed.some(key => !Object.hasOwn(query, key)) || Reflect.ownKeys(query).some(key => !allowed.includes(key as string)) || !identity(query.sessionId)) throw new TypeError('无效的日志查询。');
    if (query.action === 'request' && !identity(query.requestId)) throw new TypeError('无效的请求身份。');
    if ((query.action === 'recovery' || query.action === 'verification') && !identity(query.runId)) throw new TypeError('无效的核对身份。');
    if (query.action === 'request' && Object.hasOwn(query, 'attemptId') && !identity(query.attemptId)) throw new TypeError('无效的尝试身份。');
    if (query.action === 'export' && query.mode !== 'full' && query.mode !== 'share') throw new TypeError('无效的日志导出模式。');
    if (query.action === 'cleanup-confirm' && (typeof query.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(query.fingerprint))) throw new TypeError('无效的清理确认。');
    if (query.action === 'purge-confirm' && (query.confirmation !== '永久删除' || typeof query.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(query.fingerprint))) throw new TypeError('无效的删除确认。');
    return { ...query } as JournalQuery;
}
export function parseJournalSessionQuery(value: unknown): { sessionId: string } {
    const query = plainFields(value);
    if (Reflect.ownKeys(query).length !== 1 || !Object.hasOwn(query, 'sessionId') || !identity(query.sessionId)) throw new TypeError('无效的日志会话身份。');
    return { sessionId: query.sessionId };
}
