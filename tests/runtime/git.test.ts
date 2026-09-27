import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseGitQuery } from '../../src/shared/git.js';
import { gitPromptContext, readGit } from '../../src/runtime/git.js';

async function fixture() {
    const directory = await mkdtemp(path.join(tmpdir(), 'uah-git-'));
    const hooks = path.join(directory, 'empty-hooks');
    await mkdir(hooks);
    const invoke = (...args: string[]) => execFileSync('git', ['-c', 'core.hooksPath=' + hooks,
        '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-C', directory, ...args],
    { encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } });
    invoke('init', '--quiet');
    return { directory, invoke, close: () => rm(directory, { recursive: true, force: true }) };
}

test('Git query validates exact data fields and rejects unsafe path syntax', () => {
    assert.deepEqual(parseGitQuery({ directory: null, kind: 'status' }), { directory: null, kind: 'status' });
    assert.deepEqual(parseGitQuery({ directory: 'D:/目录', kind: 'diff', staged: false, path: '目录/a b.txt' }),
        { directory: 'D:/目录', kind: 'diff', staged: false, path: '目录/a b.txt' });
    for (const value of [null, [], {}, { directory: null, kind: 'push' }, { directory: 'relative', kind: 'status' },
        { directory: null, kind: 'status', extra: 1 }, { directory: null, kind: 'status', staged: 'true' },
        ...['../a', 'a/../b', 'a\\..\\b', '/absolute', '\\absolute', 'C:/absolute', 'a\0b', ''].map(path => ({ directory: null, kind: 'diff', path })),
        Object.defineProperty({ directory: null }, 'kind', { get: () => 'status' }),
        { directory: null, kind: { toString: () => 'status' } }]) assert.throws(() => parseGitQuery(value));
});

test('Git reports no directory, nonrepository and unborn repositories explicitly', async () => {
    assert.equal((await readGit({ directory: null, kind: 'status' })).snapshot.state, 'no-directory');
    const fx = await fixture();
    const outside = await mkdtemp(path.join(tmpdir(), 'uah-notgit-'));
    try {
        const nonrepo = await readGit({ directory: outside, kind: 'status' });
        assert.equal(nonrepo.snapshot.state, 'not-repository');
        const fresh = await readGit({ directory: fx.directory, kind: 'log' });
        assert.equal(fresh.snapshot.state, 'ready');
        assert.equal(fresh.snapshot.head, undefined);
        assert.ok(fresh.snapshot.branch);
        assert.deepEqual(fresh.commits, []);
        const missing = await readGit({ directory: path.join(outside, 'missing'), kind: 'status' });
        assert.equal(missing.snapshot.state, 'error');
        assert.match(missing.snapshot.message!, /未知/);
    } finally { await fx.close(); await rm(outside, { recursive: true, force: true }); }
});

test('Git preserves Chinese spaced paths, NUL rename records, staged and worktree diffs', async () => {
    const fx = await fixture();
    try {
        await writeFile(path.join(fx.directory, '原 文件.txt'), 'base\n');
        fx.invoke('add', '--', '原 文件.txt'); fx.invoke('commit', '--quiet', '-m', '初始化 fixture');
        await rename(path.join(fx.directory, '原 文件.txt'), path.join(fx.directory, '新 文件.txt'));
        fx.invoke('add', '--all');
        await writeFile(path.join(fx.directory, '新 文件.txt'), 'changed\n');
        await writeFile(path.join(fx.directory, '未 跟踪.txt'), 'untracked\n');
        const status = (await readGit({ directory: fx.directory, kind: 'status' })).snapshot;
        assert.equal(status.state, 'ready');
        assert.deepEqual(status.files.find(file => file.path === '新 文件.txt'),
            { path: '新 文件.txt', originalPath: '原 文件.txt', indexStatus: 'R', worktreeStatus: 'M', untracked: false });
        assert.equal(status.files.find(file => file.path === '未 跟踪.txt')?.untracked, true);
        const worktree = await readGit({ directory: fx.directory, kind: 'diff', path: '新 文件.txt' });
        assert.match(worktree.diff!, /changed/);
        const staged = await readGit({ directory: fx.directory, kind: 'diff', staged: true });
        assert.match(staged.diff!, /new file mode/);
        assert.doesNotMatch(staged.diff!, /rename from/);
        const log = await readGit({ directory: fx.directory, kind: 'log' });
        assert.equal(log.commits?.[0].subject, '初始化 fixture');
        fx.invoke('checkout', '--quiet', '--detach');
        assert.equal((await readGit({ directory: fx.directory, kind: 'status' })).snapshot.branch, '(detached)');
    } finally { await fx.close(); }
});

