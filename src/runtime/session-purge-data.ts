import type { DatabaseSync } from 'node:sqlite';

/** Erase only the named session inside the caller's transaction, including old backups. */
export function eraseSessionRows(db: DatabaseSync, sessionId: string): void {
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('Invalid session identity');
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => String(row.name)));
    for (const table of ['request_contexts', 'approvals'] as const) {
        if (tables.has(table) && tables.has('runs')) {
            db.prepare(`DELETE FROM ${table} WHERE run_id IN (SELECT id FROM runs WHERE session_id = ?)`).run(sessionId);
        }
    }
    for (const table of ['artifacts', 'events', 'canonical_events', 'journal_exports', 'runs'] as const) {
        if (tables.has(table)) db.prepare(`DELETE FROM ${table} WHERE session_id = ?`).run(sessionId);
    }
    if (tables.has('sessions')) db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}
