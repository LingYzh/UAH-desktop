import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { artifactToolDefinitions, executeArtifactRead } from '../../src/runtime/artifact-tools';
import type { ArtifactReference } from '../../src/shared/harness-contracts';
import type { ToolCall } from '../../src/shared/tool-protocol';

const signal = new AbortController().signal;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
function reference(bytes: Buffer): Extract<ArtifactReference, { availability: 'present' }> {
    const sha256 = hash(bytes); return { availability: 'present', relativePath: `artifacts/${sha256}.bin`, sha256, byteLength: bytes.length, mediaType: 'application/octet-stream', missingReason: null };
}
function call(args: unknown): ToolCall { return { id: 'artifact-read-fixture', name: 'read_artifact_range', arguments: JSON.stringify(args) }; }
function page(bytes: Buffer, args: Record<string, unknown> = {}) {
    const ref = reference(bytes); const result = executeArtifactRead(call({ sha256: ref.sha256, ...args }), [ref], () => bytes, signal);
    assert.equal(result.isError, undefined, result.content); return JSON.parse(result.content) as Record<string, unknown>;
}
test('UTF-8 ranges count UTF-16 and preserve emoji without splitting pairs', () => {
    const bytes = Buffer.from('A😀中文B'); const first = page(bytes, { offset: 0, limit: 2 });
    assert.deepEqual(first, { sha256: hash(bytes), encoding: 'utf8', offsetUnit: 'utf16', offset: 0, nextOffset: 1, totalLength: 6, text: 'A', truncated: true });
    const emoji = page(bytes, { offset: 1, limit: 1 }); assert.equal(emoji.text, '😀'); assert.equal(emoji.nextOffset, 3);
    const final = page(bytes, { offset: 3, limit: 65536 }); assert.equal(final.text, '中文B'); assert.equal(final.nextOffset, null); assert.equal(final.truncated, false);
    const ref = reference(bytes); const split = executeArtifactRead(call({ sha256: ref.sha256, offset: 2 }), [ref], () => bytes, signal); assert.equal(split.isError, true); assert.match(split.content, /surrogate/);
    assert.equal(page(bytes, { offset: 6 }).text, ''); assert.equal(page(bytes, { offset: 6 }).nextOffset, null);
});
test('UTF-8 BOM is disclosed and excluded from text offsets; raw base64 retains BOM exactly', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('😀hello')]);
    const text = page(bytes, { limit: 2 }); assert.equal(text.encoding, 'utf8-bom'); assert.equal(text.text, '😀'); assert.equal(text.totalLength, 7);
    const raw = page(bytes, { encoding: 'base64' }); assert.equal(raw.offsetUnit, 'bytes'); assert.equal(raw.totalLength, bytes.length); assert.deepEqual(Buffer.from(raw.base64 as string, 'base64'), bytes);
});
test('binary requires explicit base64, pages bytes and never silently replaces invalid UTF-8', () => {
    const bytes = Buffer.from([0x41, 0x42, 0xff, 0x00, 0x80]); const ref = reference(bytes);
    const invalid = executeArtifactRead(call({ sha256: ref.sha256, limit: 1 }), [ref], () => bytes, signal);
    assert.equal(invalid.isError, true); assert.match(invalid.content, /base64/); assert.match(invalid.content, /UTF-8/);
    const parts: Buffer[] = []; let offset = 0;
    for (;;) { const result = page(bytes, { encoding: 'base64', offset, limit: 2 }); assert.equal(result.encoding, 'base64'); assert.equal(result.offsetUnit, 'bytes'); parts.push(Buffer.from(result.base64 as string, 'base64')); if (result.nextOffset === null) break; offset = result.nextOffset as number; }
    assert.deepEqual(Buffer.concat(parts), bytes);
    const empty = page(bytes, { encoding: 'base64', offset: bytes.length }); assert.equal(empty.base64, ''); assert.equal(empty.nextOffset, null);
});
test('unknown/cross-session/unavailable hashes never invoke disk callback', () => {
    const bytes = Buffer.from('session-owned output'); const ref = reference(bytes); let reads = 0;
    const read = () => { reads++; return bytes; };
    for (const refs of [[], [{ ...ref, sha256: '0'.repeat(64) }], [{ ...ref, availability: 'missing', missingReason: 'not present' }]] as ArtifactReference[][]) {
        const result = executeArtifactRead(call({ sha256: ref.sha256 }), refs, read, signal); assert.equal(result.isError, true); assert.match(result.content, /authorized/);
    }
    assert.equal(reads, 0);
});
test('restricted/provider and arbitrary-path references are denied before reading', () => {
    const bytes = Buffer.from('restricted fixture'); const ref = reference(bytes); let reads = 0;
    for (const invalid of [{ ...ref, relativePath: `restricted/${ref.sha256}.json` }, { ...ref, mediaType: 'application/vnd.uah.restricted+json' }, { ...ref, relativePath: 'C:/private/output.bin' }, { ...ref, relativePath: `artifacts/../restricted/${ref.sha256}.bin` }, { ...ref, relativePath: `artifacts/${'0'.repeat(64)}.bin` }]) {
        const result = executeArtifactRead(call({ sha256: ref.sha256 }), [invalid], () => { reads++; return bytes; }, signal); assert.equal(result.isError, true); assert.match(result.content, /Restricted|invalid/);
    }
    assert.equal(reads, 0);
});
test('every page independently checks actual raw hash and byte size', () => {
    const bytes = Buffer.from('complete verified artifact'); const ref = reference(bytes);
    for (const returned of [Buffer.from('complete changed! artifact'), bytes.subarray(1)]) {
        const result = executeArtifactRead(call({ sha256: ref.sha256, offset: 1, limit: 1 }), [ref], () => returned, signal); assert.equal(result.isError, true); assert.match(result.content, /integrity/);
    }
    const mismatch = executeArtifactRead(call({ sha256: ref.sha256 }), [{ ...ref, byteLength: bytes.length + 1 }], () => bytes, signal); assert.equal(mismatch.isError, true);
    assert.equal(page(bytes, { sha256: ref.sha256.toUpperCase() }).sha256, ref.sha256);
});
test('64 MiB hard raw bound validates reference before read and callback bytes afterwards', () => {
    const bytes = Buffer.from('small'); const ref = reference(bytes); let reads = 0;
    const tooLarge = executeArtifactRead(call({ sha256: ref.sha256 }), [{ ...ref, byteLength: 64 * 1024 * 1024 + 1 }], () => { reads++; return bytes; }, signal); assert.equal(tooLarge.isError, true); assert.equal(reads, 0);
    const max = Buffer.alloc(64 * 1024 * 1024, 0x41); const maxRef = reference(max);
    const exact = executeArtifactRead(call({ sha256: maxRef.sha256, encoding: 'base64', offset: max.length - 1, limit: 1 }), [maxRef], () => max, signal); assert.equal(exact.isError, undefined, exact.content); assert.equal(JSON.parse(exact.content).base64, 'QQ==');
    const oversized = executeArtifactRead(call({ sha256: maxRef.sha256 }), [maxRef], () => Buffer.alloc(max.length + 1), signal); assert.equal(oversized.isError, true); assert.match(oversized.content, /64 MiB/);
});
test('strict arguments reject caller paths/refs, invalid ranges/modes and unsupported calls', () => {
    const bytes = Buffer.from('fixture'); const ref = reference(bytes); let reads = 0; const read = () => { reads++; return bytes; };
    for (const args of [null, [], { sha256: 'wrong' }, { sha256: ref.sha256, path: 'private' }, { sha256: ref.sha256, ref }, ...[-1, 67108865, 0.5, null].map(offset => ({ sha256: ref.sha256, offset })), ...[0, 65537, 0.5, null].map(limit => ({ sha256: ref.sha256, limit })), { sha256: ref.sha256, encoding: 'ascii' }, { sha256: ref.sha256, encoding: null }]) assert.equal(executeArtifactRead(call(args), [ref], read, signal).isError, true);
    assert.equal(executeArtifactRead({ ...call({ sha256: ref.sha256 }), name: 'read_file' }, [ref], read, signal).isError, true);
    assert.equal(executeArtifactRead({ ...call({ sha256: ref.sha256 }), arguments: '{' }, [ref], read, signal).isError, true); assert.equal(reads, 0);
    assert.equal(executeArtifactRead(call({ sha256: ref.sha256, offset: 8 }), [ref], read, signal).isError, true);
    assert.equal(executeArtifactRead(call({ sha256: ref.sha256, offset: 8, encoding: 'base64' }), [ref], read, signal).isError, true);
});
test('cancellation and callback failure return safe errors without leaking private diagnostics', () => {
    const bytes = Buffer.from('fixture'); const ref = reference(bytes); const controller = new AbortController(); controller.abort(); let reads = 0;
    const cancelled = executeArtifactRead(call({ sha256: ref.sha256 }), [ref], () => { reads++; return bytes; }, controller.signal); assert.equal(cancelled.isError, true); assert.match(cancelled.content, /cancelled/); assert.equal(reads, 0);
    const duringRead = new AbortController(); const stopped = executeArtifactRead(call({ sha256: ref.sha256 }), [ref], () => { duringRead.abort(); return bytes; }, duringRead.signal); assert.equal(stopped.isError, true); assert.match(stopped.content, /cancelled/);
    const failed = executeArtifactRead(call({ sha256: ref.sha256 }), [ref], () => { throw new Error('C:/private/secret-output.bin PRIVATE_CREDENTIAL'); }, signal); assert.equal(failed.isError, true); assert.equal(failed.content.includes('private'), false); assert.equal(failed.content.includes('PRIVATE_CREDENTIAL'), false);
});
test('public schema explicitly distinguishes units and forbids arbitrary paths', () => {
    const definition = artifactToolDefinitions[0]; assert.equal(definition.name, 'read_artifact_range'); assert.equal(definition.parameters.additionalProperties, false); assert.deepEqual(definition.parameters.required, ['sha256']);
    assert.match(definition.description, /UTF-16/); assert.match(definition.description, /RAW BYTE/); assert.match(definition.description, /base64/); assert.match(definition.description, /Restricted/);
});
