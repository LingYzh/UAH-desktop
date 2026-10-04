import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { once } from 'node:events';
import { type NativeCodexSettings, parseNativeCodexSettings } from '../shared/native-codex';
import { redactJournalValue } from './journal-artifacts';

const MAX_LINE_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const INTERRUPT_TIMEOUT_MS = 10_000;
const CLOSE_TIMEOUT_MS = 5_000;
const MODEL_PAGE_SIZE = 100;
const MAX_MODEL_PAGES = 50;
const MAX_DYNAMIC_ARGUMENT_BYTES = 128 * 1024;
const MAX_DYNAMIC_OUTPUT_BYTES = 128 * 1024;
const MAX_DYNAMIC_CALLS_PER_RUN = 256;
const MAX_USER_INPUT_QUESTIONS = 8;
const MAX_USER_INPUT_OPTIONS = 32;
const MAX_USER_INPUT_TEXT_BYTES = 4 * 1024;
const MAX_USER_INPUT_ANSWER_BYTES = 16 * 1024;
const MAX_USER_INPUT_TOTAL_ANSWER_BYTES = 64 * 1024;
const DYNAMIC_TOOL_FAILURE_TEXT = 'The dynamic tool call could not be completed.';
const DYNAMIC_TOOL_TRUNCATION_SUFFIX = '\n[Output truncated: exceeded 128 KiB.]';

type JsonRecord = Record<string, unknown>;
type RpcId = string | number;
type RpcPending = {
    method: string;
    resolve(value: unknown): void;
    reject(error: Error): void;
    timeout: ReturnType<typeof setTimeout>;
};

export type NativeCodexMode = 'readonly' | 'manual' | 'accept-edits' | 'auto' | 'bypass' | 'plan';
export type NativeThreadGoalStatus = 'active' | 'paused' | 'blocked' | 'usageLimited' | 'budgetLimited' | 'complete';

export interface NativeThreadGoal {
    objective: string;
    status: NativeThreadGoalStatus;
    tokenBudget: number | null;
    tokensUsed: number;
    timeUsedSeconds: number;
    threadId: string;
}

export type NativeGoalCommand =
    | { type: 'set'; objective: string; tokenBudget?: number }
    | { type: 'get' | 'pause' | 'resume' | 'clear' };

export interface NativeDynamicTool {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

export interface NativeUserQuestion {
    id: string;
    header: string;
    question: string;
    options?: Array<{ label: string; description: string }> | null;
    isOther?: boolean;
    isSecret?: boolean;
}

export interface CodexAppServerRunOptions {
    input: string;
    imagePaths?: string[];
    cwd: string;
    model: string;
    mode: NativeCodexMode;
    threadId?: string;
    signal: AbortSignal;
    config?: Record<string, unknown>;
    developerInstructions?: string;
    reasoningEffort?: string;
    collaborationMode?: 'default' | 'plan';
    goalCommand?: NativeGoalCommand;
    trackGoal?: boolean;
    requestUserInput?: (
        questions: NativeUserQuestion[],
        identity: { threadId: string; turnId: string; itemId: string },
    ) => Promise<Record<string, { answers: string[] }>>;
    dynamicTools?: NativeDynamicTool[];
    callTool?: (name: string, args: unknown, identity: { threadId: string; turnId: string; callId: string }) => Promise<{ content: string; isError?: boolean }>;
    onText(text: string): void | Promise<void>;
    onEvent(method: string, params: unknown): void | Promise<void>;
    onThread(threadId: string, turnId?: string): void | Promise<void>;
    approve(summary: string, resource: string): Promise<boolean>;
}

export interface CodexAppServerRunResult {
    threadId: string;
    turnId?: string;
    status: 'completed';
    goal?: NativeThreadGoal | null;
    usage?: {
        inputTokens?: number;
        outputTokens?: number;
        cachedInputTokens?: number;
    };
}

export interface CodexAppServerProbeResult {
    version: string;
    models: Array<{ id: string; name: string; isDefault?: boolean }>;
    authenticated: boolean;
    accountType: string | null;
}

interface ModelEntry {
    id: string;
    name: string;
    model: string;
    supportedReasoningEfforts: string[];
    isDefault?: boolean;
}

interface TurnCompletion {
    threadId: string;
    turnId: string;
    status: 'completed' | 'interrupted' | 'failed';
}

type ActiveOutcome =
    | { kind: 'completed'; completion: TurnCompletion }
    | { kind: 'failed'; error: Error };

interface Deferred<T> {
    promise: Promise<T>;
    resolve(value: T): void;
}

interface ActiveRun {
    options: CodexAppServerRunOptions;
    dynamicTools: Map<string, NativeDynamicTool>;
    dynamicCalls: Map<string, DynamicToolCallEntry>;
    pendingDynamicResponses: Set<Promise<void>>;
    activeItemIds: Set<string>;
    earlyTokenUsage: Map<string, { usage: NonNullable<CodexAppServerRunResult['usage']>; params: JsonRecord }>;
    pendingBoundTokenUsage: { turnId: string; params: JsonRecord } | null;
    dynamicToolAbort: Deferred<void>;
    dynamicToolsCancelled: boolean;
    threadId: string | null;
    turnId: string | null;
    turnStartSent: boolean;
    usageTurnTrusted: boolean;
    usage?: CodexAppServerRunResult['usage'];
    outcome: Deferred<ActiveOutcome>;
    turnReady: Deferred<void>;
    settled: boolean;
    abortRequested: boolean;
    interruptPromise?: Promise<void>;
}

interface DynamicToolCallOutput {
    content: string;
    success: boolean;
}

interface DynamicToolCallEntry {
    fingerprint: string;
    result: Promise<DynamicToolCallOutput>;
}

interface CloseResult {
    code: number | null;
    signal: NodeJS.Signals | null;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>(done => { resolve = done; });
    return { promise, resolve };
}

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateDynamicTools(tools: NativeDynamicTool[] | undefined): Map<string, NativeDynamicTool> {
    if (tools === undefined) return new Map();
    if (!Array.isArray(tools)) throw new TypeError('Native Codex dynamic tools must be an array.');
    const validated = new Map<string, NativeDynamicTool>();
    for (const value of tools) {
        if (!isRecord(value)
            || typeof value.name !== 'string' || value.name.trim() === ''
            || typeof value.description !== 'string'
            || !isRecord(value.inputSchema)) {
            throw new TypeError('Native Codex dynamic tool definitions are invalid.');
        }
        if (validated.has(value.name)) throw new TypeError('Native Codex dynamic tool names must be unique.');
        validated.set(value.name, {
            name: value.name,
            description: value.description,
            inputSchema: value.inputSchema,
        });
    }
    return validated;
}

function canonicalJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalJson);
    if (!isRecord(value)) return value;
    const result: JsonRecord = Object.create(null) as JsonRecord;
    for (const key of Object.keys(value).sort()) result[key] = canonicalJson(value[key]);
    return result;
}

function boundedDynamicOutput(content: string): string {
    if (Buffer.byteLength(content, 'utf8') <= MAX_DYNAMIC_OUTPUT_BYTES) return content;
    const prefixLimit = MAX_DYNAMIC_OUTPUT_BYTES - Buffer.byteLength(DYNAMIC_TOOL_TRUNCATION_SUFFIX, 'utf8');
    let prefix = '';
    let prefixBytes = 0;
    for (const character of content) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (prefixBytes + characterBytes > prefixLimit) break;
        prefix += character;
        prefixBytes += characterBytes;
    }
    return `${prefix}${DYNAMIC_TOOL_TRUNCATION_SUFFIX}`;
}

function dynamicToolResponse(output: DynamicToolCallOutput): JsonRecord {
    return {
        contentItems: [{ type: 'inputText', text: output.content }],
        success: output.success,
    };
}

