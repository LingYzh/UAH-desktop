import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, link, mkdir, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePlanFile, readPlanFile } from '../../src/runtime/plan-tools';

test('managed plan files preserve exact Unicode, replace atomically and reject bounds/path/link escapes', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'uah-plan-files-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const first = await writePlanFile(directory, 'session', 'run', '\uFEFF# 计划\n\n😀');
    assert.deepEqual(await readPlanFile(directory, 'session', 'run'), first);
    const second = await writePlanFile(directory, 'session', 'run', 'Revised plan');
    assert.equal(second.filePath, first.filePath); assert.notEqual(second.hash, first.hash);
    assert.deepEqual(await readdir(join(directory, 'plans', 'session')), ['run.md']);
    for (const content of ['', ' ', 'x'.repeat(100001), '\uD800']) await assert.rejects(writePlanFile(directory, 'session', 'run', content));
    for (const id of ['../escape', 'slash/name', '', 'x'.repeat(101)]) await assert.rejects(writePlanFile(directory, id, 'run', 'plan'));
    await writeFile(second.filePath, Buffer.from([0xff])); await assert.rejects(readPlanFile(directory, 'session', 'run'), /UTF-8/);
    await writeFile(second.filePath, 'valid'); await link(second.filePath, join(directory, 'hard-link'));
    await assert.rejects(readPlanFile(directory, 'session', 'run'), /链接/);
    await assert.rejects(writePlanFile(directory, 'session', 'run', 'replace'), /链接/);
    const outside = join(directory, 'outside'); await mkdir(outside);
    await symlink(outside, join(directory, 'plans', 'linked'), 'junction');
    await assert.rejects(writePlanFile(directory, 'linked', 'run', 'escape'), /链接/);
    assert.deepEqual(await readdir(outside), []);
});


test('document drafts and exclusive version snapshots are separate and preserve approved bytes', async t => {
    const directory = await mkdtemp(join(tmpdir(), 'uah-plan-version-files-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const draft = await writePlanFile(directory, 'session', 'draft', '# First', 'document');
    const archived = await writePlanFile(directory, 'session', 'snapshot-id', '# First', 'document', true);
    assert.notEqual(draft.filePath, archived.filePath);
    await writePlanFile(directory, 'session', 'draft', '# Second', 'document');
    await assert.rejects(writePlanFile(directory, 'session', 'snapshot-id', '# Overwrite', 'document', true), { code: 'EEXIST' });
    assert.equal((await readPlanFile(directory, 'session', 'snapshot-id', 'document')).content, '# First');
    assert.equal((await readPlanFile(directory, 'session', 'draft', 'document')).content, '# Second');
    for (const id of ['../escape', 'slash/name', 'x'.repeat(101)]) await assert.rejects(writePlanFile(directory, 'session', 'draft', 'plan', id));
    assert.deepEqual((await readdir(join(directory, 'plans', 'session', 'document'))).sort(), ['draft.md', 'snapshot-id.md']);
});
