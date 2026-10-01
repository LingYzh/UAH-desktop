import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { isAbsolute, join, parse, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { eraseSessionRows } from './session-purge-data';

interface OwnedFile { path: string; dev: number; ino: number; bytes: number; sha256: string }
interface OwnedBackup { path: string; dev: number; ino: number; bytes: number; modified: number }
export interface SessionPurgeIntent {
    version: 1;
    sessionId: string;
    executionIds: string[];
    files: OwnedFile[];
    directories: string[];
    backups: OwnedBackup[];
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const backupName = /^upgrade-backups\/runtime-v[1-3]-[a-f0-9-]{36}\.sqlite$/;
const pendingName = /^upgrade-backups\/runtime-v[1-3]-[a-f0-9-]{36}\.sqlite\.pending(?:-wal|-shm)?$/;
function namespaces(sessionId: string, executionIds: string[]): string[] {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(sessionId) || executionIds.length > 10_000 || executionIds.some(id => !uuid.test(id))) throw new Error('Invalid purge ownership');
    return [`sessions/${createHash('sha256').update(JSON.stringify(sessionId)).digest('hex')}`, `plans/${sessionId}`, ...executionIds.map(id => `executions/${id}`)];
}
function exists(path: string): boolean {
    try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function safePath(root: string, name: string): string {
    if (!name || name.includes('\\') || name.includes(':') || name.split('/').some(part => !part || part === '..' || part === '.')) throw new Error('Unsafe purge path');
    const target = resolve(root, name), rel = relative(resolve(root), target);
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Purge path is outside owned directory');
    let cursor = parse(target).root;
    for (const part of relative(cursor, target).split(/[\\/]/)) {
        cursor = join(cursor, part);
        if (!exists(cursor)) break;
        const stat = lstatSync(cursor);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1))) throw new Error('Purge path contains a link or unsupported object');
    }
    return target;
}
function hashFile(path: string): string {
    const hash = createHash('sha256'), bytes = Buffer.allocUnsafe(64 * 1024), fd = openSync(path, 'r');
    try { let count: number; while ((count = readSync(fd, bytes, 0, bytes.length, null))) hash.update(bytes.subarray(0, count)); }
    finally { closeSync(fd); }
    return hash.digest('hex');
}
export function prepareSessionPurgeFiles(root: string, sessionId: string, executionIds: string[]): SessionPurgeIntent {
    const intent: SessionPurgeIntent = { version: 1, sessionId, executionIds: [...new Set(executionIds)].sort(), files: [], directories: [], backups: [] };
    let inspectedBytes = 0;
    const visit = (name: string, depth = 0) => {
        const path = safePath(root, name);
        if (!exists(path)) return;
        if (depth > 16 || intent.files.length + intent.directories.length >= 50_000) throw new Error('Purge inspection limit reached');
        const stat = lstatSync(path);
        if (stat.isDirectory()) {
            intent.directories.push(name);
            for (const child of readdirSync(path).sort()) visit(`${name}/${child}`, depth + 1);
        } else {
            if ((inspectedBytes += stat.size) > 2 * 1024 ** 3) throw new Error('Purge files exceed inspection limit');
            const sha256 = hashFile(path), after = lstatSync(path);
            if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('Purge file changed during inspection');
            intent.files.push({ path: name, dev: stat.dev, ino: stat.ino, bytes: stat.size, sha256 });
        }
    };
    for (const name of namespaces(sessionId, intent.executionIds)) visit(name);
    const backupDirectory = safePath(root, 'upgrade-backups');
    if (exists(backupDirectory)) for (const name of readdirSync(backupDirectory).sort()) {
        const relativePath = `upgrade-backups/${name}`;
        if (pendingName.test(relativePath)) visit(relativePath);
        else if (backupName.test(relativePath)) {
            const path = safePath(root, relativePath), stat = lstatSync(path);
            if (!stat.isFile()) throw new Error('Invalid owned upgrade backup');
            intent.backups.push({ path: relativePath, dev: stat.dev, ino: stat.ino, bytes: stat.size, modified: stat.mtimeMs });
        }
    }
    return intent;
}
export function purgeFilesFingerprint(intent: SessionPurgeIntent): string {
    return createHash('sha256').update(JSON.stringify(intent)).digest('hex');
}
/** Idempotent finishing step after the logical deletion and intent commit.
 * Only application-owned namespaces are allowed, even when persisted input is corrupt. */
export function finishSessionPurgeFiles(root: string, intent: SessionPurgeIntent): void {
    if (intent.version !== 1 || !Array.isArray(intent.executionIds) || !Array.isArray(intent.files) || !Array.isArray(intent.directories) || !Array.isArray(intent.backups)
        || intent.files.length + intent.directories.length > 50_000 || intent.backups.length > 100) throw new Error('Invalid purge intent');
    const roots = namespaces(intent.sessionId, intent.executionIds);
    const owned = (name: string) => roots.some(base => name === base || name.startsWith(base + '/'));
    for (const item of intent.files) if (typeof item.path !== 'string' || (!owned(item.path) && !pendingName.test(item.path)) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid purge file ownership');
    for (const name of intent.directories) if (typeof name !== 'string' || !owned(name)) throw new Error('Invalid purge directory ownership');
    for (const item of intent.backups) {
        if (!backupName.test(item.path)) throw new Error('Invalid purge backup ownership');
        const path = safePath(root, item.path);
        if (!exists(path)) continue;
        const stat = lstatSync(path);
        if (stat.dev !== item.dev || stat.ino !== item.ino || !stat.isFile()) throw new Error('Upgrade backup identity changed');
        for (const suffix of ['-wal', '-shm', '-journal']) safePath(root, item.path + suffix);
        const db = new DatabaseSync(path);
        try {
            const version = Number(db.prepare('PRAGMA user_version').get()!.user_version);
            if (![1, 2, 3].includes(version) || db.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Cannot purge an unsupported or damaged backup');
            db.exec('PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; BEGIN IMMEDIATE;');
            try { eraseSessionRows(db, intent.sessionId); db.exec('COMMIT;'); }
            catch (error) { db.exec('ROLLBACK;'); throw error; }
            const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
            if (Number(checkpoint?.busy) !== 0) throw new Error('Backup WAL checkpoint is busy');
        } finally { db.close(); }
    }
    for (const item of intent.files) {
        const path = safePath(root, item.path);
        if (!exists(path)) continue;
        const stat = lstatSync(path);
        if (stat.dev !== item.dev || stat.ino !== item.ino || stat.size !== item.bytes || hashFile(path) !== item.sha256) throw new Error('Owned purge file changed; cleanup remains pending');
        unlinkSync(path);
    }
    for (const name of [...intent.directories].sort((a, b) => b.length - a.length)) {
        const path = safePath(root, name);
        if (exists(path)) rmdirSync(path); // Never recursively delete newly appeared files.
    }
}
