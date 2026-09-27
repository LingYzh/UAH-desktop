import { app, safeStorage } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { discoverApiModels } from '../../src/runtime/api-transport';
import { configureDiagnostics } from '../../src/runtime/diagnostics';
import { Supervisor } from '../../src/runtime/supervisor';
import { additionalDefaultProfiles, defaultClaudeSubagent, defaultGptSubagent } from '../../src/shared/agent-presets';
import type { AgentSettings } from '../../src/shared/agents';
import type { Snapshot, RunRecord } from '../../src/shared/contracts';
import { parseEndpointDraft, type ApiConnection } from '../../src/shared/endpoints';
import { defaultModelParameters } from '../../src/shared/model-parameters';
import type { PermissionMode } from '../../src/shared/permissions';

const TIMEOUT = 180_000;
// Windows safeStorage resolves its encryption state from the original app profile.
if (process.env.APPDATA) app.setPath('userData', join(process.env.APPDATA, 'uah-desktop'));
let stage = 'initializing';
const safeErrors = new Set(['connection_not_allowed', 'appdata_missing', 'endpoint_not_unique', 'key_unavailable', 'arguments_invalid', 'artifact_path_invalid', 'models_invalid', 'agent_missing']);
function progress(value: string): void { stage = value; console.log(JSON.stringify({ stage })); }
function errorSummary(error: unknown): Record<string, string> {
    const source = error instanceof Error ? error : undefined;
    const reason = source && 'reason' in source ? (source as Error & { reason: unknown }).reason : undefined;
    const code = source && 'code' in source ? (source as Error & { code: unknown }).code : undefined;
    return { stage, name: source && ['Error', 'TypeError', 'RangeError', 'ApiTransportError', 'AbortError', 'TimeoutError'].includes(source.name) ? source.name : 'unknown',
        code: source && safeErrors.has(source.message) ? source.message
            : typeof reason === 'string' && /^(?:http\.[1-5][0-9]{2}|models\.[a-z_.]+|json\.[a-z_]+|body\.[a-z_]+|network\.[A-Z_]+|timeout|cancelled|invalid|network)$/.test(reason) ? reason
                : typeof code === 'string' && ['ERR_SQLITE_ERROR', 'SQLITE_CANTOPEN', 'ENOENT', 'EACCES', 'EPERM'].includes(code) ? code : 'unknown_failure' };
}
const terminal = new Set(['completed', 'failed', 'stopped']);
const knownTools = new Set(['read_file', 'write_file', 'list_directory', 'search_files', 'run_command', 'spawn_agent', 'wait_agents', 'list_agent_presets', 'enter_plan_mode', 'write_plan', 'read_plan', 'submit_plan']);
const constraints = 'This is an authorized synthetic test. Do not ask for additional confirmation. Never run commands or call run_command. Do not access external networks. Only access the fixture files in the current project, except the runtime-managed plan file through plan tools. Do not modify other paths.';
type CaseKind = 'readonly' | 'edit' | 'plan' | 'inherit';
interface CaseReport { modelId: string; case: CaseKind; elapsedMs: number; state: string; tools: string[]; assertions: Record<string, boolean>; passed: boolean; errorCode?: string }

function localUrl(value: string, base = false): void {
    const url = new URL(value);
    if (!['localhost', '127.0.0.1'].includes(url.hostname) || url.port !== '5580'
        || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || (base && url.search) || url.hash) {
        throw new Error('connection_not_allowed');
    }
}

function loadConnection(): ApiConnection {
    if (!process.env.APPDATA) throw new Error('appdata_missing');
    const database = new DatabaseSync(join(process.env.APPDATA, 'uah-desktop', 'endpoints.sqlite'), { readOnly: true });
    try {
        // Legacy endpoint databases lack capability/parameter columns; read without migrating them.
        const columns = new Set(database.prepare('PRAGMA table_info(endpoints)').all().map(row => String(row.name)));
        const optionalColumns = ['model_details_json', 'model_overrides_json', 'model_parameters_json'];
        const optionalSelect = optionalColumns.map(name => columns.has(name) ? name : `'[]' AS ${name}`).join(',');
        const rows = database.prepare(`SELECT id,name,protocol,base_url,models_json,${optionalSelect},enabled,revision,key_blob FROM endpoints WHERE lower(name)=?`).all('kiro');
        if (rows.length !== 1) throw new Error('endpoint_not_unique');
        const row = rows[0];
        progress('parse_connection');
        const draft = parseEndpointDraft({
            id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.base_url,
            models: JSON.parse(String(row.models_json)), modelDetails: JSON.parse(String(row.model_details_json)),
            modelOverrides: JSON.parse(String(row.model_overrides_json)), modelParameters: JSON.parse(String(row.model_parameters_json)),
            enabled: row.enabled === 1, revision: row.revision, apiKey: null,
        });
        localUrl(draft.baseUrl, true);
        progress('decrypt_key');
        if (row.key_blob !== null && !safeStorage.isEncryptionAvailable()) throw new Error('key_unavailable');
        const apiKey = row.key_blob === null ? '' : safeStorage.decryptString(Buffer.from(row.key_blob as Uint8Array));
        return { ...draft, id: draft.id!, enabled: true, apiKey };
    } finally {
        database.close();
    }
}

