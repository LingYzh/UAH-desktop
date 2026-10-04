import { clientError } from '../../shared/client-error.js';
import { nativePermissionPreset } from '../../shared/native-codex-commands';
import { defineStore } from 'pinia';
import { computed, ref, watch } from 'vue';
import { defaultSessionControls } from '../../shared/session-controls';
import { permissionModes } from '../../shared/permissions';
import { visibleRootRuns } from '../../shared/conversation-history';
import { applyRunEvent, mergeRunSnapshot } from '../run-events.js';

export const activeStates = ['running', 'approval', 'cancelRequested', 'stopping'];
export const stateLabels = { running: '运行中', approval: '等待审批', cancelRequested: '已请求取消', stopping: '正在停止', stopped: '已中止', completed: '已完成', failed: '失败' };
const reasoningEfforts = ['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const blankDraftControls = () => ({ permissionMode: '', reasoningEffort: '' });

function newestSession(sessions) {
    let newest = null;
    let newestTime = Number.NEGATIVE_INFINITY;
    for (const session of sessions) {
        const createdAt = Date.parse(session.createdAt);
        const createdTime = Number.isFinite(createdAt) ? createdAt : Number.NEGATIVE_INFINITY;
        if (!newest || createdTime >= newestTime) {
            newest = session;
            newestTime = createdTime;
        }
    }
    return newest;
}

function isSelection(value) {
    return value !== null && typeof value === 'object'
        && typeof value.endpointId === 'string' && Boolean(value.endpointId.trim())
        && typeof value.modelId === 'string' && Boolean(value.modelId.trim());
}

function isInitialConfig(value) {
    return value !== null && typeof value === 'object'
        && typeof value.agentId === 'string' && Boolean(value.agentId.trim())
        && (value.selection === null || isSelection(value.selection))
        && value.controls !== null && typeof value.controls === 'object'
        && permissionModes.includes(value.controls.permissionMode)
        && reasoningEfforts.includes(value.controls.reasoningEffort)
        && (value.directory === null || typeof value.directory === 'string');
}

export const useWorkspace = defineStore('workspace', () => {
    const snapshot = ref({ sessions: [], runs: [], approvals: [], artifacts: [] });
    const selectedId = ref(null);
    const historyLimit = ref(50);
    const historyLoading = ref(false);
    const draft = ref({ input: '', directory: null, directoryChosen: false, model: '' });
    const draftControls = ref(blankDraftControls());
    const inputs = ref({});
    const attachmentDrafts = ref({});
    const currentAttachments = computed(() => attachmentDrafts.value[selectedId.value || 'draft'] || []);
    async function addAttachments(files) {
        if (!nativeMode.value) { error.value = '附件目前仅支持原生 Codex。'; return; }
        const key = selectedId.value || 'draft';
        await perform(async () => {
            const added = files ? await window.uah.importAttachments(files) : await window.uah.chooseAttachments();
            const existing = attachmentDrafts.value[key] || [];
            if (existing.length + added.length > 8) {
                await window.uah.releaseAttachments(added.map(item => item.id));
                throw new Error('一条消息最多添加 8 个附件。');
            }
            attachmentDrafts.value[key] = [...existing, ...added];
        });
    }
    async function removeAttachment(id) {
        const key = selectedId.value || 'draft';
        await perform(async () => {
            await window.uah.releaseAttachments([id]);
            attachmentDrafts.value[key] = (attachmentDrafts.value[key] || []).filter(item => item.id !== id);
        });
    }
    const panels = ref({});
    const activityViews = ref({});
    function activityView(run) {
        const key = `${run.sessionId}:${run.id}`;
        if (!activityViews.value[key]) activityViews.value[key] = { expanded: {}, seenApprovals: {} };
        return activityViews.value[key];
    }
    const page = ref('chat');
    const busy = ref(false);
    const error = ref('');
    const connected = ref(Boolean(window.uah));
    const ready = ref(false);
    const endpoints = ref([]);
    const nativeStatus = ref(null);
    const nativeCatalog = ref(null);
    const nativeCatalogError = ref('');
    const nativeTarget = settings => JSON.stringify([settings?.command || '', settings?.args || []]);
    async function nativeCommand(command) {
        if (!window.uah?.nativeCodex) throw new Error('请重启更新后的桌面端。');
        const result = await window.uah.nativeCodex(command);
        // A late probe must not replace a more recent saved enablement or launch target.
        if (!nativeStatus.value || result.settings.revision >= nativeStatus.value.settings.revision) nativeStatus.value = result;
        if (result.probe && nativeTarget(result.probeTarget) === nativeTarget(nativeStatus.value.settings)) {
            nativeCatalog.value = { target: nativeTarget(result.probeTarget), models: result.probe.models };
            nativeCatalogError.value = '';
        }
        return result;
    }
    async function refreshNativeModels() {
        if (!nativeStatus.value?.settings.enabled) return;
        const target = nativeTarget(nativeStatus.value.settings);
        try { await nativeCommand({ type: 'probe' }); }
        catch (cause) { if (nativeTarget(nativeStatus.value?.settings) === target) nativeCatalogError.value = clientError(cause); }
    }
    const nativeMode = computed(() => { try { return JSON.parse(currentModel.value)[0] === 'native:codex'; } catch { return false; } });
    const availableEndpoints = computed(() => {
        const settings = nativeStatus.value?.settings;
        const catalog = nativeCatalog.value?.target === nativeTarget(settings) ? nativeCatalog.value.models : [];
        const discovered = catalog.map(item => item.id);
        return [...endpoints.value, ...(settings?.enabled ? [{ id: 'native:codex', name: 'Codex 原生', enabled: true,
            models: [...new Set([settings.model, ...discovered].filter(Boolean))],
            modelNames: Object.fromEntries(catalog.map(item => [item.id, item.name || item.id])) }] : [])];
    });
    const agentSettings = ref(null);
    const draftAgentId = ref('');
    const sessionAgents = ref({});
    const sessionControlOverrides = ref({});
    async function agentCommand(command) {
        if (!window.uah?.agents) throw new Error('请重启更新后的桌面端以使用 Agent 设置。');
        const settings = await window.uah.agents(command);
        agentSettings.value = settings;
        return settings;
    }
    const modelGroups = computed(() => availableEndpoints.value.filter((endpoint) => endpoint.enabled && endpoint.models.length).map((endpoint) => ({
        id: endpoint.id, label: endpoint.name,
        models: endpoint.models.map((modelId) => ({ value: JSON.stringify([endpoint.id, modelId]), label: endpoint.modelNames?.[modelId] || modelId })),
    })));
    const modelOptions = computed(() => availableEndpoints.value.filter((endpoint) => endpoint.enabled).flatMap((endpoint) => endpoint.models.map((modelId) => ({
        value: JSON.stringify([endpoint.id, modelId]), label: `${endpoint.name} · ${endpoint.modelNames?.[modelId] || modelId}`, endpointId: endpoint.id, modelId,
    }))));
    const selected = computed(() => snapshot.value.sessions.find((item) => item.id === selectedId.value));
    const viewLoaded = computed(() => !Object.hasOwn(snapshot.value, 'viewSessionId') || snapshot.value.viewSessionId === selectedId.value);
    const sessionControls = computed(() => {
        if (!selected.value) return nativeMode.value && draftControls.value.permissionMode ? { ...draftControls.value, permissionMode: nativePermissionPreset(draftControls.value.permissionMode) } : draftControls.value;
        const saved = selected.value.controls || selected.value.initialConfig?.controls || sessionControlOverrides.value[selected.value.id];
        if (saved) return {
            ...saved,
            ...(nativeMode.value ? { permissionMode: nativePermissionPreset(saved.permissionMode) } : {}),
            // Older model-level settings used this sentinel before effort moved to sessions.
            reasoningEffort: saved.reasoningEffort === 'model-default' ? 'default' : saved.reasoningEffort,
        };
        // Older sessions did not store conversation reasoning controls separately.
        return {
            permissionMode: permissionModes.includes(selected.value.requested?.permissionMode) ? selected.value.requested.permissionMode : defaultSessionControls().permissionMode,
            reasoningEffort: 'default',
        };
    });
    async function setSessionControl(key, value) {
        if (!viewLoaded.value || busy.value || activeRun.value || currentModel.value === 'local-verification') return;
        const controls = { ...sessionControls.value, [key]: value };
        if (!selected.value) { draftControls.value = controls; return; }
        const sessionId = selected.value.id;
        const revision = selected.value.controlsRevision ?? 0;
        await perform(() => command({ type: 'set-session-controls', sessionId, controls, revision }));
    }
    const lockedAgent = computed(() => snapshot.value.runs.find(item => item.sessionId === selectedId.value && !item.parentRunId)?.effective || selected.value?.branchAgent);
    const agentLocked = computed(() => Boolean(lockedAgent.value) || (selectedId.value !== null && !viewLoaded.value));
    const currentAgent = computed({
        get: () => {
            if (nativeMode.value) return 'native-default';
            if (lockedAgent.value) return lockedAgent.value.agentId;
            if (!selected.value) return draftAgentId.value;
            const saved = sessionAgents.value[selectedId.value] ?? selected.value.initialConfig?.agentId ?? selected.value.requested?.agentId;
            return saved && !['api-text', 'local-verification'].includes(saved) ? saved : '';
        },
        set: (value) => {
            if (agentLocked.value) return;
            if (selected.value) sessionAgents.value[selectedId.value] = value;
            else draftAgentId.value = value;
        },
    });
    const agentOptions = computed(() => {
        if (nativeMode.value) return [{ id: 'native-default', name: 'Codex 原生默认' }];
        const options = agentSettings.value?.profiles.filter(item => item.kind === 'primary' && item.enabled) || [];
        if (!lockedAgent.value) return options;
        return [{ id: lockedAgent.value.agentId, name: lockedAgent.value.agentName || '会话 Agent' }];
    });
    const agentAvailable = computed(() => currentModel.value === 'local-verification' || agentOptions.value.some(item => item.id === currentAgent.value));
    const currentModelParameters = computed(() => {
        const option = modelOptions.value.find(item => item.value === currentModel.value);
        return endpoints.value.find(item => item.id === option?.endpointId)?.modelParameters?.find(item => item.id === option.modelId)?.parameters;
    });
    const sessionModels = ref({});
    const currentModel = computed({
        get: () => {
            if (!selected.value) return draft.value.model;
            const config = selected.value.requested;
            if (Object.hasOwn(sessionModels.value, selectedId.value)) return sessionModels.value[selectedId.value];
            if (['api', 'codex-native'].includes(config?.runtimeId)) return JSON.stringify([config.endpointId, config.modelId]);
            if (config?.runtimeId === 'local-verification') return 'local-verification';
            const initialSelection = selected.value.initialConfig?.selection;
            if (isSelection(initialSelection)) return JSON.stringify([initialSelection.endpointId, initialSelection.modelId]);
            if (selected.value.initialConfig && initialSelection === null) return 'local-verification';
            return '';
        },
        set: (value) => {
            if (!viewLoaded.value) return;
            const runtime = value === 'local-verification' ? 'local-verification' : value.startsWith('["native:codex",') ? 'codex-native' : 'api';
            if (lockedAgent.value && lockedAgent.value.runtimeId !== runtime) return;
            if (selected.value) sessionModels.value[selectedId.value] = value;
            else draft.value.model = value;
        },
    });
    const runs = computed(() => {
        const roots = visibleRootRuns(snapshot.value.runs, selectedId.value);
        const ids = snapshot.value.historyWindow?.rootIds;
        return ids ? roots.filter(run => ids.includes(run.id)) : roots;
    });
    const activeRun = computed(() => snapshot.value.runs.find(item => item.sessionId === selectedId.value && !item.parentRunId && activeStates.includes(item.state)));
    const modelAvailable = computed(() => {
        return currentModel.value === 'local-verification' || modelOptions.value.some((item) => item.value === currentModel.value);
    });
    const configurationReady = computed(() => {
        if (!viewLoaded.value) return false;
        if (nativeMode.value && !(selected.value?.directory || draft.value.directory)) return false;
        if (selected.value) return modelAvailable.value && agentAvailable.value
            && permissionModes.includes(sessionControls.value.permissionMode)
            && reasoningEfforts.includes(sessionControls.value.reasoningEffort);
        if (!draft.value.directoryChosen || !modelAvailable.value) return false;
        if (currentModel.value === 'local-verification') return true;
        return Boolean(currentAgent.value
            && agentOptions.value.some(item => item.id === currentAgent.value)
            && permissionModes.includes(draftControls.value.permissionMode)
            && reasoningEfforts.includes(draftControls.value.reasoningEffort));
    });
    const currentInput = computed({
        get: () => selected.value ? inputs.value[selectedId.value] || '' : draft.value.input,
        set: (value) => { if (selected.value) inputs.value[selectedId.value] = value; else draft.value.input = value; }
    });
    const panel = computed(() => {
        const key = selectedId.value || 'draft';
        if (!panels.value[key]) panels.value[key] = { open: false, tab: 'files', artifactId: null, changeRunId: null, width: 390, scrollTop: 0 };
        return panels.value[key];
    });
    let unsubscribe;
    let refreshTimer;
    let refreshJob;
    let selectionGeneration = 0;
    let knownHistoryTotal = null;
    const fullHistory = computed(() => panel.value.open && ['files', 'plans', 'agents'].includes(panel.value.tab));
    const historyPanelReady = computed(() => viewLoaded.value && !snapshot.value.historyWindow);
    const historyTotal = computed(() => snapshot.value.historyWindow?.total ?? runs.value.length);
    function snapshotView(sessionId) {
        return { sessionId, ...(sessionId !== null && !fullHistory.value ? { turnLimit: historyLimit.value } : {}) };
    }
    function retainLoadedBoundary(reply, sessionId) {
        if (sessionId === null) return false;
        const total = reply.historyWindow?.total ?? visibleRootRuns(reply.runs, sessionId).length;
        const increase = knownHistoryTotal === null ? 0 : Math.max(0, total - knownHistoryTotal);
        knownHistoryTotal = total;
        if (!increase) return false;
        const previous = historyLimit.value;
        historyLimit.value = Math.min(100000, previous + increase);
        return !!reply.historyWindow && historyLimit.value !== previous;
    }
    watch(fullHistory, () => { if (ready.value) refresh(); });
    async function loadEarlier() {
        if (historyLoading.value) return;
        const generation = selectionGeneration;
        historyLoading.value = true;
        historyLimit.value = Math.min(100000, historyLimit.value + 50);
        try { await refresh(); }
        finally { if (generation === selectionGeneration) historyLoading.value = false; }
    }

    function refresh() {
        if (!window.uah) return;
        if (refreshJob?.generation === selectionGeneration && refreshJob.sessionId === selectedId.value) { refreshJob.dirty = true; return refreshJob.promise; }
        const job = { generation: selectionGeneration, sessionId: selectedId.value, dirty: false };
        job.promise = (async () => {
            try {
                do {
                    job.dirty = false;
                    const view = snapshotView(job.sessionId);
                    const reply = await window.uah.command({ type: 'snapshot' }, view);
                    if (job.generation !== selectionGeneration || job.sessionId !== selectedId.value) return;
                    if (JSON.stringify(view) !== JSON.stringify(snapshotView(job.sessionId))) { job.dirty = true; continue; }
                    if (retainLoadedBoundary(reply, job.sessionId)) { job.dirty = true; continue; }
                    snapshot.value = mergeRunSnapshot(snapshot.value, reply, job.sessionId);
                } while (job.dirty);
            } catch (cause) {
                if (job.generation === selectionGeneration && job.sessionId === selectedId.value) error.value = clientError(cause);
            } finally {
                if (refreshJob === job) refreshJob = undefined;
            }
        })();
        refreshJob = job;
        return job.promise;
    }

    async function initialize() {
        if (!window.uah) { ready.value = true; return; }
        unsubscribe = window.uah.onEvent((event) => {
            const result = applyRunEvent(snapshot.value, event);
            if (result !== 'refresh') return;
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(refresh, 0);
        });
        await refresh();
        if (window.uah.endpoints) {
            try { await endpointCommand({ type: 'list' }); }
            catch (cause) { error.value = clientError(cause); }
        }
        if (window.uah.agents) {
            try { await agentCommand({ type: 'get' }); }
            catch (cause) { error.value = clientError(cause); }
        }
        if (window.uah.nativeCodex) {
            try { await nativeCommand({ type: 'get' }); }
            catch (cause) { error.value = clientError(cause); }
            void refreshNativeModels();
        }
        if (Object.hasOwn(snapshot.value, 'viewSessionId') && snapshot.value.viewSessionId !== selectedId.value) await refresh();
        seedDraftFromLatestInitialConfig();
        ready.value = true;
    }

    async function command(value) {
        if (!window.uah) throw new Error('请在桌面应用中运行此操作。');
        const generation = selectionGeneration; const sessionId = selectedId.value;
        const view = snapshotView(sessionId);
        const reply = await window.uah.command(value, view);
        if (generation === selectionGeneration && sessionId === selectedId.value && JSON.stringify(view) === JSON.stringify(snapshotView(sessionId))
            && !retainLoadedBoundary(reply, sessionId)) snapshot.value = mergeRunSnapshot(snapshot.value, reply, sessionId);
        // A coalesced refresh also observes any event that raced with this reply.
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 0);
        return reply;
    }

    async function endpointCommand(value) {
        if (!window.uah?.endpoints) throw new Error('请在桌面应用中管理 API 端点。');
        const reply = await window.uah.endpoints(value);
        endpoints.value = reply.endpoints;
        return reply;
    }

    async function perform(action) {
        if (busy.value) return;
        busy.value = true;
        error.value = '';
        try { await action(); }
        catch (cause) { error.value = clientError(cause); }
        finally { busy.value = false; }
    }

    function seedDraftFromLatestInitialConfig() {
        draftAgentId.value = '';
        draft.value.model = '';
        draft.value.directory = null;
        draft.value.directoryChosen = false;
        draftControls.value = blankDraftControls();
        const latest = newestSession(snapshot.value.sessions);
        const initial = latest?.initialConfig;
        if (!isInitialConfig(initial)) return;
        draftAgentId.value = initial.agentId;
        draft.value.model = initial.selection === null
            ? 'local-verification'
            : JSON.stringify([initial.selection.endpointId, initial.selection.modelId]);
        draftControls.value = { ...initial.controls };
        draft.value.directory = initial.directory;
        draft.value.directoryChosen = true;
    }

    async function answerNativeQuestion(runId, questionId, answers) {
        return perform(() => command({ type: 'answer-native-question', runId, questionId, answers }));
    }

    async function send() {
        const submittedText = currentInput.value;
        const attached = [...currentAttachments.value];
        const attachmentKey = selectedId.value || 'draft';
        const input = submittedText.trim() || (attached.length ? '请查看附件。' : '');
        if (!input || activeRun.value || !configurationReady.value) return;
        if (attached.length && !nativeMode.value) { error.value = '请切换到原生 Codex 或移除附件。'; return; }
        let targetSessionId = selectedId.value;
        const generation = selectionGeneration;
        const sourceDraft = draft.value;
        const selectedModel = modelOptions.value.find((item) => item.value === currentModel.value);
        const localSelected = currentModel.value === 'local-verification';
        const selectedModelValue = currentModel.value;
        const controls = localSelected ? undefined : { ...sessionControls.value };
        const hasModelOverride = targetSessionId && Object.hasOwn(sessionModels.value, targetSessionId);
        const selection = selectedModel ? { endpointId: selectedModel.endpointId, modelId: selectedModel.modelId } : null;
        const agentId = localSelected || agentLocked.value ? undefined : currentAgent.value;
        await perform(async () => {
            if (!targetSessionId) {
                const previous = new Set(snapshot.value.sessions.map((item) => item.id));
                const created = await command({ type: 'create-session', title: input.slice(0, 48), directory: sourceDraft.directory,
                    ...(sourceDraft.branchFromRunId ? { branchFromRunId: sourceDraft.branchFromRunId } : {}),
                    ...(agentId ? { agentId } : {}),
                    ...(controls ? { controls, selection: { endpointId: selectedModel.endpointId, modelId: selectedModel.modelId } } : {}) });
                targetSessionId = created.sessions.find((item) => !previous.has(item.id))?.id;
                if (!targetSessionId) throw new Error('新会话未能保存。');
                if (agentId) sessionAgents.value[targetSessionId] = agentId;
                if (controls) sessionControlOverrides.value[targetSessionId] = controls;
                sessionModels.value[targetSessionId] = selectedModelValue;
                inputs.value[targetSessionId] = sourceDraft.input === submittedText ? submittedText : sourceDraft.input;
                if (generation === selectionGeneration) select(targetSessionId);
                if (draft.value === sourceDraft) draft.value.input = '';
                if (attached.length) { attachmentDrafts.value[targetSessionId] = attached; delete attachmentDrafts.value[attachmentKey]; }
            }
            await command({ type: 'start-run', sessionId: targetSessionId, input, ...(attached.length ? { attachmentIds: attached.map(item => item.id) } : {}), ...(hasModelOverride ? { selection } : {}), ...(agentId ? { agentId } : {}) });
            if (attached.length) attachmentDrafts.value[targetSessionId] = (attachmentDrafts.value[targetSessionId] || []).filter(item => !attached.some(sent => sent.id === item.id));
            if (inputs.value[targetSessionId] === submittedText) inputs.value[targetSessionId] = '';
        });
    }

    async function executeNativePlan() {
        if (!nativeMode.value || !selectedId.value || activeRun.value) return;
        const sessionId = selectedId.value;
        await perform(() => command({ type: 'start-run', sessionId, input: '/plan execute' }));
    }
    function reviseNativePlan() {
        if (!nativeMode.value || activeRun.value) return;
        currentInput.value = `/plan revise ${currentInput.value}`;
        panel.value.open = false;
    }

    async function steer() {
        const run = activeRun.value;
        const submittedText = currentInput.value;
        if (!run?.activeStepId || run.effective?.permissionMode === 'plan' || !submittedText.trim()) return;
        await perform(async () => {
            await command({ type: 'steer-run', runId: run.id, expectedStepId: run.activeStepId, input: submittedText.trim() });
            if (inputs.value[run.sessionId] === submittedText) inputs.value[run.sessionId] = '';
        });
    }
    function select(id) {
        knownHistoryTotal = null;
        historyLimit.value = 50; historyLoading.value = false;
        selectionGeneration++; selectedId.value = id; page.value = 'chat';
        if (Object.hasOwn(snapshot.value, 'viewSessionId')) return refresh();
    }
    function newSession() {
        const abandonedAttachments = attachmentDrafts.value.draft || [];
        delete attachmentDrafts.value.draft;
        if (abandonedAttachments.length) window.uah?.releaseAttachments(abandonedAttachments.map(item => item.id)).catch(cause => { error.value = clientError(cause); });
        knownHistoryTotal = null;
        historyLimit.value = 50; historyLoading.value = false;
        selectionGeneration++;
        selectedId.value = null;
        refresh();
        page.value = 'chat';
        draft.value = { input: '', directory: null, directoryChosen: false, model: '' };
        seedDraftFromLatestInitialConfig();
    }
    async function chooseDirectory() {
        await perform(async () => {
            const directory = await window.uah.chooseDirectory();
            if (directory) {
                draft.value.directory = directory;
                draft.value.directoryChosen = true;
            }
        });
    }
    function chooseNoDirectory() {
        if (busy.value || selected.value) return;
        draft.value.directory = null;
        draft.value.directoryChosen = true;
    }
    async function branchFrom(run) {
        if (busy.value || activeRun.value) return;
        const source = snapshot.value.sessions.find(session => session.id === run.sessionId);
        if (!source || selectedId.value !== source.id) return;
        const generation = selectionGeneration;
        const model = modelOptions.value.find(item => item.value === currentModel.value);
        const local = currentModel.value === 'local-verification';
        if (!local && !model) { error.value = '请先选择可用模型，再创建分支。'; return; }
        const controls = { ...sessionControls.value };
        await perform(async () => {
            const previous = new Set(snapshot.value.sessions.map(item => item.id));
            const created = await command({ type: 'create-session', title: `${source.title.slice(0, 42)} · 分支`, directory: source.directory,
                branchFromRunId: run.id,
                ...(!local ? { selection: { endpointId: model.endpointId, modelId: model.modelId }, controls, agentId: run.effective.agentId } : {}) });
            const branch = created.sessions.find(item => !previous.has(item.id) && item.branchFromRunId === run.id);
            if (!branch) throw new Error('分支会话未能保存。');
            if (generation === selectionGeneration) select(branch.id);
        });
    }
    function historyCommand(value) { return perform(() => command(value)); }
    async function purgeSession(sessionId, fingerprint) {
        if (busy.value) throw new Error('请等待当前操作完成。');
        error.value = '';
        busy.value = true;
        try {
            const result = await window.uah.journal(fingerprint
                ? { action: 'purge-confirm', sessionId, fingerprint, confirmation: '永久删除' }
                : { action: 'purge-retry', sessionId });
            return result;
        } finally {
            // Resolve an ambiguous IPC failure from fresh authority too. Invalidate
            // all older view replies before discarding any loaded conversation.
            selectionGeneration++;
            try {
                const fresh = await window.uah.command({ type: 'snapshot' }, { sessionId: null });
                const remains = fresh.sessions.some(item => item.id === sessionId);
                snapshot.value = fresh;
                if (!remains) {
                    delete inputs.value[sessionId]; delete sessionModels.value[sessionId]; delete sessionAgents.value[sessionId];
                    if (selectedId.value === sessionId) {
                        selectedId.value = null; panel.open = false;
                        knownHistoryTotal = null; historyLimit.value = 50; historyLoading.value = false;
                        draft.value = { input: '', directory: null, directoryChosen: false, model: '' };
                        seedDraftFromLatestInitialConfig();
                    }
                }
                await refresh();
            } catch (cause) { error.value = `无法刷新删除状态，请重启确认：${clientError(cause)}`; }
            busy.value = false;
        }
    }
    async function retryPurge(sessionId) {
        try { const result = await purgeSession(sessionId); if (!result.completed) error.value = result.error || '删除尚未完成，请检查后重试。'; }
        catch (cause) { error.value = clientError(cause); }
    }
    function stop(run, reason) { return perform(() => command({ type: 'stop-run', runId: run.id, ...(reason?.trim() ? { reason: reason.trim() } : {}) })); }
    function resolve(approval, decision) {
        const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = approval;
        return perform(() => command({ type: 'resolve-approval', identity: { runtimeId, sessionId, runId, turnId, requestId, policyVersion }, decision }));
    }
    function dispose() { unsubscribe?.(); clearTimeout(refreshTimer); }
    return { executeNativePlan, reviseNativePlan, currentAttachments, addAttachments, removeAttachment, answerNativeQuestion, nativeCatalogError, refreshNativeModels, nativeMode, nativeStatus, nativeCommand, purgeSession, retryPurge, historyLimit, historyLoading, historyTotal, historyPanelReady, loadEarlier, steer, branchFrom, historyCommand, activityView, sessionControls, setSessionControl, agentLocked, lockedAgent, currentModelParameters, agentSettings, agentCommand, currentAgent, agentOptions, agentAvailable, snapshot, selectedId, draft, inputs, panel, page, busy, error, connected, ready, endpoints, modelGroups, modelOptions, currentModel, modelAvailable, configurationReady, endpointCommand, selected, runs, activeRun, currentInput, initialize, send, select, newSession, chooseDirectory, chooseNoDirectory, stop, resolve, dispose };
});
