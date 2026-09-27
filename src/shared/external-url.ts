/** Only explicit user-activated Markdown web/mail links can leave the renderer. */
export function parseExternalUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 8192 || /[\u0000-\u001f\u007f]/.test(value)) throw new TypeError('链接地址无效。');
    let url: URL;
    try { url = new URL(value); } catch { throw new TypeError('链接地址无效。'); }
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password) throw new TypeError('仅允许网页或邮件链接。');
    if (url.protocol === 'mailto:') {
        if (!url.pathname || /%0[ad]/i.test(url.href)) throw new TypeError('邮件链接无效。');
    } else if (!url.hostname) throw new TypeError('网页地址无效。');
    return url.href;
}
