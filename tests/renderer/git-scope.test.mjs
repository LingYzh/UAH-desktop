import assert from 'node:assert/strict';
import test from 'node:test';
import { createRenderer, h, nextTick, ref } from 'vue';
import { useGit } from '../../src/renderer/composables/use-git.js';

test('read-only Git ignores old session responses and retains explicit null directories', async () => {
    const calls = [];
    const previousWindow = globalThis.window;
    globalThis.window = { uah: { git: query => new Promise(resolve => calls.push({ query, resolve })) } };
    const renderer = createRenderer({
        createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
        insert() {}, remove() {}, setElementText() {}, setText() {}, setComment() {},
        parentNode: () => null, nextSibling: () => null, patchProp() {}
    });
    const directory = ref('D:/first');
    const session = ref('first');
    let git;
    const app = renderer.createApp({ setup() { git = useGit(directory, session); return () => h('div'); } });
    app.mount({});
    try {
        assert.deepEqual(calls[0].query, { directory: 'D:/first', kind: 'status' });
        directory.value = null;
        session.value = 'no-directory';
        const latest = calls.at(-1);
        assert.deepEqual(latest.query, { directory: null, kind: 'status' });
        latest.resolve({ snapshot: { state: 'no-directory', directory: null } });
        await nextTick();
        calls[0].resolve({ snapshot: { state: 'ready', directory: 'D:/first', branch: 'private-old-session' } });
        await nextTick();
        assert.equal(git.result.value.snapshot.state, 'no-directory');
        assert.equal(git.busy.value, false);
        const diff = git.query('diff', { staged: true });
        const oldDiff = calls.at(-1);
        session.value = 'another';
        oldDiff.resolve({ diff: 'old content', snapshot: { state: 'ready' } });
        assert.equal(await diff, null);
        assert.equal(git.result.value, null);
        const final = calls.at(-1);
        app.unmount();
        final.resolve({ snapshot: { state: 'ready', branch: 'after-unmount' } });
        await nextTick();
        assert.equal(git.result.value, null);
    } finally {
        app.unmount();
        globalThis.window = previousWindow;
    }
});
