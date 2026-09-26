import { BrowserWindow, WebContentsView, session } from 'electron';
import type { BrowserAction, BrowserState } from '../shared/contracts';
import { remoteUrl } from './security';

export class BrowserHost {
    private views = new Map<string, WebContentsView>();
    private current: string | null = null;

    constructor(private window: BrowserWindow) {}

    async execute(action: BrowserAction): Promise<BrowserState> {
        if (action.type === 'hide' || action.type === 'close') {
            const current = this.current && this.views.get(this.current);
            if (current) {
                current.setVisible(false);
                if (action.type === 'close') {
                    this.window.contentView.removeChildView(current);
                    current.webContents.close();
                    this.views.delete(this.current!);
                    this.current = null;
                }
            }
            return { url: current ? current.webContents.isDestroyed() ? '' : current.webContents.getURL() : '', visible: false };
        }
        let view = this.views.get(action.sessionId);
        if (action.type === 'open') {
            await this.execute({ type: 'hide' });
            if (!view) {
                if (this.views.size >= 8) throw new Error('最多同时保留 8 个会话浏览器，请先关闭一个。');
                const profile = session.fromPartition(`persist:uah-browser-${action.sessionId}`);
                profile.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
                profile.setPermissionCheckHandler(() => false);
                profile.on('will-download', (event) => event.preventDefault());
                view = new WebContentsView({ webPreferences: {
                    session: profile, nodeIntegration: false, contextIsolation: true, sandbox: true,
                    webSecurity: true, allowRunningInsecureContent: false
                } });
                view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
                const checkNavigation = (event: Electron.Event, url: string) => {
                    try { remoteUrl(url); } catch { event.preventDefault(); }
                };
                view.webContents.on('will-navigate', checkNavigation);
                view.webContents.on('will-redirect', checkNavigation);
                view.webContents.on('will-attach-webview', (event) => event.preventDefault());
                this.views.set(action.sessionId, view);
                this.window.contentView.addChildView(view);
                view.setBounds({ x: 0, y: 0, width: 0, height: 0 });
                view.setVisible(false);
            }
            this.current = action.sessionId;
            try {
                await view.webContents.loadURL(remoteUrl(action.url));
            } catch {
                return { url: action.url, visible: false, error: '页面加载失败，请检查地址或网络。' };
            }
            return { url: view.webContents.getURL(), visible: false };
        }
        if (!view) return { url: '', visible: false };
        if (this.current !== action.sessionId) {
            await this.execute({ type: 'hide' });
            this.current = action.sessionId;
        }
        const [width, height] = this.window.getContentSize();
        // DOM rectangles use CSS pixels; native views use device-independent pixels.
        const zoom = this.window.webContents.getZoomFactor();
        const x = Math.min(Math.round(action.x * zoom), width);
        const y = Math.min(Math.round(action.y * zoom), height);
        const bounds = { x, y, width: Math.min(Math.floor(action.width * zoom), width - x), height: Math.min(Math.floor(action.height * zoom), height - y) };
        view.setBounds(bounds);
        const visible = bounds.width >= 100 && bounds.height >= 100;
        view.setVisible(visible);
        return { url: view.webContents.getURL(), visible };
    }

    dispose() {
        for (const view of this.views.values()) {
            this.window.contentView.removeChildView(view);
            if (!view.webContents.isDestroyed()) view.webContents.close();
        }
        this.views.clear();
    }
}
