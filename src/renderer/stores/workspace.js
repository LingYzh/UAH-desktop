import { defineStore } from 'pinia';
import { computed, ref } from 'vue';
import { defaultSessionControls } from '../../shared/session-controls';
import { permissionModes } from '../../shared/permissions';
import { visibleRootRuns } from '../../shared/conversation-history';

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
    const draft = ref({ input: '', directory: null, directoryChosen: false, model: '' });
    const draftControls = ref(blankDraftControls());
    const inputs = ref({});
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
    const modelGroups = computed(() => endpoints.value.filter((endpoint) => endpoint.enabled && endpoint.models.length).map((endpoint) => ({
        id: endpoint.id, label: endpoint.name,
        models: endpoint.models.map((modelId) => ({ value: JSON.stringify([endpoint.id, modelId]), label: modelId })),
    })));
    const modelOptions = computed(() => endpoints.value.filter((endpoint) => endpoint.enabled).flatMap((endpoint) => endpoint.models.map((modelId) => ({
        value: JSON.stringify([endpoint.id, modelId]), label: `${endpoint.name} · ${modelId}`, endpointId: endpoint.id, modelId,
    }))));
    const selected = computed(() => snapshot.value.sessions.find((item) => item.id === selectedId.value));
    const sessionControls = computed(() => {
        if (!selected.value) return draftControls.value;
        const saved = selected.value.controls || selected.value.initialConfig?.controls || sessionControlOverrides.value[selected.value.id];
        if (saved) return {
            ...saved,
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
        if (busy.value || activeRun.value || currentModel.value === 'local-verification') return;
        const controls = { ...sessionControls.value, [key]: value };
        if (!selected.value) { draftControls.value = controls; return; }
        const sessionId = selected.value.id;
        const revision = selected.value.controlsRevision ?? 0;
        await perform(() => command({ type: 'set-session-controls', sessionId, controls, revision }));
    }
    const lockedAgent = computed(() => snapshot.value.runs.find(item => item.sessionId === selectedId.value && !item.parentRunId)?.effective || selected.value?.branchAgent);
    const agentLocked = computed(() => Boolean(lockedAgent.value));
    const currentAgent = computed({
        get: () => {
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
            if (config?.runtimeId === 'api') return JSON.stringify([config.endpointId, config.modelId]);
            if (config?.runtimeId === 'local-verification') return 'local-verification';
            const initialSelection = selected.value.initialConfig?.selection;
            if (isSelection(initialSelection)) return JSON.stringify([initialSelection.endpointId, initialSelection.modelId]);
            if (selected.value.initialConfig && initialSelection === null) return 'local-verification';
            return '';
        },
        set: (value) => {
            if (lockedAgent.value && ((lockedAgent.value.runtimeId === 'api') === (value === 'local-verification'))) return;
            if (selected.value) sessionModels.value[selectedId.value] = value;
            else draft.value.model = value;
        },
    });
    const runs = computed(() => visibleRootRuns(snapshot.value.runs, selectedId.value));
    const activeRun = computed(() => runs.value.find((item) => activeStates.includes(item.state)));
    const modelAvailable = computed(() => {
        return currentModel.value === 'local-verification' || modelOptions.value.some((item) => item.value === currentModel.value);
    });
    const configurationReady = computed(() => {
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
    let refreshing = false;
    let dirty = false;
    const sequences = new Map();
    let selectionGeneration = 0;

    async function refresh() {
        if (!window.uah) return;
        if (refreshing) { dirty = true; return; }
        refreshing = true;
        try {
            do {
                dirty = false;
                snapshot.value = await window.uah.command({ type: 'snapshot' });
            } while (dirty);
        } catch (cause) { error.value = cause.message; }
        finally { refreshing = false; }
    }

    async function initialize() {
        if (!window.uah) { ready.value = true; return; }
        unsubscribe = window.uah.onEvent((event) => {
            const key = `${event.sessionId}/${event.runId}`;
            if (event.runId && event.sequence <= (sequences.get(key) || 0)) return;
            sequences.set(key, event.sequence);
            clearTimeout(refreshTimer);
            refreshTimer = setTimeout(refresh, event.type === 'delta' ? 25 : 0);
        });
        await refresh();
        if (window.uah.endpoints) {
            try { await endpointCommand({ type: 'list' }); }
            catch (cause) { error.value = cause.message; }
        }
        if (window.uah.agents) {
            try { await agentCommand({ type: 'get' }); }
            catch (cause) { error.value = cause.message; }
        }
        selectedId.value = newestSession(snapshot.value.sessions)?.id || null;
        seedDraftFromLatestInitialConfig();
        ready.value = true;
    }

    async function command(value) {
        if (!window.uah) throw new Error('请在桌面应用中运行此操作。');
        snapshot.value = await window.uah.command(value);
        // A coalesced refresh also observes any event that raced with this reply.
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 0);
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
        catch (cause) { error.value = cause.message || '操作未完成。'; }
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

    async function send() {
        const submittedText = currentInput.value;
        const input = submittedText.trim();
        if (!input || activeRun.value || !configurationReady.value) return;
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
                await command({ type: 'create-session', title: input.slice(0, 48), directory: sourceDraft.directory,
                    ...(sourceDraft.branchFromRunId ? { branchFromRunId: sourceDraft.branchFromRunId } : {}),
                    ...(agentId ? { agentId } : {}),
                    ...(controls ? { controls, selection: { endpointId: selectedModel.endpointId, modelId: selectedModel.modelId } } : {}) });
                targetSessionId = snapshot.value.sessions.find((item) => !previous.has(item.id))?.id;
                if (!targetSessionId) throw new Error('新会话未能保存。');
                if (agentId) sessionAgents.value[targetSessionId] = agentId;
                if (controls) sessionControlOverrides.value[targetSessionId] = controls;
                sessionModels.value[targetSessionId] = selectedModelValue;
                inputs.value[targetSessionId] = sourceDraft.input === submittedText ? submittedText : sourceDraft.input;
                if (generation === selectionGeneration) selectedId.value = targetSessionId;
                if (draft.value === sourceDraft) draft.value.input = '';
            }
            await command({ type: 'start-run', sessionId: targetSessionId, input, ...(hasModelOverride ? { selection } : {}), ...(agentId ? { agentId } : {}) });
            if (inputs.value[targetSessionId] === submittedText) inputs.value[targetSessionId] = '';
        });
    }

    function select(id) { selectionGeneration++; selectedId.value = id; page.value = 'chat'; }
    function newSession() {
        selectionGeneration++;
        selectedId.value = null;
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
            await command({ type: 'create-session', title: `${source.title.slice(0, 42)} · 分支`, directory: source.directory,
                branchFromRunId: run.id,
                ...(!local ? { selection: { endpointId: model.endpointId, modelId: model.modelId }, controls, agentId: run.effective.agentId } : {}) });
            const branch = snapshot.value.sessions.find(item => !previous.has(item.id) && item.branchFromRunId === run.id);
            if (!branch) throw new Error('分支会话未能保存。');
            if (generation === selectionGeneration) select(branch.id);
        });
    }
    function historyCommand(value) { return perform(() => command(value)); }
    function stop(run, reason) { return perform(() => command({ type: 'stop-run', runId: run.id, ...(reason?.trim() ? { reason: reason.trim() } : {}) })); }
    function resolve(approval, decision) {
        const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = approval;
        return perform(() => command({ type: 'resolve-approval', identity: { runtimeId, sessionId, runId, turnId, requestId, policyVersion }, decision }));
    }
    function dispose() { unsubscribe?.(); clearTimeout(refreshTimer); }
    return { branchFrom, historyCommand, activityView, sessionControls, setSessionControl, agentLocked, lockedAgent, currentModelParameters, agentSettings, agentCommand, currentAgent, agentOptions, agentAvailable, snapshot, selectedId, draft, inputs, panel, page, busy, error, connected, ready, endpoints, modelGroups, modelOptions, currentModel, modelAvailable, configurationReady, endpointCommand, selected, runs, activeRun, currentInput, initialize, send, select, newSession, chooseDirectory, chooseNoDirectory, stop, resolve, dispose };
});
