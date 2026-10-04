import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { basename, extname, isAbsolute, resolve } from 'node:path';
import {
    detectNativeAttachmentImageMime,
    NATIVE_ATTACHMENT_LIMITS,
    validateAttachments,
    type NativeAttachmentDescriptor,
    type NativeAttachmentPayload,
} from '../shared/attachments.js';

interface StagedAttachment {
    payload: NativeAttachmentPayload;
    sourceBytes: number;
}

interface RegistryEntry {
    payload: NativeAttachmentPayload;
    expiresAt: number;
    timer: ReturnType<typeof setTimeout>;
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif']);
const TEXT_EXTENSIONS = new Set([
    '.txt', '.text', '.md', '.markdown', '.rst', '.adoc', '.csv', '.tsv', '.log',
    '.json', '.jsonc', '.json5', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf', '.xml',
    '.html', '.htm', '.css', '.scss', '.sass', '.less', '.js', '.jsx', '.mjs', '.cjs',
    '.ts', '.tsx', '.vue', '.svelte', '.py', '.pyw', '.rs', '.go', '.java', '.kt', '.kts',
    '.c', '.h', '.cc', '.hh', '.cpp', '.hpp', '.cs', '.fs', '.php', '.rb', '.sh', '.bash',
    '.bat', '.cmd', '.ps1', '.sql', '.env.example', '.properties', '.gradle', '.swift',
    '.m', '.mm', '.r', '.R', '.ipynb', '.make', '.mk', '.dockerignore', '.gitignore',
    '.gitattributes', '.editorconfig', '.lock', '.diff', '.patch', '.proto', '.graphql',
]);
const TEXT_FILENAMES = new Set(['dockerfile', 'makefile', 'justfile', 'gemfile', 'procfile']);

function isTextFile(path: string): boolean {
    const name = basename(path).toLowerCase();
    return TEXT_FILENAMES.has(name)
        || name === '.env'
        || name.startsWith('.env.')
        || TEXT_EXTENSIONS.has(extname(name));
}

function isImageFile(path: string): boolean {
    return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

function decodeText(bytes: Uint8Array): string {
    let encoding = 'utf-8';
    let content = bytes;
    if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        content = bytes.subarray(3);
    } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
        encoding = 'utf-16le';
        content = bytes.subarray(2);
    } else if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
        encoding = 'utf-16be';
        content = bytes.subarray(2);
    }
    try {
        const text = new TextDecoder(encoding, { fatal: true }).decode(content);
        if (text.includes('\0')) throw new TypeError('文本附件包含二进制空字符。');
        return text;
    } catch {
        throw new TypeError('文本附件编码无效；仅接受严格 UTF-8 或带 BOM 的 UTF-16，不会替换或截断内容。');
    }
}

function toBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let offset = 0; offset < bytes.length; offset += 0x2000) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + 0x2000)));
    }
    return btoa(binary);
}

function sourceLimitError(kind: 'image' | 'text'): RangeError {
    return kind === 'image'
        ? new RangeError('单张图片不能超过 5 MiB。')
        : new RangeError('单个文本附件不能超过 256 KiB。');
}

function plainDescriptor(payload: NativeAttachmentPayload): NativeAttachmentDescriptor {
    const { data: _data, ...descriptor } = payload;
    return { ...descriptor };
}

function copyPayload(payload: NativeAttachmentPayload): NativeAttachmentPayload {
    return { ...payload };
}

function checkedStringArray(value: unknown, maximum: number, message: string): string[] {
    if (!Array.isArray(value) || value.length > maximum) throw new TypeError(message);
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new TypeError(message);
    }
    const result: string[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') throw new TypeError(message);
        result.push(descriptor.value);
    }
    return result;
}

export class AttachmentStore {
    private readonly registry = new Map<string, RegistryEntry>();

