import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    renameSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import {
    basename,
    dirname,
    isAbsolute,
    join,
    relative,
    resolve,
    sep,
} from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ConnectorDraft, ConnectorRecord, ExtensionCommand, ExtensionSnapshot, MarketplacePluginRecord, MarketplaceRecord, PluginRecord, ResolvedConnector, SkillRecord } from '../shared/extensions';
import { extensionLimits, parseExtensionCommand, validateExtensionCommandSize } from '../shared/extensions';
import type { EndpointCipher } from './endpoint-store';

const DB_VERSION = 1;
const MAX_CONNECTORS = 128;
const MAX_PLUGINS = 128;
const MAX_MARKETPLACES = 64;
const MAX_SKILLS = 64;
const MAX_MARKETPLACE_PLUGINS = extensionLimits.marketplacePlugins;
const MAX_SOURCE_FILES = 5_000;
const MAX_SOURCE_ENTRIES = 10_000;
const MAX_SOURCE_BYTES = 50 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_SKILL_BYTES = 128 * 1024;
const MAX_DESCRIPTION_LENGTH = 600;
const MAX_SECRET_BYTES = 256 * 1024;
const MAX_CLONE_MS = 120_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const GITHUB_SHORTHAND = /^([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/;
const BUILTIN_SKILL_NAMES = ['grilling', 'powershell-windows-cli'] as const;
const BUILTIN_SKILL_FILES: Record<(typeof BUILTIN_SKILL_NAMES)[number], string[]> = {
    grilling: ['SKILL.md', 'agents/openai.yaml'],
    'powershell-windows-cli': [
        'SKILL.md',
        'LICENSE',
        'references/active-directory.md',
        'references/bash-to-powershell.md',
        'references/common-pitfalls.md',
        'references/native-command-execution.md',
        'references/networking.md',
        'references/powershell-vs-cmd.md',
        'references/quoting-and-escaping.md',
        'references/registry.md',
        'references/services-processes.md',
        'references/windows-text-encoding.md',
        'references/wmi-cim.md',
        'scripts/generate_template.py',
        'scripts/validate_ps.py',
    ],
};

interface StoredConnector extends ConnectorRecord {
    secretsBlob: Buffer | null;
    sourceName?: string;
}

interface StoredSkill extends SkillRecord {
    installPath: string;
    relativePath: string;
}

interface StoredPlugin extends PluginRecord {
    installPath: string;
    marketplaceId: string | null;
    marketplacePluginName: string | null;
}

interface StoredMarketplace extends MarketplaceRecord {
    installPath: string;
}

interface PluginSkillDraft {
    relativePath: string;
    name: string;
    description: string;
}

interface PluginConnectorDraft {
    sourceName: string;
    record: Omit<ConnectorRecord, 'id' | 'revision' | 'hasSecrets' | 'pluginId'>;
    secrets: Record<string, string>;
}

interface ParsedPlugin {
    name: string;
    description: string;
    version: string;
    unsupported: string[];
    skills: PluginSkillDraft[];
    connectors: PluginConnectorDraft[];
    mcpConfigPaths: string[];
}

interface SourceReference {
    kind: 'local' | 'git';
    source: string;
    localPath?: string;
    url?: string;
    ref?: string;
}

interface MarketplaceManifest {
    name: string;
    plugins: MarketplacePluginRecord[];
}

class ExtensionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ExtensionError';
    }
}

function fail(message: string): never {
    throw new ExtensionError(message);
}

function databaseError(): ExtensionError {
    return new ExtensionError('扩展数据库数据无效。');
}

function keyError(): ExtensionError {
    return new ExtensionError('系统密钥保护不可用，无法安全保存或读取连接器密钥。');
}

function text(value: unknown, label: string, max: number, allowEmpty = false): string {
    if (typeof value !== 'string' || value.length > max || CONTROL_CHARACTERS.test(value)) {
        fail(`${label}无效。`);
    }
    const result = value.trim();
    if (!allowEmpty && result.length === 0) fail(`${label}不能为空。`);
    return result;
}

function object(value: unknown): Record<string, unknown> | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    return value as Record<string, unknown>;
}

function isWithin(parent: string, candidate: string): boolean {
    const child = relative(parent, candidate);
    return child === '' || (child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function assertContained(parent: string, candidate: string, allowSame = false): string {
    const base = resolve(parent);
    const target = resolve(candidate);
    if ((!allowSame && target === base) || !isWithin(base, target)) fail('扩展路径越界。');
    return target;
}

function assertNoLink(path: string, expected: 'file' | 'directory' | 'any' = 'any'): void {
    let stat;
    try {
        stat = lstatSync(path);
    } catch {
        fail('扩展文件不存在或不可访问。');
    }
    if (stat.isSymbolicLink()) fail('扩展包包含符号链接或目录联接，已拒绝安装。');
    if (expected === 'file' && !stat.isFile()) fail('扩展文件格式无效。');
    if (expected === 'directory' && !stat.isDirectory()) fail('扩展目录格式无效。');
}

function assertRegularFileIfPresent(path: string): void {
    try {
        const stat = lstatSync(path);
        if (stat.isSymbolicLink() || !stat.isFile()) fail('扩展数据库路径不能是链接或特殊文件。');
    } catch (error) {
        if (error instanceof ExtensionError) throw error;
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        fail('扩展数据库路径无法访问。');
    }
}

function safeReadText(path: string, maxBytes: number, label: string): string {
    assertNoLink(path, 'file');
    let bytes: Buffer;
    try {
        const stat = lstatSync(path);
        if (stat.size > maxBytes) fail(`${label}超过大小限制。`);
        bytes = readFileSync(path);
    } catch (error) {
        if (error instanceof ExtensionError) throw error;
        fail(`${label}无法读取。`);
    }
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        fail(`${label}不是有效 UTF-8 文本。`);
    }
}

function assertBuiltinNode(path: string, expected?: 'file' | 'directory'): Stats {
    let stat: Stats;
    try {
        stat = lstatSync(path);
    } catch {
        fail('内置 Skill 内容缺失或不可访问。');
    }
    if (stat.isSymbolicLink()) fail('内置 Skill 内容包含符号链接或目录联接。');
    if (expected === 'file' && !stat.isFile()) fail('内置 Skill 文件格式无效。');
    if (expected === 'directory' && !stat.isDirectory()) fail('内置 Skill 目录格式无效。');
    if (!stat.isFile() && !stat.isDirectory()) fail('内置 Skill 内容包含不支持的文件类型。');
    if (stat.isFile() && stat.nlink > 1) fail('内置 Skill 内容包含硬链接。');
    return stat;
}

function validateBuiltinTree(root: string): string {
    assertBuiltinNode(root, 'directory');
    const canonicalRoot = realpathSync(root);
    let entries = 0;
    let files = 0;
    let bytes = 0;
    const visit = (directory: string): void => {
        const canonicalDirectory = realpathSync(directory);
        if (!isWithin(canonicalRoot, canonicalDirectory)) fail('内置 Skill 路径越界。');
        let names: string[];
        try {
            names = readdirSync(directory);
        } catch {
            fail('内置 Skill 目录无法读取。');
        }
        for (const name of names) {
            const path = join(directory, name);
            const stat = assertBuiltinNode(path);
            entries += 1;
            if (entries > MAX_SOURCE_ENTRIES) fail('内置 Skill 文件数量过多。');
            if (stat.isDirectory()) {
                visit(path);
                continue;
            }
            files += 1;
            if (files > MAX_SOURCE_FILES) fail('内置 Skill 文件数量过多。');
            bytes += stat.size;
            if (bytes > MAX_SOURCE_BYTES) fail('内置 Skill 包超过大小限制。');
            const canonical = realpathSync(path);
            if (!isWithin(canonicalRoot, canonical)) fail('内置 Skill 文件路径越界。');
        }
    };
    visit(root);
    const actualNames = readdirSync(canonicalRoot).sort();
    const expectedNames = [...BUILTIN_SKILL_NAMES].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)) {
        fail('内置 Skill 清单不完整或包含不支持的内容。');
    }
    return canonicalRoot;
}

function assertBuiltinFile(root: string, target: string, maxBytes: number, label: string): string {
    const canonicalRoot = realpathSync(root);
    const absoluteTarget = resolve(target);
    assertContained(canonicalRoot, absoluteTarget);
    const segments = relative(canonicalRoot, absoluteTarget).split(sep).filter(Boolean);
    let current = canonicalRoot;
    assertBuiltinNode(current, 'directory');
    for (let index = 0; index < segments.length; index += 1) {
        current = join(current, segments[index]);
        assertBuiltinNode(current, index === segments.length - 1 ? 'file' : 'directory');
    }
    const stat = assertBuiltinNode(absoluteTarget, 'file');
    if (stat.size > maxBytes) fail(`${label}超过大小限制。`);
    const canonical = realpathSync(absoluteTarget);
    if (!isWithin(canonicalRoot, canonical)) fail('内置 Skill 文件路径越界。');
    return canonical;
}

function safeReadBuiltinText(root: string, target: string, maxBytes: number, label: string): string {
    return safeReadText(assertBuiltinFile(root, target, maxBytes, label), maxBytes, label);
}

function loadBuiltinSkills(directory: string): StoredSkill[] {
    assertBuiltinNode(directory, 'directory');
    const canonicalDirectory = validateBuiltinTree(directory);
    return BUILTIN_SKILL_NAMES.map((name) => {
        const installPath = join(canonicalDirectory, name);
        assertBuiltinNode(installPath, 'directory');
        const canonicalSkillPath = realpathSync(installPath);
        if (!isWithin(canonicalDirectory, canonicalSkillPath) || canonicalSkillPath === canonicalDirectory) {
            fail('内置 Skill 安装路径越界。');
        }
        for (const relativePath of BUILTIN_SKILL_FILES[name]) {
            safeReadBuiltinText(
                canonicalSkillPath,
                resolve(canonicalSkillPath, ...safeRelativeSegments(relativePath)),
                MAX_SKILL_BYTES,
                '内置 Skill 文件',
            );
        }
        const content = safeReadBuiltinText(
            canonicalSkillPath,
            join(canonicalSkillPath, 'SKILL.md'),
            MAX_SKILL_BYTES,
            '内置 Skill 文件',
        );
        const metadata = simpleFrontmatter(content, name, 4096);
        if (metadata.name !== name) fail(`内置 Skill ${name} 的 frontmatter 名称无效。`);
        return {
            id: `builtin:${name}`,
            name: metadata.name,
            description: metadata.description,
            enabled: true,
            source: `builtin:${name}`,
            builtin: true,
            installPath: canonicalSkillPath,
            relativePath: 'SKILL.md',
        };
    });
}

