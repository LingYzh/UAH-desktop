import type { ResolvedConnector, SkillRecord } from './extensions';
import type { NativeCodexSettings } from './native-codex';

/** Host-only payload: never exposed by the renderer bridge. */
export interface ExtensionRuntimeBundle {
    connectors: ResolvedConnector[];
    skills: Array<SkillRecord & { path: string }>;
    native: NativeCodexSettings;
}

export type NativeSettingsCommand = { type: 'get' } | { type: 'discover' } | { type: 'save'; settings: NativeCodexSettings } | { type: 'probe'; settings?: NativeCodexSettings };

export interface NativeStatus {
    settings: NativeCodexSettings;
    candidates?: Array<{ command: string; args: string[]; source: string }>;
    probeTarget?: { command: string; args: string[] };
    probe?: { version: string; models: Array<{ id: string; name: string; isDefault?: boolean }>; authenticated: boolean; accountType: string | null };
}
