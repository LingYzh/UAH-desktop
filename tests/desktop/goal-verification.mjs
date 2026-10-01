import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomInt, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(); await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'goal-verification-desktop-'));
const project = path.join(evidence, 'project'); await mkdir(project);
const file = path.join(project, 'evidence.txt'); const original = 'INDEPENDENTLY CHECKED FIXTURE\r\n'; await writeFile(file, original);
const requests = []; const errors = []; const consoleErrors = []; const checks = []; const screenshots = []; const geometries = [];
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const server = http.createServer(async (request, response) => {
    try {
        const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = body.messages.some(message => message.role === 'tool') ? { content: 'The fixture file was read. Independently check its contents before accepting the goal.' }
            : { tool_calls: [{ index: 0, id: 'read-verification-file', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'evidence.txt' }) } }] };
        response.end(frame({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
    } catch (cause) { errors.push(String(cause)); response.destroy(); }
});
for (let attempt = 0; attempt < 32; attempt++) {
    try { await new Promise((done, failed) => {
        const onError = cause => { server.off('listening', onReady); failed(cause); }; const onReady = () => { server.off('error', onError); done(); };
        server.once('error', onError); server.once('listening', onReady); server.listen(randomInt(20000, 60000), '127.0.0.1');
    }); break; } catch (cause) { if (cause.code !== 'EADDRINUSE') throw cause; }
}
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page; let sessionId; let runId;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
const review = () => page.evaluate(({ sessionId, runId }) => window.uah.journal({ action: 'verification', sessionId, runId }), { sessionId, runId });
const dialog = () => page.getByRole('dialog', { name: '目标验收', exact: true });
async function launch() {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', cause => errors.push(cause.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
}
async function capture(name, theme, width, height, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, bounds) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(bounds.width, bounds.height); window.webContents.setZoomFactor(bounds.zoom); }, { width, height, zoom });
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
    const geometry = await dialog().evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, body: document.documentElement.scrollWidth, viewport: innerWidth }));
    geometries.push({ name, ...geometry }); check(`${name}: no horizontal overflow`, geometry.scroll <= geometry.client + 1 && geometry.body <= geometry.viewport + 1);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64')); screenshots.push(name);
}
async function ledger() {
    const directory = path.join(evidence, 'data', 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
    return (await readFile(path.join(directory, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
}
try {
    await launch();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    sessionId = await page.evaluate(async ({ project, baseUrl }) => {
        if (await window.uah.chooseDirectory() !== project) throw new Error('Fixture directory was not approved');
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Goal verification fixture', protocol: 'openai-chat', baseUrl, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true }], enabled: true, revision: 0, apiKey: null } });
        const created = await window.uah.command({ type: 'create-session', title: 'Goal verification fixture', directory: project, selection: { endpointId: saved.endpoints[0].id, modelId: 'fixture-model' }, agentId: 'default', controls: { permissionMode: 'auto', reasoningEffort: 'default' } });
        return created.sessions[0].id;
    }, { project, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.locator('.session-button').filter({ hasText: 'Goal verification fixture' }).click();
    await page.evaluate(() => { window.__goalTerminal = null; window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__goalTerminal = event.payload.run; }); });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Read evidence.txt and report its contents.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(sessionId => window.__goalTerminal?.sessionId === sessionId, sessionId);
    const run = (await snapshot()).runs.find(run => run.sessionId === sessionId); runId = run.id;
    assert.equal(run.state, 'completed', JSON.stringify(run)); assert.equal(requests.length, 2);
    check('real file read completes before independent goal review', requests[1].messages.some(message => message.role === 'tool' && JSON.stringify(message.content).includes(original.trim())));
    const before = await ledger(); check('exactly one old read tool was dispatched and recorded', before.filter(event => event.type === 'tool.dispatch').length === 1 && before.filter(event => event.type === 'tool.result').length === 1);
    const open = page.getByRole('button', { name: '目标验收', exact: true }); await open.focus(); await open.press('Enter');
    await dialog().getByText('版本一致', { exact: true }).waitFor();
    check('goal dialog shows recorded file evidence', await dialog().getByText(/evidence\.txt/).isVisible());
    const accept = dialog().getByRole('button', { name: '记录人工验收通过', exact: true }); check('empty criteria cannot submit', await accept.isDisabled());
    const criteria = 'I independently read evidence.txt and verified the exact fixture line; only this file result was checked.';
    await dialog().getByRole('textbox', { name: '我已独立检查的验收标准', exact: true }).fill(criteria); await accept.focus(); await accept.press('Enter');
    await dialog().getByText('已有人工验收记录，本次检查的记录及文件版本仍匹配。', { exact: true }).waitFor();
    let saved = (await snapshot()).runs.find(run => run.id === runId);
    check('keyboard acceptance records user_review while engine stays completed', saved.goalVerification?.method === 'user_review' && saved.goalVerification.criteria === criteria && saved.state === 'completed');
    check('manual acceptance sends no model request or tool invocation', requests.length === 2 && (await ledger()).filter(event => event.type === 'tool.dispatch').length === 1);
    await capture('current-light-1440.png', 'light', 1440, 900, 1);
    await capture('current-dark-900-125.png', 'dark', 900, 800, 1.25);
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); check('Escape closes the goal dialog', await page.getByRole('button', { name: '查看目标验收记录', exact: true }).isVisible());
    await app.close(); app = null; await launch();
    const restarted = await review(); check('restart preserves a current manual review', restarted.status === 'current' && restarted.previous?.method === 'user_review');
    await page.getByRole('button', { name: '查看目标验收记录', exact: true }).click();
    await dialog().getByText('已有人工验收记录，本次检查的记录及文件版本仍匹配。', { exact: true }).waitFor();
    await writeFile(file, 'EXTERNALLY CHANGED AFTER ACCEPTANCE\r\n');
    const refresh = dialog().getByRole('button', { name: '重新检查版本', exact: true }); await refresh.focus(); await refresh.press('Enter');
    await dialog().getByText('旧验收记录已经失效或无法确认当前有效，不能用于证明当前结果。', { exact: true }).waitFor();
    await dialog().getByText('已经变化', { exact: true }).waitFor();
    const stale = await review(); check('external file drift invalidates old acceptance and prevents submission', stale.status === 'stale' && stale.canVerify === false && await dialog().getByRole('button', { name: '记录人工验收通过', exact: true }).count() === 0);
    saved = (await snapshot()).runs.find(run => run.id === runId); check('stale review changes neither execution result nor old tool count', saved.state === 'completed' && requests.length === 2 && (await ledger()).filter(event => event.type === 'tool.dispatch').length === 1);
    check('inspection never overwrites the external edit', await readFile(file, 'utf8') === 'EXTERNALLY CHANGED AFTER ACCEPTANCE\r\n');
    await capture('stale-light-1440.png', 'light', 1440, 900, 1);
    await capture('stale-dark-900-125.png', 'dark', 900, 800, 1.25);
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, geometries, requests: requests.length, sessionId, runId, errors, consoleErrors }, null, 2));
    console.log(`PASS goal verification desktop: ${evidence}`);
} catch (cause) {
    if (app) { try { await capture('failure.png', 'dark', 900, 800, 1.25); } catch {} }
    const failureSnapshot = app ? await snapshot().catch(() => null) : null;
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, failure: String(cause), checks, screenshots, geometries, requests: requests.length, requestBodies: requests, failureSnapshot, sessionId, runId, errors, consoleErrors }, null, 2)); throw cause;
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
