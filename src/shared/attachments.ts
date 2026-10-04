export const NATIVE_ATTACHMENT_LIMITS = Object.freeze({
    maxFilesPerBatch: 8,
    maxImageBytesPerFile: 5 * 1024 * 1024,
    maxImageBytesPerBatch: 10 * 1024 * 1024,
    maxTextBytesPerFile: 256 * 1024,
    maxTextBytesPerBatch: 512 * 1024,
    maxRegistryItems: 32,
    maxRegistryBytes: 30 * 1024 * 1024,
    ttlMs: 30 * 60 * 1000,
});

export type NativeAttachmentKind = 'image' | 'text' | 'file';

export interface NativeAttachmentPayload {
    id: string;
    name: string;
    kind: NativeAttachmentKind;
    size: number;
    path?: string;
    mimeType?: string;
    data?: string;
}

export type NativeAttachmentDescriptor = Omit<NativeAttachmentPayload, 'data'>;

const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64_PATTERN = /^[A-Za-z0-9+/]*={0,2}$/;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function ownDataRecord(value: unknown, allowed: readonly string[]): Record<string, unknown> {
    if (!isPlainRecord(value)) throw new TypeError('附件格式无效。');
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string' || !allowed.includes(key)) throw new TypeError('附件包含未知字段。');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) throw new TypeError('附件字段格式无效。');
        result[key] = descriptor.value;
    }
    return result;
}

function denseArray(value: unknown): unknown[] {
    if (!Array.isArray(value)) throw new TypeError('附件列表格式无效。');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== value.length + 1 || keys.some(key => key !== 'length'
        && (typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length))) {
        throw new TypeError('附件列表不能包含空项或额外字段。');
    }
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor || !('value' in descriptor)) throw new TypeError('附件列表格式无效。');
        result.push(descriptor.value);
    }
    return result;
}

function wellFormedUnicode(value: string): boolean {
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code >= 0xd800 && code <= 0xdbff) {
            const next = value.charCodeAt(index + 1);
            if (next < 0xdc00 || next > 0xdfff) return false;
            index += 1;
        } else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
}

function decodedBase64(value: string, expectedSize: number): Uint8Array {
    const maxEncodedLength = Math.ceil(NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerFile / 3) * 4;
    if (!value || value.length > maxEncodedLength || value.length % 4 !== 0 || !BASE64_PATTERN.test(value)) {
        throw new TypeError('图片附件的 Base64 数据无效。');
    }
    const paddingIndex = value.indexOf('=');
    if (paddingIndex >= 0 && (value.length - paddingIndex > 2 || paddingIndex < value.length - 2)) {
        throw new TypeError('图片附件的 Base64 数据无效。');
    }
    const padding = paddingIndex < 0 ? 0 : value.length - paddingIndex;
    if (value.length / 4 * 3 - padding !== expectedSize) throw new TypeError('图片附件大小与数据不一致。');
    let binary: string;
    try { binary = atob(value); }
    catch { throw new TypeError('图片附件的 Base64 数据无效。'); }
    if (btoa(binary) !== value) throw new TypeError('图片附件的 Base64 数据无效。');
    return Uint8Array.from(binary, character => character.charCodeAt(0));
}

export function detectNativeAttachmentImageMime(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) throw new TypeError('图片附件数据格式无效。');
    if (bytes.length >= 8
        && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
        && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
    if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
    if (bytes.length >= 6) {
        const signature = String.fromCharCode(...bytes.subarray(0, 6));
        if (signature === 'GIF87a' || signature === 'GIF89a') return 'image/gif';
    }
    if (bytes.length >= 12
        && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
        && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return 'image/webp';
    throw new TypeError('图片格式不受支持；仅支持 PNG、JPEG、WebP 或 GIF。');
}

function absolutePath(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && !value.includes('\0')
        && (value.startsWith('/') || /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value));
}

function validMimeType(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\u0000-\u001f\u007f]/.test(value);
}

