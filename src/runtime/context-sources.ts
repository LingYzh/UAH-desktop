import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import type { Stats } from 'node:fs';
import { decodeFileBytes } from './file-codec';

export interface ContextSource {
    id: string;
    kind: 'rule' | 'external-rule' | 'external-memory' | 'memory';
    scope: string;
    path: string;
    modifiedAt: string;
    hash?: string;
    selected: boolean;
    reason: string;
}

export interface ProjectRulesSnapshot {
    sources: ContextSource[];
    active: Array<{ source: ContextSource; content: string }>;
    warnings: string[];
    fingerprint: string;
}

export interface ReadContextSourceOptions {
    relativePath?: string;
    offset?: number;
    limit?: number;
    expectedHash?: string;
    signal?: AbortSignal;
}

export interface ReadContextSourceResult {
    text: string;
    hash: string;
    nextOffset: number | null;
    totalCharacters: number;
    path: string;
}

export interface SearchContextSourcesResult {
    matches: Array<{ sourceId: string; path: string; line: number; text: string }>;
    truncated: boolean;
}

const MAX_RULE_FILE_BYTES = 32 * 1024;
const MAX_ACTIVE_RULE_BYTES = 48 * 1024;
const MAX_CONTEXT_FILE_BYTES = 64 * 1024;
const MAX_PAGE_CHARACTERS = 12_000;
const MAX_SEARCH_ENTRIES = 200;
const MAX_SEARCH_BYTES = 2 * 1024 * 1024;
const MAX_SEARCH_DEPTH = 4;
const MAX_IMPORT_DEPTH = 4;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown']);

type EntryKind = 'file' | 'directory' | 'either';
interface TrustedSource {
    kind: ContextSource['kind'];
    path: string;
    boundary: string;
    isDirectory: boolean;
    scope?: string;
}
interface RuleCandidate {
    path: string;
    source: ContextSource;
    stat: Stats;
    family: 'agents' | 'claude';
    name: string;
    preloaded?: LoadedRule | null;
}
interface LoadedRule {
    bytes: Buffer;
    content: string;
    hash: string;
}

const trustedSources = new Map<string, TrustedSource>();

function aborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw signal.reason ?? new Error('Context source operation aborted');
}

function canonicalPathKey(value: string): string {
    const absolute = resolve(value);
    const root = parse(absolute).root;
    const trimmed = absolute.length > root.length ? absolute.replace(/[\\/]+$/, '') : root;
    const normalized = normalize(trimmed).replace(/\\/g, '/');
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

/** Opaque stable identity for an already-canonical absolute source path. */
export function contextSourceId(canonicalPath: string): string {
    return createHash('sha256').update(canonicalPathKey(canonicalPath)).digest('hex');
}

function samePath(left: string, right: string): boolean {
    return canonicalPathKey(left) === canonicalPathKey(right);
}

function isWithin(root: string, candidate: string): boolean {
    const rel = relative(root, candidate);
    return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

function relativeLabel(root: string, value: string): string {
    const rel = relative(root, value);
    return rel || '.';
}

function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
        ? String((error as NodeJS.ErrnoException).code)
        : undefined;
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
    return errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';
}

function isReparseOrAlias(path: string, stat: Stats, actualPath: string): boolean {
    return stat.isSymbolicLink() || !samePath(path, actualPath);
}

async function prepareDirectory(directory: string, signal?: AbortSignal): Promise<string> {
    aborted(signal);
    const requested = resolve(directory);
    const stat = await lstat(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Expected a plain directory: ${requested}`);
    const actual = await realpath(requested);
    if (!samePath(requested, actual)) throw new Error(`Reparse point in directory path: ${requested}`);
    return actual;
}

async function inspectPath(root: string, candidate: string, expected: EntryKind, signal?: AbortSignal): Promise<Stats | undefined> {
    aborted(signal);
    const absolute = resolve(candidate);
    if (!isWithin(root, absolute)) throw new Error(`Path is outside its granted root: ${candidate}`);
    const rel = relative(root, absolute);
    const parts = rel ? rel.split(/[\\/]+/).filter(Boolean) : [];
    let cursor = root;
    const rootStat = await lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error(`Unsafe source root: ${root}`);
    const actualRoot = await realpath(root);
    if (!samePath(root, actualRoot)) throw new Error(`Reparse point in source root: ${root}`);
    if (!parts.length) {
        if (expected === 'file') throw new Error(`Expected a file: ${absolute}`);
        return rootStat;
    }
    let result: Stats | undefined;
    for (let index = 0; index < parts.length; index++) {
        aborted(signal);
        cursor = join(cursor, parts[index]);
        let stat: Stats;
        try { stat = await lstat(cursor); }
        catch (error) {
            if (isMissing(error)) return undefined;
            throw error;
        }
        const actual = await realpath(cursor);
        if (isReparseOrAlias(cursor, stat, actual)) throw new Error(`Reparse point in source path: ${cursor}`);
        const final = index === parts.length - 1;
        if (!final && !stat.isDirectory()) throw new Error(`Non-directory path component: ${cursor}`);
        if (final) {
            if (expected === 'file' && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Expected an unlinked regular file: ${cursor}`);
            if (expected === 'directory' && !stat.isDirectory()) throw new Error(`Expected a plain directory: ${cursor}`);
            if (expected === 'either' && !stat.isDirectory() && (!stat.isFile() || stat.nlink !== 1)) throw new Error(`Expected a plain file or directory: ${cursor}`);
            result = stat;
        }
    }
    return result;
}

