import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, normalize } from 'node:path';

export interface NativeCodexCandidate {
    command: string;
    args: string[];
    source: string;
}

const MAX_DIRECTORIES = 128;
const MAX_CANDIDATES = 20;
const MAX_PATH_COMPONENTS = MAX_DIRECTORIES * 4;

interface SearchDirectory {
    path: string;
    source: string;
}

function environmentValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
    const direct = env[name];
    if (direct !== undefined) return direct;
    const normalizedName = name.toLowerCase();
    const matchingKey = Object.keys(env).find((key) => key.toLowerCase() === normalizedName);
    return matchingKey ? env[matchingKey] : undefined;
}

function absoluteDirectory(path: string | undefined, source: string): SearchDirectory | null {
    if (!path) return null;
    const trimmed = path.trim();
    if (!trimmed || !isAbsolute(trimmed)) return null;
    return { path: normalize(trimmed), source };
}

function pathDirectories(env: NodeJS.ProcessEnv): SearchDirectory[] {
    const value = environmentValue(env, 'PATH') ?? '';
    const directories: SearchDirectory[] = [];
    const seen = new Set<string>();
    let start = 0;
    let components = 0;
    while (start <= value.length && components < MAX_PATH_COMPONENTS && directories.length < MAX_DIRECTORIES) {
        const separator = value.indexOf(';', start);
        const end = separator < 0 ? value.length : separator;
        const component = value.slice(start, end);
        components += 1;
        let path = component.trim();
        if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
            path = path.slice(1, -1).trim();
        }
        if (path) {
            const directory = absoluteDirectory(path, 'PATH');
            if (directory) {
                const key = directory.path.toLowerCase();
                if (!seen.has(key)) {
                    seen.add(key);
                    directories.push(directory);
                }
            }
        }
        if (separator < 0) break;
        start = separator + 1;
    }
    return directories;
}

