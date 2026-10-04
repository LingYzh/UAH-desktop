import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { discoverNativeCodex } from '../../src/main/native-codex-discovery';

function createRoot(t: test.TestContext): string {
    const root = mkdtempSync(join(tmpdir(), 'uah-codex-discovery-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    return root;
}

function makeFile(path: string, content = ''): string {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content, 'utf8');
    return path;
}

function makeEnv(values: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
    return { PATH: '', ...values };
}

function skipUnlessWindows(t: test.TestContext): void {
    if (process.platform !== 'win32') t.skip('Native Codex discovery is Windows-only.');
}

test('discovers and canonicalizes a direct codex.exe from an absolute PATH directory', async (t) => {
    skipUnlessWindows(t);
    const root = createRoot(t);
    const directory = join(root, 'direct');
    const executable = makeFile(join(directory, 'codex.exe'));
    const result = await discoverNativeCodex({
        env: makeEnv({ PATH: `"${directory}"` }),
        home: join(root, 'home'),
    });

    assert.deepEqual(result, [{ command: realpathSync(executable), args: [], source: 'PATH' }]);
});

test('discovers npm Codex through a matching node.exe and prefers node beside the script', async (t) => {
    skipUnlessWindows(t);
    const root = createRoot(t);
    const prefix = join(root, 'npm-prefix');
    const script = makeFile(join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));
    const localNode = makeFile(join(dirname(script), 'node.exe'));
    makeFile(join(root, 'other-node', 'node.exe'));
    const result = await discoverNativeCodex({
        env: makeEnv({ PATH: `${join(root, 'other-node')};${prefix}` }),
        home: join(root, 'home'),
    });

    assert.deepEqual(result, [{
        command: realpathSync(localNode),
        args: [realpathSync(script)],
        source: 'npm package',
    }]);
});

test('does not return npm JavaScript wrappers when no node.exe was found', async (t) => {
    skipUnlessWindows(t);
    const root = createRoot(t);
    const prefix = join(root, 'npm-prefix');
    makeFile(join(prefix, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'));

    const result = await discoverNativeCodex({
        env: makeEnv({ PATH: prefix }),
        home: join(root, 'home'),
    });
    assert.deepEqual(result, []);
});

test('ignores relative and empty PATH components and deduplicates quoted paths case-insensitively', async (t) => {
    skipUnlessWindows(t);
    const root = createRoot(t);
    const directory = join(root, 'Codex Bin');
    const executable = makeFile(join(directory, 'codex.exe'));
    const upperCasePath = directory.toUpperCase();
    const result = await discoverNativeCodex({
        env: makeEnv({ PATH: `;relative;.;"${directory}";${upperCasePath};${directory}` }),
        home: join(root, 'home'),
    });

    assert.deepEqual(result, [{ command: realpathSync(executable), args: [], source: 'PATH' }]);
});

test('discovers current-architecture npm native binaries and the older vendor layout', async (t) => {
    skipUnlessWindows(t);
    const root = createRoot(t);
    const architecture = process.arch === 'x64'
        ? { package: 'codex-win32-x64', triplet: 'x86_64-pc-windows-msvc' }
        : { package: 'codex-win32-arm64', triplet: 'aarch64-pc-windows-msvc' };
    const currentDirectory = join(root, 'current-layout');
    const oldDirectory = join(root, 'old-layout');
    const nestedDirectory = join(root, 'nested-layout');
    const codexPackageDirectory = join(root, 'codex-package-layout');
    const current = makeFile(join(
        currentDirectory,
        'node_modules', '@openai', architecture.package, 'vendor', architecture.triplet, 'codex', 'codex.exe',
    ));
    const old = makeFile(join(
        oldDirectory,
        'node_modules', '@openai', architecture.package, 'vendor', architecture.triplet, 'codex.exe',
    ));
    const nested = makeFile(join(
        nestedDirectory,
        'node_modules', '@openai', 'codex', 'node_modules', '@openai', architecture.package,
        'vendor', architecture.triplet, 'bin', 'codex.exe',
    ));
    const oldCodex = makeFile(join(
        codexPackageDirectory,
        'node_modules', '@openai', 'codex', 'vendor', architecture.triplet, 'codex', 'codex.exe',
    ));
    const oldCodexBin = makeFile(join(
        codexPackageDirectory,
        'node_modules', '@openai', 'codex', 'vendor', architecture.triplet, 'bin', 'codex.exe',
    ));
    const otherArchitecture = process.arch === 'x64'
        ? { package: 'codex-win32-arm64', triplet: 'aarch64-pc-windows-msvc' }
        : { package: 'codex-win32-x64', triplet: 'x86_64-pc-windows-msvc' };
    makeFile(join(
        currentDirectory,
        'node_modules', '@openai', otherArchitecture.package, 'vendor', otherArchitecture.triplet, 'bin', 'codex.exe',
    ));
    const result = await discoverNativeCodex({
        env: makeEnv({ PATH: `${currentDirectory};${oldDirectory};${nestedDirectory};${codexPackageDirectory}` }),
        home: join(root, 'home'),
    });

    assert.deepEqual(result.map(({ command }) => command).sort(), [
        current,
        old,
        nested,
        oldCodex,
        oldCodexBin,
    ].map((path) => realpathSync(path)).sort());
    assert.ok(result.every(({ args }) => args.length === 0));
    assert.ok(result.every((candidate) => candidate.source === 'npm native package'));
});

test('scans the bounded set of common Windows installation directories', async (t) => {
    skipUnlessWindows(t);
    const root = createRoot(t);
    const home = join(root, 'home');
    const common = [
        { path: join(root, 'appdata', 'npm'), source: 'AppData npm' },
        { path: join(root, 'program-files', 'nodejs'), source: 'ProgramFiles nodejs' },
        { path: join(root, 'local-appdata', 'Programs', 'nodejs'), source: 'Local nodejs' },
        { path: join(home, '.local', 'bin'), source: '~/.local/bin' },
        { path: join(home, 'scoop', 'shims'), source: 'Scoop shims' },
        { path: join(root, 'nvm-link'), source: 'NVM_SYMLINK' },
        { path: join(root, 'npm-prefix'), source: 'npm_config_prefix' },
    ];
    const expected = common.map(({ path }) => realpathSync(makeFile(join(path, 'codex.exe'))));
    const result = await discoverNativeCodex({
        env: makeEnv({
            APPDATA: join(root, 'appdata'),
            ProgramFiles: join(root, 'program-files'),
            LOCALAPPDATA: join(root, 'local-appdata'),
            NVM_SYMLINK: join(root, 'nvm-link'),
            npm_config_prefix: join(root, 'npm-prefix'),
        }),
        home,
    });

    assert.deepEqual(result.map(({ command }) => command), expected);
    assert.deepEqual(result.map(({ source }) => source), common.map(({ source }) => source));
});

test('ignores missing paths and caps returned candidates at twenty', async (t) => {
    skipUnlessWindows(t);
    const root = createRoot(t);
    const directories = Array.from({ length: 24 }, (_, index) => {
        const directory = join(root, `codex-${index}`);
        makeFile(join(directory, 'codex.exe'));
        return directory;
    });
    const result = await discoverNativeCodex({
        env: makeEnv({ PATH: [join(root, 'missing'), ...directories].join(';') }),
        home: join(root, 'home'),
    });

    assert.equal(result.length, 20);
    assert.equal(new Set(result.map(({ command }) => command.toLowerCase())).size, 20);
});
