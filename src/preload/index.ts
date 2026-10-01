import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, RuntimeEvent } from '../shared/contracts';

async function invoke(channel: string, ...arguments_: unknown[]) {
    try {
        return await ipcRenderer.invoke(channel, ...arguments_);
    } catch (error) {
        const message = error instanceof Error ? error.message : '操作未完成。';
        throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error|TypeError):\s*/, ''));
    }
}

const bridge: DesktopBridge = {
    journalPolicy: command => invoke('uah:journal-policy', command),
    journal: (query) => invoke('uah:journal', query),
    git: (query) => invoke('uah:git', query),
    requestContext: (query) => invoke('uah:request-context', query),
    openExternal: (url) => invoke('uah:open-external', url),
    writeClipboard: (text) => invoke('uah:write-clipboard', text),
    openLogs: () => invoke('uah:open-logs'),
    endpoints: (command) => invoke('uah:endpoints', command),
    agents: (command) => invoke('uah:agents', command),
    previewDelegation: (value) => invoke('uah:delegation-preview', value),
    command: (command, view) => invoke('uah:command', command, view),
    chooseDirectory: () => invoke('uah:choose-directory'),
    observeDesktop: () => invoke('uah:observe-desktop'),
    browser: (action) => invoke('uah:browser', action),
    setWindowTheme: (theme) => invoke('uah:window-theme', theme),
    onEvent: (listener) => {
        const handler = (_event: Electron.IpcRendererEvent, event: RuntimeEvent) => listener(event);
        ipcRenderer.on('uah:event', handler);
        return () => ipcRenderer.removeListener('uah:event', handler);
    }
};
contextBridge.exposeInMainWorld('uah', bridge);