function parseOne(value: unknown): NativeAttachmentPayload {
    const record = ownDataRecord(value, ['id', 'name', 'kind', 'size', 'path', 'mimeType', 'data']);
    if (typeof record.id !== 'string' || !UUID_PATTERN.test(record.id)) throw new TypeError('附件标识无效。');
    if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 512 || /[\u0000-\u001f\u007f]/.test(record.name)) {
        throw new TypeError('附件名称无效。');
    }
    if (record.kind !== 'image' && record.kind !== 'text' && record.kind !== 'file') throw new TypeError('附件类型无效。');
    if (typeof record.size !== 'number' || !Number.isSafeInteger(record.size) || record.size < 0) throw new TypeError('附件大小无效。');

    if (record.kind === 'image') {
        if (Object.hasOwn(record, 'path') || typeof record.data !== 'string' || !validMimeType(record.mimeType)) {
            throw new TypeError('图片附件字段无效。');
        }
        if (!IMAGE_MIME_TYPES.has(record.mimeType)) throw new TypeError('图片 MIME 类型不受支持。');
        if (record.size > NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerFile) throw new RangeError('单张图片不能超过 5 MiB。');
        const bytes = decodedBase64(record.data, record.size);
        if (detectNativeAttachmentImageMime(bytes) !== record.mimeType) throw new TypeError('图片魔数与 MIME 类型不一致。');
        return { id: record.id, name: record.name, kind: 'image', size: record.size, mimeType: record.mimeType, data: record.data };
    }

    if (record.kind === 'text') {
        if (Object.hasOwn(record, 'path') || typeof record.data !== 'string') throw new TypeError('文本附件字段无效。');
        if (record.mimeType !== undefined && record.mimeType !== 'text/plain') throw new TypeError('文本附件 MIME 类型无效。');
        if (record.data.length > NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerFile
            || !wellFormedUnicode(record.data) || record.data.includes('\0')) throw new TypeError('文本附件包含无效字符或超过大小上限。');
        const size = new TextEncoder().encode(record.data).length;
        if (size !== record.size) throw new TypeError('文本附件大小与数据不一致。');
        if (size > NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerFile) throw new RangeError('单个文本附件不能超过 256 KiB。');
        return { id: record.id, name: record.name, kind: 'text', size, ...(record.mimeType === undefined ? {} : { mimeType: 'text/plain' }), data: record.data };
    }

    if (!absolutePath(record.path) || Object.hasOwn(record, 'data')) throw new TypeError('文件附件必须使用绝对路径引用且不能携带文件内容。');
    if (record.mimeType !== undefined && !validMimeType(record.mimeType)) throw new TypeError('文件附件 MIME 类型无效。');
    return { id: record.id, name: record.name, kind: 'file', size: record.size, path: record.path, ...(record.mimeType === undefined ? {} : { mimeType: record.mimeType }) };
}

export function validateAttachments(value: unknown): NativeAttachmentPayload[] {
    if (!Array.isArray(value) || value.length > NATIVE_ATTACHMENT_LIMITS.maxFilesPerBatch) {
        throw new RangeError('单次最多添加 8 个附件。');
    }
    const attachments = denseArray(value).map(parseOne);
    if (new Set(attachments.map(item => item.id)).size !== attachments.length) throw new TypeError('附件标识不能重复。');
    const imageBytes = attachments.filter(item => item.kind === 'image').reduce((total, item) => total + item.size, 0);
    const textBytes = attachments.filter(item => item.kind === 'text').reduce((total, item) => total + item.size, 0);
    if (imageBytes > NATIVE_ATTACHMENT_LIMITS.maxImageBytesPerBatch) throw new RangeError('单次图片附件总量不能超过 10 MiB。');
    if (textBytes > NATIVE_ATTACHMENT_LIMITS.maxTextBytesPerBatch) throw new RangeError('单次文本附件总量不能超过 512 KiB。');
    return attachments;
}