function safeReadJson(path: string, maxBytes: number, label: string): Record<string, unknown> {
    const content = safeReadText(path, maxBytes, label);
    let parsed: unknown;
    try {
        parsed = JSON.parse(content);
    } catch {
        fail(`${label}不是有效 JSON。`);
    }
    const result = object(parsed);
    if (!result) fail(`${label}格式无效。`);
    return result;
}

function scanTree(root: string, options: { omitGit?: boolean } = {}): { files: string[]; bytes: number } {
    assertNoLink(root, 'directory');
    const canonicalRoot = realpathSync(root);
    const files: string[] = [];
    let bytes = 0;
    let entries = 0;
    const visit = (directory: string): void => {
        let names: string[];
        try {
            names = readdirSync(directory);
        } catch {
            fail('扩展目录无法读取。');
        }
        for (const name of names) {
            const path = join(directory, name);
            assertNoLink(path);
            let stat;
            try {
                stat = lstatSync(path);
            } catch {
                fail('扩展目录发生变化，已停止读取。');
            }
            if (options.omitGit && name.toLowerCase() === '.git') continue;
            entries += 1;
            if (entries > MAX_SOURCE_ENTRIES) fail('扩展包文件数量过多。');
            if (stat.isDirectory()) {
                visit(path);
                continue;
            }
            if (!stat.isFile()) fail('扩展包包含不支持的文件类型。');
            if (files.length >= MAX_SOURCE_FILES) fail('扩展包文件数量过多。');
            bytes += stat.size;
            if (bytes > MAX_SOURCE_BYTES) fail('扩展包超过大小限制。');
            const canonical = realpathSync(path);
            if (!isWithin(canonicalRoot, canonical)) fail('扩展路径越界。');
            files.push(path);
        }
    };
    visit(root);
    return { files, bytes };
}

function copyTree(source: string, destination: string): void {
    assertNoLink(source, 'directory');
    scanTree(source, { omitGit: true });
    mkdirSync(destination, { recursive: false });
    const copyDirectory = (from: string, to: string): void => {
        for (const name of readdirSync(from)) {
            const sourcePath = join(from, name);
            assertNoLink(sourcePath);
            if (name.toLowerCase() === '.git') continue;
            const targetPath = join(to, name);
            const stat = lstatSync(sourcePath);
            if (stat.isDirectory()) {
                mkdirSync(targetPath, { recursive: false });
                copyDirectory(sourcePath, targetPath);
            } else if (stat.isFile()) {
                copyFileSync(sourcePath, targetPath);
            } else {
                fail('扩展包包含不支持的文件类型。');
            }
        }
    };
    copyDirectory(source, destination);
    scanTree(destination);
}

function normalizeGitReference(reference: string): string {
    const result = text(reference, 'Git 版本', 200);
    if (result.startsWith('-') || /[\\\s]/.test(result) || result.includes('..')) {
        fail('Git 版本无效。');
    }
    return result;
}

function sourceReference(value: string, allowGithubShorthand = true): SourceReference {
    const source = text(value, '扩展来源', 4096);
    if (allowGithubShorthand) {
        const shorthand = GITHUB_SHORTHAND.exec(source);
        if (shorthand) {
            if (shorthand[1] === '.' || shorthand[1] === '..' || shorthand[2] === '.' || shorthand[2] === '..') {
                fail('GitHub 来源无效。');
            }
            const repository = shorthand[2].replace(/\.git$/i, '');
            return { kind: 'git', source, url: `https://github.com/${shorthand[1]}/${repository}.git` };
        }
    }

    if (/^https:\/\//i.test(source)) {
        const hash = source.indexOf('#');
        const base = hash < 0 ? source : source.slice(0, hash);
        const ref = hash < 0 ? undefined : normalizeGitReference(source.slice(hash + 1));
        let parsed: URL;
        try {
            parsed = new URL(base);
        } catch {
            fail('HTTPS Git 来源无效。');
        }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash || parsed.search) {
            fail('HTTPS Git 来源无效。');
        }
        if (!parsed.hostname || parsed.pathname === '/') fail('HTTPS Git 来源无效。');
        return { kind: 'git', source, url: parsed.toString(), ...(ref === undefined ? {} : { ref }) };
    }
    if (/^[A-Za-z][A-Za-z\d+.-]*:\/\//.test(source) || source.startsWith('git@')) {
        fail('仅支持本地目录或 HTTPS Git 来源。');
    }
    const path = resolve(source);
    assertNoLink(path, 'directory');
    return { kind: 'local', source, localPath: realpathSync(path) };
}

function gitClone(source: SourceReference, destination: string): Promise<void> {
    if (source.kind !== 'git' || !source.url) return Promise.reject(new ExtensionError('Git 来源无效。'));
    const sourceUrl = source.url;
    return new Promise((resolvePromise, rejectPromise) => {
        const args = [
            '-c', 'core.hooksPath=NUL',
            '-c', 'protocol.file.allow=never',
            '-c', 'protocol.ext.allow=never',
            'clone', '--depth', '1', '--single-branch', '--no-tags',
        ];
        if (source.ref) args.push('--branch', source.ref);
        args.push('--', sourceUrl, destination);
        let settled = false;
        const child = spawn('git', args, {
            shell: false,
            windowsHide: true,
            stdio: 'ignore',
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1' },
        });
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill();
            rejectPromise(new ExtensionError('Git 来源下载超时。'));
        }, MAX_CLONE_MS);
        child.once('error', () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            rejectPromise(new ExtensionError('无法读取 HTTPS Git 来源。'));
        });
        child.once('close', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) rejectPromise(new ExtensionError('HTTPS Git 来源下载失败。'));
            else resolvePromise();
        });
    });
}

function supportedMarketplaceSource(value: unknown): string {
    if (typeof value === 'string') {
        const source = text(value, 'Marketplace 插件来源', 4096);
        if (source.startsWith('./')) {
            const normalized = source.replace(/\/+$/, '');
            if (normalized === '.' || normalized.includes('\\') || normalized.split('/').some((part) => part === '..' || part === '')) {
                fail('Marketplace 相对路径无效。');
            }
            return normalized;
        }
        if (/^https:\/\//i.test(source)) return sourceReference(source).source;
        return `unsupported:source-string`;
    }
    const entry = object(value);
    if (!entry || typeof entry.source !== 'string') return 'unsupported:source-object';
    if (entry.source === 'github') {
        if (Object.keys(entry).some((key) => !['source', 'repo', 'ref', 'sha'].includes(key))) return 'unsupported:github-fields';
        const repo = typeof entry.repo === 'string' ? entry.repo : '';
        const shorthand = GITHUB_SHORTHAND.exec(repo);
        if (!shorthand) return 'unsupported:github-repository';
        if (shorthand[1] === '.' || shorthand[1] === '..' || shorthand[2] === '.' || shorthand[2] === '..') return 'unsupported:github-repository';
        let url = `https://github.com/${shorthand[1]}/${shorthand[2].replace(/\.git$/i, '')}.git`;
        if (entry.ref !== undefined) url += `#${normalizeGitReference(String(entry.ref))}`;
        else if (entry.sha !== undefined) url += `#${normalizeGitReference(String(entry.sha))}`;
        return url;
    }
    if (entry.source === 'url') {
        if (Object.keys(entry).some((key) => !['source', 'url', 'ref', 'sha'].includes(key))) return 'unsupported:url-fields';
        if (typeof entry.url !== 'string') return 'unsupported:url-source';
        let url = entry.url;
        if (entry.ref !== undefined) url += `#${normalizeGitReference(String(entry.ref))}`;
        else if (entry.sha !== undefined) url += `#${normalizeGitReference(String(entry.sha))}`;
        try {
            return sourceReference(url, false).source;
        } catch {
            return 'unsupported:url-source';
        }
    }
    return `unsupported:${['git-subdir', 'archive', 'npm', 'command'].includes(entry.source) ? entry.source : 'source-object'}`;
}

function parseMarketplace(root: string): MarketplaceManifest {
    const manifestPath = join(root, '.claude-plugin', 'marketplace.json');
    const manifest = safeReadJson(manifestPath, MAX_MANIFEST_BYTES, 'Marketplace 清单');
    const name = text(manifest.name, 'Marketplace 名称', 200);
    const owner = object(manifest.owner);
    if (!owner || typeof owner.name !== 'string' || !owner.name.trim()) fail('Marketplace 清单缺少有效 owner.name。');
    if (!Array.isArray(manifest.plugins) || manifest.plugins.length > MAX_MARKETPLACE_PLUGINS) {
        fail('Marketplace 插件清单无效或数量过多。');
    }
    const names = new Set<string>();
    const plugins: MarketplacePluginRecord[] = manifest.plugins.map((entryValue) => {
        const entry = object(entryValue);
        if (!entry) fail('Marketplace 插件条目格式无效。');
        const pluginName = text(entry.name, 'Marketplace 插件名称', 200);
        const key = pluginName.toLocaleLowerCase('en-US');
        if (names.has(key)) fail('Marketplace 包含重复插件名称。');
        names.add(key);
        const description = entry.description === undefined ? '' : text(entry.description, 'Marketplace 插件说明', MAX_DESCRIPTION_LENGTH, true);
        return { name: pluginName, description, source: supportedMarketplaceSource(entry.source) };
    });
    return { name, plugins };
}

function simpleFrontmatter(
    content: string,
    directoryName: string,
    maxDescriptionLength = MAX_DESCRIPTION_LENGTH,
): { name: string; description: string } {
    const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
    if (lines[0] !== '---') fail('Skill 缺少有效 YAML frontmatter。');
    const end = lines.indexOf('---', 1);
    if (end < 0) fail('Skill frontmatter 未闭合。');
    const header = lines.slice(1, end);
    let name: string | undefined;
    let description: string | undefined;
    for (let index = 0; index < header.length; index += 1) {
        const line = header[index];
        const field = /^(name|description)\s*:\s*(.*)$/.exec(line);
        if (!field) continue;
        if (field[1] === 'name') {
            name = parseYamlScalar(field[2]);
            continue;
        }
        const raw = field[2].trim();
        if (raw === '|' || raw === '|-' || raw === '>' || raw === '>-') {
            const block: string[] = [];
            for (index += 1; index < header.length && (/^\s+/.test(header[index]) || header[index].trim() === ''); index += 1) {
                block.push(header[index].trim());
            }
            index -= 1;
            description = raw.startsWith('>') ? block.join(' ').trim() : block.join('\n').trim();
        } else {
            description = parseYamlScalar(raw);
        }
    }
    const normalizedName = text(name ?? directoryName, 'Skill 名称', 200);
    const normalizedDescription = text((description ?? '').replace(/\s+/g, ' ').trim(), 'Skill 说明', maxDescriptionLength, true);
    return { name: normalizedName, description: normalizedDescription };
}

function parseYamlScalar(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length >= 2 && ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
        const quote = trimmed[0];
        const inner = trimmed.slice(1, -1);
        if (quote === '"') {
            try {
                const parsed: unknown = JSON.parse(trimmed);
                return typeof parsed === 'string' ? parsed : '';
            } catch {
                return inner;
            }
        }
        return inner.replace(/''/g, "'");
    }
    return trimmed.replace(/\s+#.*$/, '').trim();
}

function safeRelativeSegments(value: string): string[] {
    const normalized = text(value, 'Skill 相对路径', 1024);
    if (isAbsolute(normalized) || /^[A-Za-z]:/.test(normalized) || normalized.startsWith('\\') || normalized.startsWith('/')) {
        fail('Skill 相对路径无效。');
    }
    const segments = normalized.split(/[\\/]/);
    if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
        fail('Skill 相对路径无效。');
    }
    return segments;
}

