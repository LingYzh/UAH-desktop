import assert from 'node:assert/strict';
import test from 'node:test';
import { link, mkdir, mkdtemp, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { contextSourceId, listExternalSources, readContextSource, readProjectRules, searchContextSources, type ContextSource } from '../../src/runtime/context-sources';

async function tempDirectory(t: test.TestContext): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'uah-context-sources-'));
    t.after(async () => rm(root, { recursive: true, force: true }));
    return root;
}

async function put(path: string, content: string | Buffer): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
}

async function setTime(path: string, epoch: number): Promise<void> {
    const value = new Date(epoch * 1000);
    await utimes(path, value, value);
}

test('project rules load the scoped root and existing parent scopes for a missing target file', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    await put(join(workspace, 'AGENTS.md'), 'Root instructions');
    await put(join(workspace, 'area', '.claude', 'CLAUDE.md'), 'Area instructions');
    await put(join(workspace, 'unrelated', 'AGENTS.md'), 'Must stay undiscovered');

    const snapshot = await readProjectRules(workspace, [join('area', 'new-file.ts')]);

    assert.deepEqual(snapshot.active.map(item => item.content), ['Root instructions', 'Area instructions']);
    assert.equal(snapshot.sources.some(source => source.path.includes('unrelated')), false);
    assert.equal(snapshot.sources.filter(source => source.selected).length, 2);
    assert.equal(snapshot.sources.every(source => source.scope.startsWith(workspace)), true);
});

test('a target with no additional scoped rules leaves the active fingerprint unchanged', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    await put(join(workspace, 'AGENTS.md'), 'Stable root instructions');

    const before = await readProjectRules(workspace);
    const after = await readProjectRules(workspace, [join('new-folder', 'new-file.ts')]);

    assert.equal(after.fingerprint, before.fingerprint);
});

test('AGENTS.override.md replaces AGENTS.md when valid even if the base file is newer', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    const base = join(workspace, 'AGENTS.md');
    const override = join(workspace, 'AGENTS.override.md');
    const claude = join(workspace, 'CLAUDE.md');
    await put(base, 'Base instructions');
    await put(override, 'Override instructions');
    await put(claude, 'Older Claude instructions');
    await setTime(base, 30);
    await setTime(override, 20);
    await setTime(claude, 10);

    const snapshot = await readProjectRules(workspace);

    assert.deepEqual(snapshot.active.map(item => item.content), ['Override instructions']);
    assert.equal(snapshot.sources.find(source => source.path === base)?.reason, 'Replaced by nonempty AGENTS.override.md');
});

test('CLAUDE.local.md is a UAH competing primary candidate at its scope', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    const agents = join(workspace, 'AGENTS.md');
    const claude = join(workspace, 'CLAUDE.md');
    const local = join(workspace, 'CLAUDE.local.md');
    await put(agents, 'Agent rules');
    await put(claude, 'Claude rules');
    await put(local, 'Local Claude rules');
    await setTime(agents, 10);
    await setTime(claude, 20);
    await setTime(local, 30);

    const snapshot = await readProjectRules(workspace);

    assert.equal(snapshot.active[0]?.content, 'Local Claude rules');
    assert.equal(snapshot.sources.find(source => source.path === local)?.selected, true);
    assert.equal(snapshot.sources.find(source => source.path === claude)?.selected, false);
});

test('invalid oversized candidate falls back with a warning and is never silently truncated', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    const agents = join(workspace, 'AGENTS.md');
    await put(agents, 'Fallback instructions');
    await put(join(workspace, 'CLAUDE.md'), Buffer.alloc(32 * 1024 + 1, 0x61));
    await setTime(join(workspace, 'CLAUDE.md'), 30);
    await setTime(agents, 20);

    const snapshot = await readProjectRules(workspace);

    assert.deepEqual(snapshot.active.map(item => item.content), ['Fallback instructions']);
    assert.ok(snapshot.warnings.some(warning => warning.includes('byte limit')));
    assert.equal(snapshot.active.some(item => item.content.length === 32 * 1024), false);
});

