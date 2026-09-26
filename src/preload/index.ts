import { contextBridge, ipcRenderer } from 'electron';
import type { DesktopBridge, RuntimeEvent } from '../shared/contracts';

async function invoke(channel: string, argument?: unknown) {
    try {
        return await ipcRenderer.invoke(channel, argument);
    } catch (error) {
        const message = error instanceof Error ? error.message : '操作未完成。';
        throw new Error(message.replace(/^Error invoking remote method '[^']+': (?:Error|TypeError):\s*/, ''));
    }
}

const bridge: DesktopBridge = {
    command: (command) => invoke('uah:command', command),
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
