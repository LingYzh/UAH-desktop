import assert from 'node:assert/strict';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { ExtensionStore } from '../../src/main/extension-store';
import { parseExtensionCommand } from '../../src/shared/extensions';
import type { ConnectorDraft } from '../../src/shared/extensions';

const testCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value: string): Buffer {
        return Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0xa5));
    },
    decryptString(value: Buffer): string {
        return Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('utf8');
    },
};

function createHarness(t: test.TestContext): { root: string; store: ExtensionStore } {
    const root = mkdtempSync(join(tmpdir(), 'uah-extension-store-test-'));
    const store = new ExtensionStore(root, testCipher);
    t.after(() => {
        store.close();
        const target = resolve(root);
        if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-extension-store-test-')) {
            throw new Error(`Refusing to remove unexpected test directory: ${target}`);
        }
        rmSync(target, { recursive: true, force: true });
    });
    return { root, store };
}

function writeJson(path: string, value: unknown): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value), 'utf8');
}

function makeSkill(root: string, skillName: string, description = 'A concise skill description'): string {
    const directory = join(root, skillName);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${skillName}\ndescription: >\n  ${description}\n  with a second line\n---\n# ${skillName}\n`, 'utf8');
    mkdirSync(join(directory, 'docs'), { recursive: true });
    writeFileSync(join(directory, 'docs', 'guide.md'), 'A nested skill resource.', 'utf8');
    return directory;
}

function makePlugin(root: string, overrides: { version?: string; manifest?: Record<string, unknown>; mcp?: Record<string, unknown> } = {}): string {
    mkdirSync(root, { recursive: true });
    const manifest: Record<string, unknown> = {
        name: 'demo-plugin',
        description: 'Demo plugin',
        version: overrides.version ?? '1.0.0',
        ...(overrides.manifest ?? {}),
    };
    writeJson(join(root, '.claude-plugin', 'plugin.json'), manifest);
    makeSkill(join(root, 'skills'), 'review', 'Review code carefully');
    makeSkill(join(root, 'extra-skills'), 'release', 'Prepare a release');
    writeFileSync(join(root, 'server.js'), 'process.exit(0);', 'utf8');
    writeJson(join(root, '.mcp.json'), overrides.mcp ?? {
        mcpServers: {
            demo: {
                command: 'node',
                args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
                env: { TOKEN: 'do-not-expose-this-secret' },
            },
        },
    });
    return root;
}

function connectorDraft(overrides: Partial<ConnectorDraft> = {}): ConnectorDraft {
    return {
        id: null,
        name: 'Local MCP',
        transport: 'stdio',
        command: 'node',
        args: ['server.js'],
        url: '',
        enabled: false,
        revision: 0,
        secrets: {},
        ...overrides,
    };
}

test('strictly parses extension commands and rejects unknown fields and oversized values', () => {
    assert.deepEqual(parseExtensionCommand({ type: 'list' }), { type: 'list' });
    assert.throws(() => parseExtensionCommand({ type: 'list', ignored: true }), /不支持的字段/);
    assert.throws(() => parseExtensionCommand({ type: 'delete-connector', id: 'x', revision: -1 }), /版本无效/);
    assert.throws(() => parseExtensionCommand({ type: 'install-plugin', source: 'x', extra: true }), /不支持的字段/);
    assert.throws(() => parseExtensionCommand({ type: 'install-plugin', source: 'x'.repeat(4097) }), /来源无效/);
    assert.throws(() => parseExtensionCommand({
        type: 'save-connector',
        draft: connectorDraft({ args: Array.from({ length: 129 }, () => 'arg') }),
    }), /参数无效/);
    assert.throws(() => parseExtensionCommand({ type: 'set-skill-enabled', id: 'x', enabled: 1 }), /开启状态无效/);
});

