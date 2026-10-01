import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { ExecutionProvenance } from '../shared/harness-contracts';

export type ExecutionStatus = 'running' | 'completed' | 'failed' | 'timed_out' | 'cancelled';
export interface ExecutionSnapshot {
    executionId: string;
    status: ExecutionStatus;
    reason: string | null;
    exitCode: number | null;
    jobAssigned: true;
    activeProcesses: number;
    treeExited: boolean;
    outputDrained: boolean;
    stdoutPath: string;
    stderrPath: string;
    stdoutBytes: number;
    stderrBytes: number;
    elapsedMs: number;
    outputRedacted?: boolean;
}
export interface ExecutionPoll {
    executionId: string;
    stream: 'stdout' | 'stderr';
    offset: number;
    nextOffset: number;
    base64: string;
    hasMore: boolean;
    snapshot: ExecutionSnapshot;
}
export interface ExecutionStart {
    executionId?: string;
    command: string;
    cwd: string;
    timeoutMs: number;
    maxOutputBytes?: number;
    redactSecrets?: readonly string[];
}
interface Pending {
    resolve: (result: unknown) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}
interface Evidence { directory: string; maxBytes: number; credentialFilter: boolean }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = new Set<ExecutionStatus>(['running', 'completed', 'failed', 'timed_out', 'cancelled']);
const object = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const integer = (value: unknown, minimum: number, maximum: number): value is number => Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
const invalid = () => new Error('Execution helper returned invalid or uncorrelated evidence.');

/** Constructed only from a validated response correlated to a pending helper request. */
class HelperResponseError extends Error {
    constructor(readonly code: string, message: string) {
        super(`Execution helper ${code}: ${message}`);
    }
}

/** Redirected, noninteractive Windows execution. Job ownership is native, never inferred from PID. */
export class WindowsExecutionBackend {
    private child?: ChildProcessWithoutNullStreams;
    private readonly pending = new Map<string, Pending>();
    private readonly evidence = new Map<string, Evidence>();
    private readonly ready: Promise<void>;
    private closed?: Promise<void>;
    private closeTask?: Promise<void>;
    private closing = false;
    private failure?: Error;
    private lifecycleValidated = false;
    private credentialFilter = false;
    private shellMetadata?: Pick<ExecutionProvenance, 'shell' | 'shellVersion' | 'shellVersionSource' | 'arguments' | 'commandEncoding' | 'outputEncoding'>;
    private buffer = '';
    private readonly decoder = new StringDecoder('utf8');
    private readonly dataDirectory: string;
    private failTimer?: ReturnType<typeof setTimeout>;

