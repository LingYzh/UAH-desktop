import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExternalUrl } from '../../src/shared/external-url';
test('external Markdown links allow web and mail but cannot open files, scripts or shell handlers', () => {
    assert.equal(parseExternalUrl('https://example.com/docs?q=hello#part'), 'https://example.com/docs?q=hello#part');
    assert.equal(parseExternalUrl('mailto:hello@example.com'), 'mailto:hello@example.com');
    for (const url of ['file:///C:/secret', 'javascript:alert(1)', 'data:text/html,hello', 'ms-settings:test', '../relative', 'https://name:pass@example.com', 'mailto:hello@example.com?subject=a%0d%0ab', 'https://example.com\n']) assert.throws(() => parseExternalUrl(url));
});
