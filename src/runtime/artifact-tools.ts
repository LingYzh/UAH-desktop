import { createHash } from 'node:crypto';
import type { ArtifactReference } from '../shared/harness-contracts';
import type { ToolCall, ToolDefinition } from '../shared/tool-protocol';
import { decodeFileBytes } from './file-codec';

const MAX_RAW_BYTES = 64 * 1024 * 1024;
const MAX_PAGE = 65536;
export const artifactToolDefinitions: ToolDefinition[] = [{
    name: 'read_artifact_range',
    description: 'Read a public artifact already authorized by a durable tool outcome in this session, using its raw-byte SHA-256. No paths or caller-supplied references are accepted. The complete raw artifact is verified before every page, maximum 64 MiB. Default utf8 strictly decodes the whole artifact, removes an initial UTF-8 BOM (reported as utf8-bom), and uses UTF-16 code-unit offsets/limits; a page never splits a surrogate pair (limit 1 may return 2 units). Invalid UTF-8 fails; explicitly choose base64 for binary or legacy-encoded output. Base64 mode uses RAW BYTE offsets/limits and returns unchanged bytes as base64. Mode changes require choosing the new mode’s offset units explicitly; never reuse a UTF-16 offset as a byte offset. Returns JSON {sha256,encoding,offsetUnit,offset,nextOffset,totalLength,text|base64,truncated}; nextOffset is null at EOF and truncated means more pages remain. Restricted provider/request artifacts are unavailable.',
    parameters: { type: 'object', additionalProperties: false, required: ['sha256'], properties: {
        sha256: { type: 'string', pattern: '^[a-fA-F0-9]{64}$', description: 'Required raw artifact SHA-256 supplied by an authorized tool outcome.' },
        offset: { type: 'integer', minimum: 0, maximum: MAX_RAW_BYTES, description: 'Default 0. UTF-16 code-unit index for utf8; RAW BYTE index for base64. Must not exceed the decoded/raw length. UTF-8 mode cannot start inside a surrogate pair.' },
        limit: { type: 'integer', minimum: 1, maximum: MAX_PAGE, description: 'Default 16000. Maximum UTF-16 code units for utf8 (surrogate-safe, limit 1 may return 2), or maximum RAW BYTES for base64.' },
        encoding: { type: 'string', enum: ['utf8', 'base64'], description: 'Default utf8: strict whole-artifact UTF-8 decode, offsets are UTF-16. Explicit base64: no decoding, offsets are bytes.' },
    } },
}];
class ArtifactReadFailure extends Error {}
function fail(message: string): never { throw new ArtifactReadFailure(message); }
const aborted = (signal: AbortSignal) => { if (signal.aborted) fail('Artifact read cancelled.'); };
const isLow = (value: number) => value >= 0xdc00 && value <= 0xdfff;

/** The caller owns session authorization and disk access; this module never searches disk. */
export function executeArtifactRead(call: ToolCall, authorizedRefs: ArtifactReference[], read: (ref: ArtifactReference) => Buffer, signal: AbortSignal): { content: string; isError?: boolean } {
    try {
        aborted(signal);
        if (call.name !== 'read_artifact_range' || typeof call.arguments !== 'string' || call.arguments.length > 8192) fail('Invalid artifact read request.');
        let args: Record<string, unknown>;
        try { args = JSON.parse(call.arguments); } catch { fail('Artifact read arguments must be JSON.'); }
        if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !['sha256', 'offset', 'limit', 'encoding'].includes(key))) fail('Invalid artifact read fields; paths and references are not accepted.');
        if (typeof args.sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(args.sha256)) fail('Invalid artifact SHA-256.');
        const sha256 = args.sha256.toLowerCase();
        const offset = args.offset === undefined ? 0 : args.offset;
        const limit = args.limit === undefined ? 16000 : args.limit;
        const mode = args.encoding === undefined ? 'utf8' : args.encoding;
        if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset > MAX_RAW_BYTES
            || typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE
            || !['utf8', 'base64'].includes(mode as string)) fail('Invalid artifact range or encoding.');
        const ref = authorizedRefs.find(item => item.availability === 'present' && typeof item.sha256 === 'string' && item.sha256.toLowerCase() === sha256);
        if (!ref || ref.availability !== 'present') fail('Artifact is not authorized and available in this session.');
        if (/restricted/i.test(ref.mediaType) || !/^artifacts\/[a-fA-F0-9]{64}\.(bin|json)$/.test(ref.relativePath)
            || ref.relativePath.split('/')[1].split('.')[0].toLowerCase() !== sha256 || ref.missingReason !== null) fail('Restricted or invalid artifact reference.');
        if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 0 || ref.byteLength > MAX_RAW_BYTES) fail('Artifact exceeds the 64 MiB raw size limit or has invalid size evidence.');
        const bytes = read(ref);
        aborted(signal);
        if (!Buffer.isBuffer(bytes) || bytes.length > MAX_RAW_BYTES) fail('Artifact exceeds the 64 MiB raw size limit or returned invalid bytes.');
        if (bytes.length !== ref.byteLength || createHash('sha256').update(bytes).digest('hex') !== sha256) fail('Artifact integrity mismatch; stored bytes differ from authorized evidence.');
        if (mode === 'base64') {
            if (offset > bytes.length) fail('Artifact byte offset exceeds raw length.');
            const end = Math.min(bytes.length, offset + limit); const truncated = end < bytes.length;
            return { content: JSON.stringify({ sha256, encoding: 'base64', offsetUnit: 'bytes', offset, nextOffset: truncated ? end : null, totalLength: bytes.length, base64: bytes.subarray(offset, end).toString('base64'), truncated }) };
        }
        let decoded: ReturnType<typeof decodeFileBytes>;
        try { decoded = decodeFileBytes(bytes); } catch { fail('Artifact is not valid UTF-8. Explicitly choose encoding "base64" to read raw bytes.'); }
        const { text, encoding } = decoded!;
        if (offset > text.length) fail('Artifact UTF-16 offset exceeds decoded length.');
        if (offset < text.length && isLow(text.charCodeAt(offset))) fail('Artifact UTF-16 offset splits a surrogate pair.');
        let end = Math.min(text.length, offset + limit);
        if (end < text.length && isLow(text.charCodeAt(end))) end = end - offset === 1 ? end + 1 : end - 1;
        const truncated = end < text.length;
        aborted(signal);
        return { content: JSON.stringify({ sha256, encoding, offsetUnit: 'utf16', offset, nextOffset: truncated ? end : null, totalLength: text.length, text: text.slice(offset, end), truncated }) };
    } catch (error) {
        return { content: error instanceof ArtifactReadFailure ? error.message : 'Artifact read failed; verify available artifact evidence.', isError: true };
    }
}