function sameOpenedFile(before: Stats, opened: Stats): boolean {
    return before.isFile() && opened.isFile()
        && before.dev === opened.dev && before.ino === opened.ino && before.nlink === opened.nlink
        && before.size === opened.size && before.mtimeMs === opened.mtimeMs && before.ctimeMs === opened.ctimeMs;
}

async function readBoundedFile(root: string, path: string, maximum: number, signal?: AbortSignal): Promise<Buffer> {
    aborted(signal);
    const before = await inspectPath(root, path, 'file', signal);
    if (!before) throw new Error(`File does not exist: ${path}`);
    if (before.size > maximum) throw new Error(`File exceeds ${maximum} byte limit: ${relativeLabel(root, path)}`);
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    const handle = await open(path, constants.O_RDONLY | noFollow);
    try {
        aborted(signal);
        const opened = await handle.stat();
        if (opened.nlink !== 1 || !sameOpenedFile(before, opened)) throw new Error(`File changed or is linked: ${path}`);
        const buffer = Buffer.alloc(maximum + 1);
        let length = 0;
        while (length < buffer.length) {
            aborted(signal);
            const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
            if (bytesRead === 0) break;
            length += bytesRead;
        }
        if (length > maximum) throw new Error(`File exceeds ${maximum} byte limit: ${relativeLabel(root, path)}`);
        const after = await handle.stat();
        if (!sameOpenedFile(opened, after) || length !== after.size) throw new Error(`File changed during read: ${path}`);
        return buffer.subarray(0, length);
    } finally {
        await handle.close();
    }
}

function sourceRecord(
    kind: ContextSource['kind'], path: string, scope: string, modifiedAt: string,
    selected: boolean, reason: string, hash?: string,
): ContextSource {
    const source: ContextSource = { id: contextSourceId(path), kind, scope, path, modifiedAt, selected, reason };
    if (hash) source.hash = hash;
    return source;
}

function register(source: ContextSource, boundary: string, isDirectory: boolean): void {
    trustedSources.set(source.id, { kind: source.kind, path: source.path, boundary, isDirectory });
}

function fingerprint(active: ProjectRulesSnapshot['active'], warnings: readonly string[]): string {
    const value = JSON.stringify({
        active: active.map(item => [item.source.id, item.source.scope, item.source.hash ?? '', item.content]),
        warnings,
    });
    return createHash('sha256').update(value).digest('hex');
}

function compareCandidates(left: RuleCandidate, right: RuleCandidate): number {
    const dateDelta = right.stat.mtimeMs - left.stat.mtimeMs;
    if (dateDelta) return dateDelta;
    const familyDelta = (left.family === 'agents' ? 0 : 1) - (right.family === 'agents' ? 0 : 1);
    if (familyDelta) return familyDelta;
    return canonicalPathKey(left.path).localeCompare(canonicalPathKey(right.path));
}

function modifiedAt(stat: Stats): string {
    return stat.mtime.toISOString();
}