function hasNonEmptyComponent(value: unknown): boolean {
    if (value === undefined || value === null || value === false || value === '') return false;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
}

function replacePluginRoot(value: unknown, pluginRoot: string): unknown {
    if (typeof value === 'string') {
        const replaced = value.replaceAll('${CLAUDE_PLUGIN_ROOT}', pluginRoot);
        if (replaced.includes('${')) fail('MCP 配置包含不支持的变量占位符。');
        return replaced;
    }
    if (Array.isArray(value)) return value.map((entry) => replacePluginRoot(entry, pluginRoot));
    const record = object(value);
    if (!record) return value;
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, replacePluginRoot(entry, pluginRoot)]));
}

function pluginPath(root: string, componentPath: string): string {
    if (componentPath === '.') return root;
    if (!componentPath.startsWith('./') || componentPath.includes('\\')) fail('插件组件路径无效。');
    const relativePath = componentPath.slice(2).replace(/\/+$/, '');
    const parts = relativePath.split('/');
    if (parts.length === 0 || parts.some((part) => !part || part === '.' || part === '..')) fail('插件组件路径无效。');
    const resolved = resolve(root, ...parts);
    assertContained(root, resolved, true);
    let current = root;
    for (const part of parts) {
        current = join(current, part);
        assertNoLink(current);
    }
    return resolved;
}

function parseSkillDirectory(root: string, skillsRoot: string, relativeRoot: string): PluginSkillDraft[] {
    assertNoLink(skillsRoot, 'directory');
    const directManifest = join(skillsRoot, 'SKILL.md');
    if (existsSync(directManifest)) {
        const content = safeReadText(directManifest, MAX_SKILL_BYTES, 'Skill 文件');
        const relativePath = relativeRoot ? join(relativeRoot, 'SKILL.md') : 'SKILL.md';
        return [{ relativePath, ...simpleFrontmatter(content, basename(skillsRoot)) }];
    }
    const result: PluginSkillDraft[] = [];
    for (const name of readdirSync(skillsRoot)) {
        const directory = join(skillsRoot, name);
        assertNoLink(directory);
        if (!lstatSync(directory).isDirectory()) continue;
        const skillManifest = join(directory, 'SKILL.md');
        if (!existsSync(skillManifest)) continue;
        const content = safeReadText(skillManifest, MAX_SKILL_BYTES, 'Skill 文件');
        const relativePath = relativeRoot ? join(relativeRoot, name, 'SKILL.md') : join(name, 'SKILL.md');
        result.push({ relativePath, ...simpleFrontmatter(content, name) });
        if (result.length > MAX_SKILLS) fail(`插件中的 Skill 数量不能超过 ${MAX_SKILLS} 个。`);
    }
    return result;
}

function connectorSecrets(value: unknown, label: string): Record<string, string> {
    if (value === undefined) return Object.create(null) as Record<string, string>;
    const record = object(value);
    if (!record || Object.keys(record).length > extensionLimits.secretEntries) fail(`${label}格式无效。`);
    const output: Record<string, string> = Object.create(null) as Record<string, string>;
    let totalLength = 0;
    for (const [key, entry] of Object.entries(record)) {
        if (key.length > 256 || typeof entry !== 'string' || entry.length > 64 * 1024 || entry.includes('\u0000') || CONTROL_CHARACTERS.test(key)) fail(`${label}格式无效。`);
        totalLength += Buffer.byteLength(key, 'utf8') + Buffer.byteLength(entry, 'utf8');
        if (totalLength > MAX_SECRET_BYTES) fail(`${label}数据过大。`);
        output[key] = entry;
    }
    return output;
}

function validateHttpUrl(value: string): URL {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        fail('HTTP MCP 地址无效。');
    }
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.username || url.password || url.hash) {
        fail('HTTP MCP 地址无效。');
    }
    const host = url.hostname.toLowerCase();
    const loopback = host === 'localhost' || host === '::1' || host === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(host);
    if (url.protocol === 'http:' && !loopback) fail('非 loopback HTTP MCP 必须使用 HTTPS。');
    return url;
}

function validateHeaderSecrets(headers: Record<string, string>): void {
    const forbidden = new Set(['host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'proxy-authorization', 'proxy-connection']);
    for (const [key, value] of Object.entries(headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || forbidden.has(key.toLowerCase()) || /[\u0000-\u001f\u007f]/.test(value)) {
            fail('HTTP MCP 请求头无效或包含禁止字段。');
        }
    }
}

function validateConnectorTarget(draft: Pick<ConnectorDraft, 'transport' | 'command' | 'args' | 'url' | 'secrets'>): { target: string; secrets: Record<string, string> } {
    const secrets = draft.secrets ?? Object.create(null) as Record<string, string>;
    if (draft.transport === 'stdio') {
        const command = text(draft.command, 'stdio MCP 命令', 8192);
        if (draft.url !== '') fail('stdio MCP 不能设置 HTTP 地址。');
        if (/\.(?:cmd|bat)$/i.test(command)) fail('MCP 命令不能使用 .cmd 或 .bat 脚本；请改用 node.exe 等可执行程序并把脚本路径放入参数。');
        if (isAbsolute(command)) {
            // Absolute executable or script paths are passed directly with shell:false.
        } else if (/[\\/\s]/.test(command) || !/^[A-Za-z0-9_.+-]+$/.test(command)) {
            fail('stdio MCP 命令必须是绝对路径或单个可执行命令名。');
        }
        for (const key of Object.keys(secrets)) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) fail('stdio MCP 环境变量名称无效。');
        }
        return { target: JSON.stringify([draft.transport, command, draft.args]), secrets };
    }

    if (draft.command !== '' || draft.args.length > 0) fail('HTTP MCP 不能设置 stdio 命令或参数。');
    const url = validateHttpUrl(draft.url);
    validateHeaderSecrets(secrets);
    return { target: JSON.stringify([draft.transport, url.toString()]), secrets };
}

function connectorFromPlugin(
    pluginName: string,
    serverName: string,
    rawConfig: unknown,
    pluginRoot: string,
): PluginConnectorDraft {
    const replaced = object(replacePluginRoot(rawConfig, pluginRoot));
    if (!replaced) fail('MCP 服务器配置格式无效。');
    const type = typeof replaced.type === 'string' ? replaced.type.toLowerCase() : '';
    const declaredTransport = typeof replaced.transport === 'string' ? replaced.transport.toLowerCase() : '';
    if (type && !['http', 'streamable-http', 'stdio'].includes(type)) fail('MCP 传输类型暂不支持。');
    if (declaredTransport && declaredTransport !== 'http' && declaredTransport !== 'stdio') fail('MCP 传输类型暂不支持。');
    const isHttp = type === 'http' || type === 'streamable-http' || (typeof replaced.url === 'string' && typeof replaced.command !== 'string');
    const transport = isHttp ? 'http' : 'stdio';
    if (declaredTransport && declaredTransport !== transport) fail('MCP 传输类型配置不一致。');
    const unknownKeys = Object.keys(replaced).filter((key) => !['type', 'transport', 'command', 'args', 'env', 'url', 'headers', 'cwd'].includes(key));
    if (unknownKeys.length > 0) fail('MCP 服务器配置包含不支持的字段。');
    if (replaced.cwd !== undefined) fail('MCP cwd 配置暂不支持。');
    if (isHttp && (replaced.command !== undefined || replaced.args !== undefined || replaced.env !== undefined)) fail('HTTP MCP 不能设置 stdio 字段。');
    if (!isHttp && (replaced.url !== undefined || replaced.headers !== undefined)) fail('stdio MCP 不能设置 HTTP 字段。');

    const secrets = connectorSecrets(isHttp ? replaced.headers : replaced.env, isHttp ? 'HTTP 请求头' : 'stdio 环境变量');
    const draft: ConnectorDraft = {
        id: null,
        name: text(`${pluginName}:${serverName}`, '连接器名称', 200),
        transport,
        command: isHttp ? '' : text(replaced.command, 'stdio MCP 命令', 8192),
        args: isHttp ? [] : (replaced.args === undefined ? [] : replaced.args as string[]),
        url: isHttp ? text(replaced.url, 'HTTP MCP 地址', 8192) : '',
        enabled: false,
        revision: 0,
        secrets,
    };
    if (!Array.isArray(draft.args) || draft.args.length > extensionLimits.connectorArgs || draft.args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || CONTROL_CHARACTERS.test(arg))) {
        fail('MCP 参数无效。');
    }
    validateConnectorTarget(draft);
    return {
        sourceName: serverName,
        record: {
            name: draft.name,
            transport,
            command: draft.command,
            args: draft.args,
            url: draft.url,
            enabled: false,
        },
        secrets,
    };
}

