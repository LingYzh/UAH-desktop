import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(); await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'steer-desktop-')); const project = path.join(evidence, 'project'); await mkdir(project);
const target = path.join(project, 'fixture.txt'); const original = 'OLD FILE MUST REMAIN\r\n'; await writeFile(target, original);
const requests = []; const errors = []; const consoleErrors = []; const checks = []; const screenshots = []; const geometries = []; const runs = [];
const pending = new Map(); const readiness = new Map();
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
function ready(prompt) { if (pending.has(prompt)) return Promise.resolve(); return new Promise(resolve => readiness.set(prompt, resolve)); }
const server = http.createServer(async (request, response) => {
    try {
        const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
        const task = body.messages.findLast(message => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('[UAH'))?.content;
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (task?.startsWith('STEER INITIAL ')) {
            response.write(': local fixture holds the current model step\n\n');
            pending.set(task, response); readiness.get(task)?.(); readiness.delete(task);
        } else {
            assert.ok(task?.startsWith('Supplement '), 'following request contains the supplement as its new user task');
            response.end(frame({ choices: [{ index: 0, delta: { content: 'Supplement applied. Old edit skipped.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
        }
    } catch (error) { errors.push(String(error)); response.destroy(); }
});
for (let attempt = 0; attempt < 32; attempt++) {
    try {
        await new Promise((resolve, reject) => { const failed = error => { server.off('listening', listening); reject(error); }; const listening = () => { server.off('error', failed); resolve(); }; server.once('error', failed); server.once('listening', listening); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
}
assert.ok(server.address() && server.address().port >= 20000);
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page;
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); console.log(`PASS ${label}`); };
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
async function capture(name, theme, width, height, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, { width, height, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, height); window.webContents.setZoomFactor(zoom); }, { width, height, zoom });
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const geometry = await page.evaluate(() => {
        const composer = document.querySelector('.composer'); const turn = document.querySelector('.turn:last-child');
        const bounds = composer.getBoundingClientRect();
        return { viewport: { width: innerWidth, height: innerHeight }, document: { client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth },
            composer: { client: composer.clientWidth, scroll: composer.scrollWidth, left: bounds.left, right: bounds.right }, turn: { client: turn.clientWidth, scroll: turn.scrollWidth } };
    });
    geometries.push({ name, ...geometry });
    check(`${name}: document, turn and composer have no horizontal overflow`, geometry.document.scroll <= geometry.document.client + 1 && geometry.composer.scroll <= geometry.composer.client + 1 && geometry.turn.scroll <= geometry.turn.client + 1 && geometry.composer.left >= -1 && geometry.composer.right <= geometry.viewport.width + 1);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL()); await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64')); screenshots.push(name);
}
try {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    const endpointId = await page.evaluate(async ({ project, baseUrl }) => {
        const directory = await window.uah.chooseDirectory(); if (directory !== project) throw new Error('Fixture project not approved');
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Steer local SSE', protocol: 'openai-chat', baseUrl, models: ['steer-model'], modelDetails: [{ id: 'steer-model', tools: true }], enabled: true, revision: 0, apiKey: null } }); return saved.endpoints[0].id;
    }, { project, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    for (const method of ['button', 'enter']) {
        const prompt = `STEER INITIAL ${method}`; const supplement = `Supplement ${method}: **preserve the file** and report the result.\n\n- Skip the old edit.\n- Keep the existing content unchanged.`;
        const title = `Steer fixture ${method}`;
        const sessionId = await page.evaluate(async ({ project, endpointId, title }) => {
            const before = await window.uah.command({ type: 'snapshot' });
            const created = await window.uah.command({ type: 'create-session', title, directory: project, selection: { endpointId, modelId: 'steer-model' }, agentId: 'default', controls: { permissionMode: 'auto', reasoningEffort: 'default' } }); return created.sessions.find(session => !before.sessions.some(prior => prior.id === session.id)).id;
        }, { project, endpointId, title });
        await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
        await page.locator('.session-button').filter({ has: page.getByText(title, { exact: true }) }).click();
        await page.evaluate(() => { window.__steerTerminals = {}; window.__steerUnsubscribe = window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__steerTerminals[event.runId] = event.payload.run; }); });
        const composer = page.getByRole('textbox', { name: '消息', exact: true }); await composer.fill(prompt); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await ready(prompt);
        const active = (await snapshot()).runs.find(run => run.sessionId === sessionId); assert.ok(active?.activeStepId);
        const button = page.getByRole('button', { name: '补充指令', exact: true }); await button.waitFor();
        check(`${method}: supplement button disables empty input`, await button.isDisabled());
        check(`${method}: stop remains available during pending SSE`, await page.getByRole('button', { name: '停止当前任务', exact: true }).isEnabled());
        const draft = `Draft must survive rejected step (${method})`; await composer.fill(draft);
        const rejected = await page.evaluate(async ({ runId, stepId }) => { try { await window.uah.command({ type: 'steer-run', runId, expectedStepId: stepId, input: 'stale supplemental request' }); return false; } catch { return true; } }, { runId: active.id, stepId: randomUUID() });
        check(`${method}: stale-step IPC rejects without clearing the composer draft`, rejected && await composer.inputValue() === draft);
        await composer.fill(supplement); if (method === 'button') await button.click(); else await composer.press('Enter');
        const entry = page.locator('.turn [aria-label="补充指令"]').filter({ hasText: `Supplement ${method}` }); await entry.getByText('等待安全边界', { exact: true }).waitFor();
        check(`${method}: queued supplement is visible before the old response completes`, await entry.isVisible() && !pending.get(prompt).writableEnded);
        const queued = (await snapshot()).runs.find(run => run.id === active.id); assert.equal(queued.steering.length, 1); assert.equal(queued.steering[0].status, 'queued'); assert.equal(queued.steering[0].input, supplement);
        assert.equal(await composer.inputValue(), '');
        await page.waitForFunction(() => document.querySelector('button[aria-label="停止当前任务"]')?.disabled === false);
        check(`${method}: stop remains enabled after queued steering`, await page.getByRole('button', { name: '停止当前任务', exact: true }).isEnabled());
        await capture(`steer-${method}-queued-light-1440.png`, 'light', 1440, 900, 1);
        await capture(`steer-${method}-queued-dark-900-125.png`, 'dark', 900, 800, 1.25);
        pending.get(prompt).end(frame({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `old-write-${method}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'fixture.txt', expectedContent: original, content: 'OLD WRITE MUST NEVER EXECUTE' }) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
        await page.waitForFunction(id => Boolean(window.__steerTerminals[id]), active.id, { timeout: 30000 });
        const completed = (await snapshot()).runs.find(run => run.id === active.id); runs.push(completed);
        check(`${method}: following request completes with applied supplement`, completed.state === 'completed' && completed.steering[0].status === 'applied');
        const continuation = requests.find(body => body.messages.some(message => message.role === 'user' && message.content === supplement)); assert.ok(continuation);
        const skipped = completed.activities?.find(activity => activity.tool?.name === 'write_file')?.tool?.outcome;
        check(`${method}: fresh request includes new user input and skipped old write has no disk effect`, continuation.messages.some(message => message.role === 'user' && message.content === supplement) && await readFile(target, 'utf8') === original && skipped?.effectState === 'not_started' && skipped?.errorCode === 'CONTROL_SUPERSEDED');
        await entry.getByText('已加入后续上下文', { exact: true }).waitFor();
        await capture(`steer-${method}-applied-dark-900-125.png`, 'dark', 900, 800, 1.25);
        await capture(`steer-${method}-applied-light-1440.png`, 'light', 1440, 900, 1);
        await page.evaluate(() => { window.__steerUnsubscribe(); delete window.__steerUnsubscribe; delete window.__steerTerminals; });
    }
    check('both steering methods keep the fixture free of artifacts and extra model requests', (await snapshot()).artifacts.length === 0 && requests.length === 4);
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, geometries, runs, requests, errors, consoleErrors }, null, 2)); console.log(`PASS steer desktop: ${evidence}`);
} catch (error) {
    if (app) { try { const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL()); await writeFile(path.join(evidence, 'failure.png'), Buffer.from(data.split(',')[1], 'base64')); } catch {} }
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, failure: String(error), checks, screenshots, geometries, runs, requests, snapshot: page ? await snapshot().catch(() => null) : null, errors, consoleErrors }, null, 2)); console.error(`Steer failure evidence: ${evidence}`); throw error;
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
