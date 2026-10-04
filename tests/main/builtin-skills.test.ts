import assert from 'node:assert/strict';
import {
    cpSync,
    existsSync,
    linkSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    symlinkSync,
    unlinkSync,
    writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { ExtensionStore } from '../../src/main/extension-store';

const shippedBuiltinSkills = resolve('resources/builtin-skills');

const testCipher = {
    isEncryptionAvailable: () => true,
    encryptString(value: string): Buffer {
        return Buffer.from([...Buffer.from(value, 'utf8')].map((byte) => byte ^ 0xa5));
    },
    decryptString(value: Buffer): string {
        return Buffer.from([...value].map((byte) => byte ^ 0xa5)).toString('utf8');
    },
};

function makeRoot(): string {
    return mkdtempSync(join(tmpdir(), 'uah-builtin-skills-test-'));
}

function cleanupRoot(root: string): void {
    const target = resolve(root);
    if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('uah-builtin-skills-test-')) {
        throw new Error(`Refusing to remove unexpected test directory: ${target}`);
    }
    rmSync(target, { recursive: true, force: true });
}

function copyBuiltinSkills(root: string, name: string): string {
    const directory = join(root, name);
    cpSync(shippedBuiltinSkills, directory, { recursive: true });
    return directory;
}

function makeSkill(root: string, name: string, body: string): string {
    const directory = join(root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: User installed copy\n---\n${body}\n`, 'utf8');
    return directory;
}

function isLinkPermissionError(error: unknown): boolean {
    return ['EACCES', 'EPERM', 'ENOTSUP'].includes((error as NodeJS.ErrnoException).code ?? '');
}

test('loads enabled builtins, reads references, persists disable state, and rejects uninstall', async (t) => {
    const root = makeRoot();
    let store = new ExtensionStore(root, testCipher, shippedBuiltinSkills);
    t.after(() => {
        store.close();
        cleanupRoot(root);
    });

    const builtins = store.list().skills.filter((skill) => skill.builtin);
    assert.deepEqual(builtins.map(({ id, enabled, source }) => ({ id, enabled, source })), [
        { id: 'builtin:grilling', enabled: true, source: 'builtin:grilling' },
        { id: 'builtin:powershell-windows-cli', enabled: true, source: 'builtin:powershell-windows-cli' },
    ]);
    assert.equal(store.skillCatalogForRuntime().length, 2);
    assert.ok(store.skillCatalogForRuntime().every((skill) => existsSync(skill.path)));

    const reference = store.readSkill('builtin:powershell-windows-cli', 'references/windows-text-encoding.md');
    assert.match(reference.content, /UTF-8|encoding/i);
    assert.throws(
        () => store.readSkill('builtin:powershell-windows-cli', '../LICENSE'),
        /Skill 相对路径无效/,
    );

    await store.execute({ type: 'set-skill-enabled', id: 'builtin:grilling', enabled: false });
    await assert.rejects(
        () => store.execute({ type: 'remove-skill', id: 'builtin:grilling' }),
        /内置 Skill 不可卸载/,
    );
    assert.throws(() => store.readSkill('builtin:grilling'), /未启用/);

    store.close();
    store = new ExtensionStore(root, testCipher, shippedBuiltinSkills);
    assert.equal(store.list().skills.find((skill) => skill.id === 'builtin:grilling')?.enabled, false);
    assert.equal(store.list().skills.find((skill) => skill.id === 'builtin:powershell-windows-cli')?.enabled, true);
});

test('keeps same-name user skills separate from builtins', async (t) => {
    const root = makeRoot();
    const store = new ExtensionStore(root, testCipher, shippedBuiltinSkills);
    t.after(() => {
        store.close();
        cleanupRoot(root);
    });
    const userSkillPath = makeSkill(join(root, 'user-skills'), 'grilling', '# User-installed grilling copy');

    const installed = await store.execute({ type: 'install-skill', source: userSkillPath });
    const matching = installed.skills.filter((skill) => skill.name === 'grilling');
    assert.equal(matching.length, 2);
    const userSkill = matching.find((skill) => !skill.builtin)!;
    assert.notEqual(userSkill.id, 'builtin:grilling');
    assert.match(store.readSkill('builtin:grilling').content, /# Grilling/);
    assert.match(store.readSkill(userSkill.id).content, /# User-installed grilling copy/);

    await store.execute({ type: 'remove-skill', id: userSkill.id });
    assert.equal(store.list().skills.some((skill) => skill.id === 'builtin:grilling'), true);
});

test('preserves extension-only construction when no builtin directory is supplied', (t) => {
    const root = makeRoot();
    const store = new ExtensionStore(root, testCipher);
    t.after(() => {
        store.close();
        cleanupRoot(root);
    });
    assert.deepEqual(store.list().skills, []);
    assert.deepEqual(store.skillCatalogForRuntime(), []);
});

test('fails clearly when a shipped builtin file is missing or malformed', (t) => {
    const root = makeRoot();
    t.after(() => cleanupRoot(root));
    const missingDirectory = copyBuiltinSkills(root, 'missing');
    unlinkSync(join(missingDirectory, 'powershell-windows-cli', 'LICENSE'));
    assert.throws(
        () => new ExtensionStore(join(root, 'missing-data'), testCipher, missingDirectory),
        /内置 Skill 内容缺失|内置 Skill 文件不存在/,
    );

    const malformedDirectory = copyBuiltinSkills(root, 'malformed');
    writeFileSync(join(malformedDirectory, 'grilling', 'SKILL.md'), '# missing frontmatter\n', 'utf8');
    assert.throws(
        () => new ExtensionStore(join(root, 'malformed-data'), testCipher, malformedDirectory),
        /Skill 缺少有效 YAML frontmatter/,
    );
});

test('rejects symlinks and hardlinks in shipped builtin content where the host permits creation', (t) => {
    const root = makeRoot();
    t.after(() => cleanupRoot(root));
    const symlinkDirectory = copyBuiltinSkills(root, 'symlinked');
    const referencePath = join(symlinkDirectory, 'powershell-windows-cli', 'references', 'windows-text-encoding.md');
    const outsidePath = join(root, 'outside.md');
    writeFileSync(outsidePath, 'outside', 'utf8');
    unlinkSync(referencePath);
    try {
        symlinkSync(outsidePath, referencePath, 'file');
    } catch (error) {
        if (isLinkPermissionError(error)) {
            t.diagnostic('File symlink creation is unavailable on this Windows host.');
        } else {
            throw error;
        }
    }
    if (existsSync(referencePath)) {
        assert.throws(
            () => new ExtensionStore(join(root, 'symlink-data'), testCipher, symlinkDirectory),
            /符号链接或目录联接/,
        );
    }

    const hardlinkDirectory = copyBuiltinSkills(root, 'hardlinked');
    const manifestPath = join(hardlinkDirectory, 'grilling', 'SKILL.md');
    const hardlinkPath = join(hardlinkDirectory, 'grilling', 'SKILL-copy.md');
    try {
        linkSync(manifestPath, hardlinkPath);
    } catch (error) {
        if (isLinkPermissionError(error)) {
            t.diagnostic('Hardlink creation is unavailable on this Windows host.');
            return;
        }
        throw error;
    }
    assert.throws(
        () => new ExtensionStore(join(root, 'hardlink-data'), testCipher, hardlinkDirectory),
        /硬链接/,
    );
});