function parseMcpConfig(value: unknown): Record<string, unknown> {
    const root = object(value);
    if (!root) fail('MCP 配置格式无效。');
    const servers = object(root.mcpServers);
    if (servers) {
        if (Object.keys(servers).length > MAX_CONNECTORS) fail('MCP 服务器数量过多。');
        return servers;
    }
    if (Object.keys(root).every((key) => key !== 'mcpServers')) {
        if (Object.keys(root).length > MAX_CONNECTORS) fail('MCP 服务器数量过多。');
        return root;
    }
    fail('MCP 配置缺少 mcpServers 对象。');
}

function scrubMcpSecretFields(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(scrubMcpSecretFields);
    const record = object(value);
    if (!record) return value;
    const cleaned = Object.create(null) as Record<string, unknown>;
    for (const [key, entry] of Object.entries(record)) {
        if (key === 'env' || key === 'headers') continue;
        cleaned[key] = scrubMcpSecretFields(entry);
    }
    return cleaned;
}

function scrubMcpConfiguration(value: unknown): Record<string, unknown> {
    const root = object(value);
    if (!root) fail('插件 MCP 配置格式无效。');
    const servers = object(root.mcpServers);
    if (!servers) return scrubMcpSecretFields(root) as Record<string, unknown>;
    return { ...root, mcpServers: scrubMcpSecretFields(servers) as Record<string, unknown> };
}

function scrubManifestMcpServers(value: unknown): unknown {
    if (Array.isArray(value)) {
        return value.map((entry) => typeof entry === 'string' ? entry : scrubMcpSecretFields(entry));
    }
    return scrubMcpSecretFields(value);
}

function scrubStoredMcpSecrets(root: string, parsed: ParsedPlugin): void {
    const manifestPath = join(root, '.claude-plugin', 'plugin.json');
    if (existsSync(manifestPath)) {
        const manifest = safeReadJson(manifestPath, MAX_MANIFEST_BYTES, '插件清单');
        if (manifest.mcpServers !== undefined) {
            manifest.mcpServers = scrubManifestMcpServers(manifest.mcpServers);
            writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        }
    }

    for (const relativePath of parsed.mcpConfigPaths) {
        const componentPath = `./${relativePath.replaceAll('\\', '/')}`;
        const configPath = pluginPath(root, componentPath);
        const config = safeReadJson(configPath, MAX_MANIFEST_BYTES, '插件 MCP 配置');
        writeFileSync(configPath, `${JSON.stringify(scrubMcpConfiguration(config), null, 2)}\n`, 'utf8');
    }
}

function parsePlugin(root: string, pluginRoot = root, fallbackName = basename(root)): ParsedPlugin {
    scanTree(root);
    const manifestPath = join(root, '.claude-plugin', 'plugin.json');
    const manifest = existsSync(manifestPath) ? safeReadJson(manifestPath, MAX_MANIFEST_BYTES, '插件清单') : {};
    const manifestName = manifest.name === undefined ? text(fallbackName, '插件名称', 200) : text(manifest.name, '插件名称', 200);
    if (/[\\/:@]/.test(manifestName)) fail('插件名称无效。');
    const displayName = manifest.displayName === undefined ? manifestName : text(manifest.displayName, '插件显示名称', 200);
    const name = displayName || manifestName;
    const description = manifest.description === undefined ? '' : text(manifest.description, '插件说明', MAX_DESCRIPTION_LENGTH, true);
    const version = manifest.version === undefined ? '' : text(manifest.version, '插件版本', 200, true);
    const unsupported = new Set<string>();
    const addUnsupported = (component: string): void => { unsupported.add(`暂不支持组件：${component}`); };
    const supportedManifestKeys = new Set([
        '$schema', 'name', 'displayName', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords',
        'defaultEnabled', 'metadata', 'icon', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl',
        'skills', 'mcpServers', 'commands', 'agents', 'hooks', 'lspServers', 'outputStyles', 'workflows', 'experimental',
        'settings', 'dependencies', 'types', 'channels', 'userConfig',
    ]);
    for (const key of Object.keys(manifest)) {
        if (!supportedManifestKeys.has(key)) addUnsupported('manifest 中的其他字段');
    }
    for (const key of ['commands', 'agents', 'hooks', 'lspServers', 'outputStyles', 'workflows', 'settings', 'dependencies', 'types', 'channels', 'userConfig']) {
        if (hasNonEmptyComponent(manifest[key])) addUnsupported(key);
    }
    const experimental = object(manifest.experimental);
    if (experimental) {
        if (Object.keys(experimental).length > 0) addUnsupported('experimental');
    } else if (manifest.experimental !== undefined && hasNonEmptyComponent(manifest.experimental)) {
        addUnsupported('experimental');
    }

    for (const [componentPath, label] of [
        ['commands', 'commands'], ['agents', 'agents'], ['hooks', 'hooks'], ['lsp', 'lspServers'],
        ['output-styles', 'outputStyles'], ['workflows', 'workflows'], ['themes', 'themes'], ['monitors', 'monitors'],
    ]) {
        const path = join(root, componentPath);
        if (existsSync(path)) addUnsupported(label);
    }
    for (const file of ['.lsp.json', 'hooks/hooks.json', 'monitors/monitors.json']) {
        const path = join(root, file);
        if (existsSync(path)) addUnsupported(file);
    }

    const skillRoots = new Set<string>();
    const defaultSkills = join(root, 'skills');
    if (existsSync(defaultSkills)) skillRoots.add('skills');
    if (manifest.skills !== undefined) {
        const configured = typeof manifest.skills === 'string' ? [manifest.skills] : manifest.skills;
        if (!Array.isArray(configured) || configured.length > 32 || configured.some((path) => typeof path !== 'string')) {
            addUnsupported('skills');
        } else {
            for (const configuredPath of configured as string[]) {
                try {
                    const resolved = pluginPath(root, configuredPath);
                    const relativePath = relative(root, resolved);
                    if (relativePath === '') {
                        if (existsSync(join(root, 'SKILL.md')) || existsSync(join(root, 'skills'))) skillRoots.add('');
                        else addUnsupported('skills 自定义路径');
                    } else if (existsSync(resolved)) {
                        assertNoLink(resolved, 'directory');
                        skillRoots.add(relativePath);
                    } else {
                        addUnsupported('skills 自定义路径');
                    }
                } catch {
                    addUnsupported('skills');
                }
            }
        }
    }

    const skills: PluginSkillDraft[] = [];
    for (const relativeRoot of skillRoots) {
        const resolved = relativeRoot ? join(root, relativeRoot) : root;
        if (!existsSync(resolved)) continue;
        assertNoLink(resolved, 'directory');
        skills.push(...parseSkillDirectory(root, resolved, relativeRoot));
        if (skills.length > MAX_SKILLS) fail(`插件中的 Skill 数量不能超过 ${MAX_SKILLS} 个。`);
    }
    const skillNames = new Set<string>();
    for (const skill of skills) {
        const key = skill.name.toLocaleLowerCase('en-US');
        if (skillNames.has(key)) fail('插件包含重复 Skill 名称。');
        skillNames.add(key);
    }

    const mcpByName = new Map<string, unknown>();
    const mcpConfigPaths = new Set<string>();
    const defaultMcp = join(root, '.mcp.json');
    if (existsSync(defaultMcp)) {
        const file = safeReadJson(defaultMcp, MAX_MANIFEST_BYTES, '插件 MCP 配置');
        for (const [key, value] of Object.entries(parseMcpConfig(file))) mcpByName.set(key, value);
        mcpConfigPaths.add('.mcp.json');
    }
    if (manifest.mcpServers !== undefined) {
        const sources = Array.isArray(manifest.mcpServers) ? manifest.mcpServers : [manifest.mcpServers];
        for (const source of sources) {
            if (typeof source === 'string') {
                try {
                    const configPath = pluginPath(root, source);
                    const file = safeReadJson(configPath, MAX_MANIFEST_BYTES, '插件 MCP 配置');
                    for (const [key, value] of Object.entries(parseMcpConfig(file))) mcpByName.set(key, value);
                    mcpConfigPaths.add(relative(root, configPath));
                } catch {
                    addUnsupported('mcpServers JSON 路径');
                }
                continue;
            }
            const inline = object(source);
            if (!inline) {
                addUnsupported('mcpServers');
                continue;
            }
            for (const [key, value] of Object.entries(inline)) mcpByName.set(key, value);
        }
    }

    const connectors: PluginConnectorDraft[] = [];
    for (const [serverName, config] of mcpByName) {
        try {
            const parsed = connectorFromPlugin(name, text(serverName, 'MCP 服务器名称', 200), config, pluginRoot);
            connectors.push(parsed);
        } catch (error) {
            if (error instanceof ExtensionError) {
                addUnsupported('MCP 服务器项包含无效或不支持的配置');
            } else {
                addUnsupported('MCP 服务器项配置无效');
            }
        }
    }
    if (connectors.length > MAX_CONNECTORS) fail('插件 MCP 连接器数量过多。');

    if (skills.length === 0 && connectors.length === 0) {
        // Keep a structurally valid package visible, but make the missing capabilities actionable.
        addUnsupported('未发现受支持的 skills 或 MCP servers');
    }
    return { name, description, version, unsupported: [...unsupported], skills, connectors, mcpConfigPaths: [...mcpConfigPaths] };
}

function sameConnectorTarget(
    left: StoredConnector,
    right: PluginConnectorDraft,
    previousPluginRoot?: string,
    nextPluginRoot?: string,
    previousSecretNames: string[] = [],
): boolean {
    const normalizePrevious = (value: string): string => previousPluginRoot
        ? value.replaceAll(previousPluginRoot, '${CLAUDE_PLUGIN_ROOT}')
        : value;
    const normalizeNext = (value: string): string => nextPluginRoot
        ? value.replaceAll(nextPluginRoot, '${CLAUDE_PLUGIN_ROOT}')
        : value;
    return left.transport === right.record.transport
        && normalizePrevious(left.command) === normalizeNext(right.record.command)
        && JSON.stringify(left.args.map(normalizePrevious)) === JSON.stringify(right.record.args.map(normalizeNext))
        && normalizePrevious(left.url) === normalizeNext(right.record.url)
        && JSON.stringify([...previousSecretNames].sort()) === JSON.stringify(Object.keys(right.secrets).sort());
}

export class ExtensionStore {
    private readonly database: DatabaseSync;
    private readonly extensionDirectory: string;
    private readonly pluginDirectory: string;
    private readonly skillDirectory: string;
    private readonly marketplaceDirectory: string;
    private readonly builtinSkills = new Map<string, StoredSkill>();
    private closed = false;

