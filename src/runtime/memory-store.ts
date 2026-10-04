import { createHash, randomUUID } from 'node:crypto';
import {
    closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
    readSync, realpathSync, readdirSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import type {
    MemoryDocument, MemoryEntry, MemoryIndexSnapshot, MemoryKind, MemoryListResult,
    MemoryScope, MemorySnapshot, MemorySource, MemoryStatus, MemoryWrite,
} from '../shared/memory';

const FORMAT_VERSION = 1 as const;
const MAX_RECORD_BYTES = 64 * 1024;
const MAX_INDEX_BYTES = 2 * 1024 * 1024;
const MAX_INDEX_CHARS = 32 * 1024;
const MAX_INDEX_CONTENT_CHARS = 4000;
const MAX_LIST_ITEMS = 200;
const MAX_SCOPE_SCAN_ITEMS = 5000;
const START_MARKER = '<!-- UAH_MEMORY_INDEX:START -->';
const END_MARKER = '<!-- UAH_MEMORY_INDEX:END -->';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

interface MemoryMetadata {
    formatVersion: typeof FORMAT_VERSION;
    id: string;
    title: string;
    scope: MemoryScope;
    kind: MemoryKind;
    status: MemoryStatus;
    pinned: boolean;
    createdAt: string;
    updatedAt: string;
    source: MemorySource;
    contentDigest: string;
}

interface ParsedRecord { metadata: MemoryMetadata; body: string; bytes: Buffer; hash: string; }
interface LocatedRecord extends ParsedRecord { path: string; }

export type MemoryReadResult = MemoryEntry | MemoryDocument;

export class MemoryStoreError extends Error {
    constructor(message: string, readonly code: string) { super(message); this.name = 'MemoryStoreError'; }
}

/** The record is durable; callers can report this partial result and retry index recovery. */
export class MemoryIndexUpdateError extends Error {
    readonly code = 'MEMORY_INDEX_UPDATE_FAILED';
    constructor(readonly committedEntry: MemoryEntry, readonly indexPath: string, cause: unknown) {
        super(`记忆记录 ${committedEntry.id} 已提交到 ${committedEntry.path}，但索引 ${indexPath} 更新失败。可通过 rebuildIndex 恢复：${safeError(cause)}`);
        this.name = 'MemoryIndexUpdateError';
    }
}

/** The tombstone is committed, but its privacy-preserving filename change failed. */
export class MemoryRenameError extends Error {
    readonly code = 'MEMORY_RENAME_FAILED';
    constructor(readonly committedEntry: MemoryEntry, readonly targetPath: string, readonly paths: string[], cause: unknown, readonly indexError?: string) {
        super(`记忆正文和标题已清除，墓碑已保存；文件名更新失败。当前路径：${paths.join(', ')}；目标路径：${targetPath}。${indexError ? `索引更新也失败：${indexError}。` : ''}${safeError(cause)}`);
        this.name = 'MemoryRenameError';
    }
}

const writeTails = new Map<string, Promise<void>>();

function safeError(error: unknown): string {
    if (error instanceof MemoryStoreError) return error.message;
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === 'string' ? `文件系统错误 ${code}` : '未知错误';
}

function sha256(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex'); }

function fail(message: string, code: string): never { throw new MemoryStoreError(message, code); }

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) fail('记忆操作已取消。', 'CANCELLED');
}

function isNotFound(error: unknown): boolean { return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'; }

function inspectComponents(target: string, allowMissing = false): boolean {
    const absolute = resolve(target);
    const root = parse(absolute).root;
    let cursor = root;
    const parts = relative(root, absolute).split(/[\\/]/).filter(Boolean);
    for (let index = 0; index < parts.length; index++) {
        cursor = join(cursor, parts[index]);
        let stat;
        try { stat = lstatSync(cursor); }
        catch (error) {
            if (isNotFound(error) && allowMissing) return false;
            throw error;
        }
        if (stat.isSymbolicLink()) fail('记忆路径包含符号链接或重解析点。', 'UNSAFE_PATH');
        if (index < parts.length - 1 && !stat.isDirectory()) fail('记忆路径的上级目录无效。', 'UNSAFE_PATH');
    }
    return true;
}

function ensurePlainDirectory(target: string): void {
    const absolute = resolve(target);
    const root = parse(absolute).root;
    let cursor = root;
    const parts = relative(root, absolute).split(/[\\/]/).filter(Boolean);
    for (const part of parts) {
        cursor = join(cursor, part);
        try {
            const stat = lstatSync(cursor);
            if (stat.isSymbolicLink() || !stat.isDirectory()) fail('记忆路径包含不安全的目录。', 'UNSAFE_PATH');
        } catch (error) {
            if (!isNotFound(error)) throw error;
            try { mkdirSync(cursor, { mode: 0o700 }); }
            catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== 'EEXIST') throw mkdirError; }
            const stat = lstatSync(cursor);
            if (stat.isSymbolicLink() || !stat.isDirectory()) fail('无法安全创建记忆目录。', 'UNSAFE_PATH');
        }
    }
}

function assertAbsoluteDirectory(value: string, mustExist: boolean, label: string): string {
    if (typeof value !== 'string' || !value.trim() || !isAbsolute(value) || value.includes('\0') || value.split(/[\\/]/).includes('..')) {
        fail(`${label}必须是规范的绝对目录。`, 'INVALID_DIRECTORY');
    }
    const absolute = resolve(value);
    const present = inspectComponents(absolute, !mustExist);
    if (!present) {
        if (mustExist) fail(`${label}不存在。`, 'INVALID_DIRECTORY');
        return absolute;
    }
    const stat = lstatSync(absolute);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`${label}不是普通目录。`, 'UNSAFE_PATH');
    let real: string;
    try { real = realpathSync(absolute); } catch { fail(`${label}不可用。`, 'INVALID_DIRECTORY'); }
    inspectComponents(real);
    return real;
}

function normalizeDirectoryKey(directory: string): string {
    let normalized = directory.normalize('NFC').replace(/\\/g, '/');
    if (process.platform === 'win32') normalized = normalized.toLowerCase();
    return normalized;
}

