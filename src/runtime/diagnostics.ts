import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const MAX_FILES = 4;
const MAX_CODE_LENGTH = 100;
const CODE = /^[a-zA-Z0-9_.\/-]+$/;
const PROTOCOLS = new Set(['openai-chat', 'openai-responses', 'anthropic']);
const OPERATIONS = new Set(['models', 'stream', 'test']);
const STRING_FIELDS = ['reason', 'contentType', 'shape', 'method', 'route', 'outcome'] as const;
const NUMBER_FIELDS = ['status', 'elapsedMs', 'bytes', 'count', 'index', 'limit', 'page'] as const;
const PROMPT_CODE = /^[a-z][a-z0-9_.-]{0,99}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROMPT_PROFILES = new Set(['gpt', 'claude', 'coding', 'generic']);

export interface PromptAssemblySummary {
    runId: string;
    round: number;
    profile: string;
    totalCharacters: number;
    modules: Array<{ id: string; version: number; included: boolean; reason: string; characters: number }>;
}

export interface DiagnosticFields {
    status?: number;
    elapsedMs?: number;
    bytes?: number;
    count?: number;
    index?: number;
    limit?: number;
    page?: number;
    reason?: string;
    contentType?: string;
    shape?: string;
    method?: string;
    route?: string;
    outcome?: string;
}

interface DiagnosticDestination {
    directory: string;
    maxBytes: number;
}

let destination: DiagnosticDestination | null = null;
let warningIssued = false;

function warnOnce(): void {
    if (warningIssued) {
        return;
    }
    warningIssued = true;
    console.warn('Runtime diagnostics unavailable.');
}

function code(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 && value.length <= MAX_CODE_LENGTH && CODE.test(value)
        ? value
        : undefined;
}

function fieldValue(fields: unknown, name: string): unknown {
    try {
        if (!fields || typeof fields !== 'object' || !Object.hasOwn(fields, name)) {
            return undefined;
        }
        return (fields as Record<string, unknown>)[name];
    } catch {
        return undefined;
    }
}

function sanitizeFields(fields: unknown): DiagnosticFields {
    const result: DiagnosticFields = {};
    for (const name of NUMBER_FIELDS) {
        const value = fieldValue(fields, name);
        if (typeof value === 'number' && Number.isFinite(value)) {
            result[name] = value;
        }
    }
    for (const name of STRING_FIELDS) {
        const value = code(fieldValue(fields, name));
        if (value !== undefined) {
            result[name] = value;
        }
    }
    return result;
}

function nonnegativeNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function promptCode(value: unknown): string | undefined {
    return typeof value === 'string' && value.length <= MAX_CODE_LENGTH && PROMPT_CODE.test(value) ? value : undefined;
}

/** Records metadata only; arbitrary input properties and prompt text are never serialized. */
export function recordPromptAssembly(protocol: string, summary: PromptAssemblySummary): void {
    try {
        const fields: Record<string, unknown> = {};
        const runId = fieldValue(summary, 'runId');
        if (typeof runId === 'string' && runId.length === 36 && UUID.test(runId)) {
            fields.runId = runId;
        }
        for (const name of ['round', 'totalCharacters']) {
            const value = nonnegativeNumber(fieldValue(summary, name));
            if (value !== undefined) {
                fields[name] = value;
            }
        }
        const profile = fieldValue(summary, 'profile');
        if (typeof profile === 'string' && PROMPT_PROFILES.has(profile)) {
            fields.profile = profile;
        }
        const modules = fieldValue(summary, 'modules');
        const safeModules: PromptAssemblySummary['modules'] = [];
        if (Array.isArray(modules)) {
            for (let index = 0; index < Math.min(modules.length, 32); index += 1) {
                const module = fieldValue(modules, String(index));
                const id = promptCode(fieldValue(module, 'id'));
                const reason = promptCode(fieldValue(module, 'reason'));
                const version = nonnegativeNumber(fieldValue(module, 'version'));
                const characters = nonnegativeNumber(fieldValue(module, 'characters'));
                const included = fieldValue(module, 'included');
                if (id !== undefined && reason !== undefined && version !== undefined && characters !== undefined && typeof included === 'boolean') {
                    safeModules.push({ id, version, included, reason, characters });
                }
            }
        }
        fields.modules = safeModules;
        append(`${JSON.stringify({
            time: new Date().toISOString(),
            requestId: randomUUID(),
            operation: 'prompt',
            protocol: PROTOCOLS.has(protocol) ? protocol : 'unknown',
            event: 'prompt.assembled',
            fields,
        })}\n`);
    } catch {
        // Hostile accessors/proxies and logging failures must never interrupt a request.
    }
}

function rotate(directory: string): void {
    const current = join(directory, 'runtime.jsonl');
    const oldest = join(directory, `runtime.${MAX_FILES - 1}.jsonl`);
    if (existsSync(oldest)) {
        unlinkSync(oldest);
    }
    for (let index = MAX_FILES - 2; index >= 1; index -= 1) {
        const source = join(directory, `runtime.${index}.jsonl`);
        if (existsSync(source)) {
            renameSync(source, join(directory, `runtime.${index + 1}.jsonl`));
        }
    }
    if (existsSync(current)) {
        renameSync(current, join(directory, 'runtime.1.jsonl'));
    }
}

function append(line: string): void {
    if (!destination) {
        return;
    }
    try {
        mkdirSync(destination.directory, { recursive: true });
        const current = join(destination.directory, 'runtime.jsonl');
        const bytes = Buffer.byteLength(line, 'utf8');
        if (existsSync(current) && statSync(current).size > 0 && statSync(current).size + bytes > destination.maxBytes) {
            rotate(destination.directory);
        }
        appendFileSync(current, line, 'utf8');
    } catch {
        warnOnce();
    }
}

/** Sets the process-wide, local-only diagnostic destination. */
export function configureDiagnostics(directory: string, options?: { maxBytes?: number }): void {
    const configuredMax = options?.maxBytes;
    destination = {
        directory: join(resolve(directory), 'logs'),
        maxBytes: typeof configuredMax === 'number' && Number.isFinite(configuredMax) && configuredMax > 0
            ? Math.floor(configuredMax)
            : DEFAULT_MAX_BYTES,
    };
    warningIssued = false;
}

/** Creates a request-correlated trace that records only bounded diagnostic codes and numbers. */
export function createDiagnosticTrace(
    operation: 'models' | 'stream' | 'test',
    protocol: string,
): { id: string; event(event: string, fields?: DiagnosticFields): void } {
    const id = randomUUID();
    const safeOperation = OPERATIONS.has(operation) ? operation : 'unknown';
    const safeProtocol = PROTOCOLS.has(protocol) ? protocol : 'unknown';
    return {
        id,
        event(event: string, fields?: DiagnosticFields): void {
            const safeEvent = code(event) ?? 'invalid';
            append(`${JSON.stringify({
                time: new Date().toISOString(),
                requestId: id,
                operation: safeOperation,
                protocol: safeProtocol,
                event: safeEvent,
                fields: sanitizeFields(fields),
            })}\n`);
        },
    };
}
