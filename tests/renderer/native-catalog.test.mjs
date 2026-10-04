import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkspace } from '../../src/renderer/stores/workspace.js';

const settings = (revision = 1, enabled = true, command = 'C:\\codex.exe') => ({ revision, enabled, command, args: [], model: 'saved-model' });
const probe = { models: [{ id: 'model-a', name: 'A' }, { id: 'model-b', name: 'B' }, { id: 'model-no-name' }], authenticated: true, accountType: 'chatgpt', version: 'fixture' };
function setup(handler) {
    globalThis.window = { uah: { nativeCodex: handler } };
    setActivePinia(createPinia());
    return useWorkspace();
}

test('native model catalog adds all discovered models, preserves selection, and is isolated by launch target', async () => {
    let result = { settings: settings(), probe, probeTarget: { command: settings().command, args: [] } };
    const workspace = setup(async () => structuredClone(result));
    await workspace.nativeCommand({ type: 'probe' });
    assert.deepEqual(workspace.modelGroups.find(group => group.id === 'native:codex')?.models, [
        { value: JSON.stringify(['native:codex', 'saved-model']), label: 'saved-model' },
        { value: JSON.stringify(['native:codex', 'model-a']), label: 'A' },
        { value: JSON.stringify(['native:codex', 'model-b']), label: 'B' },
        { value: JSON.stringify(['native:codex', 'model-no-name']), label: 'model-no-name' },
    ]);
    assert.deepEqual(workspace.modelOptions.map(({ endpointId, modelId, value, label }) => ({ endpointId, modelId, value, label })), [
        { endpointId: 'native:codex', modelId: 'saved-model', value: JSON.stringify(['native:codex', 'saved-model']), label: 'Codex 原生 · saved-model' },
        { endpointId: 'native:codex', modelId: 'model-a', value: JSON.stringify(['native:codex', 'model-a']), label: 'Codex 原生 · A' },
        { endpointId: 'native:codex', modelId: 'model-b', value: JSON.stringify(['native:codex', 'model-b']), label: 'Codex 原生 · B' },
        { endpointId: 'native:codex', modelId: 'model-no-name', value: JSON.stringify(['native:codex', 'model-no-name']), label: 'Codex 原生 · model-no-name' },
    ]);
    result = { settings: settings(2, true, 'C:\\different.exe') };
    await workspace.nativeCommand({ type: 'save', settings: result.settings });
    assert.deepEqual(workspace.modelGroups.find(group => group.id === 'native:codex')?.models, [
        { value: JSON.stringify(['native:codex', 'saved-model']), label: 'saved-model' },
    ]);
    assert.deepEqual(workspace.modelOptions.map(({ modelId, value, label }) => ({ modelId, value, label })), [
        { modelId: 'saved-model', value: JSON.stringify(['native:codex', 'saved-model']), label: 'Codex 原生 · saved-model' },
    ]);
    result = { settings: settings(3, false) };
    await workspace.nativeCommand({ type: 'save', settings: result.settings });
    assert.deepEqual(workspace.modelOptions, []);
});

test('draft probe neither switches the saved launch target nor publishes its models', async () => {
    const workspace = setup(async () => ({ settings: settings(), probe, probeTarget: { command: 'C:\\draft.exe', args: [] } }));
    await workspace.nativeCommand({ type: 'probe', settings: settings(1, false, 'C:\\draft.exe') });
    assert.equal(workspace.nativeStatus.settings.command, 'C:\\codex.exe');
    assert.deepEqual(workspace.modelOptions.map(item => item.modelId), ['saved-model']);
});

test('late probe cannot undo a newer disable and failure preserves the configured model', async () => {
    let reply;
    const workspace = setup(command => command.type === 'probe' ? new Promise(resolve => { reply = resolve; }) : Promise.resolve({ settings: settings(2, false) }));
    workspace.nativeStatus = { settings: settings() };
    const pending = workspace.nativeCommand({ type: 'probe' });
    await workspace.nativeCommand({ type: 'save', settings: settings(2, false) });
    reply({ settings: settings(), probe, probeTarget: { command: settings().command, args: [] } });
    await pending;
    assert.equal(workspace.nativeStatus.settings.enabled, false);
    assert.equal(workspace.modelOptions.length, 0);
    window.uah.nativeCodex = async () => { throw new Error('fixture unavailable'); };
    workspace.nativeStatus = { settings: settings(3, true, 'C:\\other.exe') };
    await workspace.refreshNativeModels();
    assert.match(workspace.nativeCatalogError, /请查看应用日志/);
    assert.equal(workspace.nativeCatalogError.includes('fixture unavailable'), false);
    assert.deepEqual(workspace.modelOptions.map(item => item.modelId), ['saved-model']);
});