    async preparePaths(paths: string[]): Promise<NativeAttachmentDescriptor[]> {
        const selectedPaths = checkedStringArray(paths, NATIVE_ATTACHMENT_LIMITS.maxFilesPerBatch, '单次最多添加 8 个有效附件路径。');

        const staged: StagedAttachment[] = [];
        let batchImageBytes = 0;
        let batchTextBytes = 0;
        for (const path of selectedPaths) {
            const item = await this.readSelectedPath(path);
            staged.push(item);
            if (item.payload.kind === 'image') batchImageBytes += item.sourceBytes;
            if (item.payload.kind === 'text') batchTextBytes += item.sourceBytes;
            if (batchImageBytes > NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerBatch) throw new RangeError('单次图片附件总量不能超过 10 MiB。');
            if (batchTextBytes > NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerBatch) throw new RangeError('单次文本附件总量不能超过 512 KiB。');
        }
        const payloads = validateAttachments(staged.map(item => item.payload));
        this.commit(payloads);
        return payloads.map(plainDescriptor);
    }

    prepareImage(name: string, bytes: Uint8Array): NativeAttachmentDescriptor {
        if (!(bytes instanceof Uint8Array)) throw new TypeError('图片附件数据格式无效。');
        if (typeof name !== 'string' || !name.trim() || name.length > 512 || /[\u0000-\u001f\u007f]/.test(name)) {
            throw new TypeError('附件名称无效。');
        }
        if (bytes.length > NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerFile) throw sourceLimitError('image');
        const snapshot = Uint8Array.from(bytes);
        const payload = validateAttachments([{
            id: randomUUID(),
            name,
            kind: 'image',
            size: snapshot.length,
            mimeType: detectNativeAttachmentImageMime(snapshot),
            data: toBase64(snapshot),
        }])[0]!;
        this.commit([payload]);
        return plainDescriptor(payload);
    }

    resolve(ids: string[]): NativeAttachmentPayload[] {
        const references = checkedStringArray(ids, NATIVE_ATTACHMENT_LIMITS.maxFilesPerBatch, '附件引用无效；单次最多解析 8 个不重复附件。');
        if (new Set(references).size !== references.length) {
            throw new TypeError('附件引用无效；单次最多解析 8 个不重复附件。');
        }
        const now = Date.now();
        const expired = references.some(id => {
            const entry = this.registry.get(id);
            return entry !== undefined && entry.expiresAt <= now;
        });
        this.pruneExpired(now);
        if (expired) throw new Error('附件已过期，请重新添加。');
        const entries = references.map(id => this.registry.get(id));
        if (entries.some(entry => !entry)) throw new Error('附件不存在或已释放，请重新添加。');
        return validateAttachments(entries.map(entry => copyPayload(entry!.payload)));
    }

    release(ids: string[]): void {
        const references = checkedStringArray(ids, NATIVE_ATTACHMENT_LIMITS.maxRegistryItems, '附件释放引用无效。');
        if (new Set(references).size !== references.length) {
            throw new TypeError('附件释放引用无效。');
        }
        this.pruneExpired(Date.now());
        for (const id of references) this.deleteEntry(id);
    }

