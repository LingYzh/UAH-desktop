import { snackbar } from '@lingyzh/ui';
import { parseExternalUrl } from '../shared/external-url';

export async function openMarkdownLink(href) {
    try {
        const url = parseExternalUrl(href);
        if (window.uah?.openExternal) await window.uah.openExternal(url);
        else window.open(url, '_blank', 'noopener,noreferrer');
    } catch (error) {
        snackbar.show(error instanceof Error ? error.message : '无法打开链接。', { tone: 'error' });
    }
}
