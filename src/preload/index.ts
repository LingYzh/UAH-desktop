import { clientError } from '../shared/client-error.js';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { DesktopBridge, RuntimeEvent } from '../shared/contracts';

async function invoke(channel: string, ...arguments_: unknown[]) {
    try {
        return await ipcRenderer.invoke(channel, ...arguments_);
    } catch (error) {
        throw new Error(clientError(error));
    }
}

const bridge: DesktopBridge = {
    chooseAttachments: () => invoke('uah:attachments', { type: 'choose' }),
    importAttachments: async files => {
        if (!Array.isArray(files) || files.length > 8) throw new Error('一次最多添加 8 个附件。');
        const paths: string[] = [];
        const images: Array<{ name: string; bytes: Uint8Array }> = [];
        for (const file of files) {
            const path = webUtils.getPathForFile(file);
            if (path) paths.push(path);
            else {
                if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) throw new Error('粘贴图片需不超过 5 MiB。');
                images.push({ name: file.name || '粘贴图片.png', bytes: new Uint8Array(await file.arrayBuffer()) });
            }
        }
        return invoke('uah:attachments', { type: 'import', paths, images });
    },
    releaseAttachments: ids => invoke('uah:attachments', { type: 'release', ids }),
    extensions: command => invoke('uah:extensions', command),
    testConnector: id => invoke('uah:test-connector', id),
    nativeCodex: command => invoke('uah:native-codex', command),
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
