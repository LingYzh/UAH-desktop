import type { ToolOutcome, ArtifactReference, ExecutionProvenance } from '../shared/harness-contracts';
import { WindowsExecutionBackend } from './execution-backend';
import { redactJournalValue } from './journal-artifacts';

/** Compatibility synchronous tool wrapper; backend lifecycle/output APIs remain independently usable. */
export async function managedCommand(backend: WindowsExecutionBackend, input: {
    executionId: string; command: string; cwd: string; timeoutSeconds: number; signal: AbortSignal;
    saveOutput: (bytes: Buffer) => ArtifactReference;
    redactSecrets?: readonly string[];
}, outcome: ToolOutcome): Promise<{ content: string; isError: boolean }> {
    let cancellation: Promise<unknown> | undefined;
    let started = false;
    let terminalConfirmed = false;
    let phase: 'availability' | 'execution' | 'output' = 'availability';
    const cancel = () => { if (started) cancellation ??= backend.cancel(input.executionId).catch(() => undefined); };
    input.signal.addEventListener('abort', cancel, { once: true });
    try {
        await backend.ensureAvailable(input.redactSecrets);
        input.signal.throwIfAborted();
        const invocation = { cwd: input.cwd, timeoutMs: input.timeoutSeconds * 1000 };
        const metadata = typeof backend.executionProvenance === 'function' ? backend.executionProvenance(invocation) : {
            shell: 'unknown', shellVersion: 'unknown', shellVersionSource: 'unknown', arguments: ['unknown', '[command recorded in tool invocation]'],
            commandEncoding: 'unknown', outputEncoding: 'unknown', commandArgumentCapture: 'omitted', cwd: input.cwd, timeoutMs: invocation.timeoutMs, maxOutputBytes: 16777216, redacted: false };
        const filtered = redactJournalValue(metadata, input.redactSecrets ?? []);
        outcome.executionEvidence = { executionId: input.executionId, treeExited: false, outputDrained: false, terminationReason: null, stdoutBytes: 0, stderrBytes: 0,
            provenance: { ...filtered.value as unknown as ExecutionProvenance, redacted: filtered.changed } };
        phase = 'execution';
        // A start acknowledgement may be lost after process creation; no replay is safe.
        outcome.effectState = 'possible'; outcome.retryClass = 'reconcile_first';
        let state = await backend.start({ executionId: input.executionId, command: input.command, cwd: input.cwd, timeoutMs: input.timeoutSeconds * 1000,
            ...(input.redactSecrets?.length ? { redactSecrets: input.redactSecrets } : {}) });
        started = true;
        if (input.signal.aborted) cancel();
        while (state.status === 'running') state = await backend.wait(input.executionId, 1000);
        await cancellation;
        outcome.executionEvidence = { executionId: input.executionId, treeExited: state.treeExited, outputDrained: state.outputDrained,
            terminationReason: state.reason ?? null, stdoutBytes: state.stdoutBytes, stderrBytes: state.stderrBytes,
            provenance: outcome.executionEvidence.provenance,
            ...(state.outputRedacted ? { outputRedacted: true } : {}) };
        if (!state.treeExited || !state.outputDrained) throw new Error('Command termination was not confirmed');
        terminalConfirmed = true;
        outcome.exitCode = state.exitCode;
        outcome.status = state.status === 'completed' ? 'succeeded' : state.status === 'cancelled' ? 'cancelled' : 'failed';
        outcome.errorCode = state.reason ? `COMMAND_${state.reason.toUpperCase()}` : state.status === 'failed' ? 'COMMAND_FAILED' : null;
        phase = 'output';
        const previews: string[] = [];
        // Reserve room inside the 64 KiB result envelope for stream hashes and lifecycle evidence.
        const previewLimit = 63 * 1024;
        let previewRemaining = previewLimit;
        for (const stream of ['stdout', 'stderr'] as const) {
            const chunks: Buffer[] = [];
            let offset = 0;
            for (;;) {
                const page = await backend.poll(input.executionId, stream, offset, 65536);
                chunks.push(Buffer.from(page.base64, 'base64')); offset = page.nextOffset;
                if (!page.hasMore) break;
            }
            const bytes = Buffer.concat(chunks);
            try { outcome.artifactRefs.push(input.saveOutput(bytes)); }
            catch {
                outcome.recordingState = 'failed'; outcome.errorCode = 'RECORDING_FAILED';
                return { content: `Command ended with exit code ${state.exitCode ?? 'unknown'}, but output artifact recording failed. Side effects may have occurred; reconcile before retrying.`, isError: true };
            }
            const preview = bytes.subarray(0, previewRemaining);
            previewRemaining -= preview.length;
            const ref = outcome.artifactRefs.at(-1)!;
            previews.push(`${stream}:\n${preview.toString('utf8')}\n[${state.outputRedacted ? 'Credential-filtered' : 'Raw'} ${stream} artifact: sha256=${ref.sha256}; bytes=${ref.byteLength}; use read_artifact_range for additional output.]`);
        }
        outcome.truncation = { truncated: state.stdoutBytes + state.stderrBytes > previewLimit, reason: state.stdoutBytes + state.stderrBytes > previewLimit ? 'preview_limit' : null };
        return { content: `${previews.join('\n')}\nExit code: ${state.exitCode ?? 'unknown'}.\nExecution: ${input.executionId}; tree exited: true.${state.reason ? ` Reason: ${state.reason}.` : ''}${outcome.truncation.truncated ? '\n[Preview truncated; full retained output is available in artifacts.]' : ''}${state.outputRedacted ? '\n[Known credentials were masked before disk capture; original output is not retained.]' : ''}\nUnsandboxed command; noninteractive redirected streams.`, isError: outcome.status !== 'succeeded' };
    } catch {
        if (started) { try { await backend.cancel(input.executionId); } catch {} }
        outcome.status = input.signal.aborted ? 'cancelled' : 'failed';
        if (phase === 'availability') {
            outcome.errorCode = input.signal.aborted ? 'CANCELLED' : 'EXECUTION_BACKEND_UNAVAILABLE';
            return { content: 'Managed execution backend was unavailable or the command was cancelled before dispatch.', isError: true };
        }
        if (phase === 'output') {
            outcome.recordingState = 'failed'; outcome.errorCode = 'OUTPUT_UNCONFIRMED';
            return { content: 'Command tree exit was confirmed, but complete output could not be read or recorded; reconcile before retrying.', isError: true };
        }
        outcome.errorCode = 'EXECUTION_UNCONFIRMED';
        return { content: 'Command lifecycle was not confirmed; reconcile side effects before retrying.', isError: true };
    } finally {
        input.signal.removeEventListener('abort', cancel);
        if (terminalConfirmed) {
            try { await backend.release(input.executionId); }
            catch {
                // A failed release ack must be visible; do not silently accumulate capacity.
                outcome.status = 'failed'; outcome.errorCode = outcome.errorCode === 'RECORDING_FAILED' ? 'RECORDING_FAILED' : 'EXECUTION_RELEASE_FAILED';
                outcome.recordingState = 'failed';
                return { content: 'Confirmed command evidence could not be released; raw output remains retained. Reconcile before retrying.', isError: true };
            }
        }
    }
}