test('selected subdirectory scopes status, diff, log and rejects escaping symlinks', async () => {
    const fx = await fixture();
    try {
        await mkdir(path.join(fx.directory, 'nested'));
        await mkdir(path.join(fx.directory, 'sibling'));
        await writeFile(path.join(fx.directory, 'nested', 'local.txt'), 'local\n');
        await writeFile(path.join(fx.directory, 'sibling', 'private.txt'), 'sibling\n');
        fx.invoke('add', '--all'); fx.invoke('commit', '--quiet', '-m', 'nested initial');
        await writeFile(path.join(fx.directory, 'nested', 'local.txt'), 'new local\n');
        await writeFile(path.join(fx.directory, 'sibling', 'private.txt'), 'SECRET SIBLING\n');
        const directory = path.join(fx.directory, 'nested');
        const diff = await readGit({ directory, kind: 'diff' });
        assert.equal(diff.snapshot.state, 'ready');
        assert.deepEqual(diff.snapshot.files.map(file => file.path), ['local.txt']);
        assert.match(diff.diff!, /new local/); assert.doesNotMatch(diff.diff!, /SECRET SIBLING/);
        assert.equal((await readGit({ directory, kind: 'log' })).commits?.[0].subject, 'nested initial');
        await symlink(path.join(fx.directory, 'sibling'), path.join(directory, 'external'), process.platform === 'win32' ? 'junction' : 'dir');
        for (const requested of ['external/private.txt', 'external/missing.txt']) {
            assert.equal((await readGit({ directory, kind: 'diff', path: requested })).snapshot.state, 'error');
        }
        await assert.rejects(readGit({ directory, kind: 'diff', path: '../sibling/private.txt' }));
    } finally { await fx.close(); }
});

