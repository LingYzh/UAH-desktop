import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomInt } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'recovery-desktop-'));
const project = path.join(evidence, 'project'); await mkdir(project);
const file = path.join(project, 'evidence.txt'); await writeFile(file, 'original evidence');
const requests = []; const errors = []; const checks = []; const screenshots = [];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const server = http.createServer(async (request, response) => {
    try {
        const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        const user = body.messages.findLast(item => item.role === 'user')?.content;
        if (user?.includes('用户续接要求')) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frame({ choices: [{ delta: { content: 'Continued using saved evidence.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
        } else if (body.messages.some(item => item.role === 'tool')) {
            response.writeHead(400, { 'content-type': 'application/json' }); response.end('{"error":"fixture permanent failure"}');
        } else {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'read-evidence', type: 'function', function: { name: 'read_file', arguments: '{"path":"evidence.txt"}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
        }
    } catch (cause) { errors.push(String(cause)); response.destroy(); }
});
for (let attempt = 0; attempt < 32; attempt++) {
    try { await new Promise((resolve, reject) => {
        const failed = cause => { server.off('listening', listening); reject(cause); };
        const listening = () => { server.off('error', failed); resolve(); };
        server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1');
    }); break; } catch (cause) { if (cause.code !== 'EADDRINUSE') throw cause; }
}
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
async function launch() {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', cause => errors.push(cause.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
}
async function capture(name, theme, width, height, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, bounds) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(bounds.width, bounds.height); win.webContents.setZoomFactor(bounds.zoom); }, { width, height, zoom });
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    const geometry = await page.getByRole('dialog', { name: '核对并继续', exact: true }).evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, body: document.documentElement.scrollWidth, viewport: innerWidth }));
    check(`${name} has no horizontal overflow`, geometry.scroll <= geometry.client + 1 && geometry.body <= geometry.viewport + 1);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64')); screenshots.push(name);
}
async function waitTerminal(count) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { const current = await snapshot(); if (current.runs.length === count && current.runs.every(run => ['failed', 'stopped', 'completed'].includes(run.state))) return current; await delay(100); }
    throw new Error('Recovery fixture terminal timeout');
}
try {
    await launch();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    const sessionId = await page.evaluate(async ({ project, url }) => {
        if (await window.uah.chooseDirectory() !== project) throw new Error('Fixture directory approval failed');
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Recovery fixture', protocol: 'openai-chat', baseUrl: url, models: ['model'], modelDetails: [{ id: 'model', tools: true }], enabled: true, revision: 0, apiKey: null } });
        const created = await window.uah.command({ type: 'create-session', title: 'Recovery fixture', directory: project, selection: { endpointId: saved.endpoints[0].id, modelId: 'model' }, agentId: 'default', controls: { permissionMode: 'auto', reasoningEffort: 'default' } });
        return created.sessions[0].id;
    }, { project, url: `http://127.0.0.1:${server.address().port}/v1` });
    await page.reload();
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.locator('.session-button').filter({ hasText: 'Recovery fixture' }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Read evidence then report.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const before = await waitTerminal(1); const original = before.runs[0];
    check('fixture persists a failed run after one real read', original.state === 'failed' && requests.length === 2);
    await app.close(); app = null;
    await writeFile(file, 'changed externally after stop');
    await launch();
    await page.getByRole('button', { name: '核对并继续', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '核对并继续', exact: true });
    await dialog.getByText('文件已变化', { exact: true }).waitFor();
    check('changed evidence requires a written review and cannot immediately resume', await dialog.getByRole('button', { name: '保存核对结论', exact: true }).isDisabled() && await dialog.getByRole('button', { name: '追加预算并继续', exact: true }).count() === 0);
    check('inspection after restart sends no requests', requests.length === 2);
    await capture('changed-light-1440.png', 'light', 1440, 900, 1);
    await capture('changed-dark-900-125.png', 'dark', 900, 800, 1.25);
    await dialog.getByRole('textbox', { name: '核对结论', exact: true }).fill('I inspected the external file edit; preserve its new content.');
    await dialog.getByRole('button', { name: '保存核对结论', exact: true }).click();
    await dialog.getByRole('button', { name: '追加预算并继续', exact: true }).waitFor();
    check('saving review alone sends no request', requests.length === 2);
    await capture('reviewed-dark-900-125.png', 'dark', 900, 800, 1.25);
    await dialog.getByRole('textbox', { name: '继续要求', exact: true }).fill('Continue from the saved read; preserve the changed file.');
    const button = dialog.getByRole('button', { name: '追加预算并继续', exact: true }); await button.focus(); await button.press('Enter');
    const after = await waitTerminal(2); const continued = after.runs.find(run => run.resumeOfRunId === original.id);
    check('keyboard continuation creates a linked new run with cumulative budget', continued?.state === 'completed' && continued.budgetState.requestsUsed === original.budgetState.requestsUsed + 1);
    check('original tool is not replayed and external edit stays intact', requests.length === 3 && await readFile(file, 'utf8') === 'changed externally after stop');
    check('continuation retains original failed history', after.runs.find(run => run.id === original.id).state === 'failed');
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, requests: requests.length, sessionId, errors }, null, 2));
    console.log(`PASS recovery desktop: ${evidence}`);
} catch (cause) {
    if (app) { try { await capture('failure.png', 'dark', 900, 800, 1.25); } catch {} }
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, failure: String(cause), checks, screenshots, errors }, null, 2)); throw cause;
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
