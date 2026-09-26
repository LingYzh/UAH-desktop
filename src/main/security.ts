import type { BrowserAction } from '../shared/contracts';

export const APP_URL = 'uah://app/index.html';

export function trustedRendererUrl(value: string, developmentUrl?: string): boolean {
    try {
        const url = new URL(value);
        if (developmentUrl) {
            const expected = new URL(developmentUrl);
            return expected.hostname === '127.0.0.1' && expected.protocol === 'http:'
                && url.origin === expected.origin && url.pathname === '/';
        }
        return url.protocol === 'uah:' && url.hostname === 'app' && url.pathname === '/index.html'
            && !url.username && !url.password;
    } catch {
        return false;
    }
}

export function remoteUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 4096) throw new Error('地址无效。');
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) throw new Error('内置浏览器仅支持不含凭据的 HTTPS 地址。');
    return url.href;
}

export function parseBrowserAction(value: unknown): BrowserAction {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('浏览器请求无效。');
    const data = value as Record<string, unknown>;
    if (data.type === 'hide' || data.type === 'close') {
        if (Object.keys(data).length !== 1) throw new Error('浏览器请求包含未知字段。');
        return { type: data.type };
    }
    if (typeof data.sessionId !== 'string' || !/^[\w-]{1,128}$/.test(data.sessionId)) throw new Error('会话标识无效。');
    if (data.type === 'open') {
        if (Object.keys(data).some((key) => !['type', 'sessionId', 'url'].includes(key))) throw new Error('浏览器请求包含未知字段。');
        return { type: 'open', sessionId: data.sessionId, url: remoteUrl(data.url) };
    }
    if (data.type === 'bounds') {
        if (Object.keys(data).some((key) => !['type', 'sessionId', 'x', 'y', 'width', 'height'].includes(key))) throw new Error('浏览器请求包含未知字段。');
        for (const key of ['x', 'y', 'width', 'height']) {
            if (!Number.isSafeInteger(data[key]) || (data[key] as number) < 0 || (data[key] as number) > 10000) throw new Error('浏览器布局无效。');
        }
        return data as unknown as BrowserAction;
    }
    throw new Error('不支持的浏览器请求。');
}