test('parses literal block skill descriptions as readable single-line catalog text', async (t) => {
    const { root, store } = createHarness(t);
    const source = join(root, 'literal-skill');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '---\nname: literal-skill\ndescription: |\n  first line\n  second line\n---\n# Literal\n', 'utf8');
    const snapshot = await store.execute({ type: 'install-skill', source });
    assert.equal(snapshot.skills[0].description, 'first line second line');
});

test('accepts manifest-less standard plugin layouts and uses the selected directory name', async (t) => {
    const { root, store } = createHarness(t);
    const source = join(root, 'plain-skill-plugin');
    makeSkill(join(source, 'skills'), 'plain-skill');
    const snapshot = await store.execute({ type: 'install-plugin', source });
    assert.equal(snapshot.plugins[0].name, 'plain-skill-plugin');
    assert.equal(snapshot.skills.length, 1);
});

test('encrypts connector secrets, preserves them only for the same target, and enforces revisions and transport policy', async (t) => {
    const { root, store } = createHarness(t);
    const secret = '  keep this exact value  ';
    const created = await store.execute({ type: 'save-connector', draft: connectorDraft({ enabled: true, secrets: { TOKEN: secret } }) });
    const connector = created.connectors[0];
    assert.equal(connector.hasSecrets, true);
    assert.equal('secrets' in connector, false);
    assert.deepEqual(store.resolveConnectors()[0].secrets, { TOKEN: secret });

    const databaseBytes = readFileSync(join(root, 'extensions.sqlite'));
    assert.equal(databaseBytes.includes(Buffer.from(secret, 'utf8')), false);

    const preserve = await store.execute({
        type: 'save-connector',
        draft: connectorDraft({ ...connector, id: connector.id, revision: connector.revision, secrets: null }),
    });
    assert.equal(preserve.connectors[0].revision, 1);
    assert.equal(store.resolveConnectors()[0].secrets.TOKEN, secret);

    const latest = preserve.connectors[0];
    await assert.rejects(() => store.execute({
        type: 'save-connector',
        draft: connectorDraft({ ...latest, command: 'node.exe', secrets: null }),
    }), /必须显式替换或清除密钥/);

    const cleared = await store.execute({
        type: 'save-connector',
        draft: connectorDraft({ ...latest, command: 'node.exe', secrets: {} }),
    });
    assert.equal(cleared.connectors[0].hasSecrets, false);
    assert.deepEqual(store.resolveConnectors()[0].secrets, {});
    await assert.rejects(() => store.execute({ type: 'delete-connector', id: connector.id, revision: 0 }), /已被其他操作修改/);

    await assert.rejects(() => store.execute({
        type: 'save-connector',
        draft: connectorDraft({ transport: 'stdio', command: 'start.cmd' }),
    }), /不能使用 \.cmd 或 \.bat/);
    await assert.rejects(() => store.execute({
        type: 'save-connector',
        draft: connectorDraft({ transport: 'http', command: '', args: [], url: 'http://example.com/mcp' }),
    }), /必须使用 HTTPS/);
    await assert.rejects(() => store.execute({
        type: 'save-connector',
        draft: connectorDraft({ transport: 'http', command: '', args: [], url: 'https://user:pass@example.com/mcp' }),
    }), /地址无效/);
    await assert.rejects(() => store.execute({
        type: 'save-connector',
        draft: connectorDraft({ transport: 'http', command: '', args: [], url: 'http://localhost:3000/mcp', secrets: { Host: 'bad' } }),
    }), /禁止字段/);
    await store.execute({ type: 'delete-connector', id: connector.id, revision: 2 });
    assert.deepEqual(store.list().connectors, []);
});