async function runCase(root: string, connection: ApiConnection, modelId: string, kind: CaseKind, index: number): Promise<CaseReport> {
    const started = Date.now();
    console.log(JSON.stringify({ stage: 'case_start', modelId, case: kind }));
    const directory = join(root, `case-${index}-${kind}`);
    const project = join(directory, 'project');
    const data = join(directory, 'data');
    mkdirSync(project, { recursive: true });
    const nonce = randomUUID();
    writeFileSync(join(project, 'input.txt'), nonce, 'utf8');
    writeFileSync(join(project, 'fixture.txt'), 'OLD', 'utf8');
    configureDiagnostics(data);
    const profiles = [...additionalDefaultProfiles(), defaultClaudeSubagent(), defaultGptSubagent()];
    const settings: AgentSettings = { revision: 0, profiles, subagents: { enabled: true, maxConcurrentThreads: 2, maxDepth: 1, inheritHistory: true, timeoutSeconds: 180 } };
    const agentId = modelId.toLowerCase().includes('claude') ? 'claude-default' : 'gpt-default';
    const permissionMode: PermissionMode = kind === 'edit' ? 'accept-edits' : kind === 'plan' ? 'plan' : 'readonly';
    const memoryConnection: ApiConnection = { ...connection, modelParameters: connection.models.map(id => ({ id, parameters: { ...(connection.modelParameters?.find(item => item.id === id)?.parameters ?? defaultModelParameters()), timeoutSeconds: 180 } })) };
    let supervisor: Supervisor | undefined;
    let wake: (() => void) | undefined;
    let snapshot: Snapshot | undefined;
    let run: RunRecord | undefined;
    let timedOut = false;
    const report: CaseReport = { modelId, case: kind, elapsedMs: 0, state: 'not_started', tools: [], assertions: {}, passed: false };
    try {
        supervisor = new Supervisor({ dataDirectory: data, delayMs: 0, resolveConnection: async () => memoryConnection,
            resolveAgent: id => { const profile = profiles.find(item => item.id === id); if (!profile) throw new Error('agent_missing'); return profile; },
            getAgentSettings: () => settings,
            onEvent: event => {
                if (event.type === 'approval-requested') {
                    void Promise.resolve().then(() => supervisor?.execute({ type: 'resolve-approval', identity: event.payload.approval, decision: 'reject' })).catch(() => {});
                }
                wake?.();
            },
        });
        const selection = { endpointId: connection.id, modelId };
        snapshot = await supervisor.execute({ type: 'create-session', title: `Synthetic ${kind}`, directory: project, agentId, selection, controls: { permissionMode, reasoningEffort: 'default' } });
        const sessionId = snapshot.sessions[0].id;
        const tasks: Record<CaseKind, string> = {
            readonly: 'Use read_file to read input.txt. Return only the nonce you actually read. Do not delegate or modify any files.',
            edit: 'Use read_file to read fixture.txt, then write_file with its exact expectedContent to replace OLD with NEW. Do not delegate. Return a brief confirmation.',
            plan: 'Use read_file to inspect fixture.txt. Create a concise plan for replacing OLD with NEW using write_plan, verify it with read_plan, and submit_plan. Do not edit project files or implement the plan. The plan must state scope, steps, risks and verification.',
            inherit: 'Use spawn_agent with agent:{type:"inherit"}, permissionMode:"readonly", context:{mode:"none"}, and task instructing the child to use read_file to read input.txt and return only its nonce. Do not specify a provider or model. The child must not delegate, run commands, edit files, use external networks or access other paths. Then use wait_agents on the returned agentId until completed, inspect the child result and return only that nonce. Do not read input.txt yourself.',
        };
        snapshot = await supervisor.execute({ type: 'start-run', sessionId, input: `${constraints}\n${tasks[kind]}` });
        const runId = snapshot.runs.find(item => item.sessionId === sessionId && !item.parentRunId)!.id;
        const deadline = started + TIMEOUT;
        while (true) {
            snapshot = await supervisor.execute({ type: 'snapshot' });
            run = snapshot.runs.find(item => item.id === runId)!;
            if (terminal.has(run.state)) break;
            if (Date.now() >= deadline) {
                timedOut = true;
                await supervisor.execute({ type: 'stop-run', runId, reason: 'Synthetic case deadline' });
                snapshot = await supervisor.execute({ type: 'snapshot' });
                run = snapshot.runs.find(item => item.id === runId)!;
                break;
            }
            await new Promise<void>(resolveWait => {
                const timer = setTimeout(finish, Math.min(500, Math.max(1, deadline - Date.now())));
                function finish(): void { clearTimeout(timer); wake = undefined; resolveWait(); }
                wake = finish;
            });
        }
        const children = snapshot.runs.filter(item => item.parentRunId === runId);
        const related = [run, ...children];
        const activities = related.flatMap(item => item.activities ?? []);
        const successfulTool = (name: string, target = activities): boolean => target.some(item => item.tool?.name === name && item.status === 'completed' && !item.tool.isError);
        report.tools = [...new Set(activities.flatMap(item => item.tool ? [knownTools.has(item.tool.name) ? item.tool.name : 'unknown'] : []))];
        report.state = run.state;
        report.assertions = {
            completed: run.state === 'completed', deadline: !timedOut,
            noCommands: !activities.some(item => item.tool?.name === 'run_command'),
            noApprovals: snapshot.approvals.length === 0,
        };
        if (kind === 'readonly') Object.assign(report.assertions, { read: successfulTool('read_file'), nonce: run.output.includes(nonce), noArtifacts: snapshot.artifacts.length === 0, noChildren: children.length === 0 });
        if (kind === 'edit') Object.assign(report.assertions, { read: successfulTool('read_file'), write: successfulTool('write_file'), content: readFileSync(join(project, 'fixture.txt'), 'utf8') === 'NEW', diff: snapshot.artifacts.some(item => item.runId === runId && item.path === join(project, 'fixture.txt') && item.oldContent === 'OLD' && item.newContent === 'NEW'), noChildren: children.length === 0 });
        if (kind === 'plan') {
            const expectedPlan = run.plan?.documentId ? join(data, 'plans', sessionId, run.plan.documentId, `${run.plan.id}.md`) : join(data, 'plans', sessionId, `${runId}.md`);
            const realPlan = !!run.plan && resolve(run.plan.filePath) === resolve(expectedPlan) && readFileSync(expectedPlan, 'utf8') === run.plan.content;
            Object.assign(report.assertions, { saved: successfulTool('write_plan'), readPlan: successfulTool('read_plan'), submitted: successfulTool('submit_plan') && run.plan?.status === 'proposed', realPlan, unchanged: readFileSync(join(project, 'fixture.txt'), 'utf8') === 'OLD', noArtifacts: snapshot.artifacts.length === 0, noChildren: children.length === 0 });
        }
        if (kind === 'inherit') Object.assign(report.assertions, { spawned: successfulTool('spawn_agent'), waited: successfulTool('wait_agents'), child: children.length === 1 && children[0].state === 'completed', parentNoRead: !(run.activities ?? []).some(item => item.tool?.name === 'read_file'), inherited: children.length === 1 && children[0].effective.modelId === modelId && children[0].effective.agentId === run.effective.agentId, childRead: children.length === 1 && successfulTool('read_file', children[0].activities ?? []), childNonce: children.length === 1 && children[0].output.includes(nonce), parentNonce: run.output.includes(nonce), noArtifacts: snapshot.artifacts.length === 0 });
        report.passed = Object.values(report.assertions).every(Boolean);
        if (!report.passed) report.errorCode = timedOut ? 'case_deadline' : 'assertion_failed';
    } catch {
        report.errorCode = 'case_exception';
    } finally {
        if (supervisor) {
            try { await supervisor.shutdown(); } catch { report.passed = false; report.errorCode = 'shutdown_failed'; }
        }
        report.elapsedMs = Date.now() - started;
        writeFileSync(join(directory, 'summary.json'), JSON.stringify(report, null, 4), 'utf8');
        console.log(JSON.stringify({ stage: 'case_complete', ...report }));
    }
    return report;
}

