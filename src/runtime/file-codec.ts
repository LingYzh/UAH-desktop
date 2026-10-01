import { createHash } from 'node:crypto';

export type FileEncoding = 'utf8' | 'utf8-bom';
/** Strict decoding: never guess a legacy encoding or silently replace invalid bytes. */
export function decodeFileBytes(bytes: Buffer): { text: string; encoding: FileEncoding } {
    const bom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
    const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bom ? bytes.subarray(3) : bytes);
    return { text, encoding: bom ? 'utf8-bom' : 'utf8' };
}
export function encodeFileText(text: string, encoding: FileEncoding): Buffer {
    const bytes = Buffer.from(text, 'utf8');
    return encoding === 'utf8-bom' ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]) : bytes;
}
export function rawFileHash(bytes: Buffer): string { return createHash('sha256').update(bytes).digest('hex'); }