test('installs supported plugin skills and disabled MCP servers, filters by plugin state, and removes only its copy', async (t) => {
    const { root, store } = createHarness(t);
    const source = makePlugin(join(root, 'source-plugin'), { manifest: { skills: ['./extra-skills/', './skills'], commands: { run: 'not executed' } } });
    const snapshot = await store.execute({ type: 'install-plugin', source });
    assert.equal(snapshot.plugins.length, 1);
    const plugin = snapshot.plugins[0];
    assert.equal(plugin.enabled, false);
    assert.ok(plugin.unsupported.includes('暂不支持组件：commands'));
    assert.equal(snapshot.skills.length, 2);
    assert.equal(snapshot.connectors.length, 1);
    assert.equal(snapshot.connectors[0].enabled, false);
    assert.equal(snapshot.connectors[0].hasSecrets, true);
    assert.equal(existsSync(snapshot.connectors[0].args[0]), true);
    assert.equal(JSON.stringify(snapshot).includes('do-not-expose-this-secret'), false);
    assert.equal(store.skillCatalogForRuntime().length, 0);
    assert.throws(() => store.readSkill(snapshot.skills[0].id), /未启用/);

    await store.execute({ type: 'set-plugin-enabled', id: plugin.id, enabled: true });
    const catalog = store.skillCatalogForRuntime();
    assert.equal(catalog.length, 2);
    assert.ok(catalog.every((skill) => skill.path.endsWith('SKILL.md') && existsSync(skill.path)));
    const release = snapshot.skills.find((skill) => skill.name === 'release')!;
    const loaded = store.readSkill(release.id);
    assert.equal(loaded.name, 'release');
    assert.match(loaded.content, /# release/);
    assert.equal(store.readSkill(release.id, 'docs/guide.md').content, 'A nested skill resource.');
    assert.deepEqual(store.resolveConnectors(), []);

    const server = store.list().connectors[0];
    await store.execute({
        type: 'save-connector',
        draft: {
            ...server,
            id: server.id,
            secrets: null,
            enabled: true,
            revision: server.revision,
            pluginId: plugin.id,
        },
    });
    assert.deepEqual(store.resolveConnectors()[0].secrets, { TOKEN: 'do-not-expose-this-secret' });

    await store.execute({ type: 'set-plugin-enabled', id: plugin.id, enabled: false });
    assert.deepEqual(store.resolveConnectors(), []);
    assert.equal(store.skillCatalogForRuntime().length, 0);
    assert.throws(() => store.readSkill(release.id), /未启用/);
    await store.execute({ type: 'remove-plugin', id: plugin.id });
    assert.equal(existsSync(source), true);
    assert.deepEqual(store.list().plugins, []);
    assert.deepEqual(store.list().skills, []);
    assert.deepEqual(store.list().connectors, []);
});

test('rejects duplicate plugins and keeps the installed version when an update package is bad', async (t) => {
    const { root, store } = createHarness(t);
    const source = makePlugin(join(root, 'source-plugin'));
    const installed = await store.execute({ type: 'install-plugin', source });
    await assert.rejects(() => store.execute({ type: 'install-plugin', source }), /已安装同名插件/);
    const plugin = installed.plugins[0];
    await store.execute({ type: 'set-plugin-enabled', id: plugin.id, enabled: true });
    const catalogBefore = store.skillCatalogForRuntime();

    writeFileSync(join(source, '.claude-plugin', 'plugin.json'), '{not json', 'utf8');
    await assert.rejects(() => store.execute({ type: 'update-plugin', id: plugin.id }), /不是有效 JSON/);
    const after = store.list().plugins[0];
    assert.equal(after.version, '1.0.0');
    assert.equal(after.id, plugin.id);
    assert.ok(store.skillCatalogForRuntime().every((skill) => existsSync(skill.path)));
    assert.equal(catalogBefore.length, 1);
});

test('updates a plugin package while keeping its controlled root valid and retaining same-target connector settings', async (t) => {
    const { root, store } = createHarness(t);
    const source = makePlugin(join(root, 'source-plugin'));
    const installed = await store.execute({ type: 'install-plugin', source });
    const plugin = installed.plugins[0];
    await store.execute({ type: 'set-plugin-enabled', id: plugin.id, enabled: true });
    const connector = store.list().connectors[0];
    await store.execute({
        type: 'save-connector',
        draft: {
            ...connector,
            id: connector.id,
            enabled: true,
            revision: connector.revision,
            pluginId: plugin.id,
            secrets: null,
        },
    });

    makePlugin(source, { version: '2.0.0' });
    const updated = await store.execute({ type: 'update-plugin', id: plugin.id });
    assert.equal(updated.plugins[0].version, '2.0.0');
    assert.equal(updated.plugins[0].enabled, true);
    assert.equal(updated.connectors[0].enabled, true);
    assert.equal(existsSync(updated.connectors[0].args[0]), true);
    assert.deepEqual(store.resolveConnectors()[0].secrets, { TOKEN: 'do-not-expose-this-secret' });
});

test('resets plugin connector credentials and disables it when an update changes secret field names', async (t) => {
    const { root, store } = createHarness(t);
    const source = makePlugin(join(root, 'source-plugin'));
    const installed = await store.execute({ type: 'install-plugin', source });
    const plugin = installed.plugins[0];
    await store.execute({ type: 'set-plugin-enabled', id: plugin.id, enabled: true });
    const connector = store.list().connectors[0];
    await store.execute({
        type: 'save-connector',
        draft: {
            ...connector,
            id: connector.id,
            enabled: true,
            revision: connector.revision,
            pluginId: plugin.id,
            secrets: null,
        },
    });

    writeJson(join(source, '.mcp.json'), {
        mcpServers: {
            demo: {
                command: 'node',
                args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
                env: { API_TOKEN: 'replacement-secret' },
            },
        },
    });
    writeJson(join(source, '.claude-plugin', 'plugin.json'), {
        name: 'demo-plugin',
        description: 'Demo plugin',
        version: '2.0.0',
    });

    const updated = await store.execute({ type: 'update-plugin', id: plugin.id });
    assert.equal(updated.connectors[0].enabled, false);
    assert.deepEqual(store.resolveConnectors(), []);
    await store.execute({
        type: 'save-connector',
        draft: {
            ...updated.connectors[0],
            id: updated.connectors[0].id,
            enabled: true,
            revision: updated.connectors[0].revision,
            pluginId: plugin.id,
            secrets: null,
        },
    });
    assert.deepEqual(store.resolveConnectors()[0].secrets, { API_TOKEN: 'replacement-secret' });
});

test('scrubs parsed MCP credentials from installed copies while preserving sources and reimporting on update', async (t) => {
    const { root, store } = createHarness(t);
    const source = makePlugin(join(root, 'source-plugin'));
    const extraSecret = 'additional-plugin-secret';
    const sourceMcpPath = join(source, '.claude-plugin', 'servers.json');
    writeJson(sourceMcpPath, {
        mcpServers: {
            additional: {
                command: 'node',
                args: ['${CLAUDE_PLUGIN_ROOT}/server.js'],
                env: { API_TOKEN: extraSecret },
            },
        },
        metadata: { env: { keep: 'not a parsed MCP server field' } },
    });
    writeJson(join(source, '.claude-plugin', 'plugin.json'), {
        name: 'demo-plugin',
        description: 'Demo plugin',
        version: '1.0.0',
        mcpServers: './.claude-plugin/servers.json',
    });

    const installed = await store.execute({ type: 'install-plugin', source });
    const plugin = installed.plugins[0];
    const installedRoot = dirname(installed.connectors[0].args[0]);
    const assertScrubbedCopy = (packageRoot: string): void => {
        const defaultConfig = JSON.parse(readFileSync(join(packageRoot, '.mcp.json'), 'utf8')) as Record<string, any>;
        assert.equal(defaultConfig.mcpServers.demo.env, undefined);
        const referencedConfig = JSON.parse(readFileSync(join(packageRoot, '.claude-plugin', 'servers.json'), 'utf8')) as Record<string, any>;
        assert.equal(referencedConfig.mcpServers.additional.env, undefined);
        assert.deepEqual(referencedConfig.metadata.env, { keep: 'not a parsed MCP server field' });
        const copiedManifest = readFileSync(join(packageRoot, '.claude-plugin', 'plugin.json'), 'utf8');
        assert.equal(copiedManifest.includes(extraSecret), false);
        assert.equal(readFileSync(join(packageRoot, '.mcp.json'), 'utf8').includes('do-not-expose-this-secret'), false);
        assert.equal(readFileSync(join(packageRoot, '.claude-plugin', 'servers.json'), 'utf8').includes(extraSecret), false);
    };
    assertScrubbedCopy(installedRoot);
    assert.equal(readFileSync(join(source, '.mcp.json'), 'utf8').includes('do-not-expose-this-secret'), true);
    assert.equal(readFileSync(sourceMcpPath, 'utf8').includes(extraSecret), true);

    await store.execute({ type: 'set-plugin-enabled', id: plugin.id, enabled: true });
    for (const connector of installed.connectors) {
        await store.execute({
            type: 'save-connector',
            draft: { ...connector, id: connector.id, pluginId: plugin.id, enabled: true, secrets: null },
        });
    }
    writeJson(join(source, '.claude-plugin', 'plugin.json'), {
        name: 'demo-plugin',
        description: 'Demo plugin',
        version: '2.0.0',
        mcpServers: './.claude-plugin/servers.json',
    });
    const updated = await store.execute({ type: 'update-plugin', id: plugin.id });
    const updatedRoot = dirname(updated.connectors[0].args[0]);
    assertScrubbedCopy(updatedRoot);
    assert.deepEqual(store.resolveConnectors().map((connector) => connector.secrets), [
        { TOKEN: 'do-not-expose-this-secret' },
        { API_TOKEN: extraSecret },
    ]);

    await store.execute({ type: 'remove-plugin', id: plugin.id });
    assert.equal(existsSync(updatedRoot), false);
    assert.equal(existsSync(source), true);
});

test('adds a compatible local marketplace, normalizes GitHub sources, marks unsupported formats, and cascades removal safely', async (t) => {
    const { root, store } = createHarness(t);
    const marketplaceRoot = join(root, 'marketplace-source');
    makePlugin(join(marketplaceRoot, 'plugins', 'local-plugin'), { manifest: { name: 'market-local', version: '2.0.0' } });
    writeJson(join(marketplaceRoot, '.claude-plugin', 'marketplace.json'), {
        name: 'team-market',
        owner: { name: 'Team' },
        plugins: [
            { name: 'market-local', description: 'Local plugin', source: './plugins/local-plugin' },
            { name: 'remote-plugin', description: 'Remote plugin', source: { source: 'github', repo: 'org/remote-plugin' } },
            { name: 'archived-plugin', description: 'Unsupported archive', source: { source: 'archive', url: 'https://example.test/plugin.zip' } },
        ],
    });

    const snapshot = await store.execute({ type: 'add-marketplace', source: marketplaceRoot });
    const marketplace = snapshot.marketplaces[0];
    assert.equal(marketplace.name, 'team-market');
    assert.equal(marketplace.plugins[1].source, 'https://github.com/org/remote-plugin.git');
    assert.equal(marketplace.plugins[2].source, 'unsupported:archive');

    const installed = await store.execute({ type: 'install-marketplace-plugin', marketplaceId: marketplace.id, name: 'market-local' });
    assert.equal(installed.plugins.length, 1);
    assert.equal(installed.plugins[0].enabled, false);
    await assert.rejects(
        () => store.execute({ type: 'install-marketplace-plugin', marketplaceId: marketplace.id, name: 'archived-plugin' }),
        /暂不支持/,
    );
    await store.execute({ type: 'remove-marketplace', id: marketplace.id });
    assert.equal(existsSync(marketplaceRoot), true);
    assert.deepEqual(store.list().marketplaces, []);
    assert.deepEqual(store.list().plugins, []);
});

test('rejects skill traversal, disabled reads, links, and unsupported placeholder expansion', async (t) => {
    const { root, store } = createHarness(t);
    const skillSource = join(root, 'standalone-skill');
    makeSkill(dirname(skillSource), basename(skillSource));
    writeFileSync(join(root, 'outside.md'), 'outside', 'utf8');
    const installed = await store.execute({ type: 'install-skill', source: skillSource });
    const skill = installed.skills[0];
    assert.equal(skill.enabled, true);
    await store.execute({ type: 'set-skill-enabled', id: skill.id, enabled: false });
    assert.throws(() => store.readSkill(skill.id), /未启用/);
    await store.execute({ type: 'set-skill-enabled', id: skill.id, enabled: true });
    assert.throws(() => store.readSkill(skill.id, '../outside.md'), /相对路径无效/);
    assert.match(store.readSkill(skill.id).content, /# standalone-skill/);

    const livePath = store.skillCatalogForRuntime()[0].path;
    const linkTarget = join(dirname(livePath), 'linked-dir');
    const outsideDirectory = join(root, 'outside-directory');
    mkdirSync(outsideDirectory, { recursive: true });
    writeFileSync(join(outsideDirectory, 'outside.md'), 'outside', 'utf8');
    try {
        symlinkSync(outsideDirectory, linkTarget, 'junction');
        assert.throws(() => store.readSkill(skill.id, 'linked-dir/outside.md'), /符号链接或目录联接|路径越界/);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'ENOTSUP') {
            t.diagnostic('Junction creation is unavailable on this Windows host; path traversal checks still ran.');
        } else {
            throw error;
        }
    }

    const badPlugin = join(root, 'bad-placeholder-plugin');
    makePlugin(badPlugin, {
        mcp: { mcpServers: { unsafe: { command: 'node', args: ['${HOME}/server.js'] } } },
    });
    const bad = await store.execute({ type: 'install-plugin', source: badPlugin });
    assert.ok(bad.plugins[0].unsupported.some((item) => item.includes('MCP 服务器项')));
    assert.equal(bad.connectors.length, 0);
});

test('rejects pre-existing junctions in extension-controlled installation directories', (t) => {
    const root = mkdtempSync(join(tmpdir(), 'uah-extension-store-test-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const extensionRoot = join(root, 'extensions');
    const outside = join(root, 'outside');
    mkdirSync(extensionRoot, { recursive: true });
    mkdirSync(outside, { recursive: true });
    try {
        symlinkSync(outside, join(extensionRoot, 'plugins'), 'junction');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'ENOTSUP') {
            t.skip('Junction creation is unavailable on this Windows host.');
            return;
        }
        throw error;
    }
    assert.throws(() => new ExtensionStore(root, testCipher));
    assert.deepEqual(readdirSync(outside), []);
});

test('persists extension state in SQLite and exposes only active skills and connectors after reopening', async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'uah-extension-store-test-'));
    const store = new ExtensionStore(root, testCipher);
    const source = makePlugin(join(root, 'source-plugin'));
    const installed = await store.execute({ type: 'install-plugin', source });
    await store.execute({ type: 'set-plugin-enabled', id: installed.plugins[0].id, enabled: true });
    store.close();
    const bytes = readFileSync(join(root, 'extensions.sqlite'));
    assert.equal(bytes.includes(Buffer.from('do-not-expose-this-secret', 'utf8')), false);

    const reopened = new ExtensionStore(root, testCipher);
    t.after(() => {
        reopened.close();
        rmSync(root, { recursive: true, force: true });
    });
    assert.equal(reopened.list().plugins[0].enabled, true);
    assert.equal(reopened.skillCatalogForRuntime().length, 1);
    const database = new DatabaseSync(join(root, 'extensions.sqlite'));
    const version = (database.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    database.close();
    assert.equal(version, 1);
});