test('diff disables external diff and textconv and ignores Git environment redirection', async () => {
    const fx = await fixture();
    const other = await fixture();
    const original = { GIT_DIR: process.env.GIT_DIR, GIT_WORK_TREE: process.env.GIT_WORK_TREE,
        GIT_INDEX_FILE: process.env.GIT_INDEX_FILE, GIT_EXTERNAL_DIFF: process.env.GIT_EXTERNAL_DIFF };
    try {
        const marker = path.join(fx.directory, 'executed');
        const script = path.join(fx.directory, 'external.cjs');
        await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'BAD');`);
        await writeFile(path.join(fx.directory, '.gitattributes'), '*.txt diff=fixture filter=fixture\n');
        await writeFile(path.join(fx.directory, 'a.txt'), 'before\n');
        fx.invoke('add', '--', '.gitattributes', 'a.txt'); fx.invoke('commit', '--quiet', '-m', 'initial');
        fx.invoke('config', 'diff.fixture.command', `node "${script.replace(/\\/g, '/')}"`);
        fx.invoke('config', 'diff.fixture.textconv', `node "${script.replace(/\\/g, '/')}"`);
        fx.invoke('config', 'filter.fixture.clean', `node "${script.replace(/\\/g, '/')}"`);
        fx.invoke('config', 'filter.fixture.process', `node "${script.replace(/\\/g, '/')}"`);
        fx.invoke('config', 'filter.fixture.smudge', `node "${script.replace(/\\/g, '/')}"`);
        fx.invoke('config', 'filter.fixture.required', 'true');
        await writeFile(path.join(fx.directory, 'a.txt'), 'after\n');
        process.env.GIT_DIR = path.join(other.directory, '.git');
        process.env.GIT_WORK_TREE = other.directory;
        process.env.GIT_INDEX_FILE = path.join(other.directory, '.git', 'index');
        process.env.GIT_EXTERNAL_DIFF = `node "${script.replace(/\\/g, '/')}"`;
        const result = await readGit({ directory: fx.directory, kind: 'diff' });
        assert.equal(result.snapshot.state, 'ready');
        assert.equal(result.snapshot.root?.toLowerCase(), fx.directory.toLowerCase());
        assert.match(result.diff!, /after/);
        await assert.rejects(access(marker));
    } finally {
        for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
        await fx.close(); await other.close();
    }
});

test('Git bounds files and diff output, and cancelled or unavailable reads are explicit errors', async () => {
    const fx = await fixture();
    try {
        await writeFile(path.join(fx.directory, 'large.txt'), 'before\n');
        fx.invoke('add', '--', 'large.txt'); fx.invoke('commit', '--quiet', '-m', 'initial');
        await writeFile(path.join(fx.directory, 'large.txt'), 'changed\n'.repeat(10_000));
        const diff = await readGit({ directory: fx.directory, kind: 'diff' });
        assert.equal(diff.diff?.length, 64_000); assert.equal(diff.truncated, true);
        await writeFile(path.join(fx.directory, 'large.txt'), 'large changed line\n'.repeat(150_000));
        const overLimit = await readGit({ directory: fx.directory, kind: 'diff' });
        assert.equal(overLimit.snapshot.state, 'error'); assert.equal(overLimit.snapshot.truncated, true);
        assert.equal(overLimit.diff, undefined);
        await Promise.all(Array.from({ length: 205 }, (_, index) => writeFile(path.join(fx.directory, `u-${index}.txt`), 'u')));
        const status = (await readGit({ directory: fx.directory, kind: 'status' })).snapshot;
        assert.equal(status.files.length, 200); assert.equal(status.truncated, true);
        const controller = new AbortController(); controller.abort();
        const cancelled = await readGit({ directory: fx.directory, kind: 'status' }, controller.signal);
        assert.equal(cancelled.snapshot.state, 'error'); assert.match(cancelled.snapshot.message!, /取消/);
        const inFlight = new AbortController();
        const pending = readGit({ directory: fx.directory, kind: 'status' }, inFlight.signal);
        setTimeout(() => inFlight.abort(), 5);
        assert.equal((await pending).snapshot.state, 'error');
        const originalPath = process.env.PATH;
        try {
            process.env.PATH = fx.directory;
            assert.equal((await readGit({ directory: fx.directory, kind: 'status' })).snapshot.state, 'unavailable');
        } finally { process.env.PATH = originalPath; }
        const prompt = gitPromptContext(status);
        assert.ok(JSON.stringify(prompt).length <= 5500); assert.match(prompt, /不可信资料/); assert.match(prompt, /只读/);
        const hostile = gitPromptContext({ ...status, directory: '\\'.repeat(4000), root: '\\'.repeat(4000),
            branch: '\n'.repeat(200), upstream: '\n'.repeat(200),
            files: Array.from({ length: 200 }, () => ({ path: '\n'.repeat(500), originalPath: '\\'.repeat(500), indexStatus: 'R', worktreeStatus: '.', untracked: false })) });
        assert.ok(JSON.stringify(hostile).length <= 5500);
        assert.equal(JSON.parse(hostile.slice(hostile.indexOf('\n') + 1)).truncated, true);
    } finally { await fx.close(); }
});

test('literal pathspecs cannot expand wildcards and log history stays bounded', async () => {
    const fx = await fixture();
    try {
        await writeFile(path.join(fx.directory, '[a].txt'), 'literal\n');
        await writeFile(path.join(fx.directory, 'a.txt'), 'other\n');
        fx.invoke('add', '--all'); fx.invoke('commit', '--quiet', '-m', 'initial');
        for (let index = 0; index < 21; index++) {
            await writeFile(path.join(fx.directory, '[a].txt'), 'literal ' + index + '\n');
            fx.invoke('add', '--', '[a].txt'); fx.invoke('commit', '--quiet', '-m', 'entry ' + index);
        }
        await writeFile(path.join(fx.directory, '[a].txt'), 'LITERAL CHANGE\n');
        await writeFile(path.join(fx.directory, 'a.txt'), 'OTHER CHANGE\n');
        const diff = await readGit({ directory: fx.directory, kind: 'diff', path: '[a].txt' });
        assert.match(diff.diff!, /LITERAL CHANGE/); assert.doesNotMatch(diff.diff!, /OTHER CHANGE/);
        const log = await readGit({ directory: fx.directory, kind: 'log', path: '[a].txt' });
        assert.equal(log.commits?.length, 20); assert.equal(log.truncated, true);
        assert.equal(log.commits?.[0].subject, 'entry 20');
    } finally { await fx.close(); }
});

test('partial clone configuration and unsafe filter keys fail closed before worktree reads', async () => {
    const fx = await fixture();
    try {
        fx.invoke('config', 'remote.fixture.promisor', 'true');
        for (const kind of ['status', 'diff', 'log'] as const) {
            const result = await readGit({ directory: fx.directory, kind });
            assert.equal(result.snapshot.state, 'error');
            assert.match(result.snapshot.message!, /partial clone/);
            assert.equal(result.diff, undefined); assert.equal(result.commits, undefined);
        }
        fx.invoke('config', '--unset', 'remote.fixture.promisor');
        fx.invoke('config', 'filter.unsafe=name.clean', 'never execute');
        const result = await readGit({ directory: fx.directory, kind: 'status' });
        assert.equal(result.snapshot.state, 'error');
        assert.match(result.snapshot.message!, /未知/);
    } finally { await fx.close(); }
});

test('subdirectory diff excludes cross-directory rename source and configured color', async () => {
    const fx = await fixture();
    try {
        await mkdir(path.join(fx.directory, 'allowed'));
        await mkdir(path.join(fx.directory, 'sibling'));
        await writeFile(path.join(fx.directory, 'sibling', 'source.txt'), 'shared line\nSIBLING SECRET\n');
        await writeFile(path.join(fx.directory, 'allowed', 'initial.txt'), 'allowed\n');
        fx.invoke('add', '--all'); fx.invoke('commit', '--quiet', '-m', 'initial');
        await rename(path.join(fx.directory, 'sibling', 'source.txt'), path.join(fx.directory, 'allowed', 'destination.txt'));
        await writeFile(path.join(fx.directory, 'allowed', 'destination.txt'), 'shared line\nAUTHORIZED CONTENT\n');
        fx.invoke('add', '--all');
        fx.invoke('config', 'color.ui', 'always');
        fx.invoke('config', 'diff.renames', 'copies');
        const result = await readGit({ directory: path.join(fx.directory, 'allowed'), kind: 'diff', staged: true });
        assert.equal(result.snapshot.state, 'ready');
        assert.match(result.diff!, /AUTHORIZED CONTENT/);
        assert.doesNotMatch(result.diff!, /SIBLING SECRET|sibling\/source|\x1b\[/);
        assert.match(result.diff!, /a\/destination.txt b\/destination.txt/);
        assert.match(result.snapshot.message!, /忽略子模块内部状态/);
        assert.match(result.snapshot.message!, /本地跟踪记录/);
    } finally { await fx.close(); }
});

test('log disables signature verification even when repository configuration enables it', async () => {
    const fx = await fixture();
    try {
        const marker = path.join(fx.directory, 'gpg-executed');
        const script = path.join(fx.directory, 'fake-gpg.cjs');
        await writeFile(script, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'BAD');`);
        await writeFile(path.join(fx.directory, 'signed.txt'), 'fixture\n');
        fx.invoke('add', '--', 'signed.txt'); fx.invoke('commit', '--quiet', '-m', 'initial');
        const tree = fx.invoke('rev-parse', 'HEAD^{tree}').trim();
        // Synthetic signature bytes suffice to make verification launch gpg. No key
        // material, network access, or real signing program is used in this fixture.
        const commit = `tree ${tree}\nauthor Fixture <fixture@example.invalid> 1700000000 +0000\ncommitter Fixture <fixture@example.invalid> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n fixture\n -----END PGP SIGNATURE-----\n\nsigned fixture\n`;
        const hash = execFileSync('git', ['-C', fx.directory, 'hash-object', '-t', 'commit', '-w', '--stdin'],
            { input: commit, encoding: 'utf8', windowsHide: true }).trim();
        fx.invoke('update-ref', 'HEAD', hash);
        // Windows Git accepts a shell command in gpg.program only as an executable
        // path. A launcher file makes the controlled marker executable portable.
        const launcher = path.join(fx.directory, process.platform === 'win32' ? 'fake-gpg.bat' : 'fake-gpg');
        await writeFile(launcher, process.platform === 'win32'
            ? `@echo off\r\nnode "${script}"\r\n` : `#!/bin/sh\nnode "${script}"\n`, { mode: 0o755 });
        fx.invoke('config', 'gpg.program', launcher.replace(/\\/g, '/'));
        fx.invoke('config', 'log.showSignature', 'true');
        // Positive control proves the executable marker is reachable when verification
        // is enabled; then the production read must leave it absent.
        fx.invoke('log', '-1', '--show-signature', '--format=%s');
        await access(marker);
        await rm(marker);
        const result = await readGit({ directory: fx.directory, kind: 'log' });
        assert.equal(result.snapshot.state, 'ready');
        assert.equal(result.commits?.[0].subject, 'signed fixture');
        await assert.rejects(access(marker));
    } finally { await fx.close(); }
});
