import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { computed } from 'vue';
import { useWorkspace } from '../../src/renderer/stores/workspace.js';

const empty = () => ({ sessions: [], runs: [], approvals: [], artifacts: [] });
test('first activity expansion updates reactively and remains isolated across sessions', () => {
    globalThis.window = {};
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    const run = { id: 'same-run', sessionId: 'first' };
    const view = workspace.activityView(run);
    const open = computed(() => view.expanded['first-reasoning']);
    assert.equal(open.value, undefined);
    view.expanded['first-reasoning'] = true;
    assert.equal(open.value, true);
    assert.equal(workspace.activityView(run).expanded['first-reasoning'], true);
    assert.equal(workspace.activityView({ ...run, sessionId: 'second' }).expanded['first-reasoning'], undefined);
});
const apiProfiles = [
    { id: 'default', enabled: true, kind: 'primary' },
    { id: 'reviewer', enabled: true, kind: 'primary' },
];
const copyProfiles = profiles => profiles.map(profile => ({ ...profile }));
const endpointList = [{ id: 'endpoint', name: 'Test endpoint', enabled: true, models: ['review-model', 'second-model'] }];
const modelValue = (endpointId = 'endpoint', modelId = 'review-model') => JSON.stringify([endpointId, modelId]);

function apiInitialConfig(agentId = 'reviewer', selection = { endpointId: 'endpoint', modelId: 'review-model' }, directory = null) {
    return { agentId, selection, controls: { permissionMode: 'manual', reasoningEffort: 'high' }, directory };
}

function sessionFromCreate(command, id = 'new-session') {
    const local = !command.selection;
    return {
        id,
        title: command.title,
        directory: command.directory,
        createdAt: '2026-09-27T00:00:00.000Z',
        controls: command.controls,
        requested: local
            ? { runtimeId: 'local-verification', agentId: 'local-verification' }
            : { runtimeId: 'api', agentId: command.agentId, ...command.selection },
    };
}

async function configureApiDraft(workspace, { agentId = 'reviewer', selection = modelValue(), directory = null } = {}) {
    workspace.agentSettings = { profiles: copyProfiles(apiProfiles) };
    workspace.endpoints = endpointList;
    workspace.currentAgent = agentId;
    workspace.currentModel = selection;
    await workspace.setSessionControl('permissionMode', 'manual');
    await workspace.setSessionControl('reasoningEffort', 'high');
    workspace.draft.directory = directory;
    workspace.draft.directoryChosen = true;
}

function initializeWorkspace(snapshot, { profiles = apiProfiles, endpoints = endpointList, onCommand = () => snapshot } = {}) {
    globalThis.window = {
        uah: {
            onEvent: () => () => {},
            command: async command => command.type === 'snapshot' ? snapshot : onCommand(command),
            agents: async () => ({ profiles: copyProfiles(profiles) }),
            endpoints: async () => ({ endpoints }),
        },
    };
    setActivePinia(createPinia());
    return useWorkspace();
}

test('branch click saves immediately, inherits current controls and locks copied Agent without starting a model request', async () => {
    const source = { id: 'source', title: 'Source', directory: null, requested: { runtimeId: 'api', agentId: 'reviewer', endpointId: 'endpoint', modelId: 'review-model' }, controls: { permissionMode: 'plan', reasoningEffort: 'low' } };
    const run = { id: 'source-run', sessionId: source.id, state: 'completed', effective: { ...source.requested, agentInstructions: 'saved instructions' } };
    let saved = { ...empty(), sessions: [source], runs: [run] };
    const commands = [];
    const workspace = initializeWorkspace(saved, { onCommand: command => {
        commands.push(command);
        saved = { ...saved, sessions: [...saved.sessions, { ...sessionFromCreate(command, 'branch'), branchFromRunId: run.id, branchAgent: run.effective, branchMessages: [{ role: 'assistant', content: 'saved answer' }] }] };
        return saved;
    } });
    await workspace.initialize();
    workspace.select(source.id);
    workspace.currentModel = modelValue('endpoint', 'second-model');
    workspace.inputs[source.id] = 'unsent source text';
    await workspace.branchFrom(run);
    assert.equal(commands.length, 1);
    assert.deepEqual(commands[0], { type: 'create-session', title: 'Source · 分支', directory: null, branchFromRunId: run.id,
        selection: { endpointId: 'endpoint', modelId: 'second-model' }, agentId: 'reviewer', controls: { permissionMode: 'plan', reasoningEffort: 'low' } });
    assert.equal(workspace.selectedId, 'branch');
    assert.equal(workspace.agentLocked, true);
    assert.equal(workspace.lockedAgent.agentInstructions, 'saved instructions');
    assert.deepEqual(workspace.selected.branchMessages, [{ role: 'assistant', content: 'saved answer' }]);
    assert.equal(workspace.inputs[source.id], 'unsent source text');
    workspace.dispose();
});

