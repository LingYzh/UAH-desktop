import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { randomInt } from 'node:crypto';

const root = process.cwd();
await mkdir(path.resolve('artifacts'), { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts/journal-desktop-'));
const project = path.join(evidence, 'project'); await mkdir(project);
await writeFile(path.join(project, 'fixture.txt'), 'JOURNAL_REAL_TOOL_RESULT\n');
const apiKey = 'JOURNAL_SECRET_LOCAL_FIXTURE';
const input = `JOURNAL TOOL TASK ${'LONG_LINE_'.repeat(450)}`;
const budgetInput = 'JOURNAL LOCAL BUDGET LOOP';
const retryInput = 'JOURNAL LOCAL RETRY ATTEMPTS';
const progressInput = 'JOURNAL LOCAL NO PROGRESS';
const requests = []; const checks = []; const errors = []; const consoleErrors = []; const screenshots = []; const geometries = [];
const check = (label, condition) => { assert.ok(condition, label); checks.push(label); };
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const server = http.createServer(async (request, response) => {
    try {
        assert.equal(request.headers.authorization, `Bearer ${apiKey}`);
        const chunks = []; for await (const bytes of request) chunks.push(bytes);
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')); requests.push(body);
        if (body.messages.some(message => message.role === 'user' && message.content === retryInput)) {
            const count = requests.filter(item => item.messages.some(message => message.role === 'user' && message.content === retryInput)).length;
            if (count <= 2) { response.writeHead(503, { 'content-type': 'application/json' }); response.end('{"error":"local transient fixture"}'); return; }
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frame({ choices: [{ delta: { content: 'Retry attempts retained.' }, finish_reason: 'stop' }], usage: { prompt_tokens: 17, completion_tokens: 5, total_tokens: 22 } }) + 'data: [DONE]\n\n'); return;
        }
        if (body.messages.some(message => message.role === 'user' && message.content === progressInput)) {
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `invalid-${requests.length}`, type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n'); return;
        }
        if (body.messages.some(message => message.role === 'user' && message.content === budgetInput)) {
            // Exercise the real loop governor; no host option or product budget override.
            const round = requests.filter(body => body.messages.some(message => message.role === 'user' && message.content === budgetInput)).length;
            response.writeHead(200, { 'content-type': 'text/event-stream' });
            response.end(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: `budget-read-${round}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt', limit: 1 }) } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
            return;
        }
        const toolResult = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'journal-read');
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(frame({ choices: [{ delta: toolResult ? { content: 'Journal fixture complete.' } : { tool_calls: [{ index: 0, id: 'journal-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'fixture.txt' }) } }] }, finish_reason: toolResult ? 'stop' : 'tool_calls' }] }));
        if (!toolResult) response.write(frame({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 67, total_tokens: 1301 } }));
        response.end('data: [DONE]\n\n');
    } catch (error) { errors.push(`Fixture: ${error.message}`); response.writeHead(500); response.end('Fixture failed'); }
});
for (let attempt = 0; attempt < 32; attempt++) {
    try {
        await new Promise((resolve, reject) => {
            const failed = error => { server.off('listening', listening); reject(error); };
            const listening = () => { server.off('error', failed); resolve(); };
            server.once('error', failed); server.once('listening', listening);
            server.listen(randomInt(20000, 60000), '127.0.0.1');
        });
        break;
    } catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
}
assert.ok(server.address() && server.address().port >= 20000, 'local fixture uses a Fetch-safe port');
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page; let sessionId; let fullExport; let shareExport; let budgetRun;
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
const query = value => page.evaluate(value => window.uah.journal(value), value);
async function rejected(value) { return page.evaluate(async value => { try { await window.uah.journal(value); return false; } catch { return true; } }, value); }
async function offline(directory) {
    const validation = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/transcript.ts', 'validate', directory], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(validation.status, 0, validation.stdout + validation.stderr); return JSON.parse(validation.stdout);
}
async function files(directory, prefix = '') {
    const entries = await readdir(directory, { withFileTypes: true }); const result = [];
    for (const entry of entries) {
        const relative = prefix + entry.name;
        if (entry.isDirectory()) result.push(...await files(path.join(directory, entry.name), relative + '/'));
        else result.push(relative);
    }
    return result;
}
async function capture(dialog, theme, width, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, 900); window.webContents.setZoomFactor(zoom); }, { width, zoom });
    await page.waitForTimeout(250);
    const geometry = await dialog.evaluate(element => {
        const bounds = element.getBoundingClientRect(); const footer = element.querySelector('.ui-dialog-footer'); const footerBounds = footer.getBoundingClientRect();
        const table = element.querySelector('.ui-table'); const tableViewport = table.querySelector('.ui-scroll-viewport') || table;
        const prior = tableViewport.scrollLeft; tableViewport.scrollLeft = tableViewport.scrollWidth;
        const horizontal = { client: tableViewport.clientWidth, scroll: tableViewport.scrollWidth, moved: tableViewport.scrollLeft > 0 }; tableViewport.scrollLeft = prior;
        const code = element.querySelector('.ui-code-block'); const codeBounds = code?.getBoundingClientRect();
        const codeViewport = code?.querySelector('.ui-scroll-viewport');
        let codeHorizontal = null;
        if (codeViewport) { const prior = codeViewport.scrollLeft; codeViewport.scrollLeft = codeViewport.scrollWidth; codeHorizontal = { client: codeViewport.clientWidth, scroll: codeViewport.scrollWidth, moved: codeViewport.scrollLeft > 0 }; codeViewport.scrollLeft = prior; }
        const scroller = element.querySelector('.ui-dialog-scroll > .ui-scroll-viewport');
        return { bounds: { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }, window: { width: innerWidth, height: innerHeight },
            footerVisible: footerBounds.top >= 0 && footerBounds.bottom <= innerHeight + 1 && footerBounds.left >= bounds.left - 1 && footerBounds.right <= bounds.right + 1,
            horizontal, codeHorizontal, dialogOverflow: element.scrollWidth > element.clientWidth + 1,
            codeInside: codeBounds && codeBounds.left >= bounds.left - 1 && codeBounds.right <= bounds.right + 1,
            outerShellScroll: element.querySelector('.ui-dialog-scroll').scrollTop, outerScrollHeight: scroller.scrollHeight, outerClientHeight: scroller.clientHeight };
    });
    const name = `journal-${theme}-${width}-${Math.round(zoom * 100)}.png`;
    geometries.push({ name, ...geometry });
    check(`${name}: dialog footer stays visible`, geometry.footerVisible);
    check(`${name}: dialog and long-line detail stay within horizontal bounds`, !geometry.dialogOverflow && geometry.codeInside);
    check(`${name}: outer scroll shell does not move`, geometry.outerShellScroll === 0);
    check(`${name}: long request line scrolls inside code viewport`, geometry.codeHorizontal?.scroll > geometry.codeHorizontal?.client && geometry.codeHorizontal?.moved);
    // At narrow effective widths overflow must remain inside the real table viewport.
    if (geometry.horizontal.scroll > geometry.horizontal.client + 1) check(`${name}: overflowing table scrolls horizontally`, geometry.horizontal.moved);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(png.split(',')[1], 'base64')); screenshots.push(name);
}
try {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    sessionId = await page.evaluate(async ({ project, baseUrl }) => {
        const directory = await window.uah.chooseDirectory(); if (directory !== project) throw new Error('Fixture directory was not approved.');
        const endpoint = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Journal local SSE', protocol: 'openai-chat', baseUrl, models: ['journal-model'], modelDetails: [{ id: 'journal-model', tools: true }], enabled: true, revision: 0, apiKey: 'JOURNAL_SECRET_LOCAL_FIXTURE' } });
        const initial = await window.uah.agents({ type: 'get' }); const settings = initial.settings ?? initial;
        settings.profiles.push({ id: 'journal-fixture-agent', name: 'Journal fixture agent', description: 'Local offline test', kind: 'primary', enabled: true, allowDelegation: false, instructions: 'Read the requested fixture file through read_file, then finish.' });
        await window.uah.agents({ type: 'save', settings });
        const before = await window.uah.command({ type: 'snapshot' });
        const state = await window.uah.command({ type: 'create-session', title: 'Journal fixture session', directory, selection: { endpointId: endpoint.endpoints[0].id, modelId: 'journal-model' }, agentId: 'journal-fixture-agent', controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
        return state.sessions.find(session => !before.sessions.some(previous => previous.id === session.id)).id;
    }, { project, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    const started = await page.evaluate(({ sessionId, input }) => window.uah.command({ type: 'start-run', sessionId, input }), { sessionId, input });
    const runId = started.runs.find(run => run.sessionId === sessionId).id;
    let run;
    for (let attempt = 0; attempt < 400; attempt++) {
        run = (await snapshot()).runs.find(run => run.id === runId);
        if (run && ['completed', 'failed', 'stopped'].includes(run.state)) break;
        await page.waitForTimeout(50);
    }
    assert.equal(run?.state, 'completed', run?.error);
    check('real SSE tool loop sends exactly two requests', requests.length === 2);
    check('second final request contains the actual read_file result', requests[1].messages.some(message => message.role === 'tool' && message.content === 'JOURNAL_REAL_TOOL_RESULT\n'));
    const summary = await query({ action: 'summary', sessionId });
    check('summary contains distinct correlated two-request rows', summary.requests.length === 2 && new Set(summary.requests.map(row => row.requestId)).size === 2);
    check('known usage is preserved and next request remains unknown', summary.requests.some(row => row.inputTokens === 1234 && row.outputTokens === 67) && summary.requests.some(row => row.inputTokens === null && row.outputTokens === null));
    check('durable and exported watermarks match after flush', summary.health.status === 'healthy' && summary.health.durableSeq > 0 && summary.health.durableSeq === summary.health.exportedSeq);
    const later = summary.requests.find(row => row.inputTokens === null);
    const detail = await query({ action: 'request', sessionId, requestId: later.requestId });
    check('request detail holds final serialized application body', JSON.stringify(detail.snapshot.body) === JSON.stringify(requests[1]));
    check('request snapshot and public events contain no endpoint key', !JSON.stringify(detail).includes(apiKey));
    for (const value of [{ action: 'summary', sessionId: '../secret' }, { action: 'export', sessionId, mode: 'full', destination: evidence }, { action: 'request', sessionId, requestId: 'unknown-request' }, { action: 'summary', sessionId: 'unknown-session' }, { action: 'export', sessionId, mode: 'raw' }]) check(`invalid IPC rejects ${JSON.stringify(value)}`, await rejected(value));
    await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    const trigger = page.getByRole('button', { name: '会话日志', exact: true }); await trigger.click();
    const dialog = page.getByRole('dialog', { name: '会话日志', exact: true }); await dialog.getByText('记录正常', { exact: true }).waitFor();
    const dialogText = await dialog.innerText();
    await writeFile(path.join(evidence, 'dialog-text.txt'), dialogText);
    check('dialog renders real rows and known/unknown counts', await dialog.getByRole('button', { name: /^查看请求 / }).count() === 2 && /1,?234/.test(dialogText) && dialogText.includes('未知'));
    await dialog.getByRole('button', { name: `查看请求 ${later.requestId} 尝试 ${later.attemptId}`, exact: true }).click();
    await dialog.getByRole('heading', { name: '最终请求快照', exact: true }).waitFor();
    for (const [theme, width, zoom] of [['light', 1440, 1], ['dark', 1440, 1], ['light', 900, 1], ['dark', 900, 1], ['light', 900, 1.25], ['dark', 900, 1.25]]) await capture(dialog, theme, width, zoom);
    let narrowTable;
    for (const zoom of [1.5, 2, 2.5, 3]) {
        await app.evaluate(({ BrowserWindow }, zoom) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(800, 900); window.webContents.setZoomFactor(zoom); }, zoom);
        await page.waitForTimeout(150);
        narrowTable = await dialog.locator('.ui-table .ui-scroll-viewport').evaluate(element => { element.scrollLeft = element.scrollWidth; return { client: element.clientWidth, scroll: element.scrollWidth, left: element.scrollLeft }; });
        geometries.push({ name: `table-edge-800-${Math.round(zoom * 100)}`, ...narrowTable });
        if (narrowTable.scroll > narrowTable.client) break;
    }
    check('table horizontal overflow at a smaller effective viewport scrolls internally', narrowTable.scroll > narrowTable.client && narrowTable.left > 0);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    check('Escape closes dialog and restores trigger focus', await trigger.evaluate(element => document.activeElement === element));
    await trigger.click(); await dialog.getByText('记录正常', { exact: true }).waitFor();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, evidence);
    fullExport = await query({ action: 'export', sessionId, mode: 'full' }); shareExport = await query({ action: 'export', sessionId, mode: 'share' });
    check('host generates distinct export directories inside system-selected parent', fullExport.destination !== shareExport.destination && [fullExport, shareExport].every(result => path.dirname(result.destination) === evidence && path.basename(result.destination).startsWith('UAH-transcript-')));
    const fullValidation = await offline(fullExport.destination); const shareValidation = await offline(shareExport.destination);
    check('full/share exports pass offline validate and retain watermarks', fullValidation.targetSeq === summary.health.durableSeq && shareValidation.targetSeq === fullValidation.targetSeq);
    const fullFiles = await files(fullExport.destination); const shareFiles = await files(shareExport.destination);
    check('full contains restricted originals and share omits restricted files', fullFiles.some(file => file.startsWith('restricted/')) && !shareFiles.some(file => file.startsWith('restricted/')) && shareValidation.partial);
    const shareManifest = JSON.parse(await readFile(path.join(shareExport.destination, 'manifest.json'), 'utf8'));
    check('share manifest explicitly marks restricted originals omitted', shareManifest.artifacts.some(ref => ref.availability === 'missing' && ref.missingReason === 'share_redacted'));
    for (const destination of [fullExport.destination, shareExport.destination]) for (const file of await files(destination)) check(`export ${path.basename(destination)}/${file} contains no key`, !(await readFile(path.join(destination, file), 'utf8')).includes(apiKey));
    await app.evaluate(({ dialog }) => { dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] }); });
    check('cancelling system export dialog returns null', await query({ action: 'export', sessionId, mode: 'full' }) === null);
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
    const budgetSessionId = await page.evaluate(async sessionId => {
        const before = await window.uah.command({ type: 'snapshot' });
        const original = before.sessions.find(session => session.id === sessionId);
        const created = await window.uah.command({ type: 'create-session', title: 'Journal budget fixture', directory: original.directory,
            selection: { endpointId: original.requested.endpointId, modelId: original.requested.modelId }, agentId: 'journal-fixture-agent',
            controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
        return created.sessions.find(session => !before.sessions.some(prior => prior.id === session.id)).id;
    }, sessionId);
    await page.evaluate(() => {
        window.__journalBudgetTerminals = {};
        window.__journalBudgetUnsubscribe = window.uah.onEvent(event => {
            if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__journalBudgetTerminals[event.runId] = event.payload.run;
        });
    });
    const budgetStarted = await page.evaluate(({ sessionId, input }) => window.uah.command({ type: 'start-run', sessionId, input }), { sessionId: budgetSessionId, input: budgetInput });
    const budgetRunId = budgetStarted.runs.find(run => run.sessionId === budgetSessionId).id;
    // waitForFunction predicates must return a synchronous boolean, not a truthy
    // IPC Promise. The subscribed event is delivered after its durable commit.
    await page.waitForFunction(id => Boolean(window.__journalBudgetTerminals[id]), budgetRunId, { timeout: 60000 });
    budgetRun = (await snapshot()).runs.find(run => run.id === budgetRunId);
    await page.evaluate(() => { window.__journalBudgetUnsubscribe(); delete window.__journalBudgetUnsubscribe; delete window.__journalBudgetTerminals; });
    check('real readonly tool loop stops with suspended_budget and a preserved reason', budgetRun.state === 'stopped' && budgetRun.harnessState === 'suspended_budget' && /已达到.+限制/.test(budgetRun.stopReason));
    const budgetRequests = requests.filter(body => body.messages.some(message => message.role === 'user' && message.content === budgetInput));
    check('budget fixture reaches execution through actual local requests and read_file evidence', budgetRequests.length > 0 && budgetRequests.length <= 16
        && budgetRun.activities?.some(activity => activity.tool?.name === 'read_file' && activity.tool.outcome?.effectState === 'not_started'));
    if (budgetRun.budgetStopCode === 'requests') check('request-loop suspension occurs after the sixteen admitted rounds', budgetRequests.length === 16);
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 900); window.webContents.setZoomFactor(1); });
    await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.locator('.session-button').filter({ has: page.getByText('Journal budget fixture', { exact: true }) }).click();
    const stopStatus = page.locator('.turn').getByRole('status').filter({ hasText: `停止理由：${budgetRun.stopReason}` });
    await stopStatus.waitFor(); await stopStatus.scrollIntoViewIfNeeded();
    check('ChatWorkspace renders the persisted budget reason in a visible status element', await stopStatus.isVisible() && await stopStatus.innerText() === `停止理由：${budgetRun.stopReason}`);
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); });
    const stopImage = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, 'budget-stop-reason.png'), Buffer.from(stopImage.split(',')[1], 'base64')); screenshots.push('budget-stop-reason.png');
    for (const scenario of [{ input: retryInput, title: 'Journal retry fixture' }, { input: progressInput, title: 'Journal progress fixture' }]) {
        const isolatedId = await page.evaluate(async ({ sessionId, title }) => {
            const before = await window.uah.command({ type: 'snapshot' }); const source = before.sessions.find(item => item.id === sessionId);
            const created = await window.uah.command({ type: 'create-session', title, directory: source.directory,
                selection: { endpointId: source.requested.endpointId, modelId: source.requested.modelId }, agentId: 'journal-fixture-agent', controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
            return created.sessions.find(item => !before.sessions.some(prior => prior.id === item.id)).id;
        }, { sessionId, title: scenario.title });
        const started = await page.evaluate(({ sessionId, input }) => window.uah.command({ type: 'start-run', sessionId, input }), { sessionId: isolatedId, input: scenario.input });
        const id = started.runs.find(item => item.sessionId === isolatedId).id;
        let terminal;
        for (let index = 0; index < 300; index++) {
            terminal = (await snapshot()).runs.find(item => item.id === id);
            if (['completed', 'failed', 'stopped'].includes(terminal?.state)) break;
            await page.waitForTimeout(50);
        }
        await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
        await page.locator('.session-button').filter({ has: page.getByText(scenario.title, { exact: true }) }).click();
        if (scenario.input === retryInput) {
            check('retry fixture completes after exactly three actual attempts', terminal.state === 'completed' && requests.filter(item => item.messages.some(message => message.role === 'user' && message.content === retryInput)).length === 3);
            const attempts = await query({ action: 'summary', sessionId: isolatedId });
            check('journal retains one logical request with three independent attempt rows', attempts.requests.length === 3 && new Set(attempts.requests.map(item => item.requestId)).size === 1 && new Set(attempts.requests.map(item => item.attemptId)).size === 3);
            check('failed retry usage remains unknown and successful usage remains separate', attempts.requests.filter(item => item.status === 'failed' && item.inputTokens === null).length === 2 && attempts.requests.some(item => item.status === 'completed' && item.inputTokens === 17));
            await page.getByRole('button', { name: '会话日志', exact: true }).click(); await dialog.waitFor();
            check('real table renders all three attempts without row-key collision', await dialog.getByRole('button', { name: /^查看请求 / }).count() === 3);
            const failed = attempts.requests.find(item => item.status === 'failed');
            await dialog.getByRole('button', { name: `查看请求 ${failed.requestId} 尝试 ${failed.attemptId}`, exact: true }).click();
            await dialog.getByText(`请求 ${failed.requestId} · 尝试 ${failed.attemptId}`, { exact: true }).waitFor();
            check('failed attempt detail selects its own final request body', await dialog.locator('.ui-code-block').innerText().then(text => text.includes(failed.attemptId)));
            await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
            await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(900, 900); window.webContents.setZoomFactor(1.25); });
            await page.waitForTimeout(200);
            const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
            await writeFile(path.join(evidence, 'retry-attempts-dark-900-125.png'), Buffer.from(png.split(',')[1], 'base64')); screenshots.push('retry-attempts-dark-900-125.png');
            await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
        } else {
            check('three identical invalid batches pause without a fourth request', terminal.state === 'stopped' && terminal.budgetStopCode === 'no_progress' && terminal.toolProgress.repeatedFailureBatches === 3 && requests.filter(item => item.messages.some(message => message.role === 'user' && message.content === progressInput)).length === 3);
            const status = page.locator('.turn').getByRole('status').filter({ hasText: `停止理由：${terminal.stopReason}` });
            await status.waitFor(); await status.scrollIntoViewIfNeeded();
            check('no-progress pause renders its persistent human-readable reason', await status.isVisible() && /重复失败且无新证据/.test(await status.innerText()));
            await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
            await page.waitForTimeout(200);
            const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
            await writeFile(path.join(evidence, 'no-progress-dark-900-125.png'), Buffer.from(png.split(',')[1], 'base64')); screenshots.push('no-progress-dark-900-125.png');
        }
    }
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, geometries, summary, fullExport, shareExport, budgetRun, errors, consoleErrors, requestCount: requests.length }, null, 2));
    console.log(`PASS journal desktop: ${evidence}`);
} catch (error) {
    if (app) { try { const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL()); await writeFile(path.join(evidence, 'failure.png'), Buffer.from(png.split(',')[1], 'base64')); } catch {} }
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, failure: String(error), checks, screenshots, geometries, budgetRun, requests, errors, consoleErrors, requestCount: requests.length }, null, 2));
    console.error(`Journal failure evidence: ${evidence}`); throw error;
} finally {
    if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
