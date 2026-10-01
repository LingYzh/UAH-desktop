import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { backup, DatabaseSync } from 'node:sqlite';
import { assertPlainDirectory } from './journal-artifacts';

/** Startup-only, before opening runtime writers. Never automatically restores.
 * SQLite's backup API includes committed WAL pages and preserves implicit rowids. */
export async function prepareRuntimeUpgrade(directory: string, supportedVersion: number,
    onProgress: () => void = () => {}): Promise<{ path: string; schemaVersion: number } | null> {
    if (!Number.isSafeInteger(supportedVersion) || supportedVersion < 1) throw new Error('Invalid supported schema version');
    const root = resolve(directory);
    const file = join(root, 'runtime.sqlite');
    try { lstatSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
    assertPlainDirectory(root);
    const plainFile = (path: string) => {
        const stat = lstatSync(path);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe runtime backup file');
        return stat;
    };
    plainFile(file);
    const source = new DatabaseSync(file, { readOnly: true });
    try {
        const version = Number(source.prepare('PRAGMA user_version').get()!.user_version);
        if (version > supportedVersion) throw new Error(`Runtime database schema ${version} is newer than supported schema ${supportedVersion}`);
        if (version === supportedVersion) return null;
        if (version === 0) {
            if (Number(source.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get()!.count)) throw new Error('Unversioned nonempty runtime database requires manual migration');
            return null;
        }
        const backupDirectory = join(root, 'upgrade-backups');
        assertPlainDirectory(backupDirectory);
        const destination = join(backupDirectory, `runtime-v${version}-${randomUUID()}.sqlite`);
        const temporary = destination + '.pending';
        const reserve = openSync(temporary, 'wx', 0o600);
        closeSync(reserve);
        const reserved = plainFile(temporary);
        onProgress();
        // A failed or interrupted backup remains .pending, never presented as a
        // usable backup. The source is untouched and startup stops on failure.
        await backup(source, temporary, { rate: 256, progress: onProgress });
        assertPlainDirectory(backupDirectory);
        const written = plainFile(temporary);
        if (written.dev !== reserved.dev || written.ino !== reserved.ino) throw new Error('Backup destination identity changed');
        const copy = new DatabaseSync(temporary);
        try {
            // A WAL-mode source carries that mode into the backup. Normalize only
            // our owned stage so the published backup is a self-contained file.
            copy.exec('PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL;');
            if (Number(copy.prepare('PRAGMA user_version').get()!.user_version) !== version
                || copy.prepare('PRAGMA quick_check').get()!.quick_check !== 'ok') throw new Error('Upgrade backup verification failed');
        } finally { copy.close(); }
        const fd = openSync(temporary, 'r+');
        try { fsyncSync(fd); } finally { closeSync(fd); }
        assertPlainDirectory(backupDirectory);
        plainFile(temporary);
        renameSync(temporary, destination);
        onProgress();
        return { path: destination, schemaVersion: version };
    } finally { source.close(); }
}