    constructor(dataDirectory: string, private readonly cipher: EndpointCipher, builtinSkillsDirectory?: string) {
        const directory = resolve(dataDirectory);
        mkdirSync(directory, { recursive: true });
        this.extensionDirectory = resolve(directory, 'extensions');
        mkdirSync(this.extensionDirectory, { recursive: true });
        assertNoLink(this.extensionDirectory, 'directory');
        this.pluginDirectory = join(this.extensionDirectory, 'plugins');
        this.skillDirectory = join(this.extensionDirectory, 'skills');
        this.marketplaceDirectory = join(this.extensionDirectory, 'marketplaces');
        mkdirSync(this.pluginDirectory, { recursive: true });
        mkdirSync(this.skillDirectory, { recursive: true });
        mkdirSync(this.marketplaceDirectory, { recursive: true });
        for (const controlledDirectory of [this.pluginDirectory, this.skillDirectory, this.marketplaceDirectory]) {
            assertNoLink(controlledDirectory, 'directory');
        }
        if (builtinSkillsDirectory !== undefined) {
            for (const skill of loadBuiltinSkills(resolve(builtinSkillsDirectory))) {
                this.builtinSkills.set(skill.id, skill);
            }
        }
        const databasePath = resolve(directory, 'extensions.sqlite');
        assertRegularFileIfPresent(databasePath);
        assertRegularFileIfPresent(`${databasePath}-wal`);
        assertRegularFileIfPresent(`${databasePath}-shm`);
        this.database = new DatabaseSync(databasePath);
        this.database.exec('PRAGMA foreign_keys = ON;');
        this.database.exec('PRAGMA journal_mode = WAL;');
        this.database.exec('PRAGMA synchronous = FULL;');
        this.initializeSchema();
        this.initializeBuiltinSkillSettings();
    }

    list(): ExtensionSnapshot {
        this.assertOpen();
        return {
            connectors: this.readConnectors().map(({ secretsBlob: _secretsBlob, sourceName: _sourceName, ...record }) => record),
            skills: [...this.readBuiltinSkills(), ...this.readSkills()].map(({ installPath: _installPath, relativePath: _relativePath, ...record }) => record),
            plugins: this.readPlugins().map(({ installPath: _installPath, marketplaceId: _marketplaceId, marketplacePluginName: _marketplacePluginName, ...record }) => record),
            marketplaces: this.readMarketplaces().map(({ installPath: _installPath, ...record }) => record),
        };
    }

    async execute(value: ExtensionCommand | unknown): Promise<ExtensionSnapshot> {
        this.assertOpen();
        validateExtensionCommandSize(value);
        const command = parseExtensionCommand(value);
        try {
            switch (command.type) {
                case 'list': return this.list();
                case 'save-connector': this.saveConnector(command.draft); break;
                case 'delete-connector': this.deleteConnector(command.id, command.revision); break;
                case 'install-skill': await this.installSkill(command.source); break;
                case 'set-skill-enabled': this.setSkillEnabled(command.id, command.enabled); break;
                case 'remove-skill': this.removeSkill(command.id); break;
                case 'install-plugin': await this.installPlugin(command.source); break;
                case 'set-plugin-enabled': this.setEnabled('plugins', command.id, command.enabled); break;
                case 'remove-plugin': this.removePlugin(command.id); break;
                case 'add-marketplace': await this.addMarketplace(command.source); break;
                case 'remove-marketplace': this.removeMarketplace(command.id); break;
                case 'install-marketplace-plugin': await this.installMarketplacePlugin(command.marketplaceId, command.name); break;
                case 'update-plugin': await this.updatePlugin(command.id); break;
            }
            return this.list();
        } catch (error) {
            if (error instanceof ExtensionError) throw error;
            throw new ExtensionError('扩展操作失败。');
        }
    }

    resolveConnectors(): ResolvedConnector[] {
        this.assertOpen();
        const query = this.database.prepare(
            `SELECT c.id, c.name, c.transport, c.command, c.args_json, c.url, c.enabled, c.revision,
                    c.has_secrets, c.secrets_blob, c.plugin_id, c.source_name
             FROM connectors c LEFT JOIN plugins p ON p.id = c.plugin_id
             WHERE c.enabled = 1 AND (c.plugin_id IS NULL OR p.enabled = 1)
             ORDER BY c.rowid ASC`,
        );
        const rows = query.all() as Array<Record<string, unknown>>;
        return rows.map((row) => {
            const record = this.parseConnectorRow(row);
            const resolvedSecrets = this.decryptSecrets(record.secretsBlob);
            try {
                validateConnectorTarget({ ...record, secrets: resolvedSecrets });
            } catch {
                throw databaseError();
            }
            return { ...this.publicConnector(record), secrets: resolvedSecrets };
        });
    }

    readSkill(id: string, relativePath = 'SKILL.md'): { name: string; content: string; source: string } {
        this.assertOpen();
        const skill = this.getSkill(id);
        if (!skill.enabled || (skill.pluginId && !this.pluginEnabled(skill.pluginId))) {
            fail('Skill 未启用或所属插件已停用。');
        }
        const content = this.readSkillFile(skill, relativePath);
        return { name: skill.name, content, source: skill.source };
    }

    skillCatalogForRuntime(): Array<SkillRecord & { path: string }> {
        this.assertOpen();
        const skills = [...this.readBuiltinSkills(), ...this.readSkills()];
        const result: Array<SkillRecord & { path: string }> = [];
        for (const skill of skills) {
            if (!skill.enabled || (skill.pluginId && !this.pluginEnabled(skill.pluginId))) continue;
            const skillManifestPath = this.readSkillManifestPath(skill);
            const { installPath: _installPath, relativePath: _relativePath, ...record } = skill;
            result.push({ ...record, path: skillManifestPath });
        }
        return result;
    }

    close(): void {
        if (this.closed) return;
        this.database.close();
        this.closed = true;
    }

    private initializeSchema(): void {
        const row = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
        const version = Number(row.user_version);
        if (!Number.isSafeInteger(version) || version < 0 || version > DB_VERSION) fail('扩展数据库版本不受支持。');
        if (version === DB_VERSION) return;
        this.database.exec('BEGIN EXCLUSIVE;');
        try {
            this.database.exec(`
                CREATE TABLE connectors (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    transport TEXT NOT NULL CHECK (transport IN ('stdio', 'http')),
                    command TEXT NOT NULL,
                    args_json TEXT NOT NULL,
                    url TEXT NOT NULL,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                    revision INTEGER NOT NULL CHECK (revision >= 0),
                    has_secrets INTEGER NOT NULL CHECK (has_secrets IN (0, 1)),
                    secrets_blob BLOB,
                    plugin_id TEXT REFERENCES plugins(id) ON DELETE CASCADE,
                    source_name TEXT,
                    UNIQUE(plugin_id, source_name)
                );
                CREATE TABLE plugins (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    description TEXT NOT NULL,
                    version TEXT NOT NULL,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                    source TEXT NOT NULL,
                    install_path TEXT NOT NULL,
                    unsupported_json TEXT NOT NULL,
                    marketplace_id TEXT REFERENCES marketplaces(id) ON DELETE CASCADE,
                    marketplace_plugin_name TEXT
                );
                CREATE TABLE skills (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    description TEXT NOT NULL,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
                    plugin_id TEXT REFERENCES plugins(id) ON DELETE CASCADE,
                    source TEXT NOT NULL,
                    install_path TEXT NOT NULL,
                    relative_path TEXT NOT NULL
                );
                CREATE TABLE marketplaces (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL COLLATE NOCASE UNIQUE,
                    source TEXT NOT NULL,
                    plugins_json TEXT NOT NULL,
                    install_path TEXT NOT NULL
                );
                CREATE INDEX connectors_plugin_id_idx ON connectors(plugin_id);
                CREATE INDEX skills_plugin_id_idx ON skills(plugin_id);
                PRAGMA user_version = ${DB_VERSION};
            `);
            this.database.exec('COMMIT;');
        } catch {
            try { this.database.exec('ROLLBACK;'); } catch { /* Preserve schema failure. */ }
            fail('无法初始化扩展数据库。');
        }
    }

    private initializeBuiltinSkillSettings(): void {
        try {
            this.database.exec(`
                CREATE TABLE IF NOT EXISTS builtin_skill_settings (
                    id TEXT PRIMARY KEY,
                    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1))
                );
            `);
        } catch {
            fail('无法初始化内置 Skill 设置。');
        }
    }

    private transaction<T>(operation: () => T): T {
        this.database.exec('BEGIN IMMEDIATE;');
        try {
            const result = operation();
            this.database.exec('COMMIT;');
            return result;
        } catch (error) {
            try { this.database.exec('ROLLBACK;'); } catch { /* Preserve the original error. */ }
            throw error;
        }
    }

    private readConnectors(): StoredConnector[] {
        const rows = this.database.prepare(
            'SELECT id, name, transport, command, args_json, url, enabled, revision, has_secrets, secrets_blob, plugin_id, source_name FROM connectors ORDER BY rowid ASC',
        ).all() as Array<Record<string, unknown>>;
        if (rows.length > MAX_CONNECTORS) throw databaseError();
        return rows.map((row) => this.parseConnectorRow(row));
    }

    private parseConnectorRow(row: Record<string, unknown>): StoredConnector {
        try {
            if (typeof row.args_json !== 'string' || (row.transport !== 'stdio' && row.transport !== 'http')
                || (row.enabled !== 0 && row.enabled !== 1) || (row.has_secrets !== 0 && row.has_secrets !== 1)
                || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0) throw databaseError();
            const args: unknown = JSON.parse(row.args_json);
            if (!Array.isArray(args) || args.length > extensionLimits.connectorArgs
                || args.some((arg) => typeof arg !== 'string' || arg.length > 8192 || CONTROL_CHARACTERS.test(arg))) throw databaseError();
            const secretsBlob = row.secrets_blob === null ? null : this.asBuffer(row.secrets_blob);
            if (secretsBlob && secretsBlob.length > MAX_SECRET_BYTES + 4096) throw databaseError();
            if ((row.has_secrets === 1) !== (secretsBlob !== null)) throw databaseError();
            const result: StoredConnector = {
                id: text(row.id, '连接器标识', 200),
                name: text(row.name, '连接器名称', 200),
                transport: row.transport,
                command: text(row.command, '连接器命令', 8192, true),
                args: args as string[],
                url: text(row.url, '连接器地址', 8192, true),
                enabled: row.enabled === 1,
                revision: Number(row.revision),
                hasSecrets: row.has_secrets === 1,
                secretsBlob,
            };
            validateConnectorTarget({ ...result, secrets: {} });
            if (row.plugin_id !== null && row.plugin_id !== undefined) result.pluginId = text(row.plugin_id, '插件标识', 200);
            if (row.source_name !== null && row.source_name !== undefined) result.sourceName = text(row.source_name, 'MCP 名称', 200);
            return result;
        } catch {
            throw databaseError();
        }
    }