type ReviewReport = Omit<CaseReport, 'case'> & { case: 'plan-review' };
async function runPlanReview(root: string, connection: ApiConnection, modelId: string): Promise<ReviewReport> {
    const started = Date.now(); const directory = join(root, 'plan-review'); const project = join(directory, 'project'); const data = join(directory, 'data');
    mkdirSync(project, { recursive: true }); writeFileSync(join(project, 'fixture.txt'), 'OLD', 'utf8'); configureDiagnostics(data);
    const profiles = additionalDefaultProfiles();
    const settings: AgentSettings = { revision: 0, profiles, subagents: { enabled: false, maxConcurrentThreads: 1, maxDepth: 1, inheritHistory: false, timeoutSeconds: 180 } };
    const memoryConnection: ApiConnection = { ...connection, modelParameters: connection.models.map(id => ({ id, parameters: { ...(connection.modelParameters?.find(item => item.id === id)?.parameters ?? defaultModelParameters()), timeoutSeconds: 180 } })) };
    const agentId = modelId.includes('claude') ? 'claude-default' : 'gpt-default';
    const report: ReviewReport = { modelId, case: 'plan-review', elapsedMs: 0, state: 'not_started', tools: [], assertions: {}, passed: false };
    let supervisor: Supervisor | undefined; let blockedOperation = false;
    const reviewedTitle = 'Synthetic reviewed fixture task'; const requirement = 'REVISED_REQUIREMENT_' + randomUUID();
    const check = (name: string, valid: boolean): void => { report.assertions[name] = valid; if (!valid) throw new Error('review_assertion_failed'); };
    const seenTools = new Set<string>(); const checkedActivities = new Set<string>();
    try {
        supervisor = new Supervisor({ dataDirectory: data, delayMs: 0, resolveConnection: async () => memoryConnection,
            resolveAgent: id => { const profile = profiles.find(item => item.id === id); if (!profile) throw new Error('agent_missing'); return profile; }, getAgentSettings: () => settings,
            onEvent: event => {
                if (event.type === 'approval-requested') { blockedOperation = true; void supervisor?.execute({ type: 'resolve-approval', identity: event.payload.approval, decision: 'reject' }).catch(() => {}); }
                if (event.type !== 'run-state') return;
                for (const activity of event.payload.run.activities ?? []) {
                    if (!activity.tool) continue; const tool = activity.tool; seenTools.add(knownTools.has(tool.name) ? tool.name : 'unknown');
                    if (activity.status !== 'running' || checkedActivities.has(activity.id)) continue;
                    checkedActivities.add(activity.id);
                    const target = typeof tool.arguments.path === 'string' ? resolve(project, tool.arguments.path) : '';
                    const expectedTarget = resolve(project, 'fixture.txt');
                    const pathAllowed = process.platform === 'win32' ? target.toLowerCase() === expectedTarget.toLowerCase() : target === expectedTarget;
                    const allowed = ['write_plan', 'read_plan', 'submit_plan'].includes(tool.name)
                        || (tool.name === 'read_file' && pathAllowed)
                        || (tool.name === 'write_file' && pathAllowed && tool.arguments.content === 'NEW' && tool.arguments.expectedContent === 'OLD');
                    if (!allowed) {
                        blockedOperation = true;
                        // The runtime emits this before executing the tool; stop_run aborts its signal synchronously.
                        void supervisor?.execute({ type: 'stop-run', runId: event.payload.run.id, reason: 'Synthetic path/tool guard' }).catch(() => {});
                    }
                }
            },
        });
        const selection = { endpointId: connection.id, modelId };
        let snapshot = await supervisor.execute({ type: 'create-session', title: 'Synthetic plan review', directory: project, agentId, selection, controls: { permissionMode: 'plan', reasoningEffort: 'default' } });
        const sessionId = snapshot.sessions[0].id;
        const waitStage = async (runId: string, name: string): Promise<Snapshot> => {
            progress('plan_review_' + name); const deadline = Date.now() + TIMEOUT;
            while (true) {
                const state = await supervisor!.execute({ type: 'snapshot' }); const run = state.runs.find(item => item.id === runId)!;
                if (terminal.has(run.state)) { report.state = run.state; check(name + 'Completed', run.state === 'completed'); return state; }
                if (Date.now() >= deadline) { await supervisor!.execute({ type: 'stop-run', runId, reason: 'Synthetic review stage deadline' }); throw new Error('review_stage_deadline'); }
                await new Promise(resolveWait => setTimeout(resolveWait, 200));
            }
        };
        snapshot = await supervisor.execute({ type: 'start-run', sessionId, input: constraints + '\nUse read_file on fixture.txt. Plan replacing OLD with NEW using one write_file with exact expectedContent OLD, then read_file to verify NEW. Do not delegate or implement. Set write_plan title to Synthetic fixture task, verify using read_plan, and submit_plan. Include scope, steps, risks and verification.' });
        const firstId = snapshot.runs.at(-1)!.id; snapshot = await waitStage(firstId, 'initial'); const v1 = snapshot.runs.find(run => run.id === firstId)!.plan!;
        check('initialProposed', v1?.status === 'proposed' && v1.version === 1 && !!v1.documentId); check('initialUnchanged', readFileSync(join(project, 'fixture.txt'), 'utf8') === 'OLD' && snapshot.artifacts.length === 0);
        snapshot = await supervisor.execute({ type: 'edit-plan', runId: firstId, planId: v1.id, title: reviewedTitle, content: v1.content + '\n\n## User Markdown review\nRetain the exact OLD to NEW operation. Verify fixture.txt by reading it after the change.' });
        const v2 = snapshot.runs.find(run => run.id === firstId)!.plan!;
        check('userEditVersion', v2.version === 2 && v2.documentId === v1.documentId && v2.title === reviewedTitle && v2.id !== v1.id);
        check('userHistory', v2.history?.length === 1 && v2.history[0].id === v1.id && v2.history[0].content === v1.content);
        check('v1Immutable', readFileSync(v1.filePath, 'utf8') === v1.content);
        progress('plan_review_user_edited');
        snapshot = await supervisor.execute({ type: 'resolve-plan', runId: firstId, planId: v2.id, decision: 'revise', feedback: constraints + '\nKeep this same task. Current user-reviewed title is Synthetic reviewed fixture task; preserve that exact title in write_plan, ignoring any outdated title inside the old Markdown. Revise the current Markdown, including the user review. Add the exact requirement marker ' + requirement + ' to the revised plan, with a verification step reading fixture.txt after the approved OLD to NEW write. Remain in Plan and submit the new version. Do not implement yet.' });
        const revisionId = snapshot.runs.at(-1)!.id; snapshot = await waitStage(revisionId, 'revision'); const v3 = snapshot.runs.find(run => run.id === revisionId)!.plan!;
        check('sameTaskRevision', v3?.status === 'proposed' && v3.version === 3 && v3.documentId === v1.documentId && v3.title === reviewedTitle);
        check('feedbackApplied', v3.content.includes(requirement)); check('beforeApprovalUnchanged', readFileSync(join(project, 'fixture.txt'), 'utf8') === 'OLD' && snapshot.artifacts.length === 0);
        check('priorVersionsImmutable', readFileSync(v1.filePath, 'utf8') === v1.content && readFileSync(v2.filePath, 'utf8') === v2.content);
        snapshot = await supervisor.execute({ type: 'resolve-plan', runId: revisionId, planId: v3.id, decision: 'approve', permissionMode: 'accept-edits' });
        const implementationId = snapshot.runs.at(-1)!.id;
        let replayRejected = false;
        try { await supervisor.execute({ type: 'resolve-plan', runId: revisionId, planId: v3.id, decision: 'approve', permissionMode: 'accept-edits' }); } catch { replayRejected = true; }
        check('duplicateApprovalRejected', replayRejected);
        snapshot = await waitStage(implementationId, 'implementation');
        replayRejected = false;
        try { await supervisor.execute({ type: 'resolve-plan', runId: revisionId, planId: v3.id, decision: 'approve', permissionMode: 'accept-edits' }); } catch { replayRejected = true; }
        check('terminalReplayRejected', replayRejected);
        const artifacts = snapshot.artifacts.filter(item => item.runId === implementationId);
        check('approvedMode', snapshot.runs.find(run => run.id === implementationId)!.effective.permissionMode === 'accept-edits');
        check('implementedFixture', readFileSync(join(project, 'fixture.txt'), 'utf8') === 'NEW');
        check('exactArtifact', artifacts.length === 1 && artifacts[0].path === join(project, 'fixture.txt') && artifacts[0].oldContent === 'OLD' && artifacts[0].newContent === 'NEW');
        check('v3Immutable', readFileSync(v3.filePath, 'utf8') === v3.content); check('noUnexpectedOperations', !blockedOperation && snapshot.approvals.length === 0 && !snapshot.runs.some(run => run.parentRunId));
        check('onlyThreeRuns', snapshot.runs.length === 3);
        report.passed = Object.values(report.assertions).every(Boolean);
    } catch (error) { report.errorCode = error instanceof Error && ['review_assertion_failed', 'review_stage_deadline'].includes(error.message) ? error.message : 'case_exception'; }
    finally {
        if (supervisor) { try { await supervisor.shutdown(); } catch { report.passed = false; report.errorCode = 'shutdown_failed'; } }
        report.tools = [...seenTools]; report.elapsedMs = Date.now() - started;
        writeFileSync(join(directory, 'summary.json'), JSON.stringify(report, null, 4), 'utf8'); console.log(JSON.stringify({ stage: 'case_complete', ...report }));
    }
    return report;
}