function own(record: JsonRecord, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function requiredString(value: unknown, context: string): string {
    if (typeof value !== 'string' || value.length === 0) throw new Error(`Invalid app-server ${context}.`);
    return value;
}

function protocolError(message: string): Error {
    return new Error(`Native Codex app-server protocol error: ${message}`);
}

function abortError(): Error {
    const error = new Error('Native Codex turn was interrupted.');
    error.name = 'AbortError';
    return error;
}

function excerpt(value: unknown, max = 8_000): string {
    if (typeof value !== 'string') return '';
    return value.length <= max ? value : `${value.slice(0, max)}…`;
}

function textField(record: JsonRecord, key: string): string | null {
    return typeof record[key] === 'string' && record[key] !== '' ? record[key] as string : null;
}

function turnPolicy(mode: NativeCodexMode, cwd: string): {
    approvalPolicy: 'never' | 'on-request';
    sandbox: 'read-only' | 'workspace-write' | 'danger-full-access';
    sandboxPolicy: JsonRecord;
} {
    if (mode === 'readonly') {
        return {
            approvalPolicy: 'never',
            sandbox: 'read-only',
            sandboxPolicy: { type: 'readOnly', networkAccess: false },
        };
    }
    if (mode === 'bypass') {
        return {
            approvalPolicy: 'never',
            sandbox: 'danger-full-access',
            sandboxPolicy: { type: 'dangerFullAccess' },
        };
    }
    return {
        approvalPolicy: 'on-request',
        sandbox: 'workspace-write',
        sandboxPolicy: { type: 'workspaceWrite', writableRoots: [cwd], networkAccess: false },
    };
}

const NATIVE_GOAL_STATUSES: readonly NativeThreadGoalStatus[] = [
    'active', 'paused', 'blocked', 'usageLimited', 'budgetLimited', 'complete',
];

function validateGoalCommand(value: unknown): NativeGoalCommand | undefined {
    if (value === undefined) return undefined;
    if (!isRecord(value) || typeof value.type !== 'string') throw new TypeError('Native Codex goal command is invalid.');
    if (value.type === 'set') {
        if (typeof value.objective !== 'string' || value.objective.trim() === '') {
            throw new TypeError('Native Codex goal objective must be a non-empty string.');
        }
        if (own(value, 'tokenBudget') && (typeof value.tokenBudget !== 'number'
            || !Number.isSafeInteger(value.tokenBudget) || value.tokenBudget < 0)) {
            throw new TypeError('Native Codex goal token budget must be a nonnegative safe integer.');
        }
        return {
            type: 'set', objective: value.objective,
            ...(own(value, 'tokenBudget') ? { tokenBudget: value.tokenBudget as number } : {}),
        };
    }
    if (value.type === 'get' || value.type === 'pause' || value.type === 'resume' || value.type === 'clear') {
        return { type: value.type };
    }
    throw new TypeError('Unsupported native Codex goal command.');
}

function validateNativeThreadGoal(value: unknown, expectedThreadId: string): NativeThreadGoal {
    if (!isRecord(value)
        || typeof value.objective !== 'string'
        || typeof value.status !== 'string' || !NATIVE_GOAL_STATUSES.includes(value.status as NativeThreadGoalStatus)
        || value.threadId !== expectedThreadId
        || typeof value.createdAt !== 'number' || !Number.isSafeInteger(value.createdAt) || value.createdAt < 0
        || typeof value.updatedAt !== 'number' || !Number.isSafeInteger(value.updatedAt) || value.updatedAt < 0
        || typeof value.tokensUsed !== 'number' || !Number.isSafeInteger(value.tokensUsed) || value.tokensUsed < 0
        || typeof value.timeUsedSeconds !== 'number' || !Number.isSafeInteger(value.timeUsedSeconds) || value.timeUsedSeconds < 0
        || (own(value, 'tokenBudget') && value.tokenBudget !== null
            && (typeof value.tokenBudget !== 'number' || !Number.isSafeInteger(value.tokenBudget) || value.tokenBudget < 0))) {
        throw protocolError('thread goal response is invalid or does not match the active thread.');
    }
    return {
        objective: value.objective,
        status: value.status as NativeThreadGoalStatus,
        tokenBudget: typeof value.tokenBudget === 'number' ? value.tokenBudget : null,
        tokensUsed: value.tokensUsed,
        timeUsedSeconds: value.timeUsedSeconds,
        threadId: value.threadId,
    };
}

function boundedString(value: unknown): value is string {
    return typeof value === 'string'
        && value.trim() !== ''
        && Buffer.byteLength(value, 'utf8') <= MAX_USER_INPUT_TEXT_BYTES;
}

function validateNativeUserQuestions(value: unknown): NativeUserQuestion[] | null {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_USER_INPUT_QUESTIONS) return null;
    const ids = new Set<string>();
    const questions: NativeUserQuestion[] = [];
    for (const entry of value) {
        if (!isRecord(entry)
            || !boundedString(entry.id)
            || !boundedString(entry.header)
            || !boundedString(entry.question)
            || (own(entry, 'isOther') && typeof entry.isOther !== 'boolean')
            || (own(entry, 'isSecret') && typeof entry.isSecret !== 'boolean')) return null;
        if (ids.has(entry.id)) return null;
        ids.add(entry.id);
        let options: Array<{ label: string; description: string }> | null | undefined;
        if (own(entry, 'options')) {
            if (entry.options === null) options = null;
            else if (Array.isArray(entry.options) && entry.options.length <= MAX_USER_INPUT_OPTIONS) {
                options = [];
                for (const option of entry.options) {
                    if (!isRecord(option) || !boundedString(option.label) || !boundedString(option.description)) return null;
                    options.push({ label: option.label, description: option.description });
                }
            } else return null;
        }
        questions.push({
            id: entry.id,
            header: entry.header,
            question: entry.question,
            ...(options === undefined ? {} : { options }),
            ...(own(entry, 'isOther') ? { isOther: entry.isOther as boolean } : {}),
            ...(own(entry, 'isSecret') ? { isSecret: entry.isSecret as boolean } : {}),
        });
    }
    return questions;
}

function validateUserInputAnswers(value: unknown, questions: NativeUserQuestion[]): Record<string, { answers: string[] }> | null {
    if (!isRecord(value)) return null;
    const allowedIds = new Set(questions.map(question => question.id));
    const result: Record<string, { answers: string[] }> = Object.create(null) as Record<string, { answers: string[] }>;
    let totalBytes = 0;
    for (const [id, answer] of Object.entries(value)) {
        if (!allowedIds.has(id) || !isRecord(answer) || !Array.isArray(answer.answers) || answer.answers.length > 32) return null;
        const answers: string[] = [];
        for (const text of answer.answers) {
            if (typeof text !== 'string') return null;
            const bytes = Buffer.byteLength(text, 'utf8');
            totalBytes += bytes;
            if (bytes > MAX_USER_INPUT_ANSWER_BYTES || totalBytes > MAX_USER_INPUT_TOTAL_ANSWER_BYTES) return null;
            answers.push(text);
        }
        result[id] = { answers };
    }
    return result;
}

function tokenUsageFromParams(params: JsonRecord): NonNullable<CodexAppServerRunResult['usage']> | null {
    const tokenUsage = params.tokenUsage;
    if (!isRecord(tokenUsage) || !isRecord(tokenUsage.last)) return null;
    const usage: NonNullable<CodexAppServerRunResult['usage']> = {};
    for (const key of ['inputTokens', 'outputTokens', 'cachedInputTokens'] as const) {
        const value = tokenUsage.last[key];
        if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) usage[key] = value;
    }
    return Object.keys(usage).length > 0 ? usage : null;
}

