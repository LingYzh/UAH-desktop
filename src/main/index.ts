import { clientError } from '../shared/client-error.js';
import { AttachmentStore } from './attachment-store';
import { app, BrowserWindow, clipboard, dialog, ipcMain, protocol, safeStorage, session, shell, type IpcMainInvokeEvent } from 'electron';
import { parseExternalUrl } from '../shared/external-url';
import { realpath, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { parseCommand } from '../shared/contracts';
import { RuntimeClient } from './runtime-client';
import { BrowserHost } from './browser-host';
import { NativeClient } from './native-client';
import { APP_URL, parseBrowserAction, trustedRendererUrl } from './security';
import { parseEndpointCommand } from '../shared/endpoints';
import { EndpointStore } from './endpoint-store';
import { parseAgentCommand } from '../shared/agents';
import { parseDelegationPreview } from '../shared/delegation';
import { parseGitQuery } from '../shared/git';
import { parseContextQuery } from '../shared/request-context';
import { parseJournalQuery } from '../shared/journal-view';
import { parseSnapshotView } from '../shared/snapshot-view';
import { randomUUID } from 'node:crypto';
import { ExtensionStore } from './extension-store';
import { parseExtensionCommand } from '../shared/extensions';
import { NativeCodexStore } from './native-codex-store';
import { discoverNativeCodex } from './native-codex-discovery';
import { parseNativeCodexSettings } from '../shared/native-codex';

protocol.registerSchemesAsPrivileged([{ scheme: 'uah', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
if (process.env.UAH_DATA_DIR) app.setPath('userData', path.resolve(process.env.UAH_DATA_DIR));
// The journal and destructive maintenance require one desktop owner per userData.
// Electron owns/reclaims this OS-backed lock; no PID-based stale-lock deletion.
if (!app.requestSingleInstanceLock()) app.exit(0);
app.on('second-instance', () => { if (window && !window.isDestroyed()) { if (window.isMinimized()) window.restore(); window.focus(); } });
const developmentUrl = !app.isPackaged ? process.env.UAH_DEV_URL : undefined;
if (developmentUrl && !trustedRendererUrl(developmentUrl, developmentUrl)) throw new Error('Only the local Vite server is supported.');
let window: BrowserWindow | null = null;
let runtime: RuntimeClient;
let browser: BrowserHost;
let native: NativeClient;
let endpoints: EndpointStore;
let extensions: ExtensionStore;
let nativeCodex: NativeCodexStore;
let extensionBusy = false;
let probingEndpoint = false;
let quitting = false;
let closing = false;
const selectedDirectories = new Set<string>();
const attachmentStore = new AttachmentStore();
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
                'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: http: https:; connect-src 'self'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'"
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
    endpoints = new EndpointStore(app.getPath('userData'), safeStorage);
    extensions = new ExtensionStore(app.getPath('userData'), safeStorage, path.resolve(__dirname, '../builtin-skills'));
    nativeCodex = new NativeCodexStore(app.getPath('userData'));
    runtime = new RuntimeClient(path.join(__dirname, '../runtime/worker.cjs'), app.getPath('userData'), (event) => {
        if (window && !window.isDestroyed()) window.webContents.send('uah:event', event);
    }, (id) => endpoints.resolve(id), {
        executionHelperPath: path.join(app.getAppPath(), 'native/UAH.ExecutionHelper/bin/Release/net10.0-windows/UAH.ExecutionHelper.exe'),
        resolveExtensions: () => ({ connectors: extensions.resolveConnectors(), skills: extensions.skillCatalogForRuntime(), native: nativeCodex.get() }),
        listProviders: () => endpoints.listProviders(),
        readSkill: (id, relativePath) => extensions.readSkill(id, relativePath),
    });
    browser = new BrowserHost(window);
    ipcMain.handle('uah:extensions', async (event, value) => {
        assertSender(event);
        if (closing || extensionBusy) throw new Error('扩展操作正在进行，请稍后重试。');
        const command = parseExtensionCommand(value);
        extensionBusy = true;
        try { return await extensions.execute(command); }
        finally { extensionBusy = false; }
    });
    ipcMain.handle('uah:test-connector', async (event, id) => {
        assertSender(event);
        if (closing || typeof id !== 'string' || id.length > 200) throw new Error('连接器标识无效。');
        return runtime.testConnector(id);
    });
    ipcMain.handle('uah:native-codex', async (event, command) => {
        assertSender(event);
        if (closing || !command || typeof command !== 'object' || !['get', 'save', 'probe', 'discover'].includes(command.type)
            || Object.keys(command).some(key => !['type', ...(['save', 'probe'].includes(command.type) ? ['settings'] : [])].includes(key))) throw new Error('原生运行时操作无效。');
        if (command.type === 'save') return { settings: nativeCodex.save(command.settings) };
        const settings = nativeCodex.get();
        if (command.type === 'discover') return { settings, candidates: await discoverNativeCodex() };
        if (command.type === 'probe') {
            const target = command.settings === undefined ? settings : parseNativeCodexSettings(command.settings);
            const probe = await runtime.nativeProbe(target);
            return { settings: nativeCodex.get(), probe, probeTarget: { command: target.command, args: target.args } };
        }
        return { settings };
    });
    native = new NativeClient(path.join(app.getAppPath(), 'native/UAH.NativeHelper/bin/Release/net10.0-windows/UAH.NativeHelper.exe'));
    ipcMain.handle('uah:command', async (event, value, requestedView) => {
        assertSender(event);
        if (value && Object.hasOwn(value, 'attachments')) throw new Error('请使用附件选择入口。');
        const ids = value?.attachmentIds;
        if (ids !== undefined && value?.type !== 'start-run') throw new Error('只有发送消息可以携带附件。');
        const { attachmentIds: _attachmentIds, ...source } = value ?? {};
        const command = parseCommand({ ...source, ...(ids !== undefined ? { attachments: attachmentStore.resolve(ids) } : {}) });
        const view = parseSnapshotView(requestedView);
        if (command.type === 'create-session' && command.directory !== null) {
            const canonical = await realpath(command.directory);
            if (!selectedDirectories.has(canonical)) {
                const snapshot = await runtime.execute({ type: 'snapshot' });
                const latest = snapshot.sessions.reduce<(typeof snapshot.sessions)[number] | undefined>((newest, session) => !newest || session.createdAt >= newest.createdAt ? session : newest, undefined);
                const inherited = latest?.initialConfig?.directory;
                const sourceRun = command.branchFromRunId ? snapshot.runs.find(run => run.id === command.branchFromRunId && !run.parentRunId) : undefined;
                const branchDirectory = sourceRun ? snapshot.sessions.find(session => session.id === sourceRun.sessionId)?.directory : undefined;
                const key = (value: string) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
                if (![inherited, branchDirectory].some(directory => directory && key(directory) === key(canonical))) throw new Error('请通过系统文件夹选择器选择目录。');
            }
            command.directory = canonical;
        }
        const result = await runtime.execute(command, view);
        if (ids !== undefined) attachmentStore.release(ids);
        return result;
    });
    ipcMain.handle('uah:attachments', async (event, value) => {
        assertSender(event);
        if (closing) throw new Error('应用正在退出。');
        if (value?.type === 'release') { attachmentStore.release(value.ids); return; }
        if (value?.type === 'choose') {
            const selected = await dialog.showOpenDialog(window!, { title: '添加附件', properties: ['openFile', 'multiSelections'] });
            return selected.canceled ? [] : attachmentStore.preparePaths(selected.filePaths);
        }
        if (value?.type === 'import') {
            if (!Array.isArray(value.paths) || !Array.isArray(value.images) || value.paths.length + value.images.length > 8) throw new Error('附件列表无效。');
            const added = await attachmentStore.preparePaths(value.paths);
            try {
                for (const image of value.images) added.push(await attachmentStore.prepareImage(image.name, image.bytes));
                attachmentStore.resolve(added.map(item => item.id));
                return added;
            } catch (error) { attachmentStore.release(added.map(item => item.id)); throw error; }
        }
        throw new Error('附件操作无效。');
    });
    ipcMain.handle('uah:git', async (event, value) => {
        assertSender(event);
        if (closing) throw new Error('应用正在退出。');
        const query = parseGitQuery(value);
        if (query.directory !== null) {
            const canonical = await realpath(query.directory);
            const snapshot = await runtime.execute({ type: 'snapshot' });
            const key = (directory: string) => process.platform === 'win32' ? path.resolve(directory).toLowerCase() : path.resolve(directory);
            const granted = [...selectedDirectories, ...snapshot.sessions.flatMap(session => session.directory ? [session.directory] : [])];
            if (!granted.some(directory => key(directory) === key(canonical))) throw new Error('请通过系统文件夹选择器选择目录。');
            query.directory = canonical;
        }
        return runtime.git(query);
    });
    ipcMain.handle('uah:request-context', async (event, value) => {
        assertSender(event);
        if (closing) throw new Error('应用正在退出。');
        return runtime.requestContext(parseContextQuery(value));
    });
    ipcMain.handle('uah:journal-policy', async (event, value) => {
        assertSender(event);
        if (closing) throw new Error('应用正在退出。');
        const { parseJournalPolicyCommand } = await import('../shared/journal-policy');
        return runtime.journalPolicy(parseJournalPolicyCommand(value));
    });
    ipcMain.handle('uah:journal', async (event, value) => {
        assertSender(event);
        if (closing) throw new Error('应用正在退出。');
        const query = parseJournalQuery(value);
        if (query.action === 'purge-confirm' || query.action === 'purge-retry') {
            if (query.action === 'purge-confirm') await runtime.beginSessionPurge(query);
            else {
                const snapshot = await runtime.execute({ type: 'snapshot' }, { sessionId: null });
                if (!snapshot.pendingSessionPurges?.includes(query.sessionId)) throw new Error('没有此会话的待完成删除。');
            }
            browserIntent++;
            try { await browser.purgeSession(query.sessionId); }
            catch {
                return runtime.finishSessionPurge(query.sessionId, false);
            }
            return runtime.finishSessionPurge(query.sessionId, true);
        }
        if (query.action === 'summary' || query.action === 'request' || query.action === 'recovery' || query.action === 'verification' || query.action === 'cleanup-review' || query.action === 'cleanup-confirm' || query.action === 'purge-review') return runtime.journal(query);
        // The worker validates session ownership and flushes before revealing the directory to main.
        const directory = await runtime.journalSessionDirectory({ sessionId: query.sessionId });
        if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw new Error('日志目录不可用。');
        if (!window || window.isDestroyed()) throw new Error('应用窗口已关闭。');
        if (query.action === 'open') {
            const error = await shell.openPath(directory);
            if (error) throw new Error('无法打开日志目录。');
            return { opened: true };
        }
        const selected = await dialog.showOpenDialog(window, { title: '选择日志导出位置', properties: ['openDirectory', 'createDirectory'] });
        if (!window || window.isDestroyed()) throw new Error('应用窗口已关闭。');
        if (selected.canceled || !selected.filePaths[0]) return null;
        const parentDirectory = await realpath(selected.filePaths[0]);
        const destination = path.join(parentDirectory, `UAH-transcript-${randomUUID()}`);
        return runtime.journalExport({ sessionId: query.sessionId, destination, mode: query.mode });
    });
    ipcMain.handle('uah:agents', async (event, value) => {
        assertSender(event);
        if (closing) throw new Error('应用正在退出。');
        return runtime.agentOperation(parseAgentCommand(value));
    });
    ipcMain.handle('uah:delegation-preview', async (event, value) => {
        assertSender(event);
        if (closing) throw new Error('应用正在退出。');
        return runtime.delegationPreview(parseDelegationPreview(value));
    });
    ipcMain.handle('uah:endpoints', async (event, value) => {
        assertSender(event);
        const command = parseEndpointCommand(value);
        if (closing) throw new Error('应用正在退出。');
        if (command.type === 'list') return { endpoints: endpoints.list() };
        if (command.type === 'save') return { endpoints: endpoints.save(command.draft) };
        if (command.type === 'delete') return { endpoints: endpoints.delete(command.id, command.revision) };
        if (probingEndpoint) throw new Error('请等待当前端点测试完成。');
        const connection = endpoints.preview(command.draft);
        probingEndpoint = true;
        try {
            const result = await runtime.apiOperation(connection, command.type, command.type === 'test' ? command.modelId : undefined);
            return { endpoints: endpoints.list(), ...(command.type === 'discover' ? result : { tested: true, testResult: result }) };
        } finally { probingEndpoint = false; }
    });
    ipcMain.handle('uah:open-logs', async (event) => {
        assertSender(event);
        const directory = path.join(app.getPath('userData'), 'logs');
        await mkdir(directory, { recursive: true });
        const failure = await shell.openPath(directory);
        if (failure) throw new Error('无法打开日志目录。');
    });
    ipcMain.handle('uah:open-external', async (event, value) => {
        assertSender(event);
        await shell.openExternal(parseExternalUrl(value));
    });
    ipcMain.handle('uah:write-clipboard', async (event, value) => {
        assertSender(event);
        if (typeof value !== 'string' || value.length > 2_000_000) throw new TypeError('复制内容无效或超过 200 万字符上限。');
        await clipboard.writeText(value);
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
    dialog.showErrorBox('UAH 启动失败', clientError(error));
    app.quit();
});

app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    if (closing) return;
    closing = true;
    Promise.all([runtime?.shutdown(), native?.shutdown()]).then(() => {
        endpoints?.close();
        extensions?.close();
        browser?.dispose();
        quitting = true;
        app.quit();
    }).catch((error) => {
        closing = false;
        dialog.showErrorBox('任务尚未停止', clientError(error));
    });
});
app.on('window-all-closed', () => app.quit());
app.on('browser-window-created', (_event, createdWindow) => {
    createdWindow.on('close', (event) => {
        if (!quitting) { event.preventDefault(); app.quit(); }
    });
});
