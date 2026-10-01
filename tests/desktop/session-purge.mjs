import { _electron as electron } from 'playwright';
import electronExecutable from 'electron';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomInt, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(); await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'session-purge-desktop-')); const project = path.join(evidence, 'project'); await mkdir(project);
const requests = []; const errors = []; const consoleErrors = []; const checks = []; const screenshots = []; const geometries = []; const counts = new Map();
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const server = http.createServer(async (request, response) => {
    try {
        const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        const prompt = body.messages.findLast(message => message.role === 'user')?.content; assert.ok(['PURGE SOURCE', 'PURGE PENDING'].includes(prompt));
        const count = (counts.get(prompt) ?? 0) + 1; counts.set(prompt, count); response.writeHead(200, { 'content-type': 'text/event-stream' });
        const delta = count === 1 ? { tool_calls: [{ index: 0, id: `write-${prompt}`, type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: prompt === 'PURGE SOURCE' ? 'source.txt' : 'pending.txt', content: `${prompt} EXTERNAL FILE`, expectedContent: null }) } }] } : { content: `${prompt} COMPLETED` };
        response.end(frame({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); response.destroy(); }
});
for (let attempt = 0; attempt < 32; attempt++) { try { await new Promise((done, failed) => { const onError = error => { server.off('listening', onReady); failed(error); }; const onReady = () => { server.off('error', onError); done(); }; server.once('error', onError); server.once('listening', onReady); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; } catch (error) { if (error.code !== 'EADDRINUSE') throw error; } }
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page; let sourceId; let branchId; let pendingId; let endpointId;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
const dialog = () => page.getByRole('dialog', { name: '会话日志', exact: true });
const directory = id => path.join(evidence, 'data', 'sessions', createHash('sha256').update(JSON.stringify(id)).digest('hex'));
async function launch() {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.evaluate(() => { window.__purgeTerminals = {}; window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__purgeTerminals[event.payload.run.input] = event.payload.run; }); });
}
async function send(input) {
    await dialog().waitFor({ state: 'hidden' }); await page.getByRole('textbox', { name: '消息', exact: true }).fill(input); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(input => !!window.__purgeTerminals[input], input); const run = (await snapshot()).runs.find(run => run.input === input); assert.equal(run.state, 'completed', run.error); return run;
}
async function review() {
    await page.getByRole('button', { name: '会话日志', exact: true }).click(); const button = dialog().getByRole('button', { name: '检查会话删除范围', exact: true }); await button.scrollIntoViewIfNeeded(); await button.focus(); await button.press('Enter');
    await dialog().getByRole('textbox', { name: '输入“永久删除”确认', exact: true }).waitFor();
}
async function capture(name, theme, width, height, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, bounds) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(bounds.width, bounds.height); window.webContents.setZoomFactor(bounds.zoom); }, { width, height, zoom });
    await dialog().getByRole('button', { name: '永久删除此会话', exact: true }).scrollIntoViewIfNeeded();
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
    const geometry = await dialog().evaluate(element => {
        const section = element.querySelector('section[aria-label="彻底删除会话"]'); const viewport = element.querySelector('.ui-dialog-scroll .ui-scroll-viewport').getBoundingClientRect();
        const measure = node => { const rect = node.getBoundingClientRect(); return { top: rect.top, bottom: rect.bottom, visible: rect.width > 0 && rect.top >= viewport.top - 1 && rect.bottom <= viewport.bottom + 1 }; };
        const warning = [...section.querySelectorAll('.ui-alert')].find(node => node.textContent.includes('此操作无法撤销'));
        return { warning: measure(warning), input: measure(section.querySelector('textarea')), button: measure([...section.querySelectorAll('button')].find(button => button.textContent.trim() === '永久删除此会话')), scroll: element.scrollWidth, client: element.clientWidth, document: document.documentElement.scrollWidth, width: innerWidth };
    }); geometries.push({ name, ...geometry }); check(`${name}: warning/input/confirm visible without horizontal overflow`, geometry.warning.visible && geometry.input.visible && geometry.button.visible && geometry.scroll <= geometry.client + 1 && geometry.document <= geometry.width + 1);
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL()); await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64')); screenshots.push(name);
}
async function browserEvidence(id, injectFailure = false) {
    await app.evaluate(async ({ session }, { id, injectFailure }) => {
        const profile = session.fromPartition(`persist:uah-browser-${id}`);
        profile.protocol.handle('https', () => new Response('<html><body>local purge partition</body></html>', { headers: { 'content-type': 'text/html' } }));
        await profile.cookies.set({ url: 'https://purge.invalid', name: 'private_session', value: id, expirationDate: Date.now() / 1000 + 86400 });
        if (injectFailure) { globalThis.__originalPurgeCache = profile.clearCache; profile.clearCache = async () => { throw new Error('fixed isolated purge cache failure'); }; }
    }, { id, injectFailure });
    await page.evaluate(id => window.uah.browser({ type: 'open', sessionId: id, url: 'https://purge.invalid/' }), id);
    await app.evaluate(async ({ webContents, session }, id) => { const profile = session.fromPartition(`persist:uah-browser-${id}`); const contents = webContents.getAllWebContents().find(contents => contents.session === profile); await contents.executeJavaScript("localStorage.setItem('private_body','LOCAL SESSION BODY');true;"); }, id);
}
try {
    await launch(); check('real command bridge is present', await page.evaluate(() => typeof window.uah.command === 'function'));
    await app.evaluate(({ dialog }, project) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [project] }); }, project);
    const created = await page.evaluate(async ({ project, baseUrl }) => {
        if (await window.uah.chooseDirectory() !== project) throw new Error('Fixture project not approved');
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Session purge fixture', protocol: 'openai-chat', baseUrl, models: ['fixture'], modelDetails: [{ id: 'fixture', tools: true }], enabled: true, revision: 0, apiKey: null } });
        const reply = await window.uah.command({ type: 'create-session', title: 'Purge source fixture', directory: project, selection: { endpointId: saved.endpoints[0].id, modelId: 'fixture' }, agentId: 'default', controls: { permissionMode: 'auto', reasoningEffort: 'default' } }); return { id: reply.sessions[0].id, endpoint: saved.endpoints[0].id };
    }, { project, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }); sourceId = created.id; endpointId = created.endpoint;
    await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.evaluate(() => { window.__purgeTerminals = {}; window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__purgeTerminals[event.payload.run.input] = event.payload.run; }); });
    await page.locator('.session-button').filter({ hasText: 'Purge source fixture' }).click(); const source = await send('PURGE SOURCE');
    check('real write completed and filtered original context is readable', await readFile(path.join(project, 'source.txt'), 'utf8') === 'PURGE SOURCE EXTERNAL FILE' && !!await page.evaluate(runId => window.uah.requestContext({ runId }), source.id));
    const duplicate = spawn(electronExecutable, ['.'], { cwd: root, env, stdio: 'ignore', windowsHide: true });
    const duplicateExit = await new Promise((done, failed) => {
        const deadline = setTimeout(() => failed(new Error('Same-data second instance did not confirm exit')), 15000);
        duplicate.once('error', error => { clearTimeout(deadline); failed(error); });
        duplicate.once('close', (code, signal) => { clearTimeout(deadline); done({ code, signal }); });
    });
    check('same data directory second Electron exits while original records remain usable', duplicateExit.code === 0 && duplicateExit.signal === null && (await snapshot()).runs.some(run => run.id === source.id && run.output === source.output) && requests.length === 2);
    const separate = await electron.launch({ args: ['.'], cwd: root, env: { ...env, UAH_DATA_DIR: path.join(evidence, 'separate-data') } });
    try { const separatePage = await separate.firstWindow(); await separatePage.getByRole('textbox', { name: '消息', exact: true }).waitFor(); check('different isolated data directory keeps its independent desktop owner', await separatePage.evaluate(() => typeof window.uah.command === 'function') && (await snapshot()).sessions.some(session => session.id === sourceId)); }
    finally { await separate.close(); }
    await page.getByRole('button', { name: '从此回复创建分支', exact: true }).click(); await page.getByText('分支已保存', { exact: false }).waitFor(); const branch = (await snapshot()).sessions.find(session => session.branchFromRunId === source.id); branchId = branch.id;
    const branchRefs = [...(branch.branchArtifacts ?? []), ...branch.branchHistory.flatMap(turn => turn.modelFrame ? [turn.modelFrame.content] : [])].filter(ref => ref.availability === 'present');
    assert.ok(branchRefs.length > 0, 'branch has actual independently copied artifact files');
    const branchEvidence = await Promise.all(branchRefs.map(async ref => { const bytes = await readFile(path.join(directory(branchId), ref.relativePath)); assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256); return { ref, bytes }; }));
    check('branch has independent saved public and native history', branch.branchMessages.length > 0 && branch.branchHistory.some(turn => turn.modelFrame?.sessionId === branchId) && requests.length === 2);
    await page.locator('.session-button').filter({ hasText: 'Purge source fixture', hasNotText: '分支' }).click(); await browserEvidence(sourceId);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('UNSENT PRIVATE SOURCE DRAFT');
    await review(); const reviewData = await page.evaluate(sessionId => window.uah.journal({ action: 'purge-review', sessionId }), sourceId); check('actual review counts source evidence and branch while allowing deletion', reviewData.canDelete && reviewData.runCount === 1 && reviewData.fileCount > 0 && reviewData.branchCount === 1);
    const input = dialog().getByRole('textbox', { name: '输入“永久删除”确认', exact: true }); const confirm = dialog().getByRole('button', { name: '永久删除此会话', exact: true });
    check('confirmation is disabled until exact phrase', await confirm.isDisabled()); await input.fill('永久删除 '); check('whitespace variant is still disabled', await confirm.isDisabled()); await input.fill('永久删除'); check('exact phrase enables confirmation', await confirm.isEnabled());
    check('external workspace and independent branch warning is visible', await dialog().getByText(/工作区实际文件、独立分支和外部导出仍保留/).count() === 1 && await dialog().getByText(/此操作无法撤销/).count() === 1);
    await capture('confirm-light-1440.png', 'light', 1440, 900, 1); await capture('confirm-dark-900-125.png', 'dark', 900, 800, 1.25);
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' }); check('Escape closes confirmation without deleting', (await snapshot()).sessions.some(session => session.id === sourceId));
    await review(); await dialog().getByRole('textbox', { name: '输入“永久删除”确认', exact: true }).fill('永久删除'); const final = dialog().getByRole('button', { name: '永久删除此会话', exact: true }); await final.scrollIntoViewIfNeeded(); await final.focus(); await final.press('Enter'); await dialog().waitFor({ state: 'hidden' });
    const after = await snapshot(); check('UI purge removes source sidebar/runs/artifacts and clears selected draft', !after.sessions.some(session => session.id === sourceId) && !after.runs.some(run => run.sessionId === sourceId) && !after.artifacts.some(artifact => artifact.sessionId === sourceId) && await page.locator('.session-button').filter({ hasText: 'Purge source fixture', hasNotText: '分支' }).count() === 0 && await page.getByRole('textbox', { name: '消息', exact: true }).inputValue() === '');
    await assert.rejects(access(directory(sourceId)), { code: 'ENOENT' });
    const missingContext = await page.evaluate(async runId => { try { return await window.uah.requestContext({ runId }); } catch { return null; } }, source.id); check('source context and journal directory disappear with no new HTTP', missingContext === null && requests.length === 2);
    check('branch and actual external workspace file survive', after.sessions.some(session => session.id === branchId) && await readFile(path.join(project, 'source.txt'), 'utf8') === 'PURGE SOURCE EXTERNAL FILE');
    for (const { ref, bytes } of branchEvidence) { const saved = await readFile(path.join(directory(branchId), ref.relativePath)); assert.deepEqual(saved, bytes); assert.equal(createHash('sha256').update(saved).digest('hex'), ref.sha256); }
    check('every independently copied public/native branch artifact retains identical bytes and hash', branchEvidence.length > 0);
    const browserState = await app.evaluate(async ({ session, WebContentsView }, id) => { const profile = session.fromPartition(`persist:uah-browser-${id}`); const cookies = await profile.cookies.get({}); const probe = new WebContentsView({ webPreferences: { session: profile, sandbox: true } }); try { await probe.webContents.loadURL('https://purge.invalid/'); return { cookies, storage: await probe.webContents.executeJavaScript("localStorage.getItem('private_body')") }; } finally { probe.webContents.close({ waitForBeforeUnload: false }); } }, sourceId); check('actual purged browser partition loses cookie and localStorage', browserState.cookies.length === 0 && browserState.storage === null);
    await app.close(); app = null; await launch(); check('restart never restores deleted source and keeps branch', !(await snapshot()).sessions.some(session => session.id === sourceId) && (await snapshot()).sessions.some(session => session.id === branchId));
    pendingId = await page.evaluate(async ({ project, endpointId }) => { const reply = await window.uah.command({ type: 'create-session', title: 'Purge pending fixture', directory: project, selection: { endpointId, modelId: 'fixture' }, agentId: 'default', controls: { permissionMode: 'auto', reasoningEffort: 'default' } }); return reply.sessions.find(session => session.title === 'Purge pending fixture').id; }, { project, endpointId });
    await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor(); await page.locator('.session-button').filter({ hasText: 'Purge pending fixture' }).click();
    await page.evaluate(() => { window.__purgeTerminals = {}; window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__purgeTerminals[event.payload.run.input] = event.payload.run; }); }); await send('PURGE PENDING'); await browserEvidence(pendingId, true);
    await review(); await dialog().getByRole('textbox', { name: '输入“永久删除”确认', exact: true }).fill('永久删除'); await dialog().getByRole('button', { name: '永久删除此会话', exact: true }).click(); await dialog().waitFor({ state: 'hidden' }); await page.getByRole('button', { name: '重试删除', exact: true }).waitFor();
    check('real browser failure leaves logical deletion with durable pending banner', !(await snapshot()).sessions.some(session => session.id === pendingId) && (await snapshot()).pendingSessionPurges.includes(pendingId));
    await app.close(); app = null; await launch(); await page.getByRole('button', { name: '重试删除', exact: true }).waitFor(); check('pending deletion survives restart', (await snapshot()).pendingSessionPurges.includes(pendingId));
    await page.getByRole('button', { name: '重试删除', exact: true }).focus(); await page.getByRole('button', { name: '重试删除', exact: true }).press('Enter'); await page.getByRole('button', { name: '重试删除', exact: true }).waitFor({ state: 'hidden' });
    check('real retry finishes pending cleanup without re-executing tools', !(await snapshot()).pendingSessionPurges?.includes(pendingId) && requests.length === 4); await assert.rejects(access(directory(pendingId)), { code: 'ENOENT' }); check('pending workspace file still survives retry', await readFile(path.join(project, 'pending.txt'), 'utf8') === 'PURGE PENDING EXTERNAL FILE');
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []); await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, geometries, sourceId, branchId, pendingId, requests: requests.length, errors, consoleErrors }, null, 2)); console.log(`PASS session purge desktop: ${evidence}`);
} catch (error) { await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, error: String(error), checks, screenshots, geometries, sourceId, branchId, pendingId, requests, snapshot: app ? await snapshot().catch(() => null) : null, errors, consoleErrors }, null, 2)); throw error; }
finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