function accountModel(account: unknown): { authenticated: boolean; accountType: string | null } {
    if (account === null) return { authenticated: false, accountType: null };
    if (!isRecord(account) || typeof account.type !== 'string') throw protocolError('account/read returned an invalid account.');
    if (!['apiKey', 'chatgpt', 'amazonBedrock'].includes(account.type)) throw protocolError('account/read returned an unknown account type.');
    return { authenticated: true, accountType: account.type };
}

export class CodexAppServer {
    readonly settings: NativeCodexSettings;

    #child: ChildProcessWithoutNullStreams | null = null;
    #startPromise: Promise<void> | null = null;
    #userAgent: string | null = null;
    #nextRequestId = 1;
    #pendingRequests = new Map<RpcId, RpcPending>();
    #stdoutPartial = Buffer.alloc(0);
    #pendingInputBytes = 0;
    #messageChain = Promise.resolve();
    #transportFailure: Error | null = null;
    #closing = false;
    #childExited = false;
    #closed: Deferred<CloseResult> | null = null;
    #activeRun: ActiveRun | null = null;

    constructor(settings: NativeCodexSettings) {
        this.settings = parseNativeCodexSettings(settings);
    }

    hasExited(): boolean {
        return this.#child === null || this.#childExited;
    }

    async probe(): Promise<CodexAppServerProbeResult> {
        await this.#ensureReady();
        const models = await this.#listModels();
        const accountResponse = await this.#request('account/read', {});
        if (!isRecord(accountResponse) || !own(accountResponse, 'account')) {
            throw protocolError('account/read returned an invalid response.');
        }
        const account = accountModel(accountResponse.account);
        return {
            version: this.#userAgent ?? 'unknown',
            models: models.map(({ model, name, isDefault }) => ({ id: model, name, ...(isDefault === undefined ? {} : { isDefault }) })),
            authenticated: account.authenticated,
            accountType: account.accountType,
        };
    }

    async #requestAbortable(method: string, params: JsonRecord, signal: AbortSignal): Promise<unknown> {
        if (signal.aborted) throw abortError();
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<never>((_resolve, reject) => {
            abortListener = () => reject(abortError());
            signal.addEventListener('abort', abortListener, { once: true });
        });
        try {
            return await Promise.race([this.#request(method, params), aborted]);
        } finally {
            if (abortListener) signal.removeEventListener('abort', abortListener);
        }
    }

    async #getGoal(threadId: string, signal: AbortSignal): Promise<NativeThreadGoal | null> {
        const response = await this.#requestAbortable('thread/goal/get', { threadId }, signal);
        if (!isRecord(response)) throw protocolError('thread/goal/get returned an invalid response.');
        if (!own(response, 'goal') || response.goal === null) return null;
        return validateNativeThreadGoal(response.goal, threadId);
    }

