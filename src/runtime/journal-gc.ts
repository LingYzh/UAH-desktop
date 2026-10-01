import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { assertPlainDirectory } from './journal-artifacts';
import { retainedArtifactPaths } from './transcript-offline';
import type { JournalCleanupReview, JournalCleanupResult } from '../shared/journal-maintenance';

const MINIMUM_AGE_HOURS = 24;
const MAX_FILES = 10_000;
const MAX_BYTES = 256 * 1024 * 1024;
interface Candidate { relativePath: string; byteLength: number; identity: string }
function identity(path: string): string {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('清理候选不是独占的普通文件。');
    return JSON.stringify([stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs]);
}
function inspect(directory: string, sessionId: string, now: number, additionalRoots: unknown): { review: JournalCleanupReview; candidates: Candidate[] } {
    assertPlainDirectory(directory);
    const retained = new Set(retainedArtifactPaths(directory));
    // Display-only references must already be in the validated canonical closure;
    // otherwise we cannot prove their nested dependencies safe to collect.
    const stack = [additionalRoots];
    while (stack.length) {
        const item = stack.pop();
        if (typeof item === 'string' && /^(artifacts|restricted|segments)\//.test(item) && !retained.has(item)) {
            throw new Error('显示投影存在未纳入权威日志的引用，不能执行清理。');
        }
        else if (item && typeof item === 'object') stack.push(...Object.values(item));
    }
    const candidates: Candidate[] = [];
    let count = 0; let bytes = 0;
    for (const folder of ['artifacts', 'restricted', 'segments']) {
        const parent = join(directory, folder);
        try { lstatSync(parent); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
        assertPlainDirectory(parent);
        for (const name of readdirSync(parent).sort()) {
            if (++count > MAX_FILES) throw new Error('清理检查超过文件数量上限。');
            // Unknown files and temporary files are never inferred to be disposable.
            const match = folder === 'segments' ? /^[1-9]\d*-[1-9]\d*-([a-f0-9]{64})\.jsonl$/.exec(name)
                : /^([a-f0-9]{64})\.(json|bin)$/.exec(name);
            if (!match) continue;
            const relativePath = `${folder}/${name}`;
            if (retained.has(relativePath)) continue;
            const path = join(parent, name);
            const before = identity(path); const stat = lstatSync(path);
            if (now - Math.max(stat.mtimeMs, stat.birthtimeMs) < MINIMUM_AGE_HOURS * 3_600_000) continue;
            if ((bytes += stat.size) > MAX_BYTES) throw new Error('清理检查超过文件字节上限。');
            const content = readFileSync(path);
            if (content.length !== stat.size || identity(path) !== before
                || createHash('sha256').update(content).digest('hex') !== match[1]) throw new Error('清理候选内容或身份已变化。');
            candidates.push({ relativePath, byteLength: stat.size, identity: before });
        }
    }
    const fingerprint = createHash('sha256').update(JSON.stringify({ sessionId,
        manifest: readFileSync(join(directory, 'manifest.json'), 'utf8'), retained: [...retained].sort(), candidates })).digest('hex');
    return { review: { sessionId, fingerprint, files: candidates.map(({ relativePath, byteLength }) => ({ relativePath, byteLength })),
        bytes, minimumAgeHours: MINIMUM_AGE_HOURS }, candidates };
}

/** Called synchronously by the owning runtime with no active execution or export. */
export function reviewJournalCleanup(directory: string, sessionId: string, roots: unknown, now = Date.now()): JournalCleanupReview {
    return inspect(directory, sessionId, now, roots).review;
}
export function collectJournalOrphans(directory: string, sessionId: string, roots: unknown, fingerprint: string, now = Date.now()): JournalCleanupResult {
    const current = inspect(directory, sessionId, now, roots);
    if (current.review.fingerprint !== fingerprint) throw new Error('日志或清理候选已变化，请重新检查后确认。');
    let removedFiles = 0; let removedBytes = 0;
    for (const candidate of current.candidates) {
        try {
            const parent = join(directory, candidate.relativePath.split('/')[0]);
            assertPlainDirectory(parent);
            const path = join(directory, candidate.relativePath);
            if (identity(path) !== candidate.identity) throw new Error('清理候选身份已变化。');
            unlinkSync(path); removedFiles++; removedBytes += candidate.byteLength;
        } catch (error) {
            return { removedFiles, removedBytes, remainingFiles: current.candidates.length - removedFiles,
                error: error instanceof Error ? error.message : String(error) };
        }
    }
    return { removedFiles, removedBytes, remainingFiles: 0 };
}
