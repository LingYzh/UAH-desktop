import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { RunRecord, SessionRecord } from '../shared/contracts';
import type { ApiConnection, ApiTestResult } from '../shared/endpoints';
import type { RequestIdentity } from '../shared/harness-contracts';
import { defaultModelParameters } from '../shared/model-parameters';
import { RequestRecordingError, streamAgentApi } from './api-transport';
import { RuntimeStore } from './store';
import { RunJournal } from './run-journal';
import { RequestJournal } from './request-journal';

/** Independent application-scoped probe ledger. Its synthetic session never enters Supervisor. */
export class ApplicationJournal {
    private readonly store: RuntimeStore;
    private readonly journal: RunJournal;
    private readonly runs = new Map<string, RunRecord>();
    private readonly active = new Set<string>();
    private failed = false;
    private closed = false;
    private record<T>(action: () => T): T {
        try { return action(); } catch (error) { this.failed = true; throw error; }
    }
    constructor(dataDirectory: string, private readonly getCaptureRaw: () => boolean = () => true) {
        const directory = join(dataDirectory, 'application-journal');
        this.store = new RuntimeStore(directory);
        try {
            const snapshot = this.store.readSnapshot();
            for (const run of snapshot.runs) this.runs.set(run.id, run);
            if (!snapshot.sessions.some(session => session.id === 'application')) {
                const session: SessionRecord = { id: 'application', title: 'Application connection tests', directory: null,
                    requested: { runtimeId: 'api', modelId: 'connection-test', agentId: 'connection-test', policyVersion: 1 }, createdAt: new Date().toISOString() };
                this.store.commit({ sessions: [session] });
            }
            this.journal = new RunJournal(this.store, directory, id => this.runs.get(id), () => { this.failed = true; });
            // Restart only settles the application operation. Provider terminals
            // and usage remain observed facts; no request is resumed or resent.
            this.failed = snapshot.runs.some(run => run.harnessState === 'recording_failed');
            const timestamp = new Date().toISOString();
            const recovered = snapshot.runs.filter(run => run.harnessState
                ? !['completed', 'failed', 'cancelled', 'recording_failed'].includes(run.harnessState)
                : !['completed', 'failed', 'stopped'].includes(run.state)).map(run => ({ ...run,
                    state: 'stopped' as const, harnessState: 'cancelled' as const,
                    stopReason: 'Connection test interrupted by application process restart; completion was not observed.',
                    finishedAt: timestamp, sequence: run.sequence + 1,
                }));
            if (recovered.length) {
                this.record(() => this.journal.commit({ runs: recovered }, recovered.map(run => ({
                    run: this.journal.identity(run), type: 'run.state' as const,
                    payload: { state: 'cancelled' as const, reason: run.stopReason }, timestamp,
                }))));
                for (const run of recovered) this.runs.set(run.id, run);
            }
            // Probes have no parent history or continuation lookup after settlement.
            this.runs.clear();
        } catch (error) { this.store.close(); throw error; }
    }
    async testConnection(connection: ApiConnection, modelId: string, signal?: AbortSignal): Promise<ApiTestResult> {
        if (this.closed || this.failed) throw new Error('Application request recording is unavailable; no probe was sent.');
        const started = Date.now();
        const run: RunRecord = { id: randomUUID(), sessionId: 'application', turnId: randomUUID(), createdAt: new Date().toISOString(),
            state: 'running', harnessState: 'waiting_model', input: 'Reply with the single word OK.', output: '', sequence: 0,
            effective: { runtimeId: 'api', modelId, agentId: 'connection-test', policyVersion: 1, endpointId: connection.id, protocol: connection.protocol } };
        this.runs.set(run.id, run); this.active.add(run.id);
        this.journal.registerSecret(run.sessionId, connection.apiKey);
        let request: RequestJournal | undefined;
        try {
            const content = this.record(() => this.journal.artifactStore(run.sessionId).save({ text: run.input }));
            this.record(() => this.journal.commit({ runs: [run] }, [
                { run: this.journal.identity(run), type: 'message.accepted', payload: { messageId: run.turnId, revision: 1, role: 'user', content: content.ref }, timestamp: run.createdAt },
                { run: this.journal.identity(run), type: 'run.state', payload: { state: 'waiting_model', reason: null }, timestamp: run.createdAt },
            ]));
            const identity: RequestIdentity = { ...this.journal.identity(run), requestId: randomUUID(), attemptId: randomUUID(), stepId: randomUUID() };
            request = this.record(() => new RequestJournal(this.journal, run, identity, connection, { purpose: 'connection_test', scope: { kind: 'application' }, captureRaw: this.getCaptureRaw() }));
            let complete = false;
            for await (const event of streamAgentApi(connection, modelId, [{ role: 'user', content: run.input }], signal, {
                tools: [], requestIdentity: identity, observer: request.observer,
                parameters: { ...defaultModelParameters(), maxOutputTokens: 256, timeoutSeconds: 30 },
            })) {
                if (event.type === 'text') {
                    const offset = run.output.length;
                    run.output += event.text;
                    this.record(() => request!.text(run, event.text, offset));
                } else if (event.type === 'usage') this.record(() => request!.usage(event.usage));
                else if (event.type === 'complete') {
                    if (event.toolCalls.length) throw new Error('Connection test returned unsupported tool calls.');
                    this.record(() => request!.completed(event.continuation));
                    complete = true;
                }
            }
            if (!complete || !run.output.trim()) throw new Error('Connection test returned no visible text.');
            run.state = 'completed'; run.harnessState = 'completed'; run.finishedAt = new Date().toISOString(); run.sequence++;
            this.record(() => this.journal.event(run, 'run.state', { state: 'completed', reason: null }, { runs: [run] }));
            return { text: run.output.length > 8192 ? run.output.slice(0, 8192) + '\n（仅展示前 8192 个字符）' : run.output, elapsedMs: Date.now() - started };
        } catch (error) {
            if (error instanceof RequestRecordingError) this.failed = true;
            const cancelled = signal?.aborted === true;
            run.state = this.failed ? 'failed' : cancelled ? 'stopped' : 'failed';
            run.harnessState = this.failed ? 'recording_failed' : cancelled ? 'cancelled' : 'failed'; run.finishedAt = new Date().toISOString(); run.sequence++;
            run.error = error instanceof Error ? error.message : 'Connection test failed.';
            // streamAgentApi records its own terminal, including pre-send validation failure.
            // A subsequent probe validation failure is a run failure, not a rewritten provider terminal.
            try { this.journal.event(run, 'run.state', { state: run.harnessState, reason: run.error }, { runs: [run] }); }
            catch { this.failed = true; }
            throw error;
        } finally { this.active.delete(run.id); this.runs.delete(run.id); }
    }
    close(): void {
        if (this.closed) return;
        if (this.active.size) throw new Error('Abort and await active application requests before closing their journal.');
        this.closed = true;
        try { this.journal.close(); } finally { this.store.close(); }
    }
}