    private readSkills(): StoredSkill[] {
        const rows = this.database.prepare(
            'SELECT id, name, description, enabled, plugin_id, source, install_path, relative_path FROM skills ORDER BY rowid ASC',
        ).all() as Array<Record<string, unknown>>;
        if (rows.length > MAX_SKILLS) throw databaseError();
        return rows.map((row) => {
            try {
                if (row.enabled !== 0 && row.enabled !== 1) throw databaseError();
                const skillId = text(row.id, 'Skill 标识', 200);
                if (skillId.startsWith('builtin:')) throw databaseError();
                const result: StoredSkill = {
                    id: skillId,
                    name: text(row.name, 'Skill 名称', 200),
                    description: text(row.description, 'Skill 说明', MAX_DESCRIPTION_LENGTH, true),
                    enabled: row.enabled === 1,
                    source: text(row.source, 'Skill 来源', 4096),
                    installPath: text(row.install_path, 'Skill 安装路径', 8192),
                    relativePath: text(row.relative_path, 'Skill 相对路径', 1024),
                };
                if (row.plugin_id !== null && row.plugin_id !== undefined) result.pluginId = text(row.plugin_id, '插件标识', 200);
                return result;
            } catch {
                throw databaseError();
            }
        });
    }

    private readBuiltinSkills(): StoredSkill[] {
        return [...this.builtinSkills.values()].map((skill) => {
            const row = this.database.prepare(
                'SELECT enabled FROM builtin_skill_settings WHERE id = ?',
            ).get(skill.id) as { enabled: number } | undefined;
            if (row && row.enabled !== 0 && row.enabled !== 1) throw databaseError();
            return { ...skill, enabled: row ? row.enabled === 1 : true };
        });
    }

    private readPlugins(): StoredPlugin[] {
        const rows = this.database.prepare(
            'SELECT id, name, description, version, enabled, source, install_path, unsupported_json, marketplace_id, marketplace_plugin_name FROM plugins ORDER BY rowid ASC',
        ).all() as Array<Record<string, unknown>>;
        if (rows.length > MAX_PLUGINS) throw databaseError();
        return rows.map((row) => {
            try {
                if ((row.enabled !== 0 && row.enabled !== 1) || typeof row.unsupported_json !== 'string') throw databaseError();
                const unsupported: unknown = JSON.parse(row.unsupported_json);
                if (!Array.isArray(unsupported) || unsupported.length > 256 || unsupported.some((item) => typeof item !== 'string')) throw databaseError();
                return {
                    id: text(row.id, '插件标识', 200),
                    name: text(row.name, '插件名称', 200),
                    description: text(row.description, '插件说明', MAX_DESCRIPTION_LENGTH, true),
                    version: text(row.version, '插件版本', 200, true),
                    enabled: row.enabled === 1,
                    source: text(row.source, '插件来源', 4096),
                    unsupported,
                    installPath: text(row.install_path, '插件安装路径', 8192),
                    marketplaceId: row.marketplace_id === null ? null : text(row.marketplace_id, 'Marketplace 标识', 200),
                    marketplacePluginName: row.marketplace_plugin_name === null ? null : text(row.marketplace_plugin_name, 'Marketplace 插件名称', 200),
                };
            } catch {
                throw databaseError();
            }
        });
    }

    private readMarketplaces(): StoredMarketplace[] {
        const rows = this.database.prepare(
            'SELECT id, name, source, plugins_json, install_path FROM marketplaces ORDER BY rowid ASC',
        ).all() as Array<Record<string, unknown>>;
        if (rows.length > MAX_MARKETPLACES) throw databaseError();
        return rows.map((row) => {
            try {
                if (typeof row.plugins_json !== 'string') throw databaseError();
                const plugins: unknown = JSON.parse(row.plugins_json);
                if (!Array.isArray(plugins) || plugins.length > MAX_MARKETPLACE_PLUGINS) throw databaseError();
                return {
                    id: text(row.id, 'Marketplace 标识', 200),
                    name: text(row.name, 'Marketplace 名称', 200),
                    source: text(row.source, 'Marketplace 来源', 4096),
                    plugins: plugins.map((entry) => {
                        const record = object(entry);
                        if (!record) throw databaseError();
                        return {
                            name: text(record.name, 'Marketplace 插件名称', 200),
                            description: text(record.description, 'Marketplace 插件说明', MAX_DESCRIPTION_LENGTH, true),
                            source: text(record.source, 'Marketplace 插件来源', 4096),
                        };
                    }),
                    installPath: text(row.install_path, 'Marketplace 安装路径', 8192),
                };
            } catch {
                throw databaseError();
            }
        });
    }

