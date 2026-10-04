export interface NativeCodexSettings {
    enabled: boolean;
    command: string;
    args: string[];
    model: string;
    revision: number;
}

export const NATIVE_CODEX_ENDPOINT_ID = 'native:codex';

const SETTINGS_KEYS = ['enabled', 'command', 'args', 'model', 'revision'] as const;
const SHELL_EXECUTABLES = new Set(['cmd.exe', 'powershell.exe', 'pwsh.exe', 'bash.exe', 'sh.exe', 'wsl.exe']);
const MAX_COMMAND_LENGTH = 2_048;
const MAX_MODEL_LENGTH = 200;
const MAX_ARG_BYTES = 8 * 1024;
const MAX_TOTAL_ARG_BYTES = 32 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateCommand(value: unknown): string {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_COMMAND_LENGTH || value !== value.trim() || value.includes('\0')) {
        throw new TypeError('Native Codex command must be a non-empty absolute executable path.');
    }
    const absolute = /^[a-z]:[\\/]/i.test(value) || /^\\\\[^\\]+\\[^\\]+/.test(value);
    const name = value.replace(/\\/g, '/').split('/').at(-1)?.toLowerCase() ?? '';
    if (!absolute || !name.endsWith('.exe')) {
        throw new TypeError('Native Codex command must be an absolute .exe path.');
    }
    if (SHELL_EXECUTABLES.has(name) || name.endsWith('.bat') || name.endsWith('.cmd')) {
        throw new TypeError('Native Codex command cannot be a shell, batch file, or command file.');
    }
    return value;
}

function validateArgs(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > 128 || value.some(item => typeof item !== 'string' || item.includes('\0'))) {
        throw new TypeError('Native Codex args must be an array of at most 128 strings without NUL characters.');
    }
    let totalBytes = 0;
    for (const arg of value as string[]) {
        const bytes = new TextEncoder().encode(arg).length;
        if (bytes > MAX_ARG_BYTES) throw new TypeError('Native Codex args cannot exceed 8 KiB per argument.');
        if (arg.startsWith('-')) throw new TypeError('Native Codex args cannot contain CLI options.');
        if (arg.toLowerCase() === 'app-server') throw new TypeError('Native Codex args cannot repeat the app-server subcommand.');
        totalBytes += bytes;
        if (totalBytes > MAX_TOTAL_ARG_BYTES) throw new TypeError('Native Codex args cannot exceed 32 KiB total.');
    }
    return [...value] as string[];
}

export function parseNativeCodexSettings(value: unknown): NativeCodexSettings {
    if (!isRecord(value)) throw new TypeError('Native Codex settings must be an object.');
    const keys = Object.keys(value).sort();
    if (keys.length !== SETTINGS_KEYS.length || keys.some((key, index) => key !== [...SETTINGS_KEYS].sort()[index])) {
        throw new TypeError('Native Codex settings contain missing or unknown fields.');
    }

    const enabled = value.enabled;
    if (typeof enabled !== 'boolean') throw new TypeError('Native Codex enabled must be a boolean.');

    const rawCommand = value.command;
    if (typeof rawCommand !== 'string') throw new TypeError('Native Codex command must be a string.');
    const command = rawCommand === '' && !enabled ? '' : validateCommand(rawCommand);

    const args = validateArgs(value.args);
    if (command === '' && args.length > 0) throw new TypeError('Native Codex args require a command.');

    const model = value.model;
    if (typeof model !== 'string' || model.length > MAX_MODEL_LENGTH || model.includes('\0') || (enabled && model.trim() === '')) {
        throw new TypeError('Native Codex model must be a non-empty string when enabled.');
    }

    const revision = value.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) {
        throw new TypeError('Native Codex revision must be a non-negative safe integer.');
    }
    if (enabled && command === '') throw new TypeError('Native Codex requires an executable command when enabled.');

    return { enabled, command, args, model, revision };
}
