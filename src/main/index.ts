import { app, BrowserWindow, dialog, ipcMain, protocol, session, type IpcMainInvokeEvent } from 'electron';
import { realpath, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseCommand } from '../shared/contracts';
import { RuntimeClient } from './runtime-client';
import { BrowserHost } from './browser-host';
import { NativeClient } from './native-client';
import { APP_URL, parseBrowserAction, trustedRendererUrl } from './security';

protocol.registerSchemesAsPrivileged([{ scheme: 'uah', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.UAH_DATA_DIR) app.setPath('userData', path.resolve(process.env.UAH_DATA_DIR));
const developmentUrl = !app.isPackaged ? process.env.UAH_DEV_URL : undefined;
if (developmentUrl && !trustedRendererUrl(developmentUrl, developmentUrl)) throw new Error('Only the local Vite server is supported.');
let window: BrowserWindow | null = null;
let runtime: RuntimeClient;
let browser: BrowserHost;
let native: NativeClient;
let quitting = false;
let closing = false;
const selectedDirectories = new Set<string>();
let browserIntent = 0;

function assertSender(event: IpcMainInvokeEvent) {
    if (!window || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
        || !trustedRendererUrl(event.senderFrame.url, developmentUrl)) throw new Error('拒绝非主界面的请求。');
}

app.whenReady().then(async () => {
    const rendererRoot = path.resolve(__dirname, '../renderer');
    protocol.handle('uah', async (request) => {
        const url = new URL(request.url);
        let pathname: string;
        try { pathname = decodeURIComponent(url.pathname); } catch { return new Response('Bad request', { status: 400 }); }
        const target = path.resolve(rendererRoot, `.${pathname}`);
        const relative = path.relative(rendererRoot, target);
        if (url.host !== 'app' || relative.startsWith('..') || path.isAbsolute(relative)) return new Response('Forbidden', { status: 403 });
        try {
            const mime: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
            return new Response(await readFile(target), { headers: {
                'Content-Type': mime[path.extname(target)] || 'application/octet-stream',
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
            } });
        } catch { return new Response('Not found', { status: 404 }); }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.defaultSession.setPermissionCheckHandler(() => false);
    window = new BrowserWindow({
        title: 'UAH', width: 1440, height: 960, minWidth: 800, minHeight: 600,
        backgroundColor: '#FAF9F5', autoHideMenuBar: true,
        titleBarStyle: 'hidden', titleBarOverlay: { height: 35, color: '#f0eee6', symbolColor: '#73716a' },
        webPreferences: { preload: path.join(__dirname, '../preload/index.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => { if (!trustedRendererUrl(url, developmentUrl)) event.preventDefault(); });
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    runtime = new RuntimeClient(path.join(__dirname, '../runtime/worker.cjs'), app.getPath('userData'), (event) => {
        if (window && !window.isDestroyed()) window.webContents.send('uah:event', event);
    });
    browser = new BrowserHost(window);
    native = new NativeClient(path.join(app.getAppPath(), 'native/UAH.NativeHelper/bin/Release/net10.0-windows/UAH.NativeHelper.exe'));
    ipcMain.handle('uah:command', async (event, value) => {
        assertSender(event);
        const command = parseCommand(value);
        if (command.type === 'create-session' && command.directory !== null) {
            const canonical = await realpath(command.directory);
            if (!selectedDirectories.has(canonical)) throw new Error('请通过系统文件夹选择器选择目录。');
            command.directory = canonical;
        }
        return runtime.execute(command);
    });
    ipcMain.handle('uah:choose-directory', async (event) => {
        assertSender(event);
        browserIntent++;
        await browser.execute({ type: 'hide' });
        const result = await dialog.showOpenDialog(window!, { title: '选择工作目录', properties: ['openDirectory'] });
        if (result.canceled || !result.filePaths[0]) return null;
        const canonical = await realpath(result.filePaths[0]);
        selectedDirectories.add(canonical);
        return canonical;
    });
    ipcMain.handle('uah:browser', async (event, value) => {
        assertSender(event);
        const action = parseBrowserAction(value);
        const generation = ++browserIntent;
        if ('sessionId' in action) {
            const snapshot = await runtime.execute({ type: 'snapshot' });
            if (generation !== browserIntent) return { url: '', visible: false };
            if (!snapshot.sessions.some((item) => item.id === action.sessionId)) throw new Error('会话不存在。');
        }
        return browser.execute(action);
    });
    ipcMain.handle('uah:observe-desktop', async (event) => {
        assertSender(event);
        browserIntent++;
        await browser.execute({ type: 'hide' });
        return native.observe();
    });
    ipcMain.handle('uah:window-theme', (event, theme) => {
        assertSender(event);
        if (theme !== 'light' && theme !== 'dark') throw new Error('无效的窗口主题。');
        window!.setTitleBarOverlay({ height: 35, color: theme === 'dark' ? '#20201e' : '#f0eee6', symbolColor: theme === 'dark' ? '#b2afa3' : '#73716a' });
    });
    await window.loadURL(developmentUrl || APP_URL);
}).catch((error) => {
    dialog.showErrorBox('UAH 启动失败', error instanceof Error ? error.message : '无法启动。');
    app.quit();
});

app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    Promise.all([runtime?.shutdown(), native?.shutdown()]).then(() => {
        browser?.dispose();
        quitting = true;
        app.quit();
    }).catch((error) => {
        closing = false;
        dialog.showErrorBox('任务尚未停止', error instanceof Error ? error.message : '尚未收到退出确认。');
    });
});
app.on('window-all-closed', () => app.quit());
app.on('browser-window-created', (_event, createdWindow) => {
    createdWindow.on('close', (event) => {
        if (!quitting) { event.preventDefault(); app.quit(); }
    });
});
