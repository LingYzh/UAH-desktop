import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import type { ResourceVersion } from '../shared/harness-contracts.js';
import { canonicalizeDirectory, sameDirectory } from './paths.js';

export interface RecoveryResourceEvidence {
    uri: string;
    hashKind: 'raw_bytes' | 'utf8_text';
    expectedHash: string | null;
    actualHash: string | null;
    status: 'matched' | 'changed' | 'missing' | 'unverifiable';
    detail: string;
}

const MAX_BYTES = 16 * 1024 * 1024;
class EvidenceFailure extends Error {}
function deny(detail: string): never { throw new EvidenceFailure(detail); }
function sameIdentity(a: BigIntStats, b: BigIntStats): boolean {
    return a.dev === b.dev && a.ino === b.ino && a.birthtimeNs === b.birthtimeNs;
}
function regularFile(info: BigIntStats): void {
    if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1n) deny('Only ordinary files without symbolic or hard links can be verified.');
    if (info.ino === 0n) deny('File identity is unavailable.');
    if (info.size > BigInt(MAX_BYTES)) deny('File exceeds the 16 MiB verification limit.');
}
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
    return sameIdentity(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function targetPath(uri: string, root: string): string {
    if (typeof uri !== 'string' || uri.length > 32_000 || uri.includes('?') || uri.includes('#') || uri.trim() !== uri) deny('Only plain local file URIs can be verified.');
    let url: URL;
    try { url = new URL(uri); } catch { deny('Resource URI is invalid.'); }
    if (url.protocol !== 'file:' || url.username || url.password || url.host) deny('Only plain local file URIs can be verified.');
    let target: string;
    try { target = fileURLToPath(url); } catch { deny('Resource file URI is invalid.'); }
    if (target.includes('\0') || !path.isAbsolute(target)) deny('Resource path is invalid.');
    // Reject alternate streams, device names and ambiguous Windows path spellings.
    if (process.platform === 'win32') {
        if (!/^[a-z]:[\\/]/i.test(target)) deny('Resource path is not a local drive path.');
        const parts = target.slice(3).split(/[\\/]/);
        if (parts.some(part => /[<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) deny('Resource path contains an unsafe Windows name.');
    }
    target = path.resolve(target);
    const relative = path.relative(root, target);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) deny('Resource is outside the approved directory or is not a file.');
    return target;
}

interface Component { filename: string; info: BigIntStats }
async function inspectComponents(target: string): Promise<Component[]> {
    const parsed = path.parse(target);
    const parts = target.slice(parsed.root.length).split(path.sep).filter(Boolean);
    const result: Component[] = [];
    let filename = parsed.root;
    for (let index = 0; index <= parts.length; index++) {
        if (index > 0) filename = path.join(filename, parts[index - 1]);
        const info = await lstat(filename, { bigint: true });
        if (info.isSymbolicLink()) deny('Path crosses a symbolic link or reparse point.');
        if (index < parts.length && !info.isDirectory()) deny('A parent path is not an ordinary directory.');
        if (info.ino === 0n) deny('Path identity is unavailable.');
        result.push({ filename, info });
    }
    return result;
}

/** Host-side, read-only evidence check. Revalidation reduces ordinary races; it is not an OS sandbox. */
export async function inspectRecoveryResources(directory: string | null, resources: ResourceVersion[]): Promise<RecoveryResourceEvidence[]> {
    const latest = new Map<string, ResourceVersion>();
    for (const resource of resources) latest.set(resource.uri, { ...resource });
    let root: string | null = null;
    try {
        if (directory && path.isAbsolute(directory)) {
            const canonical = canonicalizeDirectory(directory);
            if (sameDirectory(directory, canonical)) root = canonical;
        }
    } catch { /* Fail closed without exposing host paths or diagnostics. */ }
    const results: RecoveryResourceEvidence[] = [];
    for (const resource of latest.values()) {
        const suppliedKind = resource.hashKind ?? 'utf8_text';
        const hashKind = suppliedKind === 'raw_bytes' ? 'raw_bytes' : 'utf8_text';
        const expectedHash = resource.afterHash ?? null;
        const evidence: RecoveryResourceEvidence = { uri: resource.uri, hashKind, expectedHash, actualHash: null, status: 'unverifiable', detail: '' };
        let initialInspection = false;
        let rootIdentity: BigIntStats | null = null;
        try {
            if (!root) deny('An available canonical approved directory is required.');
            if (suppliedKind !== 'raw_bytes' && suppliedKind !== 'utf8_text') deny('Resource hash kind is unsupported.');
            if (typeof expectedHash !== 'string' || !/^[a-f0-9]{64}$/i.test(expectedHash)) deny('Current resource hash is unknown or invalid.');
            const target = targetPath(resource.uri, root);
            if (!sameDirectory(canonicalizeDirectory(directory!), root)) deny('Approved directory changed.');
            rootIdentity = await lstat(root, { bigint: true });
            if (!rootIdentity.isDirectory() || rootIdentity.isSymbolicLink() || rootIdentity.ino === 0n) deny('Approved directory identity is unavailable.');
            initialInspection = true;
            const components = await inspectComponents(target);
            initialInspection = false;
            const approvedComponent = components.find(item => sameDirectory(item.filename, root));
            if (!approvedComponent || !sameIdentity(rootIdentity, approvedComponent.info)) deny('Approved directory identity changed.');
            const before = components[components.length - 1].info;
            regularFile(before);
            if (!sameDirectory(await realpath(target), target)) deny('Resource path is not canonical.');
            const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
            let bytes: Buffer;
            try {
                const opened = await handle.stat({ bigint: true });
                regularFile(opened);
                if (!sameFile(before, opened)) deny('Resource changed before reading.');
                const buffer = Buffer.alloc(Number(opened.size) + 1);
                let length = 0;
                while (length < buffer.length) {
                    const read = await handle.read(buffer, length, buffer.length - length, length);
                    if (read.bytesRead === 0) break;
                    length += read.bytesRead;
                }
                const after = await handle.stat({ bigint: true });
                regularFile(after);
                if (length !== Number(opened.size) || !sameFile(opened, after)) deny('Resource changed while reading.');
                bytes = buffer.subarray(0, length);
                const current = await inspectComponents(target);
                if (current.length !== components.length || current.some((item, index) => !sameIdentity(item.info, components[index].info))) deny('Resource path identity changed while reading.');
                regularFile(current[current.length - 1].info);
                if (!sameFile(after, current[current.length - 1].info) || !sameDirectory(await realpath(target), target) || !sameDirectory(canonicalizeDirectory(directory!), root)) deny('Resource path changed while reading.');
            } finally { await handle.close(); }
            let value: Buffer | string = bytes;
            if (hashKind === 'utf8_text') {
                // Match read_file: strict UTF-8 and remove exactly one leading BOM.
                try { value = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { deny('Resource is not valid UTF-8 text.'); }
            }
            evidence.actualHash = createHash('sha256').update(value).digest('hex');
            evidence.status = evidence.actualHash === expectedHash.toLowerCase() ? 'matched' : 'changed';
            evidence.detail = evidence.status === 'matched' ? 'Current file hash matches recorded evidence.' : 'Current file hash differs from recorded evidence.';
        } catch (error) {
            if (initialInspection && (error as NodeJS.ErrnoException)?.code === 'ENOENT') {
                // A second path inspection must still prove absence beneath the approved root.
                // If a parent becomes a link or the file reappears, absence is unproven.
                evidence.detail = 'Resource absence could not be safely verified.';
                let approved = false;
                try {
                    approved = root !== null && rootIdentity !== null && sameDirectory(canonicalizeDirectory(directory!), root)
                        && sameIdentity(rootIdentity, await lstat(root, { bigint: true }));
                } catch { /* A missing approved root cannot prove resource absence. */ }
                if (approved) {
                    try {
                        await inspectComponents(targetPath(resource.uri, root!));
                        evidence.detail = 'Resource changed during verification.';
                    } catch (confirmation) {
                        if ((confirmation as NodeJS.ErrnoException)?.code === 'ENOENT') {
                            evidence.status = 'missing'; evidence.detail = 'Recorded file is missing.';
                        }
                    }
                }
            } else evidence.detail = error instanceof EvidenceFailure ? error.message : 'Resource could not be safely verified.';
        }
        results.push(evidence);
    }
    return results;
}