function commonDirectories(env: NodeJS.ProcessEnv, requestedHome?: string): SearchDirectory[] {
    const configuredHome = requestedHome
        ?? environmentValue(env, 'USERPROFILE')
        ?? environmentValue(env, 'HOME')
        ?? homedir();
    const home = absoluteDirectory(configuredHome, 'home')?.path;
    const candidates: Array<SearchDirectory | null> = [
        absoluteDirectory(environmentValue(env, 'APPDATA'), 'AppData npm')
            ? absoluteDirectory(join(environmentValue(env, 'APPDATA')!, 'npm'), 'AppData npm')
            : null,
        absoluteDirectory(environmentValue(env, 'ProgramFiles'), 'ProgramFiles nodejs')
            ? absoluteDirectory(join(environmentValue(env, 'ProgramFiles')!, 'nodejs'), 'ProgramFiles nodejs')
            : null,
        absoluteDirectory(environmentValue(env, 'LOCALAPPDATA'), 'Local nodejs')
            ? absoluteDirectory(join(environmentValue(env, 'LOCALAPPDATA')!, 'Programs', 'nodejs'), 'Local nodejs')
            : null,
        home ? absoluteDirectory(join(home, '.local', 'bin'), '~/.local/bin') : null,
        home ? absoluteDirectory(join(home, 'scoop', 'shims'), 'Scoop shims') : null,
        absoluteDirectory(environmentValue(env, 'NVM_SYMLINK'), 'NVM_SYMLINK'),
        absoluteDirectory(environmentValue(env, 'npm_config_prefix'), 'npm_config_prefix'),
    ];
    const seen = new Set<string>();
    return candidates.filter((candidate): candidate is SearchDirectory => {
        if (!candidate) return false;
        const key = candidate.path.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

async function canonicalDirectory(path: string): Promise<string | null> {
    try {
        const canonical = await realpath(path);
        return (await stat(canonical)).isDirectory() ? canonical : null;
    } catch {
        return null;
    }
}

async function canonicalFile(path: string): Promise<string | null> {
    try {
        const canonical = await realpath(path);
        return (await stat(canonical)).isFile() ? canonical : null;
    } catch {
        return null;
    }
}

async function canonicalFileWithExtension(path: string, extension: '.exe' | '.js'): Promise<string | null> {
    const canonical = await canonicalFile(path);
    return canonical && extname(canonical).toLowerCase() === extension ? canonical : null;
}

function architectureLayout(): { packageName: string; triplet: string } | null {
    if (process.arch === 'x64') {
        return { packageName: 'codex-win32-x64', triplet: 'x86_64-pc-windows-msvc' };
    }
    if (process.arch === 'arm64') {
        return { packageName: 'codex-win32-arm64', triplet: 'aarch64-pc-windows-msvc' };
    }
    return null;
}

async function packageExecutables(directory: string): Promise<string[]> {
    const layout = architectureLayout();
    if (!layout) return [];
    const rootNodeModules = join(directory, 'node_modules', '@openai');
    const packageRoots = [
        join(rootNodeModules, layout.packageName),
        join(rootNodeModules, 'codex', 'node_modules', '@openai', layout.packageName),
    ];
    const candidates = packageRoots.flatMap((packageRoot) => {
        const vendorRoot = join(packageRoot, 'vendor');
        return [
            join(vendorRoot, layout.triplet, 'codex', 'codex.exe'),
            join(vendorRoot, layout.triplet, 'bin', 'codex.exe'),
            join(vendorRoot, layout.triplet, 'codex.exe'),
            join(vendorRoot, 'codex', 'codex.exe'),
            join(vendorRoot, 'codex.exe'),
        ];
    });
    const codexVendorRoot = join(rootNodeModules, 'codex', 'vendor', layout.triplet);
    candidates.push(
        join(codexVendorRoot, 'codex', 'codex.exe'),
        join(codexVendorRoot, 'bin', 'codex.exe'),
    );
    const found: string[] = [];
    const seen = new Set<string>();
    for (const path of candidates) {
        const canonical = await canonicalFileWithExtension(path, '.exe');
        if (!canonical) continue;
        const key = canonical.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        found.push(canonical);
    }
    return found;
}

async function npmScript(directory: string): Promise<string | null> {
    return canonicalFileWithExtension(join(directory, 'node_modules', '@openai', 'codex', 'bin', 'codex.js'), '.js');
}

function candidateKey(candidate: NativeCodexCandidate): string {
    return [candidate.command, ...candidate.args].join('\0').toLowerCase();
}

export async function discoverNativeCodex(options: {
    env?: NodeJS.ProcessEnv;
    home?: string;
} = {}): Promise<NativeCodexCandidate[]> {
    if (process.platform !== 'win32') return [];
    const env = options.env ?? process.env;
    const pathEntries = pathDirectories(env);
    const commonEntries = commonDirectories(env, options.home);
    const pathLimit = Math.max(0, MAX_DIRECTORIES - commonEntries.length);
    const directories = [...pathEntries.slice(0, pathLimit), ...commonEntries];
    const seenDirectories = new Set<string>();
    const searchable: SearchDirectory[] = [];
    for (const entry of directories) {
        const canonical = await canonicalDirectory(entry.path);
        if (!canonical) continue;
        const key = canonical.toLowerCase();
        if (seenDirectories.has(key)) continue;
        seenDirectories.add(key);
        searchable.push({ path: canonical, source: entry.source });
    }
    const results: NativeCodexCandidate[] = [];
    const resultKeys = new Set<string>();
    const scripts: Array<{ path: string; directory: SearchDirectory }> = [];
    const add = (candidate: NativeCodexCandidate): void => {
        if (results.length >= MAX_CANDIDATES) return;
        const key = candidateKey(candidate);
        if (resultKeys.has(key)) return;
        resultKeys.add(key);
        results.push(candidate);
    };

    for (const directory of searchable) {
        const directExecutable = await canonicalFileWithExtension(join(directory.path, 'codex.exe'), '.exe');
        if (directExecutable) add({ command: directExecutable, args: [], source: directory.source });
        for (const executable of await packageExecutables(directory.path)) {
            add({ command: executable, args: [], source: 'npm native package' });
        }
        const script = await npmScript(directory.path);
        if (script) scripts.push({ path: script, directory });
    }

    if (results.length >= MAX_CANDIDATES) return results;
    const nodeExecutables: string[] = [];
    for (const directory of searchable) {
        const executable = await canonicalFileWithExtension(join(directory.path, 'node.exe'), '.exe');
        if (executable && !nodeExecutables.some((existing) => existing.toLowerCase() === executable.toLowerCase())) {
            nodeExecutables.push(executable);
        }
    }

    for (const script of scripts) {
        const preferredPaths = [join(dirname(script.path), 'node.exe'), join(script.directory.path, 'node.exe')];
        let nodeExecutable: string | null = null;
        for (const path of preferredPaths) {
            nodeExecutable = await canonicalFileWithExtension(path, '.exe');
            if (nodeExecutable) break;
        }
        if (!nodeExecutable) nodeExecutable = nodeExecutables[0] ?? null;
        if (!nodeExecutable) continue;
        add({ command: nodeExecutable, args: [script.path], source: 'npm package' });
        if (results.length >= MAX_CANDIDATES) break;
    }

    return results;
}