    constructor(options: { helperPath?: string; dataDirectory: string }) {
        if (!path.isAbsolute(options.dataDirectory)) throw new Error('Execution dataDirectory must be absolute.');
        this.dataDirectory = path.resolve(options.dataDirectory);
        this.ready = this.initialize(options.helperPath ?? path.resolve(process.cwd(), 'native/UAH.ExecutionHelper/bin/Release/net10.0-windows/UAH.ExecutionHelper.exe'));
        void this.ready.catch(() => {});
    }
    private async initialize(helperPath: string): Promise<void> {
        if (process.platform !== 'win32') throw new Error('Windows execution backend is unavailable on this platform.');
        if (!path.isAbsolute(helperPath)) throw new Error('Execution helperPath must be absolute.');
        const helper = await lstat(helperPath).catch(() => { throw new Error('Windows execution helper is unavailable; build or install the independent helper.'); });
        if (!helper.isFile() || helper.isSymbolicLink()) throw new Error('Execution helper must be a regular file.');
        await mkdir(this.dataDirectory, { recursive: true });
        await this.verifyDirectory(this.dataDirectory);
        this.child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
        const child = this.child;
        this.closed = new Promise(resolve => child.once('close', () => resolve()));
        child.stdout.on('data', (chunk: Buffer) => this.receive(chunk));
        // Consume diagnostics without forwarding command paths or stderr into model/public errors.
        child.stderr.on('data', () => {});
        child.on('error', () => this.fail(new Error('Windows execution helper could not start.')));
        child.stdin.on('error', () => this.fail(new Error('Windows execution helper input became unavailable.')));
        child.once('close', () => {
            if (this.failTimer) clearTimeout(this.failTimer);
            this.fail(new Error('Windows execution helper exited; execution state is unconfirmed.'));
        });
        const caps = await this.request('capabilities', {});
        if (!object(caps) || caps.protocolVersion !== 1 || caps.backend !== 'windows-job-object' || caps.platformSupported !== true || caps.processGroups !== true || caps.atomicJobAssignment !== true || caps.breakawayAllowed !== false || caps.interactive !== false || caps.pty !== false || caps.terminalRelease !== true || typeof caps.ownership !== 'string' || !caps.ownership.includes('KILL_ON_JOB_CLOSE')) {
            const error = new Error('Windows execution helper lifecycle capabilities were not verified.'); this.fail(error); throw error;
        }
        this.lifecycleValidated = true;
        this.credentialFilter = caps.credentialFilter === true;
        const metadataKeys = ['shellVersionSource', 'shellArguments', 'commandEncoding'];
        if (metadataKeys.some(key => Object.hasOwn(caps, key))) {
            const flags = ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];
            if (typeof caps.shell !== 'string' || !path.isAbsolute(caps.shell) || caps.shell.length > 32768 || caps.shell.includes('\0')
                || typeof caps.shellVersion !== 'string' || !caps.shellVersion.length || caps.shellVersion.length > 128
                || !['unknown', 'executable_file_version'].includes(String(caps.shellVersionSource))
                || (caps.shellVersionSource === 'unknown' && caps.shellVersion !== 'unknown')
                || !Array.isArray(caps.shellArguments) || JSON.stringify(caps.shellArguments) !== JSON.stringify(flags)
                || caps.commandEncoding !== 'utf16le-base64' || caps.outputEncoding !== 'raw_bytes_command_specific') {
                const error = invalid(); this.fail(error); throw error;
            }
            this.shellMetadata = { shell: caps.shell, shellVersion: caps.shellVersion, shellVersionSource: caps.shellVersionSource as string,
                arguments: [...flags, '[command recorded in tool invocation]'], commandEncoding: caps.commandEncoding, outputEncoding: caps.outputEncoding };
        }
    }
    private fail(error: Error): void {
        this.failure ??= error;
        for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(this.failure); }
        this.pending.clear();
        // EOF is a lifecycle signal understood by this helper; no external process lookup.
        this.child?.stdin.destroy();
        if (this.lifecycleValidated && this.child && this.child.exitCode === null && !this.child.killed && !this.failTimer) {
            this.failTimer = setTimeout(() => { this.child?.kill(); }, 5000);
            this.failTimer.unref();
        }
    }
    private receive(chunk: Buffer): void {
        if (this.failure) return;
        this.buffer += this.decoder.write(chunk);
        if (Buffer.byteLength(this.buffer, 'utf8') > 1048576) { this.fail(new Error('Execution helper response exceeded the IPC limit.')); return; }
        for (;;) {
            const newline = this.buffer.indexOf('\n'); if (newline < 0) break;
            const line = this.buffer.slice(0, newline); this.buffer = this.buffer.slice(newline + 1);
            try {
                const response: unknown = JSON.parse(line);
                if (!object(response) || typeof response.id !== 'string' || typeof response.ok !== 'boolean') throw invalid();
                const request = this.pending.get(response.id); if (!request) throw invalid();
                this.pending.delete(response.id); clearTimeout(request.timer);
                if (response.ok) request.resolve(response.result);
                else if (object(response.error) && typeof response.error.code === 'string' && response.error.code.length <= 64 && typeof response.error.message === 'string' && response.error.message.length <= 512) request.reject(new HelperResponseError(response.error.code, response.error.message));
                else { request.reject(invalid()); throw invalid(); }
            } catch { this.fail(invalid()); return; }
        }
    }
    private request(method: string, params: Record<string, unknown>, deadlineMs = 35000): Promise<unknown> {
        if (this.failure) return Promise.reject(this.failure);
        if (!this.child || this.child.exitCode !== null || this.child.killed) return Promise.reject(new Error('Execution helper is unavailable.'));
        if (this.pending.size >= 64) return Promise.reject(new Error('Execution helper request concurrency limit reached.'));
        const id = randomUUID(); const line = `${JSON.stringify({ id, method, params })}\n`;
        if (Buffer.byteLength(line, 'utf8') > 131072) return Promise.reject(new Error('Execution request exceeds the IPC limit.'));
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => this.fail(new Error('Execution helper did not confirm the request before its deadline.')), deadlineMs);
            this.pending.set(id, { resolve, reject, timer });
            this.child!.stdin.write(line, error => { if (error) this.fail(new Error('Execution helper request could not be written.')); });
        });
    }
    private async available(): Promise<void> {
        if (this.closing) throw new Error('Execution backend is closing.');
        await this.ready;
        if (this.closing) throw new Error('Execution backend is closing.');
        if (this.failure) throw this.failure;
    }
    /** Verify helper availability/capabilities before the host records any possible command effect. */
    async ensureAvailable(redactSecrets: readonly string[] = []): Promise<void> {
        await this.available();
        if (!Array.isArray(redactSecrets) || redactSecrets.length > 16 || redactSecrets.some(secret => typeof secret !== 'string' || !secret.length || secret.length > 8192 || /[^\x20-\x7e]/.test(secret))
            || redactSecrets.reduce((total, secret) => total + secret.length, 0) > 32768) throw new Error('Execution credential filter limits exceeded.');
        if (redactSecrets.length && !this.credentialFilter) throw new Error('Execution helper credential filtering is unavailable; update the helper before running commands.');
    }
    /** Must be called after availability admission. Legacy helpers report unknown metadata. */
    executionProvenance(input: { cwd: string; timeoutMs: number; maxOutputBytes?: number }): ExecutionProvenance {
        return { ...(this.shellMetadata ?? { shell: 'unknown', shellVersion: 'unknown', shellVersionSource: 'unknown', arguments: ['unknown', '[command recorded in tool invocation]'],
            commandEncoding: 'unknown', outputEncoding: 'unknown' }), arguments: [...(this.shellMetadata?.arguments ?? ['unknown', '[command recorded in tool invocation]'])],
            cwd: path.resolve(input.cwd), timeoutMs: input.timeoutMs, maxOutputBytes: input.maxOutputBytes ?? 16777216, commandArgumentCapture: 'omitted', redacted: false };
    }
    private async verifyDirectory(directory: string): Promise<void> {
        for (let current = directory;; current = path.dirname(current)) {
            const info = await lstat(current);
            if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Execution artifact directories cannot traverse links.');
            if (current === path.dirname(current)) break;
        }
    }
    private requireEvidence(id: string): Evidence {
        if (!uuid.test(id) || !this.evidence.has(id)) throw new Error('Execution is not owned by this backend.');
        return this.evidence.get(id)!;
    }
    private snapshot(value: unknown, id: string): ExecutionSnapshot {
        const evidence = this.requireEvidence(id);
        if (!object(value) || (value.outputRedacted !== undefined && typeof value.outputRedacted !== 'boolean')
            || (evidence.credentialFilter && typeof value.outputRedacted !== 'boolean')) { const error = invalid(); this.fail(error); throw error; }
        if (!object(value) || value.executionId !== id || !statuses.has(value.status as ExecutionStatus) || value.jobAssigned !== true || !integer(value.activeProcesses, 0, 0xffffffff) || typeof value.treeExited !== 'boolean' || typeof value.outputDrained !== 'boolean' || !integer(value.stdoutBytes, 0, evidence.maxBytes) || !integer(value.stderrBytes, 0, evidence.maxBytes) || value.stdoutBytes + value.stderrBytes > evidence.maxBytes || !integer(value.elapsedMs, 0, Number.MAX_SAFE_INTEGER) || !(value.exitCode === null || integer(value.exitCode, 0, 0xffffffff)) || !(value.reason === null || (typeof value.reason === 'string' && value.reason.length <= 64)) || value.stdoutPath !== path.join(evidence.directory, 'stdout.bin') || value.stderrPath !== path.join(evidence.directory, 'stderr.bin') || (value.treeExited && (value.status === 'running' || value.activeProcesses !== 0 || !value.outputDrained))) {
            const error = invalid(); this.fail(error); throw error;
        }
        return value as unknown as ExecutionSnapshot;
    }
    async start(options: ExecutionStart): Promise<ExecutionSnapshot> {
        await this.ensureAvailable(options.redactSecrets);
        const executionId = options.executionId ?? randomUUID();
        if (!uuid.test(executionId) || this.evidence.has(executionId)) throw new Error('executionId must be a fresh UUID.');
        if (typeof options.command !== 'string' || !options.command.length || options.command.length > 8192 || options.command.includes('\0')) throw new Error('Command must contain 1..8192 characters without NUL.');
        if (!path.isAbsolute(options.cwd)) throw new Error('Execution cwd must be absolute.');
        if (!integer(options.timeoutMs, 1, 120000) || (options.maxOutputBytes !== undefined && !integer(options.maxOutputBytes, 1, 67108864))) throw new Error('Execution timeout or output quota is outside the allowed range.');
        const directory = path.join(this.dataDirectory, 'executions', executionId);
        await mkdir(path.dirname(directory), { recursive: true });
        await this.verifyDirectory(path.dirname(directory));
        await mkdir(directory); // EEXIST fails closed; never reuse an artifact directory.
        await this.verifyDirectory(directory);
        await this.available();
        this.evidence.set(executionId, { directory, maxBytes: options.maxOutputBytes ?? 16777216, credentialFilter: Boolean(options.redactSecrets?.length) });
        let value: unknown;
        try {
            value = await this.request('start', { ...options, executionId, cwd: path.resolve(options.cwd), outputDirectory: directory });
        } catch (error) {
            // Protocol v1 emits these codes before constructing Execution. Duplicate IDs,
            // backend errors and lost/malformed acknowledgements may already have effects.
            // Retain their ownership evidence; never infer nonexecution from error text.
            if (error instanceof HelperResponseError && (error.code === 'invalid_request' || error.code === 'busy')) {
                this.evidence.delete(executionId);
            }
            throw error;
        }
        return this.snapshot(value, executionId);
    }
    async poll(executionId: string, stream: 'stdout' | 'stderr', offset: number, limit: number): Promise<ExecutionPoll> {
        await this.available(); this.requireEvidence(executionId);
        if (!['stdout', 'stderr'].includes(stream) || !integer(offset, 0, 67108864) || !integer(limit, 1, 65536)) throw new Error('Invalid execution output page.');
        const value = await this.request('poll', { executionId, stream, offset, limit });
        if (!object(value) || value.executionId !== executionId || value.stream !== stream || value.offset !== offset || !integer(value.nextOffset, offset, offset + limit) || typeof value.base64 !== 'string' || value.base64.length > 87384 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64) || Buffer.from(value.base64, 'base64').length !== value.nextOffset - offset || typeof value.hasMore !== 'boolean') { const error = invalid(); this.fail(error); throw error; }
        const snapshot = this.snapshot(value.snapshot, executionId);
        const length = stream === 'stdout' ? snapshot.stdoutBytes : snapshot.stderrBytes;
        if (value.nextOffset > length || value.hasMore !== (value.nextOffset < length)) { const error = invalid(); this.fail(error); throw error; }
        return { ...(value as unknown as ExecutionPoll), snapshot };
    }
    async wait(executionId: string, timeoutMs: number): Promise<ExecutionSnapshot> {
        await this.available(); this.requireEvidence(executionId);
        if (!integer(timeoutMs, 0, 30000)) throw new Error('Execution wait timeout must be 0..30000 ms.');
        return this.snapshot(await this.request('wait', { executionId, timeoutMs }), executionId);
    }
    async cancel(executionId: string): Promise<ExecutionSnapshot> {
        await this.available(); this.requireEvidence(executionId);
        return this.snapshot(await this.request('cancel', { executionId }), executionId);
    }
    /** Release retained handles/evidence only; raw output paths remain on disk. Not idempotent. */
    async release(executionId: string): Promise<void> {
        await this.available(); this.requireEvidence(executionId);
        const terminal = await this.wait(executionId, 0);
        if (terminal.status === 'running' || !terminal.treeExited || !terminal.outputDrained) throw new Error('Execution release requires confirmed terminal tree exit and drained output.');
        const value = await this.request('release', { executionId });
        if (!object(value) || value.executionId !== executionId || value.status !== 'released' || value.rawOutputRetained !== true) {
            const error = invalid(); this.fail(error); throw error;
        }
        this.evidence.delete(executionId);
    }
    close(): Promise<void> {
        this.closeTask ??= this.closeOwned(); return this.closeTask;
    }
    private async closeOwned(): Promise<void> {
        this.closing = true;
        try { await this.ready; } catch { }
        if (!this.child || !this.closed) return;
        let shutdownError: Error | undefined;
        if (!this.failure) {
            try {
                const result = await this.request('shutdown', {}, 6000);
                if (!object(result) || result.status !== 'shutdown' || !Array.isArray(result.executions)) throw invalid();
                for (const item of result.executions) {
                    if (!object(item) || typeof item.executionId !== 'string') throw invalid();
                    if (!this.snapshot(item, item.executionId).treeExited) throw new Error('Execution shutdown did not confirm all owned trees exited.');
                }
            } catch (error) { shutdownError = error instanceof Error ? error : new Error('Execution shutdown failed.'); }
        } else shutdownError = this.failure;
        this.child.stdin.end();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const exited = await Promise.race([this.closed.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), 5000); })]);
        if (timer) clearTimeout(timer);
        if (!exited) {
            if (this.lifecycleValidated) this.child.kill();
            throw new Error('Execution helper shutdown timed out; owned tree exit remains unconfirmed.');
        }
        if (shutdownError) throw shutdownError;
    }
}
