import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { randomInt, createHash } from 'node:crypto';
import { mkdir, mkdtemp, writeFile, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(); await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'journal-gc-desktop-'));
const project = path.join(evidence, 'project'); await mkdir(project); await writeFile(path.join(project, 'evidence.txt'), 'GC REAL FILE EVIDENCE');
const requests = []; const errors = []; const consoleErrors = []; const checks = []; const screenshots = []; const geometries = [];
let held; let resolveHeld; const holding = new Promise(done => { resolveHeld = done; });
const frame = value => `data: ${JSON.stringify(value)}\n\n`;
const server = http.createServer(async (request, response) => {
    try {
        const chunks = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        const prompt = body.messages.findLast(message => message.role === 'user')?.content;
        assert.ok(['GC REAL TASK', 'GC HOLD TASK'].includes(prompt)); response.writeHead(200, { 'content-type': 'text/event-stream' });
        if (prompt === 'GC HOLD TASK') { held = response; response.write(': held\n\n'); resolveHeld(); return; }
        const delta = requests.length === 1 ? { tool_calls: [{ index: 0, id: 'gc-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'evidence.txt' }) } }] } : { content: 'GC CHAT COMPLETE' };
        response.end(frame({ choices: [{ index: 0, delta, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }] }) + 'data: [DONE]\n\n');
    } catch (cause) { errors.push(String(cause)); response.destroy(); }
});
for (let attempt = 0; attempt < 32; attempt++) {
    try { await new Promise((done, failed) => { const onError = cause => { server.off('listening', onReady); failed(cause); }; const onReady = () => { server.off('error', onError); done(); }; server.once('error', onError); server.once('listening', onReady); server.listen(randomInt(20000, 60000), '127.0.0.1'); }); break; }
    catch (cause) { if (cause.code !== 'EADDRINUSE') throw cause; }
}
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page; let sessionId;
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); console.log(`PASS ${name}`); };
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
const dialog = () => page.getByRole('dialog', { name: '会话日志', exact: true });
const cleanup = extra => page.evaluate(({ sessionId, extra }) => window.uah.journal({ action: 'cleanup-review', sessionId, ...extra }), { sessionId, extra });
async function terminal(input) { await page.waitForFunction(input => !!window.__gcTerminals[input], input); return (await snapshot()).runs.find(run => run.input === input); }
async function capture(name, theme, width, height, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, bounds) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(bounds.width, bounds.height); window.webContents.setZoomFactor(bounds.zoom); }, { width, height, zoom });
    const candidates = name.includes('candidates');
    const anchor = dialog().getByRole('button', { name: candidates ? '确认清理这些无引用文件' : '检查可清理文件', exact: true });
    await anchor.scrollIntoViewIfNeeded();
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); await new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))); });
    const geometry = await dialog().evaluate(element => ({ client: element.clientWidth, scroll: element.scrollWidth, body: document.documentElement.scrollWidth, viewport: innerWidth }));
    geometries.push({ name, ...geometry }); check(`${name}: no horizontal overflow`, geometry.scroll <= geometry.client + 1 && geometry.body <= geometry.viewport + 1);
    if (candidates) {
        const visibility = await dialog().evaluate(element => {
            const measure = target => {
                const rect = target.getBoundingClientRect();
                const clip = { top: 0, bottom: innerHeight, left: 0, right: innerWidth };
                // Check the dialog body/viewport, not UiTable's own scroll gutter.
                // The candidate section is inside the dialog's scrolling body.
                for (let ancestor = target.closest('section').parentElement; ancestor; ancestor = ancestor.parentElement) {
                    const style = getComputedStyle(ancestor); const bounds = ancestor.getBoundingClientRect();
                    if (/(auto|scroll|hidden|clip)/.test(style.overflowY)) { clip.top = Math.max(clip.top, bounds.top + parseFloat(style.borderTopWidth)); clip.bottom = Math.min(clip.bottom, bounds.bottom - parseFloat(style.borderBottomWidth)); }
                    if (/(auto|scroll|hidden|clip)/.test(style.overflowX)) { clip.left = Math.max(clip.left, bounds.left + parseFloat(style.borderLeftWidth)); clip.right = Math.min(clip.right, bounds.right - parseFloat(style.borderRightWidth)); }
                    // Native modal dialogs live in the top layer; underlying
                    // workspace ancestors cannot clip their visible contents.
                    if (ancestor === element) break;
                }
                return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, clip,
                    fullyVisible: rect.width > 0 && rect.height > 0 && rect.top >= clip.top - 1 && rect.bottom <= clip.bottom + 1 && rect.left >= clip.left - 1 && rect.right <= clip.right + 1 };
            };
            const table = element.querySelector('table[aria-label="清理候选"]');
            const confirm = [...element.querySelectorAll('button')].find(button => button.textContent.trim() === '确认清理这些无引用文件');
            if (!table || !confirm) throw new Error('Candidate table or confirmation is missing');
            return { table: measure(table), confirm: measure(confirm) };
        });
        geometries.push({ name, candidateVisibility: visibility });
        check(`${name}: candidate table and confirmation fully inside visible dialog body`, visibility.table.fullyVisible && visibility.confirm.fullyVisible);
    }
    const data = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL()); await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64')); screenshots.push(name);
}
try {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', cause => errors.push(cause.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    sessionId = await page.evaluate(async ({ project, baseUrl }) => {
        if (await window.uah.chooseDirectory() !== project) throw new Error('Fixture project not approved');
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Journal GC fixture', protocol: 'openai-chat', baseUrl, models: ['fixture-model'], modelDetails: [{ id: 'fixture-model', tools: true }], enabled: true, revision: 0, apiKey: null } });
        const reply = await window.uah.command({ type: 'create-session', title: 'Journal GC fixture', directory: project, selection: { endpointId: saved.endpoints[0].id, modelId: 'fixture-model' }, agentId: 'default', controls: { permissionMode: 'auto', reasoningEffort: 'default' } }); return reply.sessions[0].id;
    }, { project, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
    await page.reload(); await page.getByRole('textbox', { name: '消息', exact: true }).waitFor(); await page.locator('.session-button').filter({ hasText: 'Journal GC fixture' }).click();
    await page.evaluate(() => { window.__gcTerminals = {}; window.uah.onEvent(event => { if (event.type === 'run-state' && ['completed', 'failed', 'stopped'].includes(event.payload.run.state)) window.__gcTerminals[event.payload.run.input] = event.payload.run; }); });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('GC REAL TASK'); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    const completed = await terminal('GC REAL TASK'); check('real local tool loop completes with evidence', completed.state === 'completed' && completed.output === 'GC CHAT COMPLETE' && requests.length === 2);
    const directory = path.join(evidence, 'data', 'sessions', createHash('sha256').update(JSON.stringify(sessionId)).digest('hex'));
    const ledger = await readFile(path.join(directory, 'transcript.jsonl'), 'utf8'); const events = ledger.trim().split('\n').map(JSON.parse);
    check('fixture has canonical accepted message and native continuation', events.some(event => event.type === 'message.accepted') && events.some(event => event.type === 'response.native') && events.filter(event => event.type === 'tool.dispatch').length === 1);
    await page.getByRole('button', { name: '会话日志', exact: true }).click(); const inspect = dialog().getByRole('button', { name: '检查可清理文件', exact: true }); await inspect.scrollIntoViewIfNeeded(); await inspect.focus(); await inspect.press('Enter');
    await dialog().getByText('0 个可清理文件，共 0 字节。', { exact: true }).waitFor();
    const review = await cleanup(); check('zero candidates retain 24h grace and no confirmation button', review.files.length === 0 && review.minimumAgeHours === 24 && await dialog().getByRole('button', { name: '确认清理这些无引用文件', exact: true }).count() === 0);
    check('inspection does not alter records or send HTTP', await readFile(path.join(directory, 'transcript.jsonl'), 'utf8') === ledger && requests.length === 2);
    await capture('cleanup-light-1440.png', 'light', 1440, 900, 1); await capture('cleanup-dark-900-125.png', 'dark', 900, 800, 1.25);
    const manifestBytes = await readFile(path.join(directory, 'manifest.json'));
    const manifest = JSON.parse(manifestBytes.toString());
    const retained = await Promise.all(manifest.artifacts.filter(ref => ref.availability === 'present').map(async ref => {
        const bytes = await readFile(path.join(directory, ref.relativePath)); assert.equal(createHash('sha256').update(bytes).digest('hex'), ref.sha256); return { ref, bytes };
    }));
    const orphanBytes = [Buffer.from(JSON.stringify({ text: 'GC DESKTOP ISOLATED ORPHAN' })), Buffer.from([0, 255, 13, 10, 42])];
    const orphanPaths = orphanBytes.map((bytes, index) => path.resolve(directory, 'artifacts', `${createHash('sha256').update(bytes).digest('hex')}.${index === 0 ? 'json' : 'bin'}`));
    const artifactDirectory = await realpath(path.join(directory, 'artifacts'));
    for (let index = 0; index < orphanPaths.length; index++) {
        const file = orphanPaths[index]; assert.equal(path.dirname(file), artifactDirectory); assert.ok(file.startsWith(path.resolve(evidence) + path.sep));
        await writeFile(file, orphanBytes[index], { flag: 'wx' });
    }
    // Windows creation time is part of the actual production grace check. Modify
    // only our newly reserved fixture files, without changing the production clock.
    const quote = value => `'${value.replaceAll("'", "''")}'`;
    const command = '$old=[DateTime]::UtcNow.AddDays(-2);' + orphanPaths.map(file => `[System.IO.File]::SetCreationTimeUtc(${quote(file)},$old);[System.IO.File]::SetLastWriteTimeUtc(${quote(file)},$old);`).join('');
    assert.ok(/^[\x00-\x7f]*$/.test(command));
    const aged = spawnSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe', ['-NoProfile', '-EP', 'Bypass', '-Command', command], { encoding: 'utf8', windowsHide: true });
    assert.equal(aged.status, 0, aged.stderr || String(aged.error));
    for (const file of orphanPaths) { const metadata = await stat(file); assert.ok(Date.now() - Math.max(metadata.birthtimeMs, metadata.mtimeMs) > 24 * 3600000, 'Windows confirms real fixture age'); }
    await inspect.focus(); await inspect.press('Enter'); await dialog().getByText(/2 个可清理文件，共/).waitFor();
    check('actual aged JSON and binary files appear as exactly two UI candidates', (await cleanup()).files.length === 2 && await dialog().getByRole('table', { name: '清理候选' }).count() === 1);
    await capture('cleanup-candidates-light-1440.png', 'light', 1440, 900, 1); await capture('cleanup-candidates-dark-900-125.png', 'dark', 900, 800, 1.25);
    const confirm = dialog().getByRole('button', { name: '确认清理这些无引用文件', exact: true }); await confirm.scrollIntoViewIfNeeded(); await confirm.focus(); await confirm.press('Enter');
    await dialog().getByText(/已清理 2 个无引用文件/).waitFor();
    for (const file of orphanPaths) await assert.rejects(readFile(file), { code: 'ENOENT' });
    check('keyboard confirmation deletes only the two reviewed aged files', (await cleanup()).files.length === 0 && await confirm.count() === 0);
    for (const { ref, bytes } of retained) { const after = await readFile(path.join(directory, ref.relativePath)); assert.deepEqual(after, bytes); assert.equal(createHash('sha256').update(after).digest('hex'), ref.sha256); }
    check('canonical manifest and every retained hash remain intact after real UI collection', await readFile(path.join(directory, 'transcript.jsonl'), 'utf8') === ledger && (await readFile(path.join(directory, 'manifest.json'))).equals(manifestBytes) && requests.length === 2);
    await page.keyboard.press('Escape'); await dialog().waitFor({ state: 'hidden' });
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('GC HOLD TASK'); await page.getByRole('button', { name: '发送消息', exact: true }).click(); await holding;
    const activeRefusal = await page.evaluate(async sessionId => { try { await window.uah.journal({ action: 'cleanup-review', sessionId }); return null; } catch (error) { return String(error); } }, sessionId);
    check('active SSE run refuses cleanup over IPC', /等待会话任务/.test(activeRefusal));
    held.end(frame({ choices: [{ index: 0, delta: { content: 'GC HOLD COMPLETE' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'); await terminal('GC HOLD TASK');
    const oldSessionId = await page.evaluate(async () => { const reply = await window.uah.command({ type: 'create-session', title: 'Empty unclassified GC fixture', directory: null }); return reply.sessions.find(item => item.title === 'Empty unclassified GC fixture').id; });
    const legacyRefusal = await page.evaluate(async sessionId => { try { await window.uah.journal({ action: 'cleanup-review', sessionId }); return null; } catch (error) { return String(error); } }, oldSessionId);
    check('empty unclassified session is refused rather than fabricated as native', /旧记录/.test(legacyRefusal));
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, screenshots, geometries, requests: requests.length, sessionId, activeRefusal, legacyRefusal, errors, consoleErrors }, null, 2)); console.log(`PASS journal GC desktop: ${evidence}`);
} catch (cause) {
    const failureSnapshot = app ? await snapshot().catch(() => null) : null;
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, failure: String(cause), checks, screenshots, geometries, requests, sessionId, failureSnapshot, errors, consoleErrors }, null, 2)); throw cause;
} finally { held?.destroy(); if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