test('branch creation failure preserves the source; a late save does not steal navigation or duplicate on double click', async () => {
    const source = { id: 'source', title: 'Source', directory: null, requested: { runtimeId: 'local-verification' } };
    const run = { id: 'source-run', sessionId: source.id, state: 'completed', effective: source.requested };
    const saved = { ...empty(), sessions: [source], runs: [run] };
    let gate = deferred();
    let count = 0;
    const workspace = initializeWorkspace(saved, { onCommand: () => { count++; return gate.promise; } });
    await workspace.initialize(); workspace.select(source.id);
    const pending = workspace.branchFrom(run);
    await workspace.branchFrom(run);
    assert.equal(count, 1);
    gate.reject(new Error('fixture storage failure'));
    await pending;
    assert.equal(workspace.selectedId, source.id);
    assert.match(workspace.error, /操作未完成/);
    gate = deferred();
    const late = workspace.branchFrom(run);
    workspace.newSession(); workspace.draft.input = 'keep this draft';
    gate.resolve({ ...saved, sessions: [...saved.sessions, { ...source, id: 'branch', branchFromRunId: run.id }] });
    await late;
    assert.equal(workspace.selectedId, null);
    assert.equal(workspace.draft.input, 'keep this draft');
    workspace.dispose();
});

test('first API use waits for explicit Agent, model, permission, effort and directory choices', async () => {
    const commands = [];
    let saved = empty();
    globalThis.window = { uah: {
        command: async command => {
            commands.push(command);
            if (command.type === 'create-session') saved = { ...empty(), sessions: [sessionFromCreate(command)] };
            return saved;
        },
    } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    workspace.agentSettings = { profiles: copyProfiles(apiProfiles) };
    workspace.endpoints = endpointList;
    workspace.draft.input = 'first request';
    assert.equal(workspace.currentAgent, '');
    assert.equal(workspace.currentModel, '');
    assert.deepEqual(workspace.sessionControls, { permissionMode: '', reasoningEffort: '' });
    assert.equal(workspace.draft.directoryChosen, false);
    assert.equal(workspace.configurationReady, false);
    await workspace.send();
    assert.equal(commands.length, 0);

    workspace.currentAgent = 'reviewer';
    workspace.currentModel = modelValue();
    assert.equal(workspace.configurationReady, false);
    await workspace.setSessionControl('permissionMode', 'manual');
    assert.equal(workspace.configurationReady, false);
    await workspace.setSessionControl('reasoningEffort', 'high');
    assert.equal(workspace.configurationReady, false);
    workspace.chooseNoDirectory();
    assert.equal(workspace.draft.directoryChosen, true);
    assert.equal(workspace.configurationReady, true);

    await workspace.send();
    const create = commands.find(command => command.type === 'create-session');
    assert.deepEqual(create, {
        type: 'create-session',
        title: 'first request',
        directory: null,
        agentId: 'reviewer',
        controls: { permissionMode: 'manual', reasoningEffort: 'high' },
        selection: { endpointId: 'endpoint', modelId: 'review-model' },
    });
    workspace.dispose();
});

test('startup opens a new-session draft seeded from the newest initialConfig while explicit selection and New Session work', async () => {
    const older = {
        id: 'older', createdAt: '2026-09-26T10:00:00.000Z',
        requested: { runtimeId: 'api', agentId: 'default', endpointId: 'endpoint', modelId: 'second-model' },
        controls: { permissionMode: 'bypass', reasoningEffort: 'none' },
        initialConfig: apiInitialConfig('default', { endpointId: 'endpoint', modelId: 'second-model' }, 'D:/old'),
    };
    const latest = {
        id: 'latest', createdAt: '2026-09-27T10:00:00.000Z',
        requested: { runtimeId: 'api', agentId: 'default', endpointId: 'endpoint', modelId: 'second-model' },
        controls: { permissionMode: 'bypass', reasoningEffort: 'none' },
        initialConfig: apiInitialConfig('reviewer', { endpointId: 'endpoint', modelId: 'review-model' }, null),
    };
    const workspace = initializeWorkspace({ ...empty(), sessions: [latest, older] });
    await workspace.initialize();
    assert.equal(workspace.selectedId, null);
    assert.equal(workspace.selected, undefined);
    assert.deepEqual(workspace.snapshot.sessions.map(session => session.id), ['latest', 'older']);
    assert.equal(workspace.currentAgent, 'reviewer');
    assert.equal(workspace.currentModel, modelValue());
    assert.deepEqual(workspace.sessionControls, { permissionMode: 'manual', reasoningEffort: 'high' });
    assert.equal(workspace.draft.directory, null);
    assert.equal(workspace.draft.directoryChosen, true);

    workspace.select('latest');
    assert.equal(workspace.selectedId, 'latest');
    assert.equal(workspace.currentAgent, 'reviewer');
    assert.deepEqual(workspace.sessionControls, { permissionMode: 'bypass', reasoningEffort: 'none' });
    workspace.currentAgent = 'default';
    workspace.currentModel = modelValue('endpoint', 'second-model');
    workspace.selected.controls.permissionMode = 'readonly';
    workspace.selected.controls.reasoningEffort = 'low';
    workspace.newSession();
    assert.equal(workspace.currentAgent, 'reviewer');
    assert.equal(workspace.currentModel, modelValue());
    assert.deepEqual(workspace.sessionControls, { permissionMode: 'manual', reasoningEffort: 'high' });
    assert.equal(workspace.draft.directory, null);
    assert.equal(workspace.draft.directoryChosen, true);

    workspace.snapshot.sessions.unshift({ id: 'newest-without-initial-config', createdAt: '2026-09-28T10:00:00.000Z' });
    workspace.newSession();
    assert.equal(workspace.currentAgent, '');
    assert.equal(workspace.currentModel, '');
    assert.equal(workspace.draft.directoryChosen, false);
    assert.deepEqual(workspace.sessionControls, { permissionMode: '', reasoningEffort: '' });
    workspace.dispose();
});

test('a delayed startup snapshot retains history without selecting its previous session', async () => {
    const gate = deferred();
    const commands = [];
    const previous = { id: 'previous-session', createdAt: '2026-09-27T10:00:00.000Z', initialConfig: apiInitialConfig() };
    globalThis.window = { uah: {
        onEvent: () => () => {},
        command: async command => {
            commands.push(command.type);
            return command.type === 'snapshot' ? gate.promise : empty();
        },
        agents: async () => ({ profiles: copyProfiles(apiProfiles) }),
        endpoints: async () => ({ endpoints: endpointList }),
    } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    const initializing = workspace.initialize();

    assert.equal(workspace.selectedId, null);
    gate.resolve({ ...empty(), sessions: [previous], viewSessionId: null });
    await initializing;

    assert.equal(workspace.selectedId, null);
    assert.equal(workspace.snapshot.sessions[0].id, previous.id);
    assert.equal(workspace.currentModel, modelValue());
    assert.deepEqual(commands, ['snapshot']);
    workspace.dispose();
});

test('failed first send preserves the selected configuration and still permits edits', async () => {
    const commands = [];
    let saved = empty();
    globalThis.window = { uah: {
        command: async command => {
            commands.push(command);
            if (command.type === 'create-session') {
                const session = sessionFromCreate(command);
                session.initialConfig = apiInitialConfig(command.agentId, command.selection, command.directory);
                saved = { ...empty(), sessions: [session] };
                return saved;
            }
            if (command.type === 'start-run') throw new Error('fixture failure');
            return saved;
        },
    } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    workspace.agentSettings = { profiles: copyProfiles(apiProfiles) };
    workspace.endpoints = endpointList;
    await configureApiDraft(workspace, { directory: null });
    workspace.draft.input = 'review';
    await workspace.send();

    assert.match(workspace.error, /操作未完成/);
    assert.equal(workspace.selectedId, 'new-session');
    assert.equal(workspace.currentAgent, 'reviewer');
    assert.equal(workspace.currentModel, modelValue());
    assert.deepEqual(workspace.sessionControls, { permissionMode: 'manual', reasoningEffort: 'high' });
    assert.equal(workspace.draft.directoryChosen, true);
    assert.equal(workspace.configurationReady, true);

    workspace.agentSettings.profiles[1].enabled = false;
    assert.equal(workspace.agentAvailable, false);
    const before = commands.length;
    await workspace.send();
    assert.equal(commands.length, before);
    workspace.currentAgent = 'default';
    assert.equal(workspace.currentAgent, 'default');
    assert.equal(workspace.agentAvailable, true);
    workspace.dispose();
});

test('missing provider or Agent in the newest initialConfig remains unavailable without fallback', async () => {
    const stale = {
        id: 'stale', createdAt: '2026-09-27T10:00:00.000Z',
        requested: { runtimeId: 'api', agentId: 'default', endpointId: 'available', modelId: 'fallback' },
        initialConfig: apiInitialConfig('removed-agent', { endpointId: 'removed-endpoint', modelId: 'removed-model' }, null),
    };
    const workspace = initializeWorkspace({ ...empty(), sessions: [stale] }, {
        profiles: [{ id: 'default', kind: 'primary', enabled: true }],
        endpoints: [{ id: 'available', enabled: true, models: ['fallback'] }],
    });
    await workspace.initialize();
    workspace.newSession();
    assert.equal(workspace.currentAgent, 'removed-agent');
    assert.equal(workspace.currentAgent, 'removed-agent');
    assert.equal(workspace.currentModel, modelValue('removed-endpoint', 'removed-model'));
    assert.equal(workspace.agentAvailable, false);
    assert.equal(workspace.modelAvailable, false);
    assert.equal(workspace.configurationReady, false);
    workspace.draft.input = 'must not use a fallback';
    const before = workspace.snapshot.sessions.length;
    await workspace.send();
    assert.equal(workspace.snapshot.sessions.length, before);
    workspace.dispose();
});

test('local verification requires an explicit model and directory choice only', async () => {
    const commands = [];
    let saved = empty();
    globalThis.window = { uah: {
        command: async command => {
            commands.push(command);
            if (command.type === 'create-session') saved = { ...empty(), sessions: [sessionFromCreate(command)] };
            return saved;
        },
    } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    workspace.draft.input = 'local check';
    workspace.currentModel = 'local-verification';
    assert.equal(workspace.configurationReady, false);
    await workspace.send();
    assert.equal(commands.length, 0);
    workspace.chooseNoDirectory();
    assert.equal(workspace.configurationReady, true);
    await workspace.send();
    assert.deepEqual(commands.find(command => command.type === 'create-session'), {
        type: 'create-session', title: 'local check', directory: null,
    });
    workspace.dispose();
});

test('main conversation run stays active and locks Agent even when child runs are present', () => {
    globalThis.window = {};
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    const rootRun = { id: 'root-run', sessionId: 'session', state: 'running', effective: { runtimeId: 'api', agentId: 'reviewer', agentName: 'Reviewer' } };
    const childRun = { id: 'child-run', sessionId: 'session', parentRunId: 'root-run', state: 'completed', effective: { runtimeId: 'api', agentId: 'child-agent' } };
    workspace.snapshot = { ...empty(), sessions: [{ id: 'session', requested: { runtimeId: 'api', endpointId: 'endpoint', modelId: 'review-model' } }], runs: [childRun, rootRun] };
    workspace.select('session');
    assert.deepEqual(workspace.runs.map(run => run.id), ['root-run']);
    assert.equal(workspace.activeRun.id, 'root-run');
    assert.equal(workspace.currentAgent, 'reviewer');
    workspace.dispose();
});

test('provider groups preserve distinct IDs for identical model names and omit unavailable endpoints', () => {
    globalThis.window = {};
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    workspace.endpoints = [
        { id: 'a', name: 'Provider A', enabled: true, models: ['same'] },
        { id: 'b', name: 'Provider B', enabled: true, models: ['same'] },
        { id: 'c', name: 'Disabled', enabled: false, models: ['same'] },
        { id: 'd', name: 'Empty', enabled: true, models: [] },
    ];
    assert.deepEqual(workspace.modelGroups.map(group => group.label), ['Provider A', 'Provider B']);
    assert.deepEqual(workspace.modelGroups.map(group => group.models[0].label), ['same', 'same']);
    assert.notEqual(workspace.modelGroups[0].models[0].value, workspace.modelGroups[1].models[0].value);
    workspace.draft.model = workspace.modelGroups[1].models[0].value;
    assert.equal(workspace.modelAvailable, true);
    workspace.dispose();
});

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((finish, fail) => { resolve = finish; reject = fail; });
    return { promise, resolve, reject };
};

test('navigation while a local first send is saving cannot redirect the run or replace the newer draft', async () => {
    const creation = deferred();
    let saved = empty();
    const commands = [];
    globalThis.window = { uah: { command: async command => {
        commands.push(command);
        if (command.type === 'create-session') return creation.promise;
        return saved;
    } } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    workspace.currentModel = 'local-verification';
    workspace.chooseNoDirectory();
    workspace.draft.input = 'first request';
    const sending = workspace.send();
    workspace.newSession();
    workspace.draft.input = 'new draft typed while saving';
    saved = { ...empty(), sessions: [{ id: 'created-session', requested: { runtimeId: 'local-verification' } }] };
    creation.resolve(saved);
    await sending;
    assert.equal(workspace.selectedId, null);
    assert.equal(workspace.draft.input, 'new draft typed while saving');
    assert.deepEqual(commands.find(command => command.type === 'start-run'), { type: 'start-run', sessionId: 'created-session', input: 'first request' });
    workspace.dispose();
});

test('navigation while an API session is saving preserves the model captured for that session', async () => {
    const creation = deferred();
    let saved = empty();
    const commands = [];
    globalThis.window = { uah: { command: async command => {
        commands.push(command);
        if (command.type === 'create-session') return creation.promise;
        return saved;
    } } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    await configureApiDraft(workspace);
    workspace.draft.input = 'API request';
    const sending = workspace.send();

    workspace.newSession();
    workspace.currentModel = 'local-verification';
    workspace.chooseNoDirectory();
    workspace.draft.input = 'new local draft';
    saved = { ...empty(), sessions: [sessionFromCreate(commands[0], 'created-api-session')] };
    creation.resolve(saved);
    await sending;

    assert.equal(workspace.selectedId, null);
    assert.equal(workspace.currentModel, 'local-verification');
    assert.equal(workspace.draft.input, 'new local draft');
    workspace.select('created-api-session');
    assert.equal(workspace.currentModel, modelValue());
    workspace.dispose();
});

test('slow start reply preserves the next message typed into the same composer', async () => {
    const starting = deferred();
    const saved = { ...empty(), sessions: [{ id: 'existing', requested: { runtimeId: 'local-verification' } }] };
    globalThis.window = { uah: { command: command => command.type === 'start-run' ? starting.promise : Promise.resolve(saved) } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    workspace.snapshot = saved;
    workspace.select('existing');
    workspace.currentInput = 'submitted';
    const sending = workspace.send();
    workspace.currentInput = 'next message';
    starting.resolve(saved);
    await sending;
    assert.equal(workspace.currentInput, 'next message');
    workspace.dispose();
});

test('API selection sends stable IDs and removed models never fall back to local verification', async () => {
    const commands = [];
    let saved = empty();
    globalThis.window = { uah: { command: async command => {
        commands.push(command);
        if (command.type === 'create-session') saved = { ...empty(), sessions: [sessionFromCreate(command, 'api-session')] };
        return saved;
    } } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    await configureApiDraft(workspace, { directory: null });
    assert.equal(workspace.configurationReady, true);
    workspace.draft.input = 'test API';
    await workspace.send();
    assert.deepEqual(commands.find(command => command.type === 'create-session').selection, { endpointId: 'endpoint', modelId: 'review-model' });
    workspace.endpoints[0].models.push('model/two');
    workspace.currentModel = modelValue('endpoint', 'model/two');
    workspace.currentInput = 'switch model';
    await workspace.send();
    assert.deepEqual(commands.at(-1), { type: 'start-run', sessionId: 'api-session', input: 'switch model', selection: { endpointId: 'endpoint', modelId: 'model/two' }, agentId: 'reviewer' });
    workspace.currentModel = 'local-verification';
    workspace.currentInput = 'explicit local';
    await workspace.send();
    assert.equal(commands.at(-1).selection, null);
    workspace.currentModel = modelValue('endpoint', 'model/two');
    workspace.endpoints[0].enabled = false;
    assert.equal(workspace.modelAvailable, false);
    workspace.currentInput = 'must not send';
    const before = commands.length;
    await workspace.send();
    assert.equal(commands.length, before);
    workspace.dispose();
});
