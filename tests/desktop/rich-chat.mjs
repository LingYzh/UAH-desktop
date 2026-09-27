import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'rich-chat-'));
const errors = []; const passed = []; const metrics = [];
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const delta = content => sse({ choices: [{ delta: { content }, finish_reason: null }] });
const normalize = value => value.replace(/\s/g, '');
const bursts = [1, 2, 3].map(stage => Array.from({ length: 50 }, (_, index) => `Stage ${stage} line ${index + 1}: streamed fixture presentation follows actual growth.\n\n`).join(''));
// Each burst remains below the pacer's deliberate 4096-character bypass bound.
assert.ok(bursts.every(value => value.length < 4096));
let responseStream;
const server = http.createServer(async (request, response) => {
    try {
        for await (const _chunk of request) { /* consume isolated request */ }
        response.writeHead(200, { 'content-type': 'text/event-stream' }); response.flushHeaders();
        responseStream = response;
    } catch (error) { errors.push(String(error)); response.destroy(); }
});
const blocked = new Set([3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
while (true) {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    if (!blocked.has(server.address().port)) break;
    await new Promise(resolve => server.close(resolve));
}
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE; delete environment.UAH_DEV_URL;
let desktop; let page;
async function poll(predicate, label, duration = 15000) {
    const end = Date.now() + duration;
    while (Date.now() < end) { const value = await predicate(); if (value) return value; await page.waitForTimeout(10); }
    throw new Error(`Timed out: ${label}`);
}
async function view() {
    return page.evaluate(() => {
        const markdown = document.querySelector('.turn:last-child .assistant-message .ui-markdown');
        const scroll = document.querySelector('.chat-scroll');
        return { text: markdown?.textContent || '', busy: markdown?.getAttribute('aria-busy'), top: scroll.scrollTop, height: scroll.scrollHeight, viewport: scroll.clientHeight };
    });
}
try {
    desktop = await electron.launch({ args: ['.'], cwd: root, env: environment, timeout: 30000 });
    page = await desktop.firstWindow(); page.setDefaultTimeout(15000);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await desktop.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1100, 760); window.webContents.setZoomFactor(1); });
    await page.evaluate(url => (async () => {
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Rich fixture', protocol: 'openai-chat', baseUrl: url, models: ['fixture-model'], enabled: true, revision: 0, apiKey: null } });
        await window.uah.command({ type: 'create-session', title: 'Streaming fixture', directory: null, selection: { endpointId: saved.endpoints[0].id, modelId: 'fixture-model' }, agentId: 'default', controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
    })(), `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Local streaming fixture only.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await poll(() => responseStream, 'fixture stream connected');
    responseStream.write(delta(bursts[0]));
    const partial = await poll(async () => { const value = await view(); const length = normalize(value.text).length; return length > 0 && length < normalize(bursts[0]).length ? value : false; }, 'partial rendered burst');
    const burstState = await page.evaluate(() => window.uah.command({ type: 'snapshot' }));
    assert.equal(burstState.runs[0].output, bursts[0]);
    metrics.push({ phase: 'partial', rendered: normalize(partial.text).length, source: normalize(bursts[0]).length });
    passed.push('a burst renders progressively instead of appearing all at once');
    await poll(async () => normalize((await view()).text) === normalize(bursts[0]), 'first burst rendered');
    // Text publication precedes ResizeObserver and the next animation-frame follow.
    const initial = await poll(async () => {
        const value = await view();
        return value.height - value.viewport - value.top < 60 ? value : false;
    }, 'first burst bottom follow');
    assert.ok(initial.height > initial.viewport + 100);
    assert.ok(initial.height - initial.viewport - initial.top < 60);
    await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(60);
    responseStream.write(delta(bursts[1]));
    await poll(async () => normalize((await view()).text) === normalize(bursts[0] + bursts[1]), 'second burst rendered');
    const scrolledUp = await view(); assert.ok(scrolledUp.top < 5, `Unexpected pull to ${scrolledUp.top}`);
    metrics.push({ phase: 'scrolled-up', ...scrolledUp, text: undefined });
    passed.push('new streaming content preserves an explicit scroll toward earlier messages');
    await page.locator('.chat-scroll').evaluate(element => { element.scrollTop = element.scrollHeight; element.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(60);
    responseStream.write(delta(bursts[2]));
    const following = await poll(async () => { const value = await view(); return value.height > scrolledUp.height + 50 && value.height - value.viewport - value.top < 60 ? value : false; }, 'bottom follows rendered growth');
    metrics.push({ phase: 'following', ...following, text: undefined });
    passed.push('bottom follow tracks presentation growth between provider messages');
    responseStream.end(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    await poll(async () => { const value = await view(); return value.busy === 'false' && normalize(value.text) === normalize(bursts.join('')); }, 'complete final presentation');
    const state = await page.evaluate(() => window.uah.command({ type: 'snapshot' }));
    assert.equal(state.runs[0].output, bursts.join('')); assert.equal(state.runs[0].state, 'completed');
    passed.push('terminal rendering contains the full immutable provider output');
    const png = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, 'stream-completed.png'), Buffer.from(png.split(',')[1], 'base64'));
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed, metrics, errors }, null, 2));
    for (const label of passed) console.log(`PASS ${label}`);
    console.log(`Evidence: ${evidence}`);
} finally {
    if (desktop) await desktop.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
