import test from 'node:test';
import assert from 'node:assert/strict';
import { createPinia, setActivePinia } from 'pinia';
import { useWorkspace } from '../../src/renderer/stores/workspace.js';

const empty = () => ({ sessions: [], runs: [], approvals: [], artifacts: [] });
const deferred = () => {
    let resolve;
    const promise = new Promise((finish) => { resolve = finish; });
    return { promise, resolve };
};

test('navigation while first send is saving cannot redirect the run or replace the newer draft', async () => {
    const creation = deferred();
    let saved = empty();
    const commands = [];
    globalThis.window = { uah: { command: async (command) => {
        commands.push(command);
        if (command.type === 'create-session') return creation.promise;
        return saved;
    } } };
    setActivePinia(createPinia());
    const workspace = useWorkspace();
    workspace.draft.model = 'local-verification';
    workspace.draft.input = 'first request';
    const sending = workspace.send();
    workspace.newSession();
    workspace.draft.input = 'new draft typed while saving';
    saved = { ...empty(), sessions: [{ id: 'created-session' }] };
    creation.resolve(saved);
    await sending;
    assert.equal(workspace.selectedId, null);
    assert.equal(workspace.draft.input, 'new draft typed while saving');
    assert.deepEqual(commands.find((command) => command.type === 'start-run'), { type: 'start-run', sessionId: 'created-session', input: 'first request' });
    workspace.dispose();
});

test('slow start reply preserves the next message typed into the same composer', async () => {
    const starting = deferred();
    const saved = { ...empty(), sessions: [{ id: 'existing' }] };
    globalThis.window = { uah: { command: (command) => command.type === 'start-run' ? starting.promise : Promise.resolve(saved) } };
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