async function loadRule(root: string, candidate: RuleCandidate, warnings: string[], signal?: AbortSignal): Promise<LoadedRule | null> {
    if (candidate.preloaded !== undefined) return candidate.preloaded;
    try {
        const bytes = await readBoundedFile(root, candidate.path, MAX_RULE_FILE_BYTES, signal);
        const decoded = decodeFileBytes(bytes).text;
        if (!decoded.trim()) {
            candidate.source = { ...candidate.source, selected: false, reason: 'Empty rule file' };
            return candidate.preloaded = null;
        }
        return candidate.preloaded = { bytes, content: decoded, hash: createHash('sha256').update(bytes).digest('hex') };
    } catch (error) {
        warnings.push(`Could not use rule ${relativeLabel(root, candidate.path)}: ${errorText(error)}`);
        candidate.source = { ...candidate.source, selected: false, reason: `Unavailable: ${errorText(error)}` };
        return candidate.preloaded = null;
    }
}

function scopeRulePaths(scope: string): Array<{ name: string; relativePath: string; family: RuleCandidate['family'] }> {
    return [
        { name: 'AGENTS.override.md', relativePath: 'AGENTS.override.md', family: 'agents' },
        { name: 'AGENTS.md', relativePath: 'AGENTS.md', family: 'agents' },
        { name: 'CLAUDE.md', relativePath: 'CLAUDE.md', family: 'claude' },
        { name: 'CLAUDE.local.md', relativePath: 'CLAUDE.local.md', family: 'claude' },
        { name: '.claude/CLAUDE.md', relativePath: join('.claude', 'CLAUDE.md'), family: 'claude' },
    ];
}

async function candidatesForScope(
    root: string, scope: string, records: Map<string, ContextSource>, warnings: string[], signal?: AbortSignal,
): Promise<RuleCandidate[]> {
    const candidates: RuleCandidate[] = [];
    for (const item of scopeRulePaths(scope)) {
        aborted(signal);
        const path = join(scope, item.relativePath);
        try {
            const stat = await inspectPath(root, path, 'file', signal);
            if (!stat) continue;
            const canonical = await realpath(path);
            const canonicalScope = await realpath(scope);
            const source = sourceRecord('rule', canonical, canonicalScope, modifiedAt(stat), false, 'Available scoped rule candidate');
            register(source, root, false);
            records.set(source.id, source);
            candidates.push({ path: canonical, source, stat, family: item.family, name: item.name });
        } catch (error) {
            warnings.push(`Could not inspect rule ${relativeLabel(root, path)}: ${errorText(error)}`);
            const source = sourceRecord('rule', resolve(path), scope, '', false, `Unavailable: ${errorText(error)}`);
            records.set(source.id, source);
        }
    }
    return candidates;
}

async function selectScopedRule(
    root: string, candidates: RuleCandidate[], warnings: string[], signal?: AbortSignal,
): Promise<RuleCandidate | null> {
    const sorted = [...candidates].sort(compareCandidates);
    const override = candidates.find(candidate => candidate.name === 'AGENTS.override.md');
    const base = candidates.find(candidate => candidate.name === 'AGENTS.md');
    let agentsResolved = !override;

    while (sorted.length) {
        aborted(signal);
        let candidate = sorted[0];
        if (!agentsResolved && candidate.family === 'agents') {
            agentsResolved = true;
            sorted.splice(0, sorted.length, ...sorted.filter(item => item.family !== 'agents'));
            const overrideContent = await loadRule(root, override!, warnings, signal);
            if (overrideContent) {
                override!.source = { ...override!.source, selected: false, reason: 'AGENTS.override.md replaces AGENTS.md when nonempty and valid' };
                if (base) base.source = { ...base.source, selected: false, reason: 'Replaced by nonempty AGENTS.override.md' };
                sorted.push(override!);
            } else if (base) {
                base.source = { ...base.source, selected: false, reason: 'Fallback after AGENTS.override.md was empty or invalid' };
                sorted.push(base);
            }
            sorted.sort(compareCandidates);
            continue;
        }
        candidate = sorted.shift()!;
        const loaded = await loadRule(root, candidate, warnings, signal);
        if (!loaded) continue;
        candidate.source = { ...candidate.source, selected: true, reason: 'Newest valid nonempty candidate in this scope', hash: loaded.hash };
        return candidate;
    }
    return null;
}

