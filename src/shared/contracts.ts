export interface RuntimeConfig {
    runtimeId: string;
    modelId: string;
    agentId: string;
    policyVersion: number;
}

export interface SessionRecord {
    id: string;
    title: string;
    directory: string | null;
    requested: RuntimeConfig;
    createdAt: string;
}

export type RunState =
    | 'running'
    | 'approval'
    | 'cancelRequested'
    | 'stopping'
    | 'stopped'
    | 'completed'
    | 'failed';

export interface RunRecord {
    id: string;
    sessionId: string;
    turnId: string;
    state: RunState;
    input: string;
    output: string;
    effective: RuntimeConfig;
    sequence: number;
    error?: string;
    createdAt: string;
}

export interface ApprovalIdentity {
    runtimeId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    requestId: string;
    policyVersion: number;
}

export interface ApprovalRecord extends ApprovalIdentity {
    status: 'pending' | 'approved' | 'rejected' | 'expired';
    summary: string;
    path: string;
    createdAt: string;
}

export interface ArtifactSnapshot {
    id: string;
    sessionId: string;
    runId: string;
    turnId: string;
    path: string;
    oldContent: string | null;
    newContent: string;
    hash: string;
    createdAt: string;
}

export interface Snapshot {
    sessions: SessionRecord[];
    runs: RunRecord[];
    approvals: ApprovalRecord[];
    artifacts: ArtifactSnapshot[];
}

export type Command =
    | { type: 'snapshot' }
    | { type: 'create-session'; title: string; directory: string | null }
    | { type: 'start-run'; sessionId: string; input: string }
    | { type: 'stop-run'; runId: string }
    | {
          type: 'resolve-approval';
          identity: ApprovalIdentity;
          decision: 'approve' | 'reject';
      };

type EventEnvelope<TType extends string, TPayload> = {
    runtimeId: string;
    sessionId: string;
    runId: string;
    turnId: string;
    sequence: number;
    type: TType;
    payload: TPayload;
};

export type RuntimeEvent =
    | EventEnvelope<'run-state', { run: RunRecord }>
    | EventEnvelope<'delta', { text: string }>
    | EventEnvelope<'approval-requested', { approval: ApprovalRecord }>
    | EventEnvelope<'approval-resolved', { approval: ApprovalRecord }>
    | EventEnvelope<'artifact-created', { artifact: ArtifactSnapshot }>
    | EventEnvelope<'session-created', { session: SessionRecord }>;

export type BrowserAction =
    | { type: 'open'; url: string; sessionId: string }
    | {
          type: 'bounds';
          sessionId: string;
          x: number;
          y: number;
          width: number;
          height: number;
      }
    | { type: 'hide' }
    | { type: 'close' };

export interface BrowserState {
    url: string;
    visible: boolean;
    error?: string;
}

export interface DesktopBridge {
    command(command: Command): Promise<Snapshot>;
    onEvent(listener: (event: RuntimeEvent) => void): () => void;
    setWindowTheme(theme: 'light' | 'dark'): Promise<void>;
    chooseDirectory(): Promise<string | null>;
    observeDesktop(): Promise<unknown>;
    browser(action: BrowserAction): Promise<BrowserState>;
}

const MAX_ID_LENGTH = 200;
const MAX_TITLE_LENGTH = 200;
const MAX_INPUT_LENGTH = 100_000;

function fail(message: string): never {
    throw new TypeError(`Invalid runtime command: ${message}`);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }

    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(
    value: unknown,
    requiredKeys: readonly string[],
    field: string,
): asserts value is Record<string, unknown> {
    if (!isPlainRecord(value)) {
        fail(`${field} must be a plain object`);
    }

    const actualKeys = Reflect.ownKeys(value);
    const expected = new Set(requiredKeys);
    const missing = requiredKeys.filter((key) => !Object.hasOwn(value, key));
    const unknown = actualKeys.filter((key) => typeof key !== 'string' || !expected.has(key));
    if (missing.length > 0 || unknown.length > 0) {
        const details = [
            missing.length > 0 ? `missing ${missing.join(', ')}` : '',
            unknown.length > 0 ? `unknown ${unknown.map(String).join(', ')}` : '',
        ]
            .filter(Boolean)
            .join('; ');
        fail(`${field} has ${details}`);
    }

    for (const key of actualKeys) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor)) {
            fail(`${field}.${String(key)} must be a data property`);
        }
    }
}

function readString(value: unknown, field: string, maximumLength = MAX_ID_LENGTH): string {
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximumLength) {
        fail(`${field} must be a non-empty string of at most ${maximumLength} characters`);
    }
    return value;
}

function readInput(value: unknown): string {
    if (typeof value !== 'string' || value.length > MAX_INPUT_LENGTH) {
        fail(`input must be a string of at most ${MAX_INPUT_LENGTH} characters`);
    }
    return value;
}

function readPolicyVersion(value: unknown): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
        fail('identity.policyVersion must be a non-negative safe integer');
    }
    return value as number;
}

function parseApprovalIdentity(value: unknown): ApprovalIdentity {
    assertExactKeys(
        value,
        ['runtimeId', 'sessionId', 'runId', 'turnId', 'requestId', 'policyVersion'],
        'identity',
    );

    return {
        runtimeId: readString(value.runtimeId, 'identity.runtimeId'),
        sessionId: readString(value.sessionId, 'identity.sessionId'),
        runId: readString(value.runId, 'identity.runId'),
        turnId: readString(value.turnId, 'identity.turnId'),
        requestId: readString(value.requestId, 'identity.requestId'),
        policyVersion: readPolicyVersion(value.policyVersion),
    };
}

/** Validates the renderer-to-runtime protocol and rejects all extra fields. */
export function parseCommand(value: unknown): Command {
    if (!isPlainRecord(value) || typeof value.type !== 'string') {
        fail('command must be an object with a type');
    }

    switch (value.type) {
        case 'snapshot': {
            assertExactKeys(value, ['type'], 'command');
            return { type: 'snapshot' };
        }
        case 'create-session': {
            assertExactKeys(value, ['type', 'title', 'directory'], 'command');
            if (value.directory !== null && typeof value.directory !== 'string') {
                fail('directory must be a string or null');
            }
            if (typeof value.directory === 'string' && value.directory.length > 32_000) {
                fail('directory is too long');
            }

            return {
                type: 'create-session',
                title: readString(value.title, 'title', MAX_TITLE_LENGTH),
                directory: value.directory as string | null,
            };
        }
        case 'start-run': {
            assertExactKeys(value, ['type', 'sessionId', 'input'], 'command');
            const input = readInput(value.input);
            if (input.trim().length === 0) {
                fail('input must not be empty');
            }

            return {
                type: 'start-run',
                sessionId: readString(value.sessionId, 'sessionId'),
                input,
            };
        }
        case 'stop-run': {
            assertExactKeys(value, ['type', 'runId'], 'command');
            return {
                type: 'stop-run',
                runId: readString(value.runId, 'runId'),
            };
        }
        case 'resolve-approval': {
            assertExactKeys(value, ['type', 'identity', 'decision'], 'command');
            if (value.decision !== 'approve' && value.decision !== 'reject') {
                fail('decision must be approve or reject');
            }

            return {
                type: 'resolve-approval',
                identity: parseApprovalIdentity(value.identity),
                decision: value.decision,
            };
        }
        default:
            fail(`unknown command type ${value.type}`);
    }
}
