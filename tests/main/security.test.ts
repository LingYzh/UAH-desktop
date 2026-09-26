import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBrowserAction, remoteUrl, trustedRendererUrl } from '../../src/main/security';

test('renderer trust rejects remote, subdocument and spoofed local URLs', () => {
    assert.equal(trustedRendererUrl('uah://app/index.html'), true);
    for (const url of ['https://app/index.html', 'uah://other/index.html', 'uah://app/evil.html', 'file:///index.html']) assert.equal(trustedRendererUrl(url), false);
    assert.equal(trustedRendererUrl('http://127.0.0.1:5173/', 'http://127.0.0.1:5173'), true);
    assert.equal(trustedRendererUrl('http://127.0.0.1:5173/remote', 'http://127.0.0.1:5173'), false);
    assert.equal(trustedRendererUrl('http://127.0.0.1:5174/', 'http://127.0.0.1:5173'), false);
});

test('remote navigation does not accept script, file, HTTP or credential-bearing URLs', () => {
    assert.equal(remoteUrl('https://example.com'), 'https://example.com/');
    for (const url of ['javascript:alert(1)', 'file:///C:/secret', 'http://example.com', 'https://user:secret@example.com', 'data:text/html,hi']) assert.throws(() => remoteUrl(url));
});

test('browser IPC rejects malformed bounds, identities and extra fields', () => {
    assert.deepEqual(parseBrowserAction({ type: 'hide' }), { type: 'hide' });
    assert.throws(() => parseBrowserAction({ type: 'hide', script: 'evil' }));
    assert.throws(() => parseBrowserAction({ type: 'bounds', sessionId: '../elsewhere', x: 0, y: 0, width: 100, height: 100 }));
    assert.throws(() => parseBrowserAction({ type: 'bounds', sessionId: 'session-1', x: NaN, y: 0, width: 100, height: 100 }));
});