    async #setGoal(threadId: string, params: JsonRecord, signal: AbortSignal): Promise<NativeThreadGoal> {
        const response = await this.#requestAbortable('thread/goal/set', { threadId, ...params }, signal);
        if (!isRecord(response) || !own(response, 'goal')) throw protocolError('thread/goal/set returned an invalid response.');
        return validateNativeThreadGoal(response.goal, threadId);
    }

    async #clearGoal(threadId: string, signal: AbortSignal): Promise<boolean> {
        const response = await this.#requestAbortable('thread/goal/clear', { threadId }, signal);
        if (!isRecord(response) || typeof response.cleared !== 'boolean') {
            throw protocolError('thread/goal/clear returned an invalid response.');
        }
        return response.cleared;
    }

    async #executeGoalCommand(
        command: NativeGoalCommand,
        threadId: string,
        signal: AbortSignal,
    ): Promise<{ goal: NativeThreadGoal | null; cleared?: boolean }> {
        if (command.type === 'get') return { goal: await this.#getGoal(threadId, signal) };
        if (command.type === 'set') {
            return { goal: await this.#setGoal(threadId, {
                objective: command.objective,
                status: 'active',
                ...(command.tokenBudget === undefined ? {} : { tokenBudget: command.tokenBudget }),
            }, signal) };
        }
        if (command.type === 'pause') return { goal: await this.#setGoal(threadId, { status: 'paused' }, signal) };
        if (command.type === 'resume') return { goal: await this.#setGoal(threadId, { status: 'active' }, signal) };
        return { goal: null, cleared: await this.#clearGoal(threadId, signal) };
    }

    #goalSummary(command: NativeGoalCommand, goal: NativeThreadGoal | null, cleared?: boolean): string {
        if (command.type === 'clear') return cleared ? '目标已清除。' : '当前没有目标。';
        if (!goal) return '当前没有目标。';
        if (command.type === 'pause') return `目标已暂停：${goal.objective}`;
        const statusText: Record<NativeThreadGoalStatus, string> = {
            active: '进行中', paused: '已暂停', blocked: '已阻塞', usageLimited: '已达到用量限制',
            budgetLimited: '已达到预算限制', complete: '已完成',
        };
        return `目标状态：${statusText[goal.status]}。目标：${goal.objective}`;
    }

    async run(options: CodexAppServerRunOptions): Promise<CodexAppServerRunResult> {
        this.#assertEnabled();
        if (this.#activeRun) throw new Error('A native Codex turn is already active for this app-server client.');
        if (options.signal.aborted) throw abortError();
        const cwd = await validateWorkingDirectory(options.cwd);
        const input = requiredString(options.input, 'user input');
        const model = requiredString(options.model || this.settings.model, 'model');
        if (!['readonly', 'manual', 'accept-edits', 'auto', 'bypass', 'plan'].includes(options.mode)) {
            throw new TypeError('Unsupported native Codex permission mode.');
        }
        if (options.developerInstructions !== undefined && typeof options.developerInstructions !== 'string') {
            throw new TypeError('Native Codex developer instructions must be a string.');
        }
        if (options.collaborationMode !== undefined && options.collaborationMode !== 'default' && options.collaborationMode !== 'plan') {
            throw new TypeError('Unsupported native Codex collaboration mode.');
        }
        if (options.trackGoal !== undefined && typeof options.trackGoal !== 'boolean') throw new TypeError('Native Codex trackGoal must be a boolean.');
        if (options.config !== undefined && !isRecord(options.config)) throw new TypeError('Native Codex config must be an object.');
        const goalCommand = validateGoalCommand(options.goalCommand);
        const dynamicTools = validateDynamicTools(options.dynamicTools);
        await this.#ensureReady();
        if (options.reasoningEffort !== undefined) await this.#validateReasoningEffort(model, options.reasoningEffort);

        const policy = turnPolicy(options.mode, cwd);
        const active: ActiveRun = {
            options,
            dynamicTools,
            dynamicCalls: new Map(),
            pendingDynamicResponses: new Set(),
            activeItemIds: new Set(),
            earlyTokenUsage: new Map(),
            pendingBoundTokenUsage: null,
            dynamicToolAbort: deferred<void>(),
            dynamicToolsCancelled: false,
            threadId: null,
            turnId: null,
            turnStartSent: false,
            usageTurnTrusted: false,
            outcome: deferred<ActiveOutcome>(),
            turnReady: deferred<void>(),
            settled: false,
            abortRequested: false,
        };
        this.#activeRun = active;
        const onAbort = () => {
            active.abortRequested = true;
            active.dynamicToolsCancelled = true;
            active.dynamicToolAbort.resolve();
            if (active.turnId) void this.#interrupt(active).catch(error => this.#failActive(active, asError(error)));
        };
        options.signal.addEventListener('abort', onAbort, { once: true });

        try {
            const threadParams: JsonRecord = {
                model,
                cwd,
                approvalPolicy: policy.approvalPolicy,
                sandbox: policy.sandbox,
            };
            if (options.config !== undefined) threadParams.config = options.config;
            if (options.developerInstructions !== undefined) threadParams.developerInstructions = options.developerInstructions;
            if (!options.threadId && dynamicTools.size > 0) {
                threadParams.dynamicTools = [...dynamicTools.values()].map(tool => ({
                    type: 'function',
                    name: tool.name,
                    description: tool.description,
                    inputSchema: tool.inputSchema,
                }));
            }
            const threadResponse = options.threadId
                ? await this.#request('thread/resume', { ...threadParams, threadId: requiredString(options.threadId, 'thread id') })
                : await this.#request('thread/start', threadParams);
            const thread = isRecord(threadResponse) ? threadResponse.thread : null;
            if (!isRecord(thread)) throw protocolError('thread start/resume returned no thread.');
            const threadId = requiredString(thread.id, 'thread id');
            if (active.threadId !== null && active.threadId !== threadId) throw protocolError('thread notification did not match the response.');
            active.threadId = threadId;
            await this.#notifyThread(active, threadId);
            if (options.signal.aborted) active.abortRequested = true;

            let commandGoal: NativeThreadGoal | null | undefined;
            if (goalCommand) {
                if (active.abortRequested || options.signal.aborted) throw abortError();
                const result = await this.#executeGoalCommand(goalCommand, threadId, options.signal);
                commandGoal = result.goal;
                if (active.abortRequested || options.signal.aborted) throw abortError();
                if (goalCommand.type === 'get' || goalCommand.type === 'pause' || goalCommand.type === 'clear') {
                    await options.onText(this.#goalSummary(goalCommand, result.goal, result.cleared));
                    return {
                        threadId,
                        status: 'completed',
                        goal: result.goal,
                    };
                }
            }

            const turnParams: JsonRecord = {
                threadId,
                input: [{ type: 'text', text: input }, ...(options.imagePaths ?? []).map(path => ({ type: 'localImage', path }))],
                model,
                cwd,
                approvalPolicy: policy.approvalPolicy,
                sandboxPolicy: policy.sandboxPolicy,
            };
            if (options.reasoningEffort !== undefined) turnParams.effort = options.reasoningEffort;
            if (options.collaborationMode !== undefined) {
                turnParams.collaborationMode = {
                    mode: options.collaborationMode,
                    settings: {
                        model,
                        reasoning_effort: options.reasoningEffort ?? null,
                        developer_instructions: null,
                    },
                };
            }
            if (goalCommand && (active.abortRequested || options.signal.aborted)) throw abortError();
            active.turnStartSent = true;
            const turnStart = this.#request('turn/start', turnParams);
            const startResponse = await turnStart;
            const turn = isRecord(startResponse) ? startResponse.turn : null;
            if (!isRecord(turn)) throw protocolError('turn/start returned no turn.');
            const turnId = requiredString(turn.id, 'turn id');
            if (!['inProgress', 'completed', 'interrupted', 'failed'].includes(String(turn.status))) {
                throw protocolError('turn/start returned an unknown turn status.');
            }
            this.#recordTurn(active, turnId, true);
            await this.#notifyThread(active, threadId, turnId);
            if (active.abortRequested || options.signal.aborted) {
                active.abortRequested = true;
                if (!active.settled) await this.#interrupt(active);
            }

            const outcome = await this.#waitForOutcome(active);
            if (outcome.kind === 'failed') {
                await this.#waitForDynamicResponses(active);
                throw outcome.error;
            }
            if (outcome.completion.status === 'interrupted') {
                await this.#waitForDynamicResponses(active);
                if (active.abortRequested || options.signal.aborted) throw abortError();
                throw new Error('Native Codex turn was interrupted.');
            }
            if (outcome.completion.status === 'failed') {
                await this.#waitForDynamicResponses(active);
                throw new Error('Native Codex turn failed.');
            }
            if (outcome.completion.status !== 'completed') throw protocolError('turn/completed used an unknown terminal status.');
            await this.#waitForDynamicResponses(active);
            const shouldReadGoal = goalCommand?.type === 'set' || goalCommand?.type === 'resume' || options.trackGoal === true;
            const finalGoal = shouldReadGoal ? await this.#getGoal(threadId, options.signal) : undefined;
            return {
                threadId: outcome.completion.threadId,
                turnId: outcome.completion.turnId,
                status: 'completed',
                ...(finalGoal === undefined ? {} : { goal: finalGoal }),
                ...(active.usage ? { usage: active.usage } : {}),
            };
        } catch (error) {
            if (active.settled) {
                const outcome = await active.outcome.promise;
                if (outcome.kind === 'failed') throw outcome.error;
            }
            throw asError(error);
        } finally {
            options.signal.removeEventListener('abort', onAbort);
            if (this.#activeRun === active) this.#activeRun = null;
        }
    }

    async pauseGoal(threadId: string): Promise<NativeThreadGoal | null> {
        this.#assertEnabled();
        if (this.#activeRun) throw new Error('Cannot pause a native Codex goal while a turn is active.');
        const id = requiredString(threadId, 'thread id');
        if (id.trim() === '') throw new TypeError('Native Codex thread id must be a non-empty string.');
        await this.#ensureReady();
        const signal = new AbortController().signal;
        const goal = await this.#getGoal(id, signal);
        if (!goal || goal.status !== 'active') return goal;
        return this.#setGoal(id, { status: 'paused' }, signal);
    }

    async close(): Promise<void> {
        const child = this.#child;
        if (!child) return;
        if (this.#activeRun) throw new Error('Cannot close native Codex app-server while a turn is active.');
        this.#closing = true;
        if (!child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.end();
        const closed = this.#closed;
        if (!closed) throw new Error('Native Codex app-server has no tracked child lifecycle.');
        const result = await withTimeout(closed.promise, CLOSE_TIMEOUT_MS, 'Native Codex app-server did not exit after stdin closed.');
        await this.#messageChain;
        if (this.#stdoutPartial.length > 0) throw protocolError('server exited with an incomplete JSONL line.');
        if (this.#transportFailure) throw this.#transportFailure;
        if (result.code !== 0 || result.signal !== null) throw new Error('Native Codex app-server exited unsuccessfully.');
    }

    #assertEnabled(): void {
        if (!this.settings.enabled) throw new Error('Native Codex is disabled.');
        if (!this.settings.command || !this.settings.model) throw new Error('Native Codex settings are incomplete.');
        if (this.#transportFailure) throw this.#transportFailure;
    }

    async #ensureReady(): Promise<void> {
        // Probe is intentionally allowed before the user chooses a model or enables
        // native execution. It still requires an explicit executable and a healthy
        // transport; only run() applies the enabled/model gate above.
        if (!this.settings.command) throw new Error('Native Codex command is incomplete.');
        if (this.#transportFailure) throw this.#transportFailure;
        if (this.#userAgent !== null) return;
        if (this.#startPromise) return this.#startPromise;
        this.#startPromise = this.#startAndInitialize();
        return this.#startPromise;
    }

    async #startAndInitialize(): Promise<void> {
        const args = [...this.settings.args, 'app-server', '--stdio'];
        let child: ChildProcessWithoutNullStreams;
        try {
            child = spawn(this.settings.command, args, {
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
                shell: false,
            });
        } catch {
            throw new Error('Could not start native Codex app-server.');
        }
        this.#child = child;
        this.#closed = deferred<CloseResult>();
        child.stdout.on('data', chunk => this.#acceptStdout(chunk as Buffer | string));
        child.stderr.on('data', () => { /* stderr is consumed without retaining or exposing its contents. */ });
        child.stdin.on('error', () => this.#fail(new Error('Native Codex app-server input stream failed.')));
        child.once('error', () => this.#fail(new Error('Could not start native Codex app-server.')));
        child.once('close', (code, signal) => {
            this.#childExited = true;
            void this.#messageChain.then(() => {
                if (this.#stdoutPartial.length > 0) this.#fail(protocolError('server exited with an incomplete JSONL line.'));
                if (this.#pendingRequests.size > 0) this.#fail(new Error('Native Codex app-server exited before replying to a request.'));
                if (!this.#closing) this.#fail(new Error('Native Codex app-server exited unexpectedly.'));
                else if (code !== 0 || signal !== null) this.#fail(new Error('Native Codex app-server exited unsuccessfully.'));
                this.#closed?.resolve({ code, signal });
            });
        });

        const response = await this.#request('initialize', {
            clientInfo: { name: 'uah', title: 'UAH', version: '0.1.0' },
            capabilities: { experimentalApi: true },
        });
        if (!isRecord(response) || typeof response.userAgent !== 'string' || response.userAgent.length === 0) {
            throw protocolError('initialize returned no user agent.');
        }
        this.#userAgent = response.userAgent;
        await this.#writeMessage({ method: 'initialized' });
    }

    #request(method: string, params: JsonRecord, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
        if (this.#transportFailure) return Promise.reject(this.#transportFailure);
        const child = this.#child;
        if (!child || child.stdin.destroyed || child.stdin.writableEnded) return Promise.reject(new Error('Native Codex app-server is not available.'));
        const id = this.#nextRequestId++;
        return new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                this.#pendingRequests.delete(id);
                reject(new Error(`Native Codex app-server request timed out (${method}).`));
            }, timeoutMs);
            this.#pendingRequests.set(id, { method, resolve, reject, timeout });
            void this.#writeMessage({ id, method, params }).catch(error => {
                const pending = this.#pendingRequests.get(id);
                if (!pending) return;
                this.#pendingRequests.delete(id);
                clearTimeout(pending.timeout);
                pending.reject(asError(error));
                this.#fail(asError(error));
            });
        });
    }

    async #writeMessage(message: JsonRecord): Promise<void> {
        const child = this.#child;
        if (!child || child.stdin.destroyed || child.stdin.writableEnded) throw new Error('Native Codex app-server input stream is closed.');
        let line: string;
        try {
            line = `${JSON.stringify(message)}\n`;
        } catch {
            throw new Error('Native Codex app-server request could not be encoded.');
        }
        if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) throw new Error('Native Codex app-server request exceeds the JSONL line limit.');
        if (!child.stdin.write(line, 'utf8')) await once(child.stdin, 'drain');
    }

    #acceptStdout(chunk: Buffer | string): void {
        if (this.#transportFailure) return;
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, 'utf8');
        if (this.#pendingInputBytes + bytes.length > MAX_PENDING_BYTES) {
            this.#fail(protocolError('pending JSONL data exceeded the 8 MiB limit.'));
            return;
        }
        this.#pendingInputBytes += bytes.length;
        let offset = 0;
        while (offset < bytes.length) {
            const newline = bytes.indexOf(0x0a, offset);
            if (newline === -1) {
                const tail = bytes.subarray(offset);
                this.#stdoutPartial = this.#stdoutPartial.length === 0 ? Buffer.from(tail) : Buffer.concat([this.#stdoutPartial, tail]);
                if (this.#stdoutPartial.length > MAX_LINE_BYTES) this.#fail(protocolError('JSONL line exceeded the 2 MiB limit.'));
                return;
            }
            const part = bytes.subarray(offset, newline);
            const line = this.#stdoutPartial.length === 0 ? Buffer.from(part) : Buffer.concat([this.#stdoutPartial, part]);
            this.#stdoutPartial = Buffer.alloc(0);
            if (line.length > MAX_LINE_BYTES) {
                this.#fail(protocolError('JSONL line exceeded the 2 MiB limit.'));
                return;
            }
            const accountedBytes = line.length + 1;
            this.#messageChain = this.#messageChain.then(async () => {
                if (!this.#transportFailure) await this.#handleLine(line);
            }).catch(error => this.#fail(asError(error))).finally(() => {
                this.#pendingInputBytes = Math.max(0, this.#pendingInputBytes - accountedBytes);
            });
            offset = newline + 1;
        }
    }

    async #handleLine(bytes: Buffer): Promise<void> {
        const line = bytes.length > 0 && bytes[bytes.length - 1] === 0x0d ? bytes.subarray(0, bytes.length - 1) : bytes;
        let message: unknown;
        try {
            message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(line));
        } catch {
            throw protocolError('server sent invalid UTF-8 JSON.');
        }
        if (!isRecord(message)) throw protocolError('server message must be an object.');
        if (typeof message.method === 'string') {
            if (own(message, 'id')) await this.#handleServerRequest(message);
            else await this.#handleNotification(message.method, message.params);
            return;
        }
        if (own(message, 'result') || own(message, 'error')) {
            this.#handleResponse(message);
            return;
        }
        throw protocolError('server sent an unrecognized message.');
    }

    #handleResponse(message: JsonRecord): void {
        const id = message.id;
        if ((typeof id !== 'number' && typeof id !== 'string') || (typeof id === 'number' && !Number.isFinite(id))) {
            throw protocolError('response id is invalid.');
        }
        const pending = this.#pendingRequests.get(id);
        if (!pending) throw protocolError('server sent a response with an unknown or duplicate id.');
        const hasResult = own(message, 'result');
        const hasError = own(message, 'error');
        if (hasResult === hasError) throw protocolError('response must contain exactly one of result or error.');
        this.#pendingRequests.delete(id);
        clearTimeout(pending.timeout);
        if (hasError) {
            const serverError = isRecord(message.error) ? message.error : null;
            const unsupported = serverError?.code === -32601;
            const code = Number.isSafeInteger(serverError?.code) ? String(serverError!.code) : '未提供';
            // Preserve the server's diagnostic message, not arbitrary error.data
            // (which may contain request bodies or credentials).
            const raw = typeof serverError?.message === 'string' ? serverError.message : '服务端未提供错误详情。';
            const safe = String(redactJournalValue(raw).value)
                .replace(/\bBearer\s+[^\s"'<>]+/gi, 'Bearer [REDACTED]')
                .replace(/\b(authorization|proxy-authorization|x-api-key|api[_-]?key|access_token|refresh_token|password|secret)\s*[=:]\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;]+)(?:\s+[^\s,;]+)?/gi, '$1=[REDACTED]');
            const summary = unsupported ? 'Codex 原生运行时不支持此请求' : 'Codex 原生运行时拒绝了请求';
            const legacy = unsupported ? 'does not support method' : 'rejected request';
            pending.reject(new Error(`${summary}（${pending.method}，错误码：${code}）。\nNative Codex app-server ${legacy} (${pending.method}).\n原始诊断：${excerpt(safe, 8000)}`));
        }
        else pending.resolve(message.result);
    }

    async #handleNotification(method: string, params: unknown): Promise<void> {
        const active = this.#activeRun;
        if (active && method === 'thread/tokenUsage/updated') {
            if (!isRecord(params)) return;
            const threadId = textField(params, 'threadId');
            const turnId = textField(params, 'turnId');
            if (!threadId || !turnId || !active.threadId || threadId !== active.threadId) return;
            const usage = tokenUsageFromParams(params);
            if (!active.usageTurnTrusted) {
                if (usage) {
                    active.earlyTokenUsage.delete(turnId);
                    active.earlyTokenUsage.set(turnId, { usage, params });
                    if (active.earlyTokenUsage.size > 16) {
                        const oldestTurnId = active.earlyTokenUsage.keys().next().value;
                        if (typeof oldestTurnId === 'string') active.earlyTokenUsage.delete(oldestTurnId);
                    }
                }
                return;
            }
            if (turnId !== active.turnId) return;
            await active.options.onEvent(method, params);
            if (usage) active.usage = usage;
            return;
        }
        if (active) await active.options.onEvent(method, params);
        if (!active || !isRecord(params)) return;

        if (method === 'thread/started') {
            const thread = params.thread;
            if (!isRecord(thread) || typeof thread.id !== 'string') throw protocolError('thread/started notification is invalid.');
            if (active.threadId === null) {
                active.threadId = thread.id;
                await this.#notifyThread(active, thread.id);
            }
            return;
        }

        const threadId = textField(params, 'threadId');
        if (!threadId || !active.threadId || threadId !== active.threadId) return;

        if (method === 'item/started' || method === 'item/completed') {
            const turnId = textField(params, 'turnId');
            const item = params.item;
            if (!turnId || !isRecord(item) || typeof item.id !== 'string' || item.id.length === 0) {
                throw protocolError(`${method} notification is invalid.`);
            }
            if (active.turnId === null) {
                this.#recordTurn(active, turnId);
                await this.#notifyThread(active, threadId, turnId);
            }
            if (turnId !== active.turnId) return;
            if (method === 'item/started') active.activeItemIds.add(item.id);
            else active.activeItemIds.delete(item.id);
            return;
        }

        if (method === 'turn/started') {
            const turn = params.turn;
            if (!isRecord(turn)) throw protocolError('turn/started notification is invalid.');
            const turnId = requiredString(turn.id, 'turn id');
            this.#recordTurn(active, turnId, true);
            await this.#notifyThread(active, threadId, turnId);
            return;
        }

        if (method === 'item/agentMessage/delta') {
            const turnId = textField(params, 'turnId');
            const delta = params.delta;
            if (!turnId || typeof delta !== 'string') throw protocolError('agent message delta is invalid.');
            if (active.turnId === null) {
                this.#recordTurn(active, turnId);
                await this.#notifyThread(active, threadId, turnId);
            }
            if (turnId === active.turnId) await active.options.onText(delta);
            return;
        }

        if (method === 'item/plan/delta') {
            const turnId = textField(params, 'turnId');
            const itemId = textField(params, 'itemId');
            const delta = params.delta;
            if (!turnId || !itemId || typeof delta !== 'string') throw protocolError('plan delta notification is invalid.');
            if (active.turnId === null) {
                this.#recordTurn(active, turnId);
                await this.#notifyThread(active, threadId, turnId);
            }
            if (turnId === active.turnId) await active.options.onText(delta);
            return;
        }

        if (method === 'thread/tokenUsage/updated') {
            return;
        }

        if (method === 'turn/completed') {
            const turn = params.turn;
            if (!isRecord(turn)) throw protocolError('turn/completed notification is invalid.');
            const turnId = requiredString(turn.id, 'turn id');
            const status = turn.status;
            if (!['completed', 'interrupted', 'failed'].includes(String(status))) {
                throw protocolError('turn/completed used an unknown terminal status.');
            }
            if (active.turnId !== null && turnId !== active.turnId) return;
            this.#recordTurn(active, turnId);
            const completion: TurnCompletion = { threadId, turnId, status: status as TurnCompletion['status'] };
            this.#settleActive(active, { kind: 'completed', completion });
        }
    }

    async #handleServerRequest(message: JsonRecord): Promise<void> {
        const id = message.id;
        const method = message.method;
        if ((typeof id !== 'number' && typeof id !== 'string') || typeof method !== 'string') {
            throw protocolError('server request id or method is invalid.');
        }
        const params = message.params;
        const active = this.#activeRun;
        if (method === 'item/tool/requestUserInput') {
            const response = this.#handleUserInputRequest(active, id, params).catch(error => {
                const failure = asError(error);
                if (active) this.#failActive(active, failure);
                this.#fail(failure);
            });
            if (active) {
                active.pendingDynamicResponses.add(response);
                void response.finally(() => active.pendingDynamicResponses.delete(response));
            }
            return;
        }
        if (method === 'item/tool/call') {
            const response = this.#handleDynamicToolCall(active, id, params).catch(error => {
                const failure = asError(error);
                if (active) this.#failActive(active, failure);
                this.#fail(failure);
            });
            if (active) {
                active.pendingDynamicResponses.add(response);
                void response.finally(() => active.pendingDynamicResponses.delete(response));
            }
            return;
        }
        if (active) await active.options.onEvent(method, params);
        if (!isRecord(params)) {
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Invalid request parameters.' });
            return;
        }

        if (method === 'mcpServer/elicitation/request') {
            await this.#writeServerResponse(id, { action: 'decline', content: null });
            return;
        }

        if (method === 'item/commandExecution/requestApproval') {
            const command = textField(params, 'command');
            const reason = textField(params, 'reason');
            const summary = excerpt([command, reason].filter(Boolean).join('\n') || 'Codex requests approval to run a command.');
            const resource = textField(params, 'cwd') ?? textField(params, 'threadId') ?? 'Native Codex command';
            const allowed = await this.#approval(active, summary, resource, id);
            await this.#writeServerResponse(id, { decision: allowed ? 'accept' : 'decline' });
            return;
        }

        if (method === 'item/fileChange/requestApproval') {
            const summary = excerpt(textField(params, 'reason') ?? 'Codex requests approval to change files.');
            const resource = textField(params, 'grantRoot') ?? textField(params, 'threadId') ?? 'Native Codex file changes';
            const allowed = await this.#approval(active, summary, resource, id);
            await this.#writeServerResponse(id, { decision: allowed ? 'accept' : 'decline' });
            return;
        }

        if (method === 'item/permissions/requestApproval') {
            const reason = textField(params, 'reason');
            const permissions = isRecord(params.permissions) ? params.permissions : {};
            const summary = excerpt(reason ?? `Codex requests additional permissions: ${JSON.stringify(permissions)}`);
            const resource = textField(params, 'cwd') ?? textField(params, 'threadId') ?? 'Native Codex permissions';
            const allowed = await this.#approval(active, summary, resource, id);
            await this.#writeServerResponse(id, {
                permissions: allowed ? permissions : {},
                scope: 'turn',
            });
            return;
        }

        if (method === 'execCommandApproval') {
            const command = Array.isArray(params.command) ? params.command.filter(item => typeof item === 'string').join(' ') : '';
            const reason = textField(params, 'reason');
            const summary = excerpt([command, reason].filter(Boolean).join('\n') || 'Codex requests approval to run a command.');
            const resource = textField(params, 'cwd') ?? textField(params, 'conversationId') ?? 'Native Codex command';
            const allowed = await this.#approval(active, summary, resource, id);
            await this.#writeServerResponse(id, {
                decision: allowed ? 'approved' : { denied: { rejection: 'The request was denied.' } },
            });
            return;
        }

        if (method === 'applyPatchApproval') {
            const fileChanges = isRecord(params.fileChanges) ? params.fileChanges : {};
            const files = Object.keys(fileChanges).slice(0, 100);
            const reason = textField(params, 'reason');
            const summary = excerpt([reason, `Codex requests approval to change: ${files.join(', ') || 'files'}`].filter(Boolean).join('\n'));
            const resource = files[0] ?? textField(params, 'conversationId') ?? 'Native Codex file changes';
            const allowed = await this.#approval(active, summary, resource, id);
            await this.#writeServerResponse(id, {
                decision: allowed ? 'approved' : { denied: { rejection: 'The request was denied.' } },
            });
            return;
        }

        await this.#writeServerResponse(id, null, { code: -32601, message: 'Unsupported server request.' });
    }

    async #handleUserInputRequest(active: ActiveRun | null, id: RpcId, params: unknown): Promise<void> {
        if (!isRecord(params)) {
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Invalid request parameters.' });
            return;
        }
        const questions = validateNativeUserQuestions(params.questions);
        const threadId = params.threadId;
        const turnId = params.turnId;
        const itemId = params.itemId;
        if (questions === null
            || typeof params.isBlocking !== 'boolean'
            || typeof threadId !== 'string' || threadId.trim() === ''
            || typeof turnId !== 'string' || turnId.trim() === ''
            || typeof itemId !== 'string' || itemId.trim() === '') {
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Invalid user input request parameters.' });
            return;
        }
        if (!active) {
            await this.#writeServerResponse(id, { answers: {} });
            return;
        }
        if ((active.threadId !== null && active.threadId !== threadId)
            || (active.turnId !== null && active.turnId !== turnId)
            || !active.turnStartSent) {
            await this.#writeServerResponse(id, null, { code: -32602, message: 'User input request does not match the active thread, turn, and item.' });
            return;
        }
        if (active.settled || active.abortRequested || active.options.signal.aborted || active.dynamicToolsCancelled) {
            await this.#writeServerResponse(id, { answers: {} });
            return;
        }

        const needsThreadNotification = active.threadId === null || active.turnId === null;
        if (active.threadId === null) active.threadId = threadId;
        if (active.turnId === null) this.#recordTurn(active, turnId);
        const identity = { threadId, turnId, itemId };
        const beforeDispatch = Promise.all([
            Promise.resolve().then(() => active.options.onEvent('item/tool/requestUserInput', params)),
            needsThreadNotification ? this.#notifyThread(active, threadId, turnId) : Promise.resolve(),
        ]);
        const callback = active.options.requestUserInput;
        const execution = beforeDispatch.then(async () => {
            if (!callback || active.settled || active.abortRequested || active.options.signal.aborted || active.dynamicToolsCancelled) {
                return { answers: {} as Record<string, { answers: string[] }> };
            }
            try {
                const answers = await callback(questions, identity);
                const valid = validateUserInputAnswers(answers, questions);
                return { answers: valid ?? {} };
            } catch {
                return { answers: {} as Record<string, { answers: string[] }> };
            }
        }).catch(() => ({ answers: {} as Record<string, { answers: string[] }> }));
        const cancelled = active.dynamicToolAbort.promise.then(() => ({ answers: {} as Record<string, { answers: string[] }> }));
        const result = await Promise.race([execution, cancelled]);
        const answers = active.abortRequested || active.options.signal.aborted || active.dynamicToolsCancelled || active.settled
            ? {} : result.answers;
        await this.#writeServerResponse(id, { answers });
    }

    async #handleDynamicToolCall(active: ActiveRun | null, id: RpcId, params: unknown): Promise<void> {
        const event = active
            ? Promise.resolve().then(() => active.options.onEvent('item/tool/call', params)).then(() => undefined)
            : Promise.resolve();
        if (!isRecord(params)) {
            await event;
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Invalid request parameters.' });
            return;
        }

        const callId = params.callId;
        const tool = params.tool;
        const threadId = params.threadId;
        const turnId = params.turnId;
        const args = params.arguments;
        if (typeof callId !== 'string' || callId.trim() === ''
            || typeof tool !== 'string' || tool.trim() === ''
            || typeof threadId !== 'string' || threadId.trim() === ''
            || typeof turnId !== 'string' || turnId.trim() === ''
            || !isRecord(args)
            || (own(params, 'namespace') && params.namespace !== null && typeof params.namespace !== 'string')) {
            await event;
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Invalid dynamic tool call parameters.' });
            return;
        }
        let serializedArgs: string;
        try {
            serializedArgs = JSON.stringify(args);
        } catch {
            await event;
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Invalid dynamic tool call arguments.' });
            return;
        }
        if (Buffer.byteLength(serializedArgs, 'utf8') > MAX_DYNAMIC_ARGUMENT_BYTES) {
            await event;
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Dynamic tool call arguments exceed the 128 KiB limit.' });
            return;
        }
        if (!active || active.settled || active.abortRequested || active.options.signal.aborted || !active.turnStartSent) {
            await event;
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Dynamic tool call is no longer active.' });
            return;
        }

        if ((active.threadId !== null && active.threadId !== threadId)
            || (active.turnId !== null && active.turnId !== turnId)) {
            await event;
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Dynamic tool call does not match the active thread and turn.' });
            return;
        }
        const needsThreadNotification = active.threadId === null || active.turnId === null;
        if (active.threadId === null) active.threadId = threadId;
        if (active.turnId === null) this.#recordTurn(active, turnId);
        const threadNotification = needsThreadNotification ? this.#notifyThread(active, threadId, turnId) : Promise.resolve();
        if (active.abortRequested || active.options.signal.aborted) {
            await Promise.all([event, threadNotification]);
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Dynamic tool call is no longer active.' });
            return;
        }

        const registered = active.dynamicTools.has(tool);
        if (!registered) {
            await Promise.all([event, threadNotification]);
            await this.#writeServerResponse(id, null, { code: -32601, message: 'Unknown dynamic tool.' });
            return;
        }

        let fingerprint: string;
        try {
            fingerprint = JSON.stringify({ tool, arguments: canonicalJson(args) });
        } catch {
            await Promise.all([event, threadNotification]);
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Invalid dynamic tool call arguments.' });
            return;
        }
        const existing = active.dynamicCalls.get(callId);
        if (existing) {
            if (existing.fingerprint !== fingerprint) {
                await Promise.all([event, threadNotification]);
                await this.#writeServerResponse(id, null, { code: -32602, message: 'Dynamic tool call ID was reused with different arguments.' });
                return;
            }
            await Promise.all([event, threadNotification]);
            await this.#writeServerResponse(id, dynamicToolResponse(await existing.result));
            return;
        }
        if (active.dynamicCalls.size >= MAX_DYNAMIC_CALLS_PER_RUN) {
            await Promise.all([event, threadNotification]);
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Dynamic tool call limit exceeded for this run.' });
            return;
        }
        if (active.abortRequested || active.options.signal.aborted) {
            await Promise.all([event, threadNotification]);
            await this.#writeServerResponse(id, null, { code: -32602, message: 'Dynamic tool call is no longer active.' });
            return;
        }

        const beforeDispatch = Promise.all([event, threadNotification]).then(() => undefined);
        const result = this.#executeDynamicTool(active, tool, args, { threadId, turnId, callId }, beforeDispatch);
        active.dynamicCalls.set(callId, { fingerprint, result });
        await this.#writeServerResponse(id, dynamicToolResponse(await result));
    }

    async #executeDynamicTool(
        active: ActiveRun,
        name: string,
        args: JsonRecord,
        identity: { threadId: string; turnId: string; callId: string },
        beforeDispatch: Promise<void>,
    ): Promise<DynamicToolCallOutput> {
        const callback = active.options.callTool;
        if (!callback || active.abortRequested || active.options.signal.aborted) {
            return { content: DYNAMIC_TOOL_FAILURE_TEXT, success: false };
        }

        const execution = beforeDispatch.then(async () => {
            if (active.dynamicToolsCancelled || active.abortRequested || active.options.signal.aborted) {
                return { content: DYNAMIC_TOOL_FAILURE_TEXT, success: false };
            }
            let result: { content: string; isError?: boolean };
            try {
                result = await callback(name, args, identity);
            } catch {
                return { content: DYNAMIC_TOOL_FAILURE_TEXT, success: false };
            }
            if (!isRecord(result) || typeof result.content !== 'string'
                || (own(result, 'isError') && typeof result.isError !== 'boolean')) {
                return { content: DYNAMIC_TOOL_FAILURE_TEXT, success: false };
            }
            return { content: boundedDynamicOutput(result.content), success: result.isError !== true };
        });
        const cancelled = active.dynamicToolAbort.promise.then(() => ({ content: DYNAMIC_TOOL_FAILURE_TEXT, success: false }));
        const result = await Promise.race([execution, cancelled]);
        if (active.dynamicToolsCancelled || active.abortRequested || active.options.signal.aborted) return { content: DYNAMIC_TOOL_FAILURE_TEXT, success: false };
        return result;
    }

    async #waitForDynamicResponses(active: ActiveRun): Promise<void> {
        await this.#messageChain;
        if (this.#transportFailure) throw this.#transportFailure;
        while (active.pendingDynamicResponses.size > 0) {
            await Promise.all([...active.pendingDynamicResponses]);
            if (this.#transportFailure) throw this.#transportFailure;
            if (active.abortRequested || active.options.signal.aborted) throw abortError();
        }
    }

    async #approval(active: ActiveRun | null, summary: string, resource: string, id: RpcId): Promise<boolean> {
        // Read-only mode never delegates an approval decision to the host UI.
        if (!active || active.options.mode === 'readonly' || active.options.mode === 'bypass') return false;
        try {
            return await active.options.approve(summary, resource);
        } catch (error) {
            await this.#writeServerResponse(id, null, { code: -32603, message: 'Approval could not be completed.' });
            throw asError(error);
        }
    }

    async #writeServerResponse(id: RpcId, result?: unknown, error?: { code: number; message: string }): Promise<void> {
        const message: JsonRecord = { id };
        if (error) message.error = error;
        else message.result = result;
        await this.#writeMessage(message);
    }

    async #notifyThread(active: ActiveRun, threadId: string, turnId?: string): Promise<void> {
        await active.options.onThread(threadId, turnId);
        const buffered = active.pendingBoundTokenUsage;
        if (turnId && buffered?.turnId === turnId) {
            active.pendingBoundTokenUsage = null;
            await active.options.onEvent('thread/tokenUsage/updated', buffered.params);
        }
    }

    #recordTurn(active: ActiveRun, turnId: string, trustedUsageBinding = false): void {
        if (active.turnId !== null && active.turnId !== turnId) throw protocolError('turn notification did not match the active turn.');
        active.turnId = turnId;
        active.turnReady.resolve();
        if (trustedUsageBinding) {
            active.usageTurnTrusted = true;
            const buffered = active.earlyTokenUsage.get(turnId);
            active.earlyTokenUsage.clear();
            if (buffered) {
                active.usage = buffered.usage;
                active.pendingBoundTokenUsage = { turnId, params: buffered.params };
            }
        }
    }

    #settleActive(active: ActiveRun, outcome: ActiveOutcome): void {
        if (active.settled) return;
        active.settled = true;
        if (outcome.kind === 'failed' || outcome.completion.status !== 'completed') {
            active.dynamicToolsCancelled = true;
            active.dynamicToolAbort.resolve();
        }
        active.outcome.resolve(outcome);
    }

    #failActive(active: ActiveRun, error: Error): void {
        this.#settleActive(active, { kind: 'failed', error });
    }

    async #interrupt(active: ActiveRun): Promise<void> {
        if (active.settled || active.interruptPromise) return active.interruptPromise;
        active.interruptPromise = (async () => {
            if (!active.turnId) await withTimeout(active.turnReady.promise, INTERRUPT_TIMEOUT_MS, 'Native Codex cancellation could not be confirmed.');
            if (active.settled) return;
            if (!active.threadId || !active.turnId) throw new Error('Native Codex cancellation could not be confirmed.');
            await this.#request('turn/interrupt', { threadId: active.threadId, turnId: active.turnId }, INTERRUPT_TIMEOUT_MS);
        })();
        try {
            await active.interruptPromise;
        } catch (error) {
            this.#failActive(active, asError(error));
            throw asError(error);
        }
    }

    async #waitForOutcome(active: ActiveRun): Promise<ActiveOutcome> {
        if (active.abortRequested) {
            return withTimeout(active.outcome.promise, INTERRUPT_TIMEOUT_MS, 'Native Codex cancellation could not be confirmed.');
        }
        let abortListener: (() => void) | undefined;
        const aborted = new Promise<'aborted'>(resolve => {
            abortListener = () => resolve('aborted');
            active.options.signal.addEventListener('abort', abortListener, { once: true });
        });
        try {
            const first = await Promise.race([
                active.outcome.promise.then(outcome => ({ kind: 'outcome' as const, outcome })),
                aborted.then(() => ({ kind: 'aborted' as const })),
            ]);
            if (first.kind === 'outcome') return first.outcome;
            active.abortRequested = true;
            await this.#interrupt(active);
            return await withTimeout(active.outcome.promise, INTERRUPT_TIMEOUT_MS, 'Native Codex cancellation could not be confirmed.');
        } finally {
            if (abortListener) active.options.signal.removeEventListener('abort', abortListener);
        }
    }

    async #listModels(): Promise<ModelEntry[]> {
        const models: ModelEntry[] = [];
        const seenCursors = new Set<string>();
        let cursor: string | null = null;
        for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
            const params: JsonRecord = { limit: MODEL_PAGE_SIZE, includeHidden: false };
            if (cursor !== null) params.cursor = cursor;
            const response = await this.#request('model/list', params);
            if (!isRecord(response) || !Array.isArray(response.data)) throw protocolError('model/list returned an invalid response.');
            for (const value of response.data) {
                if (!isRecord(value) || typeof value.id !== 'string' || typeof value.displayName !== 'string') {
                    throw protocolError('model/list returned an invalid model entry.');
                }
                const efforts = Array.isArray(value.supportedReasoningEfforts)
                    ? value.supportedReasoningEfforts.flatMap(item => isRecord(item) && typeof item.reasoningEffort === 'string' ? [item.reasoningEffort] : [])
                    : [];
                models.push({
                    id: value.id,
                    name: value.displayName,
                    model: typeof value.model === 'string' ? value.model : value.id,
                    supportedReasoningEfforts: efforts,
                    ...(typeof value.isDefault === 'boolean' ? { isDefault: value.isDefault } : {}),
                });
            }
            const next = response.nextCursor;
            if (next === null || next === undefined || next === '') return models;
            if (typeof next !== 'string' || seenCursors.has(next)) throw protocolError('model/list returned an invalid pagination cursor.');
            seenCursors.add(next);
            cursor = next;
        }
        throw protocolError('model/list exceeded the pagination limit.');
    }

    async #validateReasoningEffort(model: string, effort: string): Promise<void> {
        if (typeof effort !== 'string' || effort.trim() === '') throw new TypeError('Native Codex reasoning effort must be a non-empty string.');
        const models = await this.#listModels();
        const selected = models.find(entry => entry.id === model || entry.model === model);
        if (!selected || !selected.supportedReasoningEfforts.includes(effort)) {
            throw new Error('The selected native Codex model does not support this reasoning effort.');
        }
    }

    #fail(error: Error): void {
        if (this.#transportFailure) return;
        this.#transportFailure = error;
        for (const [id, pending] of this.#pendingRequests) {
            clearTimeout(pending.timeout);
            pending.reject(error);
            this.#pendingRequests.delete(id);
        }
        if (this.#activeRun) {
            this.#activeRun.dynamicToolsCancelled = true;
            this.#activeRun.dynamicToolAbort.resolve();
            this.#failActive(this.#activeRun, error);
        }
    }
}


function asError(error: unknown): Error {
    return error instanceof Error ? error : new Error('Native Codex app-server failed.');
}

async function validateWorkingDirectory(cwd: string): Promise<string> {
    if (typeof cwd !== 'string' || cwd.length === 0 || !isAbsolute(cwd)) throw new TypeError('Native Codex cwd must be an absolute directory.');
    try {
        if (!(await stat(cwd)).isDirectory()) throw new TypeError('Native Codex cwd must be an absolute directory.');
    } catch (error) {
        if (error instanceof TypeError) throw error;
        throw new TypeError('Native Codex cwd must be an existing absolute directory.');
    }
    return cwd;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
                timer = setTimeout(() => reject(new Error(message)), timeoutMs);
            }),
        ]);
    } finally {
        if (timer) clearTimeout(timer);
    }
}