    private async readSelectedPath(path: string): Promise<StagedAttachment> {
        if (!isAbsolute(path) || path.includes('\0')) throw new TypeError('附件路径必须是绝对路径。');
        let before;
        try { before = await lstat(path); }
        catch { throw new Error('无法读取所选附件；请确认文件仍存在并重新选择。'); }
        if (before.isSymbolicLink()) throw new TypeError('不允许添加符号链接。');
        if (!before.isFile()) throw new TypeError('只允许添加普通文件，不能添加目录或特殊文件。');

        const flags = constants.O_RDONLY | ((constants as typeof constants & { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0);
        let handle;
        try { handle = await open(path, flags); }
        catch { throw new Error('无法打开所选附件；请确认文件仍可读取。'); }
        try {
            const opened = await handle.stat();
            if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
                throw new Error('附件在打开时发生变化，请重新选择。');
            }
            let currentPath;
            try { currentPath = await lstat(path); }
            catch { throw new Error('附件在打开时发生变化，请重新选择。'); }
            if (currentPath.isSymbolicLink() || !currentPath.isFile()
                || currentPath.dev !== opened.dev || currentPath.ino !== opened.ino || currentPath.size !== opened.size) {
                throw new Error('附件在打开时发生变化，请重新选择。');
            }
            if (!Number.isSafeInteger(opened.size) || opened.size < 0) throw new RangeError('附件大小超出支持范围。');

            const name = basename(path);
            if (isImageFile(path)) {
                if (opened.size > NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerFile) throw sourceLimitError('image');
                const bytes = await handle.readFile();
                const afterRead = await handle.stat();
                if (bytes.length !== opened.size || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
                    throw new Error('图片附件在读取时发生变化，请重新选择。');
                }
                const payload = validateAttachments([{
                    id: randomUUID(), name, kind: 'image', size: bytes.length,
                    mimeType: detectNativeAttachmentImageMime(bytes), data: toBase64(bytes),
                }])[0]!;
                return { payload, sourceBytes: opened.size };
            }

            if (isTextFile(path)) {
                if (opened.size > NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerFile) throw sourceLimitError('text');
                const bytes = await handle.readFile();
                const afterRead = await handle.stat();
                if (bytes.length !== opened.size || afterRead.size !== opened.size || afterRead.mtimeMs !== opened.mtimeMs) {
                    throw new Error('文本附件在读取时发生变化，请重新选择。');
                }
                const data = decodeText(bytes);
                const payload = validateAttachments([{
                    id: randomUUID(), name, kind: 'text', size: new TextEncoder().encode(data).length,
                    mimeType: 'text/plain', data,
                }])[0]!;
                return { payload, sourceBytes: opened.size };
            }

            const payload = validateAttachments([{
                id: randomUUID(), name, kind: 'file', size: opened.size, path: resolve(path),
            }])[0]!;
            return { payload, sourceBytes: opened.size };
        } finally {
            await handle.close();
        }
    }

    private commit(payloads: NativeAttachmentPayload[]): void {
        this.pruneExpired(Date.now());
        const retainedBytes = (payload: NativeAttachmentPayload) => payload.kind === 'file' ? 0 : payload.size;
        const currentBytes = [...this.registry.values()].reduce((total, entry) => total + retainedBytes(entry.payload), 0);
        const addedBytes = payloads.reduce((total, payload) => total + retainedBytes(payload), 0);
        if (this.registry.size + payloads.length > NATIVE_ATTACHMENT_LIMITS.maxRegistryItems) {
            throw new RangeError('附件暂存最多保留 32 项，请先释放已发送附件。');
        }
        if (currentBytes + addedBytes > NATIVE_ATTACHMENT_LIMITS.maxRegistryBytes) {
            throw new RangeError('附件暂存总量不能超过 30 MiB，请先释放已发送附件。');
        }

        for (const payload of payloads) {
            const stored = copyPayload(payload);
            const expiresAt = Date.now() + NATIVE_ATTACHMENT_LIMITS.ttlMs;
            const timer = setTimeout(() => {
                const current = this.registry.get(stored.id);
                if (current?.expiresAt === expiresAt) this.registry.delete(stored.id);
            }, NATIVE_ATTACHMENT_LIMITS.ttlMs);
            timer.unref?.();
            this.registry.set(stored.id, { payload: stored, expiresAt, timer });
        }
    }

    private pruneExpired(now: number): void {
        for (const [id, entry] of this.registry) {
            if (entry.expiresAt <= now) this.deleteEntry(id);
        }
    }

    private deleteEntry(id: string): void {
        const entry = this.registry.get(id);
        if (!entry) return;
        clearTimeout(entry.timer);
        this.registry.delete(id);
    }
}
