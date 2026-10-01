import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomInt, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(); await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'journal-policy-desktop-')); const project = path.join(evidence, 'project'); await mkdir(project);
const requests = []; const errors = []; const consoleErrors = []; const checks = []; const screenshots = []; const geometries = [];
const counters = new Map(); const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const server = http.createServer(async (request, response) => {
    try {
        const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        const prompt = body.messages.findLast(message => message.role === 'user')?.content;
        const probe = typeof prompt === 'string' && prompt.includes('Reply with the single word OK');
        assert.ok(probe || ['POLICY OFF TASK', 'POLICY ON TASK'].includes(prompt), 'fixture only receives its own local task');
        const count = (counters.get(prompt) ?? 0) + 1; counters.set(prompt, count);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        const mode = prompt === 'POLICY OFF TASK' ? 'off' : 'on';
        const delta = probe ? { content: 'OK' } : count === 1 ? { tool_calls: [{ index: 0, id: `policy-write-${mode}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: `${mode}.txt`, content: `POLICY ${mode.toUpperCase()} FILE SNAPSHOT`, expectedContent: null }) } }] } : { content: `POLICY ${mode.toUpperCase()} CHAT COMPLETE` };
        response.end(frame({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } }) + 'data: [DONE]\n\n');
    } catch (cause) { errors.push(String(cause)); response.destroy(); }
});
for (let attempt = 0; attempt < 32; attempt++) {
    try { await new Promise((done, failed) => { const onError = cause => { server.off('listening', onReady); failed(cause); }; const onReady = () => { server.off('error', onError); done(); }; server.once('error', onError); server.once('listening', onReady); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; }
    catch (cause) { if (cause.code !== 'EADDRINUSE') throw cause; }
}
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page; let sessionId; let endpoint; let offRun; let onRun;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
const policy = () => page.evaluate(() => window.uah.journalPolicy({ action: 'get' }));
const dialog = () => page.getByRole('dialog', { name: '会话日志', exact: true });
const summary = () => page.evaluate(sessionId => window.uah.journal({ action: 'summary', sessionId }), sessionId);
const detail = row => page.evaluate(({ sessionId, row }) => window.uah.journal({ action: 'request', sessionId, requestId: row.requestId, attemptId: row.attemptId }), { sessionId, row });
async function launch() {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', cause => errors.push(cause.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.evaluate(() => { window.__policyTerminals = {}; window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__policyTerminals[event.payload.run.input] = event.payload.run; }); });
}
async function openJournal() { await page.getByRole('button', { name: '会话日志', exact: true }).click(); await dialog().getByText('保存额外原始请求与响应', { exact: true }).waitFor(); }
async function send(prompt) {
    await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(prompt => !!window.__policyTerminals[prompt], prompt); const run = (await snapshot()).runs.find(run => run.input === prompt);
    assert.equal(run.state, 'completed', run.error); return run;
}
async function ledger(application = false) {
    const id = application ? 'application' : sessionId;
    const base = application ? path.join(evidence, 'data', 'application-journal') : path.join(evidence, 'data');
    const directory = path.join(base, 'sessions', createHash('sha256').update(JSON.stringify(id)).digest('hex'));
    const events = (await readFile(path.join(directory, 'transcript.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    return { directory, events };
}
async function capture(name, theme, width, height, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, bounds) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(bounds.width, bounds.height); window.webContents.setZoomFactor(bounds.zoom); }, { width, height, zoom });
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
    const geometry = await dialog().evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, body: document.documentElement.scrollWidth, viewport: innerWidth }));
    geometries.push({ name, ...geometry }); check(`${name}: no horizontal overflow`, geometry.scroll <= geometry.client + 1 && geometry.body <= geometry.viewport + 1);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL()); await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64')); screenshots.push(name);
}
try {
    await launch(); await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    const created = await page.evaluate(async ({ project, baseUrl }) => {
        if (await window.uah.chooseDirectory() !== project) throw new Error('Fixture project not approved');
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Journal policy fixture', protocol: 'openai-chat', baseUrl, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true }], enabled: true, revision: 0, apiKey: null } });
        const endpoint = saved.endpoints[0]; const result = await window.uah.command({ type: 'create-session', title: 'Journal policy fixture', directory: project, selection: { endpointId: endpoint.id, modelId: 'fixture-model' }, agentId: 'default', controls: { permissionMode: 'auto', reasoningEffort: 'default' } });
        return { endpoint, sessionId: result.sessions[0].id };
    }, { project, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }); endpoint = created.endpoint; sessionId = created.sessionId;
    await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.evaluate(() => { window.__policyTerminals = {}; window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__policyTerminals[event.payload.run.input] = event.payload.run; }); });
    await page.locator('.session-button').filter({ hasText: 'Journal policy fixture' }).click(); await openJournal();
    check('default policy saves raw request and response capture', (await policy()).captureRaw === true);
    const toggle = dialog().getByRole('checkbox', { name: '保存额外原始请求与响应', exact: true }); await toggle.focus(); await toggle.press('Space');
    await dialog().getByText('日志设置已保存，从下一次模型请求或连接测试生效。', { exact: true }).waitFor();
    check('keyboard switch disables capture globally', (await policy()).captureRaw === false);
    check('scope description explains retained chat, context, snapshots and native history', await dialog().getByText(/聊天、过滤后的请求上下文、文件快照和必要原生续接历史仍保留/).isVisible());
    await dialog().getByRole('button', { name: '关闭', exact: true }).click(); offRun = await send('POLICY OFF TASK');
    check('off policy preserves chat and actual file snapshots', offRun.output === 'POLICY OFF CHAT COMPLETE' && await readFile(path.join(project, 'off.txt'), 'utf8') === 'POLICY OFF FILE SNAPSHOT' && (await snapshot()).artifacts.some(artifact => artifact.runId === offRun.id));
    check('off policy preserves the filtered context panel and required native frame', !!offRun.requestContext && offRun.modelFrame?.continuationCoverage === 'native');
    const offSummary = await summary(); const offRows = offSummary.requests; assert.equal(offRows.length, 2);
    const offDetails = await Promise.all(offRows.map(detail));
    check('each off attempt records disabled body and partial coverage', offDetails.every(value => value.snapshot.body === null && value.snapshot.bodyCapture === 'disabled' && value.snapshot.coverage === 'partial'));
    const offLedger = await ledger(); check('off attempts persist no provider raw frames but retain native continuation', offLedger.events.filter(event => event.type === 'provider.frame').length === 0 && offLedger.events.filter(event => event.type === 'response.native').length === 2);
    check('session coverage is explicitly partial while recording stays healthy', offSummary.coverage === 'partial' && offSummary.health.status === 'healthy');
    await openJournal(); await dialog().getByText('部分覆盖', { exact: true }).waitFor();
    await dialog().getByRole('button', { name: /查看请求/ }).first().click();
    await dialog().getByText('本次已关闭原始请求正文捕获，以下仅为请求身份和记录策略。', { exact: true }).waitFor();
    await capture('disabled-light-1440.png', 'light', 1440, 900, 1); await capture('disabled-dark-900-125.png', 'dark', 900, 800, 1.25);
    await app.close(); app = null; await launch(); check('restart keeps raw capture disabled', (await policy()).captureRaw === false);
    await page.getByRole('button', { name: '刷新当前 Git 状态', exact: true }).waitFor();
    await page.waitForFunction(() => document.querySelector('button[aria-label="刷新当前 Git 状态"]')?.disabled === false);
    const tested = await page.evaluate(endpoint => window.uah.endpoints({ type: 'test', modelId: 'fixture-model', draft: { id: endpoint.id, name: endpoint.name, protocol: endpoint.protocol, baseUrl: endpoint.baseUrl, models: endpoint.models, modelDetails: endpoint.modelDetails, enabled: endpoint.enabled, revision: endpoint.revision, apiKey: null } }), endpoint);
    check('application connection test still succeeds under disabled capture', tested.tested === true);
    const application = await ledger(true); const intent = application.events.find(event => event.type === 'request.intent');
    const probeSnapshot = JSON.parse(await readFile(path.join(application.directory, intent.payload.snapshot.relativePath), 'utf8'));
    check('application journal obeys the same disabled policy', probeSnapshot.body === null && probeSnapshot.bodyCapture === 'disabled' && application.events.every(event => event.type !== 'provider.frame'));
    await openJournal(); const enableToggle = dialog().getByRole('checkbox', { name: '保存额外原始请求与响应', exact: true }); await enableToggle.focus(); await enableToggle.press('Space');
    await dialog().getByText('日志设置已保存，从下一次模型请求或连接测试生效。', { exact: true }).waitFor(); check('capture can be explicitly enabled again', (await policy()).captureRaw === true);
    await dialog().getByRole('button', { name: '关闭', exact: true }).click(); onRun = await send('POLICY ON TASK');
    const onSummary = await summary(); const oldIdentities = new Set(offRows.map(row => row.attemptId)); const onRows = onSummary.requests.filter(row => !oldIdentities.has(row.attemptId)); assert.equal(onRows.length, 2);
    const onDetails = await Promise.all(onRows.map(detail)); check('new enabled attempts capture full final request bodies', onDetails.every(value => value.snapshot.body !== null && value.snapshot.coverage === 'complete' && value.snapshot.bodyCapture !== 'disabled'));
    check('re-enabling never backfills old disabled attempts', JSON.stringify(await Promise.all(offRows.map(detail))) === JSON.stringify(offDetails));
    const onRequests = requests.filter(body => body.messages.findLast(message => message.role === 'user')?.content === 'POLICY ON TASK');
    check('native history survives off policy and restart', onRequests[0].messages.some(message => message.role === 'assistant' && message.tool_calls?.some(call => call.id === 'policy-write-off')) && onRequests[0].messages.some(message => message.role === 'tool' && message.tool_call_id === 'policy-write-off'));
    check('each task executes exactly one intended tool and mixed session remains partial', (await ledger()).events.filter(event => event.type === 'tool.dispatch').length === 2 && onSummary.coverage === 'partial' && onRun.state === 'completed');
    await openJournal(); await dialog().getByRole('button', { name: /查看请求/ }).first().click();
    await dialog().getByRole('heading', { name: '最终请求快照' }).waitFor(); await capture('enabled-light-1440.png', 'light', 1440, 900, 1); await capture('enabled-dark-900-125.png', 'dark', 900, 800, 1.25);
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, geometries, sessionId, requests: requests.length, errors, consoleErrors }, null, 2)); console.log(`PASS journal policy desktop: ${evidence}`);
} catch (cause) {
    const failureSnapshot = app ? await snapshot().catch(() => null) : null;
    const rendererState = app ? await page.evaluate(() => {
        const pinia = document.querySelector('#app')?.__vue_app__?.config.globalProperties.$pinia;
        const workspace = pinia?._s.get('workspace');
        return { body: document.body.innerText, input: document.querySelector('textarea[aria-label="消息"]')?.value,
            workspace: workspace ? { selectedId: workspace.selectedId, ready: workspace.ready, busy: workspace.busy, currentInput: workspace.currentInput, currentAgent: workspace.currentAgent, agentAvailable: workspace.agentAvailable, currentModel: workspace.currentModel, modelAvailable: workspace.modelAvailable, configurationReady: workspace.configurationReady, error: workspace.error, viewSessionId: workspace.snapshot.viewSessionId, historyWindow: workspace.snapshot.historyWindow } : null };
    }).catch(() => null) : null;
    if (app && await dialog().count()) { try { await capture('failure.png', 'dark', 900, 800, 1.25); } catch {} }
    else if (app) { const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL()); await writeFile(path.join(evidence, 'failure.png'), Buffer.from(data.split(',')[1], 'base64')); screenshots.push('failure.png'); }
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, failure: String(cause), checks, screenshots, geometries, requestBodies: requests, failureSnapshot, rendererState, sessionId, errors, consoleErrors }, null, 2)); throw cause;
} finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
