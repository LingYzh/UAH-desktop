import { randomUUID } from 'node:crypto';
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { assertPlainDirectory } from './journal-artifacts';
import { parseJournalPolicyCommand, type JournalPolicy, type JournalPolicyCommand } from '../shared/journal-policy';

/** Single runtime-owned policy. Each request snapshots it at attempt creation. */
export class JournalPolicyStore {
    private readonly directory: string;
    private readonly file: string;
    private readonly marker: string;
    private policy: JournalPolicy;
    private persisted = false;
    constructor(directory: string) {
        this.directory = resolve(directory); assertPlainDirectory(this.directory);
        this.file = join(this.directory, 'journal-policy.json');
        this.marker = join(this.directory, 'journal-policy.initialized');
        try {
            const stat = lstatSync(this.marker);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 1 || readFileSync(this.marker, 'utf8') !== '1') throw new Error('日志设置初始化记录无效。');
            this.persisted = true;
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
        this.policy = this.read();
        if (this.persisted) this.ensureInitialized();
    }
    private ensureInitialized(): void {
        assertPlainDirectory(this.directory);
        try {
            const fd = openSync(this.marker, 'wx', 0o600);
            try { writeFileSync(fd, '1', 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const stat = lstatSync(this.marker);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 1 || readFileSync(this.marker, 'utf8') !== '1') throw new Error('日志设置初始化记录无效。');
        }
        this.persisted = true;
    }
    private read(): JournalPolicy {
        assertPlainDirectory(this.directory);
        try {
            const stat = lstatSync(this.file);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 4096) throw new Error('日志设置文件不安全或过大。');
            const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(readFileSync(this.file)));
            if (value?.schemaVersion !== 1 || Object.keys(value).length !== 3) throw new Error('日志设置版本无效。');
            const command = parseJournalPolicyCommand({ action: 'set', revision: value.revision, captureRaw: value.captureRaw });
            if (command.action !== 'set') throw new Error('日志设置无效。');
            this.persisted = true;
            return { revision: command.revision, captureRaw: command.captureRaw };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !this.persisted) return { revision: 0, captureRaw: true };
            throw error;
        }
    }
    get(): JournalPolicy { this.policy = this.read(); return { ...this.policy }; }
    execute(value: JournalPolicyCommand): JournalPolicy {
        const command = parseJournalPolicyCommand(value);
        if (command.action === 'get') return this.get();
        const disk = this.read();
        if (command.revision !== this.policy.revision || disk.revision !== this.policy.revision || disk.captureRaw !== this.policy.captureRaw) throw new Error('日志设置已变化，请刷新后再保存。');
        if (this.policy.revision >= Number.MAX_SAFE_INTEGER) throw new Error('日志设置版本已达上限。');
        const next = { revision: this.policy.revision + 1, captureRaw: command.captureRaw };
        const temporary = this.file + '.' + randomUUID() + '.tmp';
        const fd = openSync(temporary, 'wx', 0o600);
        try { writeFileSync(fd, JSON.stringify({ schemaVersion: 1, ...next }), 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
        // Persist the initialization witness first: a missing policy must not silently re-enable capture after restart.
        this.ensureInitialized();
        // Rename is the policy commit boundary. A first-save crash fails closed until repaired.
        assertPlainDirectory(this.directory); renameSync(temporary, this.file);
        this.policy = next;
        this.persisted = true;
        return this.get();
    }
}
