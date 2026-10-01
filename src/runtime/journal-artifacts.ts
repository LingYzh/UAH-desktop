import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, lstatSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, parse, relative, isAbsolute } from 'node:path';
import type { ArtifactReference, JsonValue } from '../shared/harness-contracts';

export function assertPlainDirectory(directory: string): void {
    const absolute = resolve(directory);
    let cursor = parse(absolute).root;
    for (const part of relative(cursor, absolute).split(/[\\/]/).filter(Boolean)) {
        cursor = join(cursor, part);
        try { const stat = lstatSync(cursor); if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe journal directory'); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; mkdirSync(cursor); }
    }
}

export function redactJournalValue(value: unknown, secrets: readonly string[] = []): { value: JsonValue; changed: boolean } {
    let changed = false;
    const redactText = (text: string) => {
        let result = text;
        for (const secret of secrets.filter(Boolean)) result = result.split(secret).join('[REDACTED]');
        result = result.replace(/https?:\/\/[^\s"<>]+/g, raw => {
            try {
                const url = new URL(raw);
                let modified = false;
                if (url.username || url.password) { url.username = ''; url.password = ''; modified = true; }
                for (const key of [...url.searchParams.keys()]) if (/^(token|key|api_key|access_token|password|secret)$/i.test(key)) { url.searchParams.set(key, '[REDACTED]'); modified = true; }
                return modified ? url.href : raw;
            } catch { return raw; }
        });
        if (result !== text) changed = true;
        return result;
    };
    const visit = (input: unknown): JsonValue => {
        if (input === null || typeof input === 'boolean') return input;
        if (typeof input === 'number') { if (!Number.isFinite(input)) throw new Error('Non-JSON journal value'); return input; }
        if (typeof input === 'string') return redactText(input);
        if (Array.isArray(input)) return input.map(visit);
        if (!input || typeof input !== 'object') throw new Error('Non-JSON journal value');
        return Object.fromEntries(Object.entries(input).filter(([, item]) => item !== undefined).map(([key, item]) => {
            if (/^(authorization|proxy-authorization|x-api-key|api[_-]?key|cookie|set-cookie|access_token|refresh_token|password)$/i.test(key)) {
                changed = true; return [key, '[REDACTED]'];
            }
            return [key, visit(item)];
        }));
    };
    return { value: visit(value), changed };
}

/** Artifacts are synced before any journal transaction refers to them. */
export class JournalArtifacts {
    constructor(private readonly directory: string) { assertPlainDirectory(directory); }
    save(value: unknown, secrets: readonly string[] = [], restricted = false): { ref: ArtifactReference; redacted: boolean } {
        const result = redactJournalValue(value, secrets);
        const bytes = Buffer.from(JSON.stringify(result.value), 'utf8');
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const relativePath = `${restricted ? 'restricted' : 'artifacts'}/${sha256}.json`;
        const target = join(this.directory, relativePath);
        assertPlainDirectory(dirname(target));
        try {
            const stat = lstatSync(target);
            if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || !readFileSync(target).equals(bytes)) throw new Error('Journal artifact integrity mismatch');
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            const temporary = target + '.' + randomUUID() + '.tmp';
            const fd = openSync(temporary, 'wx');
            try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
            try { renameSync(temporary, target); } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
        }
        return { ref: { availability: 'present', relativePath, sha256, byteLength: bytes.length,
            mediaType: restricted ? 'application/vnd.uah.restricted+json' : 'application/json', missingReason: null }, redacted: result.changed };
    }
    saveBytes(bytes: Buffer, mediaType = 'application/octet-stream'): ArtifactReference {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const relativePath = `artifacts/${sha256}.bin`;
        const target = join(this.directory, relativePath);
        assertPlainDirectory(dirname(target));
        try {
            const fd = openSync(target, 'wx');
            try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
            const stat = lstatSync(target);
            if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !readFileSync(target).equals(bytes)) throw new Error('Artifact integrity mismatch');
        }
        return { availability: 'present', relativePath, sha256, byteLength: bytes.length, mediaType, missingReason: null };
    }
    read(ref: ArtifactReference): Buffer {
        if (ref.availability !== 'present') throw new Error('Artifact is not available offline');
        const target = resolve(this.directory, ref.relativePath);
        const rel = relative(resolve(this.directory), target);
        if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('Invalid artifact path');
        assertPlainDirectory(dirname(target));
        const stat = lstatSync(target);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe artifact');
        const bytes = readFileSync(target);
        if (bytes.length !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== ref.sha256) throw new Error('Artifact integrity mismatch');
        return bytes;
    }
}