function safeReadBytes(target: string, maximum: number): Buffer {
    inspectComponents(dirname(target));
    let before;
    try { before = lstatSync(target); } catch (error) { throw error; }
    if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1 || before.size > maximum) {
        fail('记忆文件不是独占的普通文件或超过大小上限。', 'UNSAFE_FILE');
    }
    let fd: number;
    try { fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)); }
    catch (error) { throw error; }
    try {
        const owned = fstatSync(fd);
        if (!owned.isFile() || owned.nlink !== 1 || owned.dev !== before.dev || owned.ino !== before.ino) fail('记忆文件在打开时发生变化。', 'READ_CONFLICT');
        const bytes = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < bytes.length) {
            const count = readSync(fd, bytes, length, bytes.length - length, length);
            if (!count) break;
            length += count;
        }
        if (length > maximum) fail('记忆文件超过大小上限。', 'FILE_TOO_LARGE');
        const afterHandle = fstatSync(fd);
        const afterPath = lstatSync(target);
        if (afterHandle.dev !== owned.dev || afterHandle.ino !== owned.ino || afterHandle.size !== owned.size
            || afterHandle.mtimeMs !== owned.mtimeMs || afterHandle.ctimeMs !== owned.ctimeMs
            || afterPath.dev !== owned.dev || afterPath.ino !== owned.ino || afterPath.nlink !== 1) {
            fail('记忆文件在读取时发生变化。', 'READ_CONFLICT');
        }
        return bytes.subarray(0, length);
    } finally { closeSync(fd); }
}

function decodeUtf8(bytes: Buffer): string {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { fail('Markdown 文件不是有效的 UTF-8。', 'INVALID_ENCODING'); }
}

function validScope(value: unknown): value is MemoryScope { return value === 'user' || value === 'project' || value === 'private-project'; }
function validKind(value: unknown): value is MemoryKind { return value === 'preference' || value === 'decision' || value === 'lesson' || value === 'checkpoint'; }
function validStatus(value: unknown): value is MemoryStatus { return value === 'candidate' || value === 'active' || value === 'deleted'; }

function validSource(value: unknown): value is MemorySource {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const source = value as Record<string, unknown>;
    if (Object.keys(source).sort().join(',') !== 'evidenceIds,origin,runId,sessionId') return false;
    return typeof source.sessionId === 'string' && source.sessionId.length > 0 && source.sessionId.length <= 200 && !source.sessionId.includes('\0')
        && typeof source.runId === 'string' && source.runId.length > 0 && source.runId.length <= 200 && !source.runId.includes('\0')
        && (source.origin === 'user' || source.origin === 'agent') && Array.isArray(source.evidenceIds)
        && source.evidenceIds.length <= 100 && source.evidenceIds.every(item => typeof item === 'string' && item.trim().length > 0 && item.length <= 200 && !item.includes('\0'));
}

function parseMetadata(value: unknown): MemoryMetadata {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('记忆元数据无效。', 'INVALID_METADATA');
    const item = value as Record<string, unknown>;
    if (Object.keys(item).sort().join(',') !== 'contentDigest,createdAt,formatVersion,id,kind,pinned,scope,source,status,title,updatedAt') fail('记忆元数据字段集合无效。', 'INVALID_METADATA');
    if (item.formatVersion !== FORMAT_VERSION || typeof item.id !== 'string' || !UUID_PATTERN.test(item.id)
        || typeof item.title !== 'string' || !item.title.trim() || item.title.length > 200 || item.title.includes('\0') || /[\r\n]/.test(item.title)
        || !validScope(item.scope) || !validKind(item.kind) || !validStatus(item.status) || typeof item.pinned !== 'boolean'
        || typeof item.createdAt !== 'string' || item.createdAt.length > 40 || !Number.isFinite(Date.parse(item.createdAt))
        || typeof item.updatedAt !== 'string' || item.updatedAt.length > 40 || !Number.isFinite(Date.parse(item.updatedAt))
        || !validSource(item.source) || typeof item.contentDigest !== 'string' || !HASH_PATTERN.test(item.contentDigest)) {
        fail('记忆元数据格式或字段无效。', 'INVALID_METADATA');
    }
    if (item.pinned && (item.scope !== 'user' || item.kind !== 'preference' || item.status !== 'active')) fail('固定记忆只能是已启用的用户偏好。', 'INVALID_METADATA');
    return {
        formatVersion: FORMAT_VERSION, id: item.id.toLowerCase(), title: item.title, scope: item.scope,
        kind: item.kind, status: item.status, pinned: item.pinned, createdAt: item.createdAt,
        updatedAt: item.updatedAt, source: structuredClone(item.source), contentDigest: item.contentDigest,
    };
}

function parseRecord(bytes: Buffer): { metadata: MemoryMetadata; body: string } {
    const text = decodeUtf8(bytes);
    const newline = text.indexOf('\n');
    if (newline < 0) fail('记忆文件缺少元数据分隔行。', 'INVALID_METADATA');
    const firstLine = text.slice(0, newline).replace(/\r$/, '');
    const prefix = '<!-- UAH_MEMORY:';
    const suffix = ' -->';
    if (!firstLine.startsWith(prefix) || !firstLine.endsWith(suffix)) fail('记忆文件缺少有效元数据头。', 'INVALID_METADATA');
    let raw: unknown;
    try { raw = JSON.parse(firstLine.slice(prefix.length, -suffix.length)); }
    catch { fail('记忆元数据 JSON 无效。', 'INVALID_METADATA'); }
    const metadata = parseMetadata(raw);
    let bodyOffset = newline + 1;
    if (text[bodyOffset] === '\r') bodyOffset++;
    if (text[bodyOffset] !== '\n') fail('记忆元数据与正文之间缺少空行。', 'INVALID_METADATA');
    bodyOffset++;
    return { metadata, body: text.slice(bodyOffset) };
}