test('rule imports include standalone in-workspace paths, ignore fenced and outside paths, and stop cycles', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside.md');
    const imported = join(workspace, '.claude', 'child.md');
    await put(join(workspace, 'AGENTS.md'), 'Root\n@.claude/child.md\n```md\n@ignored.md\n```\n@../outside.md');
    await put(imported, 'Child\n@../AGENTS.md');
    await put(join(workspace, 'ignored.md'), 'Fenced content must not load');
    await put(outside, Buffer.from([0xff, 0xfe]));

    const snapshot = await readProjectRules(workspace);

    assert.deepEqual(snapshot.active.map(item => item.content), ['Root\n@.claude/child.md\n```md\n@ignored.md\n```\n@../outside.md', 'Child\n@../AGENTS.md']);
    assert.equal(snapshot.active[1].source.scope, workspace, 'the import inherits the declaring rule scope');
    assert.equal(snapshot.sources.find(source => source.path === imported)?.scope, workspace);
    assert.equal(snapshot.active.some(item => item.content.includes('Fenced content')), false);
    assert.ok(snapshot.warnings.some(warning => warning.includes('outside-workspace')));
    assert.ok(snapshot.warnings.some(warning => warning.includes('cyclic')));
    assert.equal(snapshot.warnings.some(warning => warning.includes('Invalid UTF-8')), false);
});

test('one imported document remains active for each sibling rule scope', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    const shared = join(workspace, 'shared.md');
    await put(join(workspace, 'one', 'AGENTS.md'), 'One\n@../shared.md');
    await put(join(workspace, 'two', 'AGENTS.md'), 'Two\n@../shared.md');
    await put(shared, 'Shared requirements');

    const snapshot = await readProjectRules(workspace, [join('one', 'target.ts'), join('two', 'target.ts')]);
    const sharedEntries = snapshot.active.filter(item => item.source.path === shared);

    assert.deepEqual(sharedEntries.map(item => item.source.scope), [join(workspace, 'one'), join(workspace, 'two')]);
    assert.deepEqual(sharedEntries.map(item => item.content), ['Shared requirements', 'Shared requirements']);
});

test('rule imports and on-demand paths reject Windows ADS, device names, and ambiguous spelling', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    await put(join(workspace, 'AGENTS.md'), 'Root\n@secret.json:stream.md\n@C:drive-relative.md\n@CON.md\n@bad-name. ');

    const snapshot = await readProjectRules(workspace);
    assert.ok(snapshot.warnings.some(warning => warning.includes('unsafe')));
    assert.equal(snapshot.active.length, 1);

    const home = join(root, 'home');
    const projects = join(home, '.claude', 'projects');
    await put(join(projects, 'safe.md'), 'Safe');
    const source = (await listExternalSources(home)).find(item => item.kind === 'external-memory')!;
    for (const relativePath of ['secret.json:stream.md', 'C:drive-relative.md', 'CON.md', 'bad-name. ']) {
        await assert.rejects(readContextSource(source, { relativePath }), /safe relative path/);
    }
});

test('hardlinked rules are rejected and scoped candidate failures are reported', async t => {
    const root = await tempDirectory(t);
    const workspace = join(root, 'workspace');
    const rule = join(workspace, 'AGENTS.md');
    await put(rule, 'Linked rule must not be read');
    await link(rule, join(root, 'hardlink.md'));

    const snapshot = await readProjectRules(workspace);

    assert.equal(snapshot.active.length, 0);
    assert.ok(snapshot.warnings.some(warning => warning.includes('unlinked regular file')));
});