async function main(): Promise<void> {
    progress('app_ready');
    const args = process.argv.slice(2);
    const list = args.includes('--list');
    const modelsArgument = args.find(value => value.startsWith('--models='));
    const planReview = args.find(value => value.startsWith('--plan-review='))?.slice('--plan-review='.length);
    const workflow = args.find(value => value.startsWith('--workflow='))?.slice('--workflow='.length);
    const artifactArgument = args.find(value => value.startsWith('--artifacts='))?.slice('--artifacts='.length);
    if (args.some(value => value !== '--list' && !/^--(models|workflow|plan-review|artifacts)=/.test(value)) || !artifactArgument || (!list && !modelsArgument && !planReview) || (list && (modelsArgument || workflow || planReview)) || (planReview && (modelsArgument || workflow))) throw new Error('arguments_invalid');
    const artifacts = resolve('artifacts');
    const root = resolve(artifactArgument);
    const inside = relative(artifacts, root);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error('artifact_path_invalid');
    mkdirSync(root, { recursive: true });
    configureDiagnostics(join(root, 'catalog-data'));
    // Block redirects and any accidental request outside the explicitly authorized loopback endpoint.
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = ((input, init) => { localUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url); return nativeFetch(input, { ...init, redirect: 'error' }); }) as typeof fetch;
    progress('load_connection');
    const connection = loadConnection();
    progress('discover');
    const catalog = await discoverApiModels(connection, AbortSignal.timeout(60_000));
    progress('catalog_ready');
    connection.models = catalog.models;
    connection.modelDetails = catalog.modelDetails;
    writeFileSync(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2), 'utf8');
    if (list) { console.log(JSON.stringify(catalog, null, 2)); return; }
    if (planReview) {
        if (!['gpt-5.6-sol', 'claude-sonnet-4.6'].includes(planReview) || !catalog.models.includes(planReview)) throw new Error('models_invalid');
        const report = await runPlanReview(root, connection, planReview);
        writeFileSync(join(root, 'report.json'), JSON.stringify([report], null, 2), 'utf8');
        if (!report.passed) process.exitCode = 1;
        return;
    }
    const models = modelsArgument!.slice('--models='.length).split(',');
    if (!models.length || models.some(id => !id || !catalog.models.includes(id)) || new Set(models).size !== models.length || (workflow && !models.includes(workflow))) throw new Error('models_invalid');
    const reports: CaseReport[] = [];
    for (const model of models) {
        reports.push(await runCase(root, connection, model, 'readonly', reports.length));
        if (workflow === model) for (const kind of ['edit', 'plan', 'inherit'] as const) reports.push(await runCase(root, connection, model, kind, reports.length));
    }
    writeFileSync(join(root, 'report.json'), JSON.stringify(reports, null, 2), 'utf8');
    console.log(JSON.stringify(reports, null, 2));
    if (reports.some(item => !item.passed)) process.exitCode = 1;
}

void app.whenReady().then(main).catch(error => { console.log(JSON.stringify({ failure: 'kiro_harness_failed', ...errorSummary(error) })); process.exitCode = 1; }).finally(() => { app.exit(Number(process.exitCode ?? 0)); });