function contentDigest(_title: string, body: string): string {
    const normalize = (value: string) => value.normalize('NFKC').replace(/\r\n?/g, '\n')
        .split('\n').map(line => line.trim()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return sha256(normalize(body));
}

function serializeRecord(metadata: MemoryMetadata, body: string): Buffer {
    const bytes = Buffer.from(`<!-- UAH_MEMORY:${JSON.stringify(metadata)} -->\n\n${body}`, 'utf8');
    if (bytes.length > MAX_RECORD_BYTES) fail('记忆记录超过 64 KiB 上限。', 'RECORD_TOO_LARGE');
    return bytes;
}

function relativePath(root: string, target: string): string { return relative(root, target).split(sep).join('/'); }

function toEntry(record: ParsedRecord, path: string): MemoryEntry {
    const { metadata } = record;
    return {
        id: metadata.id, title: metadata.title, body: record.body, scope: metadata.scope, kind: metadata.kind,
        status: metadata.status, pinned: metadata.pinned, createdAt: metadata.createdAt, updatedAt: metadata.updatedAt,
        source: structuredClone(metadata.source), path, hash: record.hash,
    };
}

function uuidBasenameId(filename: string): string | null {
    if (!/\.md$/i.test(filename)) return null;
    const stem = filename.slice(0, -3);
    return UUID_PATTERN.test(stem) ? stem.toLowerCase() : null;
}

function assertFilenameMatchesRecord(filename: string, metadata: MemoryMetadata): void {
    const filenameId = uuidBasenameId(filename);
    if (filenameId && filenameId !== metadata.id) {
        fail('UUID 文件名与记忆元数据 ID 不一致。', 'UUID_FILENAME_MISMATCH');
    }
}

function localDateString(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function slugFromTitle(title: string): string {
    const normalized = title.normalize('NFKC').toLowerCase();
    const points = Array.from(normalized.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/-+/g, '-').replace(/^-|-$/g, ''));
    const bounded: string[] = []; let bytes = 0;
    for (const point of points) {
        const size = Buffer.byteLength(point, 'utf8');
        if (bounded.length >= 80 || bytes + size > 160) break;
        bounded.push(point); bytes += size;
    }
    const slug = bounded.join('').replace(/-+$/g, '');
    return slug || 'memory';
}

function availableFriendlyPath(root: string, date: string, slug: string, from = 1): { path: string; suffix: number } {
    for (let suffix = from; suffix < from + 10_000; suffix++) {
        const disambiguator = suffix === 1 ? '' : `-${suffix}`;
        const path = join(root, `${date}-${slug}${disambiguator}.md`);
        if (!statIfPresent(path)) return { path, suffix };
    }
    fail('同名记忆过多，无法安全分配文件名。', 'FILENAME_EXHAUSTED');
}

function encodedBasename(path: string): string {
    return encodeURIComponent(basename(path)).replace(/[!'()*]/g, value => `%${value.charCodeAt(0).toString(16).toUpperCase()}`);
}

function titleFromMarkdown(path: string, content: string): string {
    const heading = content.match(/^\s*#\s+(.+?)\s*#*\s*$/m)?.[1]?.trim();
    return (heading || basename(path, '.md')).slice(0, 200) || 'Markdown';
}

function toDocument(scope: MemoryScope, path: string, content: string, hash: string): MemoryDocument {
    return { scope, path, title: titleFromMarkdown(path, content), content, hash };
}

function withWriteLock<T>(key: string, action: () => Promise<T>): Promise<T> {
    const previous = writeTails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>(resolveLock => { release = resolveLock; });
    writeTails.set(key, current);
    return previous.then(action).finally(() => {
        release();
        if (writeTails.get(key) === current) writeTails.delete(key);
    });
}

function assertExpectedHash(value: string): void {
    if (!HASH_PATTERN.test(value)) fail('expectedHash 必须是小写 SHA-256。', 'INVALID_HASH');
}

function assertInput(input: MemoryWrite): void {
    if (!input || typeof input !== 'object' || !validScope(input.scope) || !validKind(input.kind)
        || (input.status !== 'candidate' && input.status !== 'active') || typeof input.pinned !== 'boolean'
        || typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || /[\r\n\0]/.test(input.title)
        || typeof input.body !== 'string' || input.body.includes('\0') || !validSource(input.source)) {
        fail('记忆写入参数无效。', 'INVALID_INPUT');
    }
    if (input.slug !== undefined && (typeof input.slug !== 'string' || input.slug.length < 1 || input.slug.length > 80 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.slug))) {
        fail('slug 只能包含 1–80 个 ASCII 小写字母、数字或连字符。', 'INVALID_SLUG');
    }
    if (input.id && input.slug !== undefined) fail('更新记忆不能更改文件名 slug。', 'INVALID_SLUG');
    if (input.pinned && (input.scope !== 'user' || input.kind !== 'preference' || input.status !== 'active')) fail('固定记忆只能是已启用的用户偏好。', 'INVALID_INPUT');
    if (input.id !== undefined && !UUID_PATTERN.test(input.id)) fail('记忆 ID 必须是 UUID。', 'INVALID_ID');
    if (input.expectedHash !== undefined) assertExpectedHash(input.expectedHash);
    if (input.id && !input.expectedHash) fail('更新记忆必须提供 expectedHash。', 'EXPECTED_HASH_REQUIRED');
    if (!input.id && input.expectedHash) fail('新建记忆不能提供 expectedHash。', 'UNEXPECTED_HASH');
}

function statIfPresent(path: string) {
    try { return lstatSync(path); } catch (error) { if (isNotFound(error)) return null; throw error; }
}

function safeMarkdownPath(input: string): string[] {
    if (typeof input !== 'string' || !input.trim() || input.includes('\0') || isAbsolute(input) || /^[A-Za-z]:/.test(input)) fail('Markdown 路径必须是范围内的相对路径。', 'INVALID_PATH');
    const parts = input.replace(/\\/g, '/').split('/');
    if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || /[. ]$/.test(part)
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) fail('Markdown 路径无效。', 'INVALID_PATH');
    if (!/\.md$/i.test(parts.at(-1)!)) fail('只允许读取 Markdown 文件。', 'INVALID_PATH');
    return parts;
}

function blockBounds(content: string): { start: number; end: number } | null {
    const starts: number[] = []; const ends: number[] = [];
    let offset = 0;
    while ((offset = content.indexOf(START_MARKER, offset)) >= 0) { starts.push(offset); offset += START_MARKER.length; }
    offset = 0;
    while ((offset = content.indexOf(END_MARKER, offset)) >= 0) { ends.push(offset); offset += END_MARKER.length; }
    if (starts.length === 0 && ends.length === 0) return null;
    if (starts.length !== 1 || ends.length !== 1 || starts[0] >= ends[0]) fail('MEMORY.md 中的托管索引标记不完整或重复，未覆盖文件。', 'INVALID_INDEX_BLOCK');
    const start = starts[0]; const end = ends[0];
    const startAfter = start + START_MARKER.length;
    const endAfter = end + END_MARKER.length;
    if ((start > 0 && content[start - 1] !== '\n') || (end > 0 && content[end - 1] !== '\n')
        || (content[startAfter] !== '\n' && content.slice(startAfter, startAfter + 2) !== '\r\n')
        || (endAfter < content.length && content[endAfter] !== '\n' && content.slice(endAfter, endAfter + 2) !== '\r\n')) {
        fail('MEMORY.md 索引标记必须独占一行。', 'INVALID_INDEX_BLOCK');
    }
    return { start, end };
}

function markdownIndexBlock(records: LocatedRecord[]): string {
    const active = records.filter(record => record.metadata.status !== 'deleted')
        .sort((left, right) => Number(right.metadata.pinned) - Number(left.metadata.pinned)
            || right.metadata.updatedAt.localeCompare(left.metadata.updatedAt)
            || left.metadata.title.localeCompare(right.metadata.title));
    const lines = ['# UAH memory index', ''];
    let omitted = 0;
    for (const record of active) {
        const title = record.metadata.title.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
        const pin = record.metadata.pinned ? ' · pinned' : '';
        const line = `- [${title}](${encodedBasename(record.path)}) · ${record.metadata.kind} · ${record.metadata.status}${pin}`;
        if (Buffer.byteLength(`${START_MARKER}\n${[...lines, line].join('\n')}\n${END_MARKER}`, 'utf8') > MAX_INDEX_CHARS) { omitted++; continue; }
        lines.push(line);
    }
    if (omitted) lines.push('', `> Index shortened by the ${MAX_INDEX_CHARS}-byte limit; use memory list/search for remaining records.`);
    return `${START_MARKER}\n${lines.join('\n')}\n${END_MARKER}`;
}

function composeIndex(oldContent: string | null, block: string): string {
    if (oldContent === null) return `${block}\n`;
    const bounds = blockBounds(oldContent);
    if (bounds) return `${oldContent.slice(0, bounds.start + START_MARKER.length)}\n${block.slice(START_MARKER.length, -END_MARKER.length)}${oldContent.slice(bounds.end)}`;
    const separator = oldContent.length === 0 || oldContent.endsWith('\n') ? '\n' : '\n\n';
    return `${oldContent}${separator}${block}\n`;
}

function syncDirectory(directory: string): void {
    let fd: number | undefined;
    try { fd = openSync(directory, constants.O_RDONLY); fsyncSync(fd); }
    catch { /* Directory fsync is unsupported on some Windows filesystems. */ }
    finally { if (fd !== undefined) closeSync(fd); }
}

function writeTemp(target: string, bytes: Buffer): string {
    const temporary = `${target}.${randomUUID()}.tmp`;
    const fd = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); }
    catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
    finally { closeSync(fd); }
    return temporary;
}