function standaloneImports(content: string): string[] {
    const result: string[] = [];
    let fence: { character: string; length: number } | null = null;
    for (const line of content.split(/\r?\n/)) {
        const fenceMatch = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
        if (fenceMatch) {
            const marker = fenceMatch[1];
            if (!fence) fence = { character: marker[0], length: marker.length };
            else if (marker[0] === fence.character && marker.length >= fence.length) fence = null;
            continue;
        }
        if (fence) continue;
        const match = /^\s*@([^\s]+)\s*$/.exec(line);
        if (match) result.push(match[1]);
    }
    return result;
}

function normalizedImportPath(parent: string, token: string): string | null {
    if (!validPathSegments(token, true) || isAbsolute(token) || /^[A-Za-z]:/.test(token) || token.startsWith('\\')) return null;
    return resolve(dirname(parent), token);
}

function validPathSegments(value: string, allowDotSegments: boolean): boolean {
    if (!value || value.includes('\0')) return false;
    const parts = value.split(/[\\/]/);
    if (parts.some(part => !part)) return false;
    for (const part of parts) {
        if (part === '.' || part === '..') {
            if (allowDotSegments) continue;
            return false;
        }
        if (/[<>:"|?*]/.test(part) || /[. ]$/.test(part)) return false;
        if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) return false;
    }
    return true;
}

export async function readProjectRules(
    directory: string | null,
    targetPaths: readonly string[] = [],
    signal?: AbortSignal,
): Promise<ProjectRulesSnapshot> {
    const records = new Map<string, ContextSource>();
    const active: ProjectRulesSnapshot['active'] = [];
    const warnings: string[] = [];
    if (!directory) return { sources: [], active: [], warnings: [], fingerprint: fingerprint([], []) };

    let root: string;
    try { root = await prepareDirectory(directory, signal); }
    catch (error) {
        aborted(signal);
        warnings.push(`Could not inspect project root: ${errorText(error)}`);
        return { sources: [], active: [], warnings, fingerprint: fingerprint([], warnings) };
    }

    const requestedRoot = resolve(directory);
    const scopes = new Map<string, string>([[canonicalPathKey(root), root]]);
    for (const target of targetPaths) {
        aborted(signal);
        try {
            if (!target || target.includes('\0')) throw new Error('Target path is empty or invalid');
            const absolute = isAbsolute(target) ? resolve(target) : resolve(root, target);
            let candidate = absolute;
            if (isWithin(requestedRoot, absolute) && !isWithin(root, absolute)) candidate = resolve(root, relative(requestedRoot, absolute));
            if (!isWithin(root, candidate)) throw new Error('Target is outside the granted project root');
            await inspectPath(root, candidate, 'either', signal);
            let cursor = candidate;
            const candidateStat = await inspectPath(root, candidate, 'either', signal);
            if (!candidateStat || !candidateStat.isDirectory()) cursor = dirname(candidate);
            let found: string | null = null;
            while (isWithin(root, cursor)) {
                const stat = await inspectPath(root, cursor, 'directory', signal);
                if (stat) { found = await realpath(cursor); break; }
                if (samePath(cursor, root)) break;
                const parent = dirname(cursor);
                if (samePath(parent, cursor)) break;
                cursor = parent;
            }
            if (!found) found = root;
            const chain: string[] = [];
            for (let item = found; isWithin(root, item); item = dirname(item)) {
                chain.push(item);
                if (samePath(item, root)) break;
            }
            for (const item of chain.reverse()) scopes.set(canonicalPathKey(item), item);
        } catch (error) {
            warnings.push(`Ignored target ${String(target)}: ${errorText(error)}`);
        }
    }

    const orderedScopes = [...scopes.values()].sort((left, right) => {
        const depth = (value: string) => relative(root, value).split(/[\\/]+/).filter(Boolean).length;
        return depth(left) - depth(right) || canonicalPathKey(left).localeCompare(canonicalPathKey(right));
    });
    let activeBytes = 0;
    const activePaths = new Set<string>();
    const importStack = new Set<string>();

    const include = async (path: string, scope: string, source: ContextSource, loaded: LoadedRule | null, depth: number): Promise<void> => {
        aborted(signal);
        const pathKey = canonicalPathKey(path);
        const activeKey = `${canonicalPathKey(scope)}\0${pathKey}`;
        if (importStack.has(pathKey)) {
            warnings.push(`Skipped cyclic rule import: ${relativeLabel(root, path)}`);
            return;
        }
        if (activePaths.has(activeKey)) return;
        if (depth > MAX_IMPORT_DEPTH) {
            warnings.push(`Rule import depth exceeded at ${relativeLabel(root, path)}`);
            return;
        }
        let data = loaded;
        if (!data) {
            try {
                const bytes = await readBoundedFile(root, path, MAX_RULE_FILE_BYTES, signal);
                const content = decodeFileBytes(bytes).text;
                if (!content.trim()) {
                    records.set(source.id, { ...source, selected: false, reason: 'Empty imported rule' });
                    warnings.push(`Imported rule is empty: ${relativeLabel(root, path)}`);
                    return;
                }
                data = { bytes, content, hash: createHash('sha256').update(bytes).digest('hex') };
            } catch (error) {
                records.set(source.id, { ...source, selected: false, reason: `Unavailable: ${errorText(error)}` });
                warnings.push(`Could not include imported rule ${relativeLabel(root, path)}: ${errorText(error)}`);
                return;
            }
        }
        if (activeBytes + data.bytes.length > MAX_ACTIVE_RULE_BYTES) {
            records.set(source.id, { ...source, selected: false, reason: 'Not loaded because the active rule byte limit would be exceeded' });
            warnings.push(`Active rule byte limit exceeded at ${relativeLabel(root, path)}; the file was not truncated`);
            return;
        }
        const selected = { ...source, selected: true, reason: depth === 0 ? source.reason : 'Explicit in-workspace rule import', hash: data.hash };
        records.set(source.id, selected);
        register(selected, root, false);
        active.push({ source: selected, content: data.content });
        activeBytes += data.bytes.length;
        activePaths.add(activeKey);
        importStack.add(pathKey);
        try {
            for (const token of standaloneImports(data.content)) {
                aborted(signal);
                const importPath = normalizedImportPath(path, token);
                if (!importPath || !isWithin(root, importPath)) {
                    warnings.push(`Ignored unsafe, outside-workspace or absolute import in ${relativeLabel(root, path)}: @${token}`);
                    continue;
                }
                if (depth >= MAX_IMPORT_DEPTH) {
                    warnings.push(`Rule import depth exceeded at ${relativeLabel(root, importPath)}`);
                    continue;
                }
                if (importStack.has(canonicalPathKey(importPath))) {
                    warnings.push(`Skipped cyclic rule import: ${relativeLabel(root, importPath)}`);
                    continue;
                }
                try {
                    const stat = await inspectPath(root, importPath, 'file', signal);
                    if (!stat) {
                        warnings.push(`Imported rule does not exist: ${relativeLabel(root, importPath)}`);
                        continue;
                    }
                    const canonical = await realpath(importPath);
                    const importSource = sourceRecord('rule', canonical, scope, modifiedAt(stat), false, 'Explicit in-workspace rule import');
                    register(importSource, root, false);
                    records.set(importSource.id, importSource);
                    await include(canonical, scope, importSource, null, depth + 1);
                } catch (error) {
                    warnings.push(`Could not inspect imported rule ${relativeLabel(root, importPath)}: ${errorText(error)}`);
                }
            }
        } finally {
            importStack.delete(pathKey);
        }
    };

    for (const scope of orderedScopes) {
        aborted(signal);
        const candidates = await candidatesForScope(root, scope, records, warnings, signal);
        const selected = await selectScopedRule(root, candidates, warnings, signal);
        for (const candidate of candidates) records.set(candidate.source.id, candidate.source);
        if (!selected) continue;
        const loaded = selected.preloaded ?? null;
        if (!loaded) continue;
        const before = active.length;
        await include(selected.path, scope, selected.source, loaded, 0);
        const activeKey = `${canonicalPathKey(scope)}\0${canonicalPathKey(selected.path)}`;
        if (active.length === before && !activePaths.has(activeKey)) selected.source = { ...selected.source, selected: false, reason: 'Not included in the active context' };
        for (const candidate of candidates) {
            if (candidate.path === selected.path) continue;
            const current = records.get(candidate.source.id) ?? candidate.source;
            if (current.reason === 'Available scoped rule candidate') {
                records.set(candidate.source.id, { ...current, selected: false, reason: `Superseded by ${basename(selected.path)}` });
            } else records.set(candidate.source.id, current);
        }
        records.set(selected.source.id, records.get(selected.source.id) ?? selected.source);
    }

    const sources = [...records.values()].sort((left, right) => canonicalPathKey(left.scope).localeCompare(canonicalPathKey(right.scope))
        || canonicalPathKey(left.path).localeCompare(canonicalPathKey(right.path)));
    const warningsUnique = [...new Set(warnings)];
    const fingerprintWarnings = warningsUnique.filter(warning => !warning.startsWith('Ignored target '));
    return { sources, active, warnings: warningsUnique, fingerprint: fingerprint(active, fingerprintWarnings) };
}

function unavailableExternalSource(kind: ContextSource['kind'], path: string, scope: string, reason: string): ContextSource {
    return sourceRecord(kind, resolve(path), scope, '', false, reason);
}

export async function listExternalSources(homeDirectory: string, signal?: AbortSignal): Promise<ContextSource[]> {
    let home: string;
    try { home = await prepareDirectory(homeDirectory, signal); }
    catch (error) {
        aborted(signal);
        if (isMissing(error)) return [];
        const requestedHome = resolve(homeDirectory);
        const unavailable = [
            { kind: 'external-rule' as const, path: join(requestedHome, '.claude', 'CLAUDE.md'), scope: join(requestedHome, '.claude') },
            { kind: 'external-rule' as const, path: join(requestedHome, '.codex', 'AGENTS.override.md'), scope: join(requestedHome, '.codex') },
            { kind: 'external-rule' as const, path: join(requestedHome, '.codex', 'AGENTS.md'), scope: join(requestedHome, '.codex') },
            { kind: 'external-memory' as const, path: join(requestedHome, '.claude', 'projects'), scope: join(requestedHome, '.claude', 'projects') },
            { kind: 'external-memory' as const, path: join(requestedHome, '.codex', 'memories'), scope: join(requestedHome, '.codex', 'memories') },
        ];
        return unavailable.map(item => unavailableExternalSource(item.kind, item.path, item.scope, `Unavailable external home: ${errorText(error)}`));
    }
    const known: Array<{ kind: ContextSource['kind']; path: string; scope: string; directory: boolean }> = [
        { kind: 'external-rule', path: join(home, '.claude', 'CLAUDE.md'), scope: join(home, '.claude'), directory: false },
        { kind: 'external-rule', path: join(home, '.codex', 'AGENTS.override.md'), scope: join(home, '.codex'), directory: false },
        { kind: 'external-rule', path: join(home, '.codex', 'AGENTS.md'), scope: join(home, '.codex'), directory: false },
        { kind: 'external-memory', path: join(home, '.claude', 'projects'), scope: join(home, '.claude', 'projects'), directory: true },
        { kind: 'external-memory', path: join(home, '.codex', 'memories'), scope: join(home, '.codex', 'memories'), directory: true },
    ];
    const sources: ContextSource[] = [];
    for (const item of known) {
        aborted(signal);
        try {
            const stat = await inspectPath(home, item.path, item.directory ? 'directory' : 'file', signal);
            if (!stat) continue;
            const canonical = await realpath(item.path);
            const canonicalScope = item.directory ? canonical : await realpath(item.scope);
            const source = sourceRecord(item.kind, canonical, canonicalScope, modifiedAt(stat), false,
                item.directory ? 'External memory directory; read or search only on explicit request' : 'External rule file; read only on explicit request');
            register(source, item.directory ? canonical : home, item.directory);
            sources.push(source);
        } catch (error) {
            if (isMissing(error)) continue;
            sources.push(unavailableExternalSource(item.kind, item.path, item.scope, `Unavailable: ${errorText(error)}`));
        }
    }
    return sources.sort((left, right) => canonicalPathKey(left.path).localeCompare(canonicalPathKey(right.path)));
}

async function resolveSource(source: ContextSource, signal?: AbortSignal): Promise<TrustedSource> {
    aborted(signal);
    if (!source || typeof source !== 'object' || typeof source.id !== 'string' || typeof source.path !== 'string') throw new Error('Invalid context source');
    const registered = trustedSources.get(source.id);
    if (registered) {
        if (registered.kind !== source.kind || !samePath(registered.path, source.path)) throw new Error('Context source metadata does not match its discovered identity');
        const boundary = await prepareDirectory(registered.boundary, signal);
        const path = resolve(source.path);
        if (!isWithin(boundary, path)) throw new Error('Context source is outside its granted root');
        return { ...registered, boundary };
    }
    if (source.kind !== 'memory') throw new Error('Context source was not discovered by this runtime');
    const boundary = await prepareDirectory(source.path, signal);
    if (!samePath(boundary, source.path) || source.id !== contextSourceId(boundary)) throw new Error('Invalid memory source identity');
    return { kind: 'memory', path: boundary, boundary, isDirectory: true, scope: source.scope };
}

function markdownFile(path: string): boolean {
    return MARKDOWN_EXTENSIONS.has(extname(path).toLowerCase());
}

function safeRelativePath(root: string, value: string): string {
    if (!validPathSegments(value, false) || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.startsWith('\\')) throw new Error('A safe relative path inside the source is required');
    const absolute = resolve(root, value);
    if (!isWithin(root, absolute)) throw new Error('Path escapes the context source root');
    return absolute;
}

function decodedText(bytes: Buffer, path: string): string {
    try { return decodeFileBytes(bytes).text; }
    catch (error) { throw new Error(`Invalid UTF-8 in ${path}`, { cause: error }); }
}

export async function readContextSource(
    source: ContextSource,
    options: ReadContextSourceOptions = {},
): Promise<ReadContextSourceResult> {
    const signal = options.signal;
    const trusted = await resolveSource(source, signal);
    const offset = options.offset ?? 0;
    const limit = options.limit ?? MAX_PAGE_CHARACTERS;
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('Invalid context page offset');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_CHARACTERS) throw new Error(`Context page limit must be between 1 and ${MAX_PAGE_CHARACTERS}`);
    if (offset > 0 && !options.expectedHash) throw new Error('A file hash is required for nonzero page offsets');

    let path: string;
    if (trusted.isDirectory) {
        if (!options.relativePath) throw new Error('A relative Markdown file path is required for directory sources');
        path = safeRelativePath(trusted.path, options.relativePath);
        if (trusted.kind === 'memory' && trusted.scope === 'user') {
            const rel = relative(trusted.path, path).split(/[\\/]+/).filter(Boolean);
            if (rel[0]?.toLowerCase() === 'projects') throw new Error('User memory source cannot read project memory paths');
        }
        if (!markdownFile(path)) throw new Error('Only Markdown files can be read from directory sources');
    } else {
        if (options.relativePath && options.relativePath !== basename(trusted.path)) throw new Error('File sources do not accept another relative path');
        path = trusted.path;
    }
    aborted(signal);
    const bytes = await readBoundedFile(trusted.boundary, path, MAX_CONTEXT_FILE_BYTES, signal);
    const text = decodedText(bytes, path);
    const hash = createHash('sha256').update(bytes).digest('hex');
    if (options.expectedHash && options.expectedHash.toLowerCase() !== hash) throw new Error('Context source changed; restart reading at offset 0');
    const characters = Array.from(text);
    if (offset > characters.length) throw new Error('Context page offset exceeds the file length');
    const page = characters.slice(offset, offset + limit);
    const nextOffset = offset + page.length < characters.length ? offset + page.length : null;
    return { text: page.join(''), hash, nextOffset, totalCharacters: characters.length, path: await realpath(path) };
}