    private asBuffer(value: unknown): Buffer {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) return Buffer.from(value);
        throw databaseError();
    }

    private publicConnector(connector: StoredConnector): ConnectorRecord {
        const { secretsBlob: _secretsBlob, sourceName: _sourceName, ...record } = connector;
        return record;
    }

    private decryptSecrets(blob: Buffer | null): Record<string, string> {
        if (blob === null) return {};
        if (!this.cipher.isEncryptionAvailable()) throw keyError();
        try {
            const parsed: unknown = JSON.parse(this.cipher.decryptString(blob));
            const record = object(parsed);
            if (!record || Object.keys(record).length > extensionLimits.secretEntries
                || Object.values(record).some((value) => typeof value !== 'string')) throw databaseError();
            const totalLength = Object.entries(record).reduce((total, [key, value]) => total + Buffer.byteLength(key, 'utf8') + Buffer.byteLength(value as string, 'utf8'), 0);
            if (totalLength > MAX_SECRET_BYTES) throw databaseError();
            return Object.fromEntries(Object.entries(record)) as Record<string, string>;
        } catch (error) {
            if (error instanceof ExtensionError) throw error;
            throw keyError();
        }
    }

    private encryptSecrets(secrets: Record<string, string>): Buffer | null {
        if (Object.keys(secrets).length === 0) return null;
        if (!this.cipher.isEncryptionAvailable()) throw keyError();
        try {
            return Buffer.from(this.cipher.encryptString(JSON.stringify(secrets)));
        } catch {
            throw keyError();
        }
    }

    private saveConnector(draft: ConnectorDraft): void {
        const target = validateConnectorTarget(draft);
        if (draft.id === null) {
            if (draft.revision !== 0) fail('新连接器版本必须为 0。');
            if (draft.pluginId !== undefined) fail('不能从连接器编辑器创建插件连接器。');
            const count = this.database.prepare('SELECT COUNT(*) AS count FROM connectors').get() as { count: number };
            if (Number(count.count) >= MAX_CONNECTORS) fail(`连接器数量不能超过 ${MAX_CONNECTORS} 个。`);
            const secretsBlob = this.encryptSecrets(target.secrets);
            this.transaction(() => {
                this.database.prepare(
                    `INSERT INTO connectors (id, name, transport, command, args_json, url, enabled, revision, has_secrets, secrets_blob, plugin_id, source_name)
                     VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, NULL, NULL)`,
                ).run(randomUUID(), draft.name, draft.transport, draft.command, JSON.stringify(draft.args), draft.url,
                    draft.enabled ? 1 : 0, secretsBlob === null ? 0 : 1, secretsBlob);
            });
            return;
        }

        const existing = this.readConnector(draft.id);
        if (!existing) fail('连接器不存在。');
        if (existing.revision !== draft.revision) fail('连接器已被其他操作修改。');
        if (draft.pluginId !== undefined && draft.pluginId !== existing.pluginId) fail('连接器所属插件不能修改。');
        const sameTarget = JSON.stringify([existing.transport, existing.command, existing.args, existing.url])
            === JSON.stringify([draft.transport, draft.command, draft.args, draft.url]);
        if (draft.secrets === null && !sameTarget) fail('修改连接器目标时必须显式替换或清除密钥。');
        const secretsBlob = draft.secrets === null ? existing.secretsBlob : this.encryptSecrets(target.secrets);
        this.transaction(() => {
            const result = this.database.prepare(
                `UPDATE connectors SET name = ?, transport = ?, command = ?, args_json = ?, url = ?, enabled = ?,
                 revision = ?, has_secrets = ?, secrets_blob = ? WHERE id = ? AND revision = ?`,
            ).run(draft.name, draft.transport, draft.command, JSON.stringify(draft.args), draft.url, draft.enabled ? 1 : 0,
                existing.revision + 1, secretsBlob === null ? 0 : 1, secretsBlob, existing.id, existing.revision);
            if (result.changes !== 1) fail('连接器已被其他操作修改。');
        });
    }

    private readConnector(id: string): StoredConnector | null {
        const row = this.database.prepare(
            'SELECT id, name, transport, command, args_json, url, enabled, revision, has_secrets, secrets_blob, plugin_id, source_name FROM connectors WHERE id = ?',
        ).get(id) as Record<string, unknown> | undefined;
        return row ? this.parseConnectorRow(row) : null;
    }

    private deleteConnector(id: string, revision: number): void {
        const existing = this.readConnector(id);
        if (!existing) fail('连接器不存在。');
        if (existing.revision !== revision) fail('连接器已被其他操作修改。');
        const result = this.database.prepare('DELETE FROM connectors WHERE id = ? AND revision = ?').run(id, revision);
        if (result.changes !== 1) fail('连接器已被其他操作修改。');
    }

    private async installSkill(sourceValue: string): Promise<void> {
        const source = sourceReference(sourceValue, false);
        if (source.kind !== 'local' || !source.localPath) fail('独立 Skill 目前只支持本地目录。');
        if (existsSync(join(source.localPath, '.git'))) {
            // Git metadata is ignored when copied; the skill itself remains local content.
        }
        const manifest = join(source.localPath, 'SKILL.md');
        const content = safeReadText(manifest, MAX_SKILL_BYTES, 'Skill 文件');
        const metadata = simpleFrontmatter(content, basename(source.localPath));
        const count = this.database.prepare('SELECT COUNT(*) AS count FROM skills').get() as { count: number };
        if (Number(count.count) >= MAX_SKILLS) fail(`Skill 数量不能超过 ${MAX_SKILLS} 个。`);
        const id = randomUUID();
        const stage = this.makeStage();
        const stagedSkill = join(stage, 'skill');
        const finalPath = join(this.skillDirectory, `${id}-${randomUUID()}`);
        try {
            copyTree(source.localPath, stagedSkill);
            safeReadText(join(stagedSkill, 'SKILL.md'), MAX_SKILL_BYTES, 'Skill 文件');
            renameSync(stagedSkill, finalPath);
            try {
                this.transaction(() => {
                    this.database.prepare(
                        'INSERT INTO skills (id, name, description, enabled, plugin_id, source, install_path, relative_path) VALUES (?, ?, ?, 1, NULL, ?, ?, ?)',
                    ).run(id, metadata.name, metadata.description, source.source, finalPath, 'SKILL.md');
                });
            } catch (error) {
                this.removeControlledPath(finalPath, this.skillDirectory);
                throw error;
            }
        } finally {
            this.removeControlledPath(stage, this.extensionDirectory);
        }
    }

    private async installPlugin(sourceValue: string): Promise<void> {
        const source = sourceReference(sourceValue);
        await this.installPluginFromSource(source, source.source, null, null, null);
    }

    private async installMarketplacePlugin(marketplaceId: string, name: string): Promise<void> {
        const marketplace = this.readMarketplaces().find((entry) => entry.id === marketplaceId);
        if (!marketplace) fail('Marketplace 不存在。');
        const entry = marketplace.plugins.find((plugin) => plugin.name === name);
        if (!entry) fail('Marketplace 中不存在该插件。');
        if (entry.source.startsWith('unsupported:')) fail(`Marketplace 插件来源暂不支持：${entry.source.slice('unsupported:'.length)}。`);
        const source = this.marketplaceEntrySource(marketplace, entry);
        await this.installPluginFromSource(source.reference, entry.source, marketplace.id, entry.name, source.localPath ?? null);
    }

    private marketplaceEntrySource(marketplace: StoredMarketplace, entry: MarketplacePluginRecord): { reference: SourceReference; localPath?: string } {
        if (entry.source.startsWith('./')) {
            const root = this.controlledPath(marketplace.installPath, this.marketplaceDirectory);
            const destination = resolve(root, ...entry.source.slice(2).split('/'));
            assertContained(root, destination);
            this.assertNoLinksBetween(root, destination);
            assertNoLink(destination, 'directory');
            return { reference: { kind: 'local', source: entry.source, localPath: realpathSync(destination) }, localPath: realpathSync(destination) };
        }
        return { reference: sourceReference(entry.source), localPath: undefined };
    }

    private async installPluginFromSource(
        source: SourceReference,
        publicSource: string,
        marketplaceId: string | null,
        marketplacePluginName: string | null,
        resolvedLocalPath: string | null,
        existing?: StoredPlugin,
    ): Promise<void> {
        const id = existing?.id ?? randomUUID();
        const stage = this.makeStage();
        const stagedPackage = join(stage, 'package');
        let finalPath: string | undefined = existing?.installPath ?? join(this.pluginDirectory, `${id}`);
        try {
            if (resolvedLocalPath) copyTree(resolvedLocalPath, stagedPackage);
            else await this.materializeSource(source, stagedPackage);
            finalPath = join(this.pluginDirectory, `${id}-${randomUUID()}`);
            const fallbackName = marketplacePluginName ?? (source.kind === 'local' && source.localPath
                ? basename(source.localPath)
                : source.url ? basename(new URL(source.url).pathname).replace(/\.git$/i, '') : 'plugin');
            const parsed = parsePlugin(stagedPackage, finalPath, fallbackName);
            scrubStoredMcpSecrets(stagedPackage, parsed);
            this.assertPluginNameAvailable(parsed.name, id);
            const currentSkills = existing ? this.readSkills().filter((skill) => skill.pluginId === existing.id) : [];
            const currentConnectors = existing ? this.readConnectors().filter((connector) => connector.pluginId === existing.id) : [];
            const totalSkills = this.readSkills().length - currentSkills.length + parsed.skills.length;
            const totalConnectors = this.readConnectors().length - currentConnectors.length + parsed.connectors.length;
            if (totalSkills > MAX_SKILLS) fail(`Skill 数量不能超过 ${MAX_SKILLS} 个。`);
            if (totalConnectors > MAX_CONNECTORS) fail(`连接器数量不能超过 ${MAX_CONNECTORS} 个。`);
            if (!existing && this.readPlugins().length >= MAX_PLUGINS) fail(`插件数量不能超过 ${MAX_PLUGINS} 个。`);
            renameSync(stagedPackage, finalPath);
            const pluginRecord: PluginRecord = {
                id,
                name: parsed.name,
                description: parsed.description,
                version: parsed.version,
                enabled: existing?.enabled ?? false,
                source: publicSource,
                unsupported: parsed.unsupported,
            };
            const skillByPath = new Map(currentSkills.map((skill) => [skill.relativePath.replaceAll('\\', '/'), skill]));
            const connectorByName = new Map(currentConnectors.map((connector) => [connector.sourceName ?? '', connector]));
            const keepSkillIds = new Set<string>();
            const keepConnectorIds = new Set<string>();
            const skillRows = parsed.skills.map((skill) => {
                const key = skill.relativePath.replaceAll('\\', '/');
                const previous = skillByPath.get(key);
                const skillId = previous?.id ?? randomUUID();
                keepSkillIds.add(skillId);
                return { ...skill, id: skillId, enabled: previous?.enabled ?? true };
            });
            const connectorRows = parsed.connectors.map((connector) => {
                const previous = connectorByName.get(connector.sourceName);
                if (previous) keepConnectorIds.add(previous.id);
                return { connector, previous };
            });

            this.transaction(() => {
                if (!existing) {
                    this.database.prepare(
                        `INSERT INTO plugins (id, name, description, version, enabled, source, install_path, unsupported_json, marketplace_id, marketplace_plugin_name)
                         VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`,
                    ).run(pluginRecord.id, pluginRecord.name, pluginRecord.description, pluginRecord.version, pluginRecord.source,
                        finalPath!, JSON.stringify(pluginRecord.unsupported), marketplaceId, marketplacePluginName);
                } else {
                    this.database.prepare(
                        `UPDATE plugins SET name = ?, description = ?, version = ?, source = ?, install_path = ?, unsupported_json = ?, marketplace_id = ?, marketplace_plugin_name = ?
                         WHERE id = ?`,
                    ).run(pluginRecord.name, pluginRecord.description, pluginRecord.version, pluginRecord.source, finalPath!,
                        JSON.stringify(pluginRecord.unsupported), marketplaceId, marketplacePluginName, existing.id);
                }
                for (const skill of currentSkills) {
                    if (!keepSkillIds.has(skill.id)) this.database.prepare('DELETE FROM skills WHERE id = ?').run(skill.id);
                }
                for (const skill of skillRows) {
                    const manifestPath = join(finalPath!, skill.relativePath);
                    if (skillByPath.has(skill.relativePath.replaceAll('\\', '/'))) {
                        this.database.prepare(
                            'UPDATE skills SET name = ?, description = ?, enabled = ?, source = ?, install_path = ?, relative_path = ? WHERE id = ?',
                        ).run(skill.name, skill.description, skill.enabled ? 1 : 0, publicSource, finalPath!, skill.relativePath.replaceAll('\\', '/'), skill.id);
                    } else {
                        this.database.prepare(
                            'INSERT INTO skills (id, name, description, enabled, plugin_id, source, install_path, relative_path) VALUES (?, ?, ?, 1, ?, ?, ?, ?)',
                        ).run(skill.id, skill.name, skill.description, pluginRecord.id, publicSource, finalPath!, skill.relativePath.replaceAll('\\', '/'));
                    }
                    assertContained(finalPath!, manifestPath);
                }

                for (const connector of currentConnectors) {
                    if (!keepConnectorIds.has(connector.id)) this.database.prepare('DELETE FROM connectors WHERE id = ?').run(connector.id);
                }
                for (const { connector, previous } of connectorRows) {
                    const targetDraft: ConnectorDraft = {
                        id: previous?.id ?? null,
                        ...connector.record,
                        revision: previous?.revision ?? 0,
                        secrets: connector.secrets,
                    };
                    const target = validateConnectorTarget(targetDraft);
                    const sameTarget = previous
                        ? sameConnectorTarget(
                            previous,
                            connector,
                            existing?.installPath,
                            finalPath,
                            Object.keys(this.decryptSecrets(previous.secretsBlob)),
                        )
                        : false;
                    const secretsBlob = previous && sameTarget
                        ? previous.secretsBlob
                        : this.encryptSecrets(target.secrets);
                    const enabled = previous && sameTarget ? previous.enabled : false;
                    if (previous) {
                        this.database.prepare(
                            `UPDATE connectors SET name = ?, transport = ?, command = ?, args_json = ?, url = ?, enabled = ?, revision = ?,
                             has_secrets = ?, secrets_blob = ?, source_name = ? WHERE id = ?`,
                        ).run(connector.record.name, connector.record.transport, connector.record.command, JSON.stringify(connector.record.args),
                            connector.record.url, enabled ? 1 : 0, previous.revision + 1, secretsBlob === null ? 0 : 1, secretsBlob,
                            connector.sourceName, previous.id);
                    } else {
                        this.database.prepare(
                            `INSERT INTO connectors (id, name, transport, command, args_json, url, enabled, revision, has_secrets, secrets_blob, plugin_id, source_name)
                             VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
                        ).run(randomUUID(), connector.record.name, connector.record.transport, connector.record.command,
                            JSON.stringify(connector.record.args), connector.record.url, secretsBlob === null ? 0 : 1,
                            secretsBlob, pluginRecord.id, connector.sourceName);
                    }
                }
            });
            if (existing) this.removeControlledPath(existing.installPath, this.pluginDirectory);
        } catch (error) {
            if (finalPath) this.removeControlledPath(finalPath, this.pluginDirectory);
            throw error;
        } finally {
            this.removeControlledPath(stage, this.extensionDirectory);
        }
    }

    private assertPluginNameAvailable(name: string, exceptId?: string): void {
        const existing = this.readPlugins().find((plugin) => plugin.name.toLocaleLowerCase('en-US') === name.toLocaleLowerCase('en-US') && plugin.id !== exceptId);
        if (existing) fail('已安装同名插件。');
    }

    private async materializeSource(source: SourceReference, destination: string): Promise<void> {
        if (source.kind === 'local' && source.localPath) {
            copyTree(source.localPath, destination);
            return;
        }
        await gitClone(source, destination);
        const gitMetadata = join(destination, '.git');
        if (existsSync(gitMetadata)) {
            assertNoLink(gitMetadata, 'directory');
            rmSync(gitMetadata, { recursive: true, force: true });
        }
        scanTree(destination);
    }

    private async addMarketplace(sourceValue: string): Promise<void> {
        if (this.readMarketplaces().length >= MAX_MARKETPLACES) fail(`Marketplace 数量不能超过 ${MAX_MARKETPLACES} 个。`);
        const source = sourceReference(sourceValue);
        const id = randomUUID();
        const stage = this.makeStage();
        const stagedDirectory = join(stage, 'marketplace');
        const finalPath = join(this.marketplaceDirectory, `${id}-${randomUUID()}`);
        try {
            await this.materializeSource(source, stagedDirectory);
            const parsed = parseMarketplace(stagedDirectory);
            const duplicate = this.readMarketplaces().some((marketplace) => marketplace.name.toLocaleLowerCase('en-US') === parsed.name.toLocaleLowerCase('en-US'));
            if (duplicate) fail('已添加同名 Marketplace。');
            renameSync(stagedDirectory, finalPath);
            try {
                this.transaction(() => {
                    this.database.prepare(
                        'INSERT INTO marketplaces (id, name, source, plugins_json, install_path) VALUES (?, ?, ?, ?, ?)',
                    ).run(id, parsed.name, source.source, JSON.stringify(parsed.plugins), finalPath);
                });
            } catch (error) {
                this.removeControlledPath(finalPath, this.marketplaceDirectory);
                throw error;
            }
        } finally {
            this.removeControlledPath(stage, this.extensionDirectory);
        }
    }

    private setEnabled(table: 'skills' | 'plugins', id: string, enabled: boolean): void {
        const row = this.database.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(id) as { id: string } | undefined;
        if (!row) fail(table === 'skills' ? 'Skill 不存在。' : '插件不存在。');
        const result = this.database.prepare(`UPDATE ${table} SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id);
        if (result.changes !== 1) fail('扩展状态更新失败。');
    }

    private setSkillEnabled(id: string, enabled: boolean): void {
        if (!this.builtinSkills.has(id)) {
            this.setEnabled('skills', id, enabled);
            return;
        }
        try {
            this.database.prepare(
                `INSERT INTO builtin_skill_settings (id, enabled) VALUES (?, ?)
                 ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled`,
            ).run(id, enabled ? 1 : 0);
        } catch {
            fail('内置 Skill 状态更新失败。');
        }
    }

    private removeSkill(id: string): void {
        if (this.builtinSkills.has(id)) fail('内置 Skill 不可卸载。');
        const skill = this.readSkills().find((entry) => entry.id === id);
        if (!skill) fail('Skill 不存在。');
        this.database.prepare('DELETE FROM skills WHERE id = ?').run(id);
        if (!skill.pluginId) this.removeControlledPath(skill.installPath, this.skillDirectory);
    }

    private removePlugin(id: string): void {
        const plugin = this.readPlugins().find((entry) => entry.id === id);
        if (!plugin) fail('插件不存在。');
        this.transaction(() => {
            const result = this.database.prepare('DELETE FROM plugins WHERE id = ?').run(id);
            if (result.changes !== 1) fail('插件不存在。');
        });
        this.removeControlledPath(plugin.installPath, this.pluginDirectory);
    }

    private removeMarketplace(id: string): void {
        const marketplace = this.readMarketplaces().find((entry) => entry.id === id);
        if (!marketplace) fail('Marketplace 不存在。');
        const plugins = this.readPlugins().filter((plugin) => plugin.marketplaceId === id);
        this.transaction(() => {
            const result = this.database.prepare('DELETE FROM marketplaces WHERE id = ?').run(id);
            if (result.changes !== 1) fail('Marketplace 不存在。');
        });
        for (const plugin of plugins) this.removeControlledPath(plugin.installPath, this.pluginDirectory);
        this.removeControlledPath(marketplace.installPath, this.marketplaceDirectory);
    }

    private async updatePlugin(id: string): Promise<void> {
        const plugin = this.readPlugins().find((entry) => entry.id === id);
        if (!plugin) fail('插件不存在。');
        let source: SourceReference;
        let localPath: string | null = null;
        if (plugin.marketplaceId) {
            const marketplace = this.readMarketplaces().find((entry) => entry.id === plugin.marketplaceId);
            if (!marketplace || !plugin.marketplacePluginName) fail('插件 Marketplace 来源已不存在。');
            const stage = this.makeStage();
            try {
                const marketplaceRoot = join(stage, 'marketplace');
                await this.materializeSource(sourceReference(marketplace.source), marketplaceRoot);
                const manifest = parseMarketplace(marketplaceRoot);
                const entry = manifest.plugins.find((item) => item.name === plugin.marketplacePluginName);
                if (!entry) fail('Marketplace 已移除该插件。');
                if (entry.source.startsWith('unsupported:')) fail(`Marketplace 插件来源暂不支持：${entry.source.slice('unsupported:'.length)}。`);
                if (entry.source.startsWith('./')) {
                    const resolved = resolve(marketplaceRoot, ...entry.source.slice(2).split('/'));
                    assertContained(marketplaceRoot, resolved);
                    this.assertNoLinksBetween(marketplaceRoot, resolved);
                    assertNoLink(resolved, 'directory');
                    source = { kind: 'local', source: entry.source, localPath: realpathSync(resolved) };
                    localPath = realpathSync(resolved);
                } else {
                    source = sourceReference(entry.source);
                }
                await this.installPluginFromSource(source, entry.source, marketplace.id, entry.name, localPath, plugin);
            } finally {
                this.removeControlledPath(stage, this.extensionDirectory);
            }
            return;
        }
        source = sourceReference(plugin.source);
        await this.installPluginFromSource(source, plugin.source, null, null, null, plugin);
    }

    private getSkill(id: string): StoredSkill {
        const builtin = this.builtinSkills.get(id);
        if (builtin) return this.readBuiltinSkills().find((entry) => entry.id === id)!;
        const skill = this.readSkills().find((entry) => entry.id === id);
        if (!skill) fail('Skill 不存在。');
        return skill;
    }

    private pluginEnabled(id: string): boolean {
        const row = this.database.prepare('SELECT enabled FROM plugins WHERE id = ?').get(id) as { enabled: number } | undefined;
        return row?.enabled === 1;
    }

    private readSkillManifestPath(skill: StoredSkill): string {
        if (skill.builtin) {
            return assertBuiltinFile(
                skill.installPath,
                resolve(skill.installPath, ...safeRelativeSegments(skill.relativePath)),
                MAX_SKILL_BYTES,
                '内置 Skill 文件',
            );
        }
        const root = this.controlledPath(skill.installPath, skill.pluginId ? this.pluginDirectory : this.skillDirectory);
        const segments = safeRelativeSegments(skill.relativePath);
        const target = resolve(root, ...segments);
        assertContained(root, target);
        this.assertNoLinksBetween(root, target);
        assertNoLink(target, 'file');
        let stat;
        try { stat = lstatSync(target); } catch { fail('Skill 文件不存在或不可访问。'); }
        if (stat.size > MAX_SKILL_BYTES) fail('Skill 文件超过大小限制。');
        const canonical = realpathSync(target);
        if (!isWithin(realpathSync(root), canonical)) fail('Skill 文件路径越界。');
        return canonical;
    }

    private readSkillFile(skill: StoredSkill, relativePath: string): string {
        const skillManifest = this.readSkillManifestPath(skill);
        const root = dirname(skillManifest);
        const segments = safeRelativeSegments(relativePath);
        const target = resolve(root, ...segments);
        if (skill.builtin) {
            return safeReadBuiltinText(root, target, MAX_SKILL_BYTES, '内置 Skill 文件');
        }
        assertContained(root, target);
        this.assertNoLinksBetween(root, target);
        assertNoLink(target, 'file');
        let size = 0;
        try { size = lstatSync(target).size; } catch { fail('Skill 文件不存在或不可访问。'); }
        if (size > MAX_SKILL_BYTES) fail('Skill 文件超过大小限制。');
        const canonical = realpathSync(target);
        if (!isWithin(realpathSync(root), canonical)) fail('Skill 文件路径越界。');
        return safeReadText(canonical, MAX_SKILL_BYTES, 'Skill 文件');
    }

    private assertNoLinksBetween(root: string, target: string): void {
        let current = resolve(root);
        const destination = resolve(target);
        assertContained(current, destination, true);
        const segments = relative(current, destination).split(sep).filter(Boolean);
        assertNoLink(current, 'directory');
        for (let index = 0; index < segments.length; index += 1) {
            current = join(current, segments[index]);
            assertNoLink(current, index === segments.length - 1 ? 'any' : 'directory');
        }
    }

    private controlledPath(path: string, allowedParent: string): string {
        const resolved = assertContained(allowedParent, path);
        const canonicalParent = realpathSync(allowedParent);
        const canonical = realpathSync(resolved);
        if (!isWithin(canonicalParent, canonical)) fail('扩展安装路径越界。');
        assertNoLink(resolved);
        return canonical;
    }

    private makeStage(): string {
        return mkdtempSync(join(this.extensionDirectory, '.stage-'));
    }

    private removeControlledPath(path: string, allowedParent: string): void {
        const resolved = resolve(path);
        const parent = resolve(allowedParent);
        if (!isWithin(parent, resolved) || resolved === parent) return;
        try {
            if (existsSync(resolved)) {
                assertNoLink(resolved);
                if (!isWithin(realpathSync(parent), realpathSync(resolved))) return;
            }
            rmSync(resolved, { recursive: true, force: true, maxRetries: 1 });
        } catch {
            // A failed cleanup does not expose the underlying path or change registry state.
        }
    }

    private assertOpen(): void {
        if (this.closed) fail('Extension store is closed.');
    }
}