function commitNewFile(target: string, expectedMissing: true, bytes: Buffer, signal?: AbortSignal): void {
    throwIfAborted(signal);
    inspectComponents(dirname(target));
    if (statIfPresent(target)) fail('记忆文件已存在，拒绝覆盖未知内容。', 'WRITE_CONFLICT');
    const temporary = writeTemp(target, bytes);
    try {
        throwIfAborted(signal);
        inspectComponents(dirname(target));
        if (statIfPresent(target)) fail('记忆文件已被其他写入创建。', 'WRITE_CONFLICT');
        linkSync(temporary, target);
        unlinkSync(temporary);
        syncDirectory(dirname(target));
    } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

function commitReplaceFile(target: string, expected: Buffer, bytes: Buffer, signal?: AbortSignal): void {
    const temporary = writeTemp(target, bytes);
    try {
        throwIfAborted(signal);
        const current = safeReadBytes(target, Math.max(expected.length, MAX_INDEX_BYTES));
        if (!current.equals(expected)) fail('记忆文件已变化，请重新读取后再试。', 'WRITE_CONFLICT');
        inspectComponents(dirname(target));
        throwIfAborted(signal);
        renameSync(temporary, target);
        syncDirectory(dirname(target));
    } catch (error) { try { unlinkSync(temporary); } catch {} throw error; }
}

export class MemoryStore {
    readonly homeDirectory: string;

    constructor(options: { homeDirectory: string }) {
        this.homeDirectory = assertAbsoluteDirectory(options.homeDirectory, false, 'homeDirectory');
    }

    /** Resolve one exact scope root without creating it. */
    directoryFor(directory: string | null, scope: MemoryScope): string {
        if (!validScope(scope)) fail('记忆范围无效。', 'INVALID_SCOPE');
        const userRoot = join(this.homeDirectory, '.uah', 'memory');
        if (scope === 'user') return userRoot;
        if (directory === null) fail('项目记忆需要明确的工作目录。', 'DIRECTORY_REQUIRED');
        const canonical = assertAbsoluteDirectory(directory, true, '项目目录');
        if (scope === 'project') return join(canonical, '.memory');
        return join(userRoot, 'projects', sha256(normalizeDirectoryKey(canonical)));
    }

    async list(directory: string | null, scope?: MemoryScope): Promise<MemoryListResult> {
        if (scope !== undefined && !validScope(scope)) fail('记忆范围无效。', 'INVALID_SCOPE');
        const scopes: MemoryScope[] = scope ? [scope] : directory === null
            ? ['user'] : ['user', 'project', 'private-project'];
        const result: MemoryListResult = { entries: [], documents: [], warnings: [] };
        for (const currentScope of scopes) {
            let root: string;
            try { root = this.directoryFor(directory, currentScope); }
            catch (error) { result.warnings.push(`${currentScope}: ${safeError(error)}`); continue; }
            try { this.listRoot(root, currentScope, result); }
            catch (error) { result.warnings.push(`${currentScope}: ${safeError(error)}`); }
            if (result.entries.length + result.documents.length >= MAX_LIST_ITEMS) {
                result.warnings.push(`列表最多返回 ${MAX_LIST_ITEMS} 项；结果可能不完整。`);
                break;
            }
        }
        return result;
    }

    async read(directory: string | null, scope: MemoryScope, idOrPath: string): Promise<MemoryReadResult> {
        const root = this.directoryFor(directory, scope);
        const id = UUID_PATTERN.test(idOrPath) ? idOrPath.toLowerCase() : null;
        if (id) {
            const matches = this.findManagedRecords(root, scope, id);
            if (matches.length > 1) fail('同一记忆 ID 对应多个文件，无法安全选择。', 'AMBIGUOUS_ID');
            if (matches.length === 1) return toEntry(matches[0], matches[0].path);
            const legacyPath = join(root, `${id}.md`);
            if (statIfPresent(legacyPath)) {
                const bytes = safeReadBytes(legacyPath, MAX_RECORD_BYTES);
                try {
                    const parsed = parseRecord(bytes);
                    assertFilenameMatchesRecord(basename(legacyPath), parsed.metadata);
                    if (parsed.metadata.id === id && parsed.metadata.scope === scope) return toEntry({ ...parsed, bytes, hash: sha256(bytes) }, legacyPath);
                } catch (error) {
                    if (bytes.subarray(0, 32).toString('utf8').startsWith('<!-- UAH_MEMORY:')) throw error;
                }
            }
            fail('未找到该 ID 对应的 UAH 记忆记录。', 'NOT_FOUND');
        }
        const parts = safeMarkdownPath(idOrPath);
        if (scope === 'user' && parts[0]?.toLowerCase() === 'projects') fail('用户范围不能读取私有项目记忆目录。', 'INVALID_PATH');
        const target = resolve(root, ...parts);
        const relativeTarget = relative(resolve(root), target);
        if (!relativeTarget || relativeTarget === '..' || relativeTarget.startsWith(`..${sep}`) || isAbsolute(relativeTarget)) fail('Markdown 路径超出记忆范围。', 'INVALID_PATH');
        inspectComponents(target);
        const bytes = safeReadBytes(target, MAX_RECORD_BYTES);
        const hash = sha256(bytes);
        let parsed: { metadata: MemoryMetadata; body: string } | undefined;
        try { parsed = parseRecord(bytes); } catch (error) {
            if (bytes.subarray(0, 32).toString('utf8').startsWith('<!-- UAH_MEMORY:')) throw error;
        }
        if (parsed) {
            assertFilenameMatchesRecord(basename(target), parsed.metadata);
            if (parsed.metadata.scope === scope && parts.length === 1) return toEntry({ ...parsed, bytes, hash }, target);
        }
        const content = decodeUtf8(bytes);
        return toDocument(scope, target, content, hash);
    }

    async save(directory: string | null, input: MemoryWrite, signal?: AbortSignal): Promise<MemoryEntry> {
        assertInput(input);
        const root = this.directoryFor(directory, input.scope);
        return withWriteLock(root, async () => {
            throwIfAborted(signal);
            ensurePlainDirectory(root);
            let id = input.id?.toLowerCase();
            let target: string | undefined;
            let existing: LocatedRecord | null = null;
            let oldBytes: Buffer | null = null;
            if (id) {
                const matches = this.findManagedRecords(root, input.scope, id);
                if (matches.length > 1) fail('同一记忆 ID 对应多个文件，无法安全更新。', 'AMBIGUOUS_ID');
                if (matches.length === 1) {
                    existing = matches[0]; target = existing.path; oldBytes = existing.bytes;
                    if (sha256(oldBytes) !== input.expectedHash) fail('记忆已变化，请重新读取后再试。', 'WRITE_CONFLICT');
                } else {
                    const legacyPath = join(root, `${id}.md`);
                    if (!statIfPresent(legacyPath)) fail('要更新的记忆记录不存在。', 'NOT_FOUND');
                    const bytes = safeReadBytes(legacyPath, MAX_RECORD_BYTES);
                    try {
                        const parsed = parseRecord(bytes);
                        assertFilenameMatchesRecord(basename(legacyPath), parsed.metadata);
                        if (parsed.metadata.id === id && parsed.metadata.scope === input.scope) {
                            existing = { ...parsed, path: legacyPath, bytes, hash: sha256(bytes) };
                            target = legacyPath; oldBytes = bytes;
                            if (existing.hash !== input.expectedHash) fail('记忆已变化，请重新读取后再试。', 'WRITE_CONFLICT');
                        } else fail('目标文件不是此记忆条目的有效记录。', 'UNOWNED_FILE');
                    } catch (error) {
                        if (error instanceof MemoryStoreError && error.code === 'INVALID_METADATA') throw error;
                        throw error;
                    }
                }
                if (existing.metadata.status === 'deleted') {
                    fail('已删除记忆保留为墓碑；如需重新保存，请创建新的记忆 ID。', 'TOMBSTONED_CONTENT');
                }
            } else {
                if (input.source.origin === 'agent') this.assertNotTombstoned(root, input.scope, contentDigest(input.title, input.body));
                id = randomUUID();
            }

            const created = new Date();
            const now = created.toISOString();
            const metadata: MemoryMetadata = {
                formatVersion: FORMAT_VERSION, id: id!, title: input.title.trim(), scope: input.scope, kind: input.kind,
                status: input.status, pinned: input.pinned, createdAt: existing?.metadata.createdAt ?? now, updatedAt: now,
                source: structuredClone(input.source), contentDigest: contentDigest(input.title, input.body),
            };
            const bytes = serializeRecord(metadata, input.body);
            throwIfAborted(signal);
            if (oldBytes) commitReplaceFile(target!, oldBytes, bytes, signal);
            else {
                const date = localDateString(created);
                const slug = input.slug ?? slugFromTitle(input.title);
                let available = availableFriendlyPath(root, date, slug);
                while (true) {
                    target = available.path;
                    try { commitNewFile(target, true, bytes, signal); break; }
                    catch (error) {
                        if (!(error instanceof MemoryStoreError) || error.code !== 'WRITE_CONFLICT') throw error;
                        available = availableFriendlyPath(root, date, slug, available.suffix + 1);
                    }
                }
            }
            const committed: ParsedRecord = { metadata, body: input.body, bytes, hash: sha256(bytes) };
            const entry = toEntry(committed, target!);
            try { this.rebuildIndexUnlocked(root, input.scope); }
            catch (error) { throw new MemoryIndexUpdateError(entry, join(root, 'MEMORY.md'), error); }
            return entry;
        });
    }

    async forget(directory: string | null, scope: MemoryScope, id: string, expectedHash: string, signal?: AbortSignal): Promise<void> {
        if (!validScope(scope)) fail('记忆范围无效。', 'INVALID_SCOPE');
        if (!UUID_PATTERN.test(id)) fail('记忆 ID 必须是 UUID。', 'INVALID_ID');
        assertExpectedHash(expectedHash);
        const normalizedId = id.toLowerCase();
        const root = this.directoryFor(directory, scope);
        await withWriteLock(root, async () => {
            throwIfAborted(signal);
            ensurePlainDirectory(root);
            const matches = this.findManagedRecords(root, scope, normalizedId);
            if (matches.length > 1) fail('同一记忆 ID 对应多个文件，无法安全遗忘。', 'AMBIGUOUS_ID');
            let located = matches[0];
            if (!located) {
                const legacyPath = join(root, `${normalizedId}.md`);
                if (!statIfPresent(legacyPath)) fail('记忆记录不存在。', 'NOT_FOUND');
                const bytes = safeReadBytes(legacyPath, MAX_RECORD_BYTES);
                try {
                    const parsed = parseRecord(bytes);
                    assertFilenameMatchesRecord(basename(legacyPath), parsed.metadata);
                    if (parsed.metadata.id !== normalizedId || parsed.metadata.scope !== scope) fail('目标文件不是此记忆条目的有效记录。', 'UNOWNED_FILE');
                    located = { ...parsed, path: legacyPath, bytes, hash: sha256(bytes) };
                } catch (error) {
                    if (bytes.subarray(0, 32).toString('utf8').startsWith('<!-- UAH_MEMORY:')) throw error;
                    fail('目标文件不是 UAH 管理的记忆记录。', 'UNOWNED_FILE');
                }
            }
            const target = located.path;
            const original = located.bytes;
            if (sha256(original) !== expectedHash) fail('记忆已变化，请重新读取后再试。', 'WRITE_CONFLICT');
            const parsed = parseRecord(original);
            if (parsed.metadata.id !== normalizedId || parsed.metadata.scope !== scope) fail('目标文件不是此记忆条目的有效记录。', 'UNOWNED_FILE');
            if (parsed.metadata.status === 'deleted') fail('记忆已经删除。', 'ALREADY_DELETED');
            const forgottenAt = new Date();
            const metadata: MemoryMetadata = {
                ...parsed.metadata, title: '已遗忘记忆', status: 'deleted', pinned: false, updatedAt: forgottenAt.toISOString(),
                contentDigest: contentDigest(parsed.metadata.title, parsed.body),
            };
            const bytes = serializeRecord(metadata, '');
            throwIfAborted(signal);
            commitReplaceFile(target, original, bytes, signal);
            let entry = toEntry({ metadata, body: '', bytes, hash: sha256(bytes) }, target);
            try { entry = { ...entry, path: this.moveTombstone(root, target, bytes, entry, localDateString(forgottenAt)) }; }
            catch (error) {
                const renameError = error instanceof MemoryRenameError ? error : new MemoryRenameError(entry, target, [target], error);
                let indexError: string | undefined;
                try { this.rebuildIndexUnlocked(root, scope); } catch (rebuildError) { indexError = safeError(rebuildError); }
                if (indexError) throw new MemoryRenameError(renameError.committedEntry, renameError.targetPath, renameError.paths, renameError, indexError);
                throw renameError;
            }
            try { this.rebuildIndexUnlocked(root, scope); }
            catch (error) { throw new MemoryIndexUpdateError(entry, join(root, 'MEMORY.md'), error); }
        });
    }

    async rebuildIndex(directory: string | null, scope: MemoryScope, signal?: AbortSignal): Promise<void> {
        if (!validScope(scope)) fail('记忆范围无效。', 'INVALID_SCOPE');
        const root = this.directoryFor(directory, scope);
        await withWriteLock(root, async () => {
            throwIfAborted(signal);
            ensurePlainDirectory(root);
            this.rebuildIndexUnlocked(root, scope, signal);
        });
    }

    async snapshot(directory: string | null): Promise<MemorySnapshot> {
        const indexes: MemoryIndexSnapshot[] = [];
        const warnings: string[] = [];
        const scopes: MemoryScope[] = directory === null ? ['user'] : ['user', 'project', 'private-project'];
        for (const scope of scopes) {
            let root: string;
            try { root = this.directoryFor(directory, scope); }
            catch (error) { warnings.push(`${scope}: ${safeError(error)}`); continue; }
            const path = join(root, 'MEMORY.md');
            try {
                inspectComponents(dirname(path), true);
                if (!inspectComponents(dirname(path), true)) {
                    indexes.push({ scope, path, content: '', hash: sha256(Buffer.alloc(0)), exists: false });
                    continue;
                }
                const stat = statIfPresent(path);
                if (!stat) { indexes.push({ scope, path, content: '', hash: sha256(Buffer.alloc(0)), exists: false }); continue; }
                const bytes = safeReadBytes(path, MAX_INDEX_BYTES);
                const hash = sha256(bytes);
                let content = '';
                if (scope === 'project') {
                    const decoded = decodeUtf8(bytes);
                    content = trimCharacters(decoded, MAX_INDEX_CONTENT_CHARS);
                    if (content.length < decoded.length) warnings.push('项目 MEMORY.md 索引超过 4000 字符，已明确截短。');
                }
                indexes.push({ scope, path, content, hash, exists: true });
            } catch (error) {
                warnings.push(`${scope} MEMORY.md: ${safeError(error)}`);
                indexes.push({ scope, path, content: '', hash: '', exists: false });
            }
        }

        const user = await this.list(null, 'user');
        warnings.push(...user.warnings);
        const pinned: MemoryEntry[] = [];
        let remaining = MAX_INDEX_CONTENT_CHARS;
        const candidates = user.entries.filter(entry => entry.status === 'active' && entry.kind === 'preference' && entry.pinned)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        for (const entry of candidates) {
            if (remaining <= 0) break;
            const prefixCost = entry.title.length + 2;
            if (prefixCost > remaining) break;
            const bodyBudget = Math.max(0, remaining - prefixCost);
            const body = trimCharacters(entry.body, bodyBudget);
            pinned.push({ ...entry, body });
            remaining -= prefixCost + body.length;
        }
        if (candidates.length > pinned.length || candidates.some((entry, index) => entry.body.length !== pinned[index]?.body.length)) {
            warnings.push('固定用户偏好总计超过 4000 字符，结果已截短。');
        }
        return { indexes, pinned, warnings };
    }

    private moveTombstone(root: string, source: string, expectedBytes: Buffer, entry: MemoryEntry, date: string): string {
        for (let suffix = 1; suffix <= 10_000; suffix++) {
            const disambiguator = suffix === 1 ? '' : `-${suffix}`;
            const target = join(root, `${date}-forgotten-memory${disambiguator}.md`);
            if (statIfPresent(target)) continue;
            let createdLink: ReturnType<typeof lstatSync> | undefined;
            try {
                const current = safeReadBytes(source, MAX_RECORD_BYTES);
                if (!current.equals(expectedBytes)) fail('墓碑在改名之前已变化。', 'WRITE_CONFLICT');
                inspectComponents(root);
                createdLink = lstatSync(source);
                if (!createdLink.isFile() || createdLink.nlink !== 1) fail('墓碑源文件身份无效。', 'UNSAFE_FILE');
                linkSync(source, target);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
                throw new MemoryRenameError(entry, target, [source], error);
            }
            let sourceRemoved = false;
            try {
                const sourceStat = lstatSync(source); const targetStat = lstatSync(target);
                if (!createdLink || !sourceStat.isFile() || !targetStat.isFile()
                    || sourceStat.dev !== createdLink.dev || sourceStat.ino !== createdLink.ino
                    || targetStat.dev !== createdLink.dev || targetStat.ino !== createdLink.ino) {
                    fail('墓碑文件身份在改名期间发生变化。', 'RENAME_CONFLICT');
                }
                unlinkSync(source);
                sourceRemoved = true;
                syncDirectory(root);
                return target;
            } catch (error) {
                if (!sourceRemoved) {
                    try {
                        const currentTarget = lstatSync(target);
                        if (createdLink && currentTarget.isFile() && currentTarget.dev === createdLink.dev && currentTarget.ino === createdLink.ino) unlinkSync(target);
                    } catch { /* Keep every possibly-live path reported if cleanup cannot be verified. */ }
                }
                const paths: string[] = [];
                for (const path of [source, target]) {
                    try { lstatSync(path); paths.push(path); }
                    catch (pathError) { if (!isNotFound(pathError)) paths.push(path); }
                }
                const actualPath = paths.includes(source) ? source : paths[0] ?? target;
                throw new MemoryRenameError({ ...entry, path: actualPath }, target, paths, error);
            }
        }
        const target = join(root, `${date}-forgotten-memory-10000.md`);
        throw new MemoryRenameError(entry, target, [source], new MemoryStoreError('遗忘墓碑文件名冲突过多。', 'FILENAME_EXHAUSTED'));
    }

    private findManagedRecords(root: string, scope: MemoryScope, id: string): LocatedRecord[] {
        if (!inspectComponents(root, true)) return [];
        const names = readdirSync(root).sort((left, right) => left.localeCompare(right));
        if (names.length > MAX_SCOPE_SCAN_ITEMS) fail(`记忆目录超过 ${MAX_SCOPE_SCAN_ITEMS} 项扫描上限，无法可靠确认 ID 唯一性。`, 'SCOPE_SCAN_LIMIT');
        const matches: LocatedRecord[] = [];
        for (const name of names) {
            if (!/\.md$/i.test(name)) continue;
            const path = join(root, name);
            let bytes: Buffer | undefined;
            try {
                bytes = safeReadBytes(path, MAX_RECORD_BYTES);
                const parsed = parseRecord(bytes);
                const filenameId = uuidBasenameId(name);
                if (filenameId && filenameId !== parsed.metadata.id) {
                    if (filenameId === id || parsed.metadata.id === id) fail('UUID 文件名与记忆元数据 ID 不一致。', 'UUID_FILENAME_MISMATCH');
                    continue;
                }
                if (parsed.metadata.scope === scope && parsed.metadata.id === id) matches.push({ ...parsed, path, bytes, hash: sha256(bytes) });
            } catch (error) {
                if (error instanceof MemoryStoreError && error.code === 'UUID_FILENAME_MISMATCH') throw error;
                if (error instanceof MemoryStoreError && ['UNSAFE_FILE', 'UNSAFE_PATH', 'READ_CONFLICT'].includes(error.code)) throw error;
                if (name.toLowerCase() === `${id}.md` && (!bytes || bytes.subarray(0, 32).toString('utf8').startsWith('<!-- UAH_MEMORY:'))) throw error;
            }
        }
        return matches;
    }

    private listRoot(root: string, scope: MemoryScope, result: MemoryListResult): void {
        if (!inspectComponents(root, true)) return;
        let scanned = 0;
        let scanLimitReported = false;
        const visit = (directory: string, depth: number): void => {
            if (result.entries.length + result.documents.length >= MAX_LIST_ITEMS) return;
            if (depth > 4) { result.warnings.push(`${relativePath(root, directory)}: 已达搜索深度上限。`); return; }
            let names: string[];
            try { names = readdirSync(directory).sort((left, right) => left.localeCompare(right)); }
            catch (error) { result.warnings.push(`${relativePath(root, directory)}: ${safeError(error)}`); return; }
            for (const name of names) {
                if (scanned >= MAX_SCOPE_SCAN_ITEMS) {
                    if (!scanLimitReported) result.warnings.push(`记忆目录扫描达到 ${MAX_SCOPE_SCAN_ITEMS} 项上限；结果可能不完整。`);
                    scanLimitReported = true; return;
                }
                scanned++;
                if (result.entries.length + result.documents.length >= MAX_LIST_ITEMS) return;
                if (depth === 0 && scope === 'user' && name.toLowerCase() === 'projects') continue;
                const target = join(directory, name);
                let stat;
                try { stat = lstatSync(target); }
                catch (error) { result.warnings.push(`${relativePath(root, target)}: ${safeError(error)}`); continue; }
                if (stat.isSymbolicLink()) { result.warnings.push(`${relativePath(root, target)}: 已跳过符号链接或重解析点。`); continue; }
                if (stat.isDirectory()) { visit(target, depth + 1); continue; }
                if (!stat.isFile() || !/\.md$/i.test(name)) continue;
                const path = target;
                try {
                    const bytes = safeReadBytes(target, MAX_RECORD_BYTES);
                    const hash = sha256(bytes);
                    let parsed: { metadata: MemoryMetadata; body: string } | null = null;
                    try { parsed = parseRecord(bytes); }
                    catch (error) {
                        if (bytes.subarray(0, 32).toString('utf8').startsWith('<!-- UAH_MEMORY:')) result.warnings.push(`${path}: ${safeError(error)}`);
                    }
                    const filenameId = uuidBasenameId(name);
                    if (parsed && filenameId && filenameId !== parsed.metadata.id) {
                        result.warnings.push(`${path}: UUID 文件名与记忆元数据 ID 不一致，已排除。`);
                        continue;
                    }
                    if (parsed && parsed.metadata.scope === scope && depth === 0) {
                        if (parsed.metadata.status !== 'deleted') result.entries.push(toEntry({ ...parsed, bytes, hash }, path));
                        continue;
                    }
                    if (parsed && (parsed.metadata.scope !== scope || depth !== 0)) {
                        result.warnings.push(`${path}: 元数据与记忆范围不一致，或记录不在记忆根目录。`);
                    }
                    const content = decodeUtf8(bytes);
                    result.documents.push(toDocument(scope, path, content, hash));
                } catch (error) { result.warnings.push(`${path}: ${safeError(error)}`); }
            }
        };
        visit(root, 0);
    }

    private assertNotTombstoned(root: string, scope: MemoryScope, digest: string): void {
        if (!inspectComponents(root, true)) return;
        let names: string[];
        try { names = readdirSync(root); } catch (error) { if (isNotFound(error)) return; throw error; }
        if (names.length > MAX_SCOPE_SCAN_ITEMS) fail(`记忆目录超过 ${MAX_SCOPE_SCAN_ITEMS} 项扫描上限，无法确认删除墓碑。`, 'SCOPE_SCAN_LIMIT');
        for (const name of names) {
            if (!/\.md$/i.test(name)) continue;
            const target = join(root, name);
            try {
                const bytes = safeReadBytes(target, MAX_RECORD_BYTES);
                const parsed = parseRecord(bytes);
                const filenameId = uuidBasenameId(name);
                if (filenameId && filenameId !== parsed.metadata.id) continue;
                if (parsed.metadata.scope === scope
                    && parsed.metadata.status === 'deleted' && parsed.metadata.contentDigest === digest) {
                    fail('此内容已有删除记录，自动记忆不能重新创建。', 'TOMBSTONED_CONTENT');
                }
            } catch (error) {
                if (error instanceof MemoryStoreError && error.code === 'TOMBSTONED_CONTENT') throw error;
                // An unrelated malformed file does not authorize overwriting or block a new UUID record.
            }
        }
    }

    private loadManagedRecords(root: string, scope: MemoryScope): LocatedRecord[] {
        const records: LocatedRecord[] = [];
        if (!inspectComponents(root, true)) return records;
        const names = readdirSync(root).sort((left, right) => left.localeCompare(right));
        if (names.length > MAX_SCOPE_SCAN_ITEMS) fail(`记忆目录超过 ${MAX_SCOPE_SCAN_ITEMS} 项扫描上限，无法完整重建索引。`, 'SCOPE_SCAN_LIMIT');
        for (const name of names) {
            if (!/\.md$/i.test(name)) continue;
            const target = join(root, name);
            try {
                const bytes = safeReadBytes(target, MAX_RECORD_BYTES);
                const parsed = parseRecord(bytes);
                const filenameId = uuidBasenameId(name);
                if (filenameId && filenameId !== parsed.metadata.id) continue;
                if (parsed.metadata.scope === scope) records.push({ ...parsed, path: target, bytes, hash: sha256(bytes) });
            } catch { /* Unknown and malformed files remain untouched and outside the managed index. */ }
        }
        return records;
    }

    private rebuildIndexUnlocked(root: string, scope: MemoryScope, signal?: AbortSignal): void {
        throwIfAborted(signal);
        const records = this.loadManagedRecords(root, scope);
        const target = join(root, 'MEMORY.md');
        const oldStat = statIfPresent(target);
        let oldBytes: Buffer | null = null;
        let oldContent: string | null = null;
        if (oldStat) {
            oldBytes = safeReadBytes(target, MAX_INDEX_BYTES);
            oldContent = decodeUtf8(oldBytes);
        }
        const nextBytes = Buffer.from(`${composeIndex(oldContent, markdownIndexBlock(records))}`, 'utf8');
        if (nextBytes.length > MAX_INDEX_BYTES) fail('托管索引更新会超过 2 MiB 上限。', 'INDEX_TOO_LARGE');
        if (oldBytes) commitReplaceFile(target, oldBytes, nextBytes, signal);
        else commitNewFile(target, true, nextBytes, signal);
    }
}

function trimCharacters(value: string, maximum: number): string {
    if (maximum <= 0) return '';
    if (value.length <= maximum) return value;
    let end = maximum;
    const code = value.charCodeAt(end - 1);
    if (code >= 0xd800 && code <= 0xdbff) end--;
    return value.slice(0, end);
}