test('external discovery is metadata-only and on-demand reads use stable hash pagination', async t => {
    const root = await tempDirectory(t);
    const home = join(root, 'home');
    const rulePath = join(home, '.claude', 'CLAUDE.md');
    const projects = join(home, '.claude', 'projects');
    await put(rulePath, `# External\n${'🙂'.repeat(7000)}`);
    await put(join(home, '.codex', 'AGENTS.md'), 'Codex external rules');
    await put(join(projects, 'alpha', 'README.md'), 'Needle in project memory');

    const sources = await listExternalSources(home);
    const fileSource = sources.find(source => source.path === rulePath)!;

    assert.ok(fileSource);
    assert.equal(fileSource.kind, 'external-rule');
    assert.equal(fileSource.hash, undefined);
    assert.equal(fileSource.selected, false);
    assert.equal(sources.filter(source => source.kind === 'external-memory').length, 1);

    const first = await readContextSource(fileSource, { limit: 5 });
    assert.equal(first.text, '# Ext');
    assert.equal(first.nextOffset, 5);
    await assert.rejects(readContextSource(fileSource, { offset: 5, limit: 5 }), /hash is required/);
    const second = await readContextSource(fileSource, { offset: first.nextOffset!, limit: 5, expectedHash: first.hash });
    assert.equal(second.text, 'ernal');
    await assert.rejects(readContextSource(fileSource, { offset: 5, limit: 5, expectedHash: '0'.repeat(64) }), /changed/);
    assert.equal(basename(first.path), 'CLAUDE.md');

    const ruleSearch = await searchContextSources([fileSource], 'External');
    assert.equal(ruleSearch.matches[0].path, 'CLAUDE.md');
    const searchedFile = await readContextSource(fileSource, { relativePath: ruleSearch.matches[0].path });
    assert.match(searchedFile.text, /# External/);
});

test('external discovery leaves a missing home untouched and returns no sources', async t => {
    const root = await tempDirectory(t);
    const missingHome = join(root, 'not-created');

    assert.deepEqual(await listExternalSources(missingHome), []);
    await assert.rejects(readFile(missingHome), /ENOENT/);
});

test('explicit external search is Markdown-only, bounded to the selected roots, and skips sensitive directories', async t => {
    const root = await tempDirectory(t);
    const home = join(root, 'home');
    const projects = join(home, '.claude', 'projects');
    await put(join(projects, 'alpha', 'README.md'), 'A needle belongs here');
    await put(join(projects, 'sessions', 'private.md'), 'needle in a session');
    await put(join(projects, 'config', 'private.md'), 'needle in config');
    await put(join(projects, 'alpha', 'ignore.txt'), 'needle in a text file');

    const sources = await listExternalSources(home);
    const projectSource = sources.find(source => source.kind === 'external-memory')!;
    const result = await searchContextSources([projectSource], 'needle');

    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].text, 'A needle belongs here');
    assert.equal(result.matches[0].path, join('alpha', 'README.md'));
    assert.equal(result.matches[0].line, 1);
});

test('user memory sources cannot read or search per-project memories', async t => {
    const root = await tempDirectory(t);
    const memoryRoot = join(root, 'user-memory');
    await put(join(memoryRoot, 'general.md'), 'Shared note');
    await put(join(memoryRoot, 'projects', 'project-a.md'), 'Private needle');
    const source: ContextSource = {
        id: contextSourceId(memoryRoot), kind: 'memory', scope: 'user', path: memoryRoot,
        modifiedAt: '', selected: false, reason: 'User memory root',
    };

    await assert.rejects(readContextSource(source, { relativePath: join('projects', 'project-a.md') }), /cannot read project memory/);
    const result = await searchContextSources([source], 'needle');
    assert.deepEqual(result.matches, []);
});

test('search skips lazy memory roots that do not exist and continues with available project sources', async t => {
    const root = await tempDirectory(t);
    const absentUserRoot = join(root, 'memory', 'user');
    const projectRoot = join(root, 'memory', 'projects', 'current');
    await put(join(projectRoot, 'note.md'), 'Project needle');
    const sources: ContextSource[] = [
        { id: contextSourceId(absentUserRoot), kind: 'memory', scope: 'user', path: absentUserRoot, modifiedAt: '', selected: false, reason: 'Lazy user memory' },
        { id: contextSourceId(projectRoot), kind: 'memory', scope: 'private-project', path: projectRoot, modifiedAt: '', selected: false, reason: 'Current project memory' },
    ];

    const result = await searchContextSources(sources, 'needle');

    assert.equal(result.truncated, false);
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].text, 'Project needle');
});

test('directory source reads reject traversal and reparse points', async t => {
    const root = await tempDirectory(t);
    const home = join(root, 'home');
    const projects = join(home, '.claude', 'projects');
    await put(join(projects, 'ok.md'), 'Safe content');
    const outside = join(root, 'outside');
    await mkdir(outside, { recursive: true });
    await put(join(outside, 'outside.md'), 'Outside content');
    try { await symlink(outside, join(projects, 'linked'), process.platform === 'win32' ? 'junction' : 'dir'); }
    catch (error) {
        if (!['EPERM', 'EACCES', 'ENOTSUP', 'EINVAL'].includes(String((error as NodeJS.ErrnoException).code))) throw error;
    }

    const projectSource = (await listExternalSources(home)).find(source => source.kind === 'external-memory')!;
    await assert.rejects(readContextSource(projectSource, { relativePath: join('..', 'outside.md') }), /relative path/);
    const result = await searchContextSources([projectSource], 'Outside content');
    assert.deepEqual(result.matches, []);
});