const SENSITIVE_DIRECTORY_NAMES = new Set([
    '.git', '.ssh', '.gnupg', '.aws', '.azure', '.config', 'auth', 'authentication', 'oauth', 'config', 'configs',
    'history', 'histories', 'session', 'sessions', 'credential', 'credentials', 'secret', 'secrets', 'token', 'tokens',
    'cache', 'caches', 'log', 'logs', 'transcript', 'transcripts', 'keychain', 'private', 'state', 'sqlite', 'db',
]);

function sensitiveDirectory(name: string): boolean {
    const lower = name.toLowerCase();
    return SENSITIVE_DIRECTORY_NAMES.has(lower)
        || /^(auth|oauth|session|history|credential|secret|token|config|cache|transcript)([-_.]|$)/i.test(lower);
}

function searchSnippet(line: string, query: string): string {
    const chars = Array.from(line);
    if (chars.length <= 900) return line;
    const lower = line.toLocaleLowerCase();
    const at = lower.indexOf(query.toLocaleLowerCase());
    const start = Math.max(0, Array.from(line.slice(0, Math.max(0, at))).length - 300);
    const end = Math.min(chars.length, start + 900);
    return (start ? '…' : '') + chars.slice(start, end).join('') + (end < chars.length ? '…' : '');
}

