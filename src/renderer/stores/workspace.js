import { defineStore } from 'pinia';
import { computed, ref } from 'vue';

export const activeStates = ['running', 'approval', 'cancelRequested', 'stopping'];
export const stateLabels = { running: '运行中', approval: '等待审批', cancelRequested: '已请求取消', stopping: '正在停止', stopped: '已中止', completed: '已完成', failed: '失败' };

export const useWorkspace = defineStore('workspace', () => {
    const snapshot = ref({ sessions: [], runs: [], approvals: [], artifacts: [] });
    const selectedId = ref(null);
    const draft = ref({ input: '', directory: null, model: '' });
    const inputs = ref({});
    const panels = ref({});
    const page = ref('chat');
    const busy = ref(false);
    const error = ref('');
    const connected = ref(Boolean(window.uah));
    const ready = ref(false);
    const selected = computed(() => snapshot.value.sessions.find((item) => item.id === selectedId.value));
    const runs = computed(() => snapshot.value.runs.filter((item) => item.sessionId === selectedId.value));
    const activeRun = computed(() => runs.value.find((item) => activeStates.includes(item.state)));
    const currentInput = computed({
        get: () => selected.value ? inputs.value[selectedId.value] || '' : draft.value.input,
        set: (value) => { if (selected.value) inputs.value[selectedId.value] = value; else draft.value.input = value; }
    });
    const panel = computed(() => {
        const key = selectedId.value || 'draft';
        if (!panels.value[key]) panels.value[key] = { open: false, tab: 'files', artifactId: null, width: 390, scrollTop: 0 };
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
        selectedId.value = snapshot.value.sessions.at(-1)?.id || null;
        ready.value = true;
    }

    async function command(value) {
        if (!window.uah) throw new Error('请在桌面应用中运行此操作。');
        snapshot.value = await window.uah.command(value);
        // A coalesced refresh also observes any event that raced with this reply.
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(refresh, 0);
    }

    async function perform(action) {
        if (busy.value) return;
        busy.value = true;
        error.value = '';
        try { await action(); }
        catch (cause) { error.value = cause.message || '操作未完成。'; }
        finally { busy.value = false; }
    }

    async function send() {
        const submittedText = currentInput.value;
        const input = submittedText.trim();
        if (!input || activeRun.value || (!selected.value && !draft.value.model)) return;
        let targetSessionId = selectedId.value;
        const generation = selectionGeneration;
        const sourceDraft = draft.value;
        await perform(async () => {
            if (!targetSessionId) {
                const previous = new Set(snapshot.value.sessions.map((item) => item.id));
                await command({ type: 'create-session', title: input.slice(0, 48), directory: sourceDraft.directory });
                targetSessionId = snapshot.value.sessions.find((item) => !previous.has(item.id)).id;
                inputs.value[targetSessionId] = sourceDraft.input === submittedText ? submittedText : sourceDraft.input;
                if (generation === selectionGeneration) selectedId.value = targetSessionId;
                if (draft.value === sourceDraft) draft.value.input = '';
            }
            await command({ type: 'start-run', sessionId: targetSessionId, input });
            if (inputs.value[targetSessionId] === submittedText) inputs.value[targetSessionId] = '';
        });
    }

    function select(id) { selectionGeneration++; selectedId.value = id; page.value = 'chat'; }
    function newSession() { selectionGeneration++; selectedId.value = null; page.value = 'chat'; draft.value = { input: '', directory: null, model: draft.value.model }; }
    async function chooseDirectory() {
        await perform(async () => {
            const directory = await window.uah.chooseDirectory();
            if (directory) draft.value.directory = directory;
        });
    }
    function stop(run) { return perform(() => command({ type: 'stop-run', runId: run.id })); }
    function resolve(approval, decision) {
        const { runtimeId, sessionId, runId, turnId, requestId, policyVersion } = approval;
        return perform(() => command({ type: 'resolve-approval', identity: { runtimeId, sessionId, runId, turnId, requestId, policyVersion }, decision }));
    }
    function dispose() { unsubscribe?.(); clearTimeout(refreshTimer); }
    return { snapshot, selectedId, draft, inputs, panel, page, busy, error, connected, ready, selected, runs, activeRun, currentInput, initialize, send, select, newSession, chooseDirectory, stop, resolve, dispose };
});
