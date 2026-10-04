import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeCodexStore } from '../../src/main/native-codex-store';

test('native settings persist with revision checks and never accept stale overwrites', () => {
    const directory = mkdtempSync(join(tmpdir(), 'uah-native-settings-'));
    const store = new NativeCodexStore(directory);
    const initial = store.get();
    assert.equal(initial.enabled, false);
    const saved = store.save({ ...initial, command: process.execPath });
    assert.equal(saved.revision, 1);
    assert.throws(() => store.save(initial), /已改变/);
    assert.deepEqual(new NativeCodexStore(directory).get(), saved);
    saved.args.push('mutated');
    assert.deepEqual(store.get().args, []);
    assert.throws(() => store.save({ ...store.get(), enabled: true }), /model/);
});