export async function searchContextSources(
    sources: readonly ContextSource[],
    query: string,
    signal?: AbortSignal,
): Promise<SearchContextSourcesResult> {
    if (!Array.isArray(sources)) throw new Error('Context sources must be an array');
    if (typeof query !== 'string' || !query.trim()) throw new Error('An explicit nonempty search query is required');
    const normalizedQuery = query.trim();
    const matches: SearchContextSourcesResult['matches'] = [];
    let entries = 0;
    let bytesRead = 0;
    let truncated = false;
    let stop = false;

    const scanFile = async (sourceId: string, boundary: string, displayRoot: string, path: string): Promise<void> => {
        aborted(signal);
        if (!markdownFile(path)) return;
        let stat: Stats | undefined;
        try { stat = await inspectPath(boundary, path, 'file', signal); }
        catch { return; }
        if (!stat) return;
        if (stat.size > MAX_CONTEXT_FILE_BYTES) { truncated = true; return; }
        if (bytesRead + stat.size > MAX_SEARCH_BYTES) { truncated = true; stop = true; return; }
        let raw: Buffer;
        try { raw = await readBoundedFile(boundary, path, MAX_CONTEXT_FILE_BYTES, signal); }
        catch { truncated = true; return; }
        bytesRead += raw.length;
        let content: string;
        try { content = decodedText(raw, path); }
        catch { truncated = true; return; }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index++) {
            if (!lines[index].toLocaleLowerCase().includes(normalizedQuery.toLocaleLowerCase())) continue;
            if (matches.length >= MAX_SEARCH_ENTRIES) { truncated = true; stop = true; return; }
            matches.push({ sourceId, path: relativeLabel(displayRoot, path), line: index + 1, text: searchSnippet(lines[index], normalizedQuery) });
        }
    };

    for (const source of sources) {
        if (stop) break;
        let trusted: TrustedSource;
        try { trusted = await resolveSource(source, signal); }
        catch (error) {
            if (errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR') continue;
            truncated = true;
            continue;
        }
        if (trusted.isDirectory) {
            const visit = async (directory: string, depth: number): Promise<void> => {
                aborted(signal);
                if (stop) return;
                await inspectPath(trusted.path, directory, 'directory', signal);
                const entriesAtPath = await opendir(directory);
                try {
                    for await (const entry of entriesAtPath) {
                        aborted(signal);
                        if (stop) break;
                        entries++;
                        if (entries > MAX_SEARCH_ENTRIES) { truncated = true; stop = true; break; }
                        const child = join(directory, entry.name);
                        if (entry.isSymbolicLink()) continue;
                        if (entry.isDirectory()) {
                            if (sensitiveDirectory(entry.name)) continue;
                            if (trusted.kind === 'memory' && trusted.scope === 'user' && depth === 0 && entry.name.toLowerCase() === 'projects') continue;
                            if (depth >= MAX_SEARCH_DEPTH) { truncated = true; continue; }
                            try {
                                await inspectPath(trusted.path, child, 'directory', signal);
                                await visit(child, depth + 1);
                            } catch { truncated = true; }
                        } else if (entry.isFile()) {
                            await scanFile(source.id, trusted.path, trusted.path, child);
                            if (stop) break;
                        }
                    }
                } finally {
                    try { await entriesAtPath.close(); } catch { /* The iterator may already have closed it. */ }
                }
            };
            await visit(trusted.path, 0);
        } else {
            entries++;
            if (entries > MAX_SEARCH_ENTRIES) { truncated = true; break; }
            await scanFile(source.id, trusted.boundary, dirname(trusted.path), trusted.path);
        }
    }
    return { matches, truncated };
}
