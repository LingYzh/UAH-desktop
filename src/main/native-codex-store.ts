import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { parseNativeCodexSettings, type NativeCodexSettings } from '../shared/native-codex';

export class NativeCodexStore {
    private readonly file: string;
    private settings: NativeCodexSettings;
    constructor(directory: string) {
        mkdirSync(directory, { recursive: true });
        this.file = path.join(directory, 'native-codex.json');
        this.settings = existsSync(this.file) ? parseNativeCodexSettings(JSON.parse(readFileSync(this.file, 'utf8'))) : {
            enabled: false, command: '', args: [], model: '', revision: 0,
        };
    }
    get(): NativeCodexSettings { return structuredClone(this.settings); }
    save(value: unknown): NativeCodexSettings {
        const next = parseNativeCodexSettings(value);
        if (next.revision !== this.settings.revision) throw new Error('原生运行时设置已改变，请刷新后重试。');
        if (next.revision >= Number.MAX_SAFE_INTEGER) throw new Error('原生设置版本已达到上限。');
        next.revision++;
        const temporary = this.file + '.tmp';
        writeFileSync(temporary, JSON.stringify(next), { encoding: 'utf8', mode: 0o600 });
        renameSync(temporary, this.file);
        this.settings = next;
        return this.get();
    }
}
