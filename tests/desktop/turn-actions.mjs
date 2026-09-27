import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts/turn-actions-'));
const project = path.join(evidence, 'project');
await mkdir(project);
await writeFile(path.join(project, 'example.txt'), 'before\n');
const requests = [];
const errors = [];
let initial = true;
const sse = data => `data: ${JSON.stringify(data)}\n\n`;
const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const tools = body.messages.filter(item => item.role === 'tool');
    const input = body.messages.filter(item => item.role === 'user').at(-1).content;
    if (input === 'Prototype fixture' && initial && !tools.length) {
        initial = false;
        const calls = [
            ['read-1', 'read_file', { path: 'example.txt' }],
            ['read-2', 'list_directory', { path: '.' }],
            ['write', 'write_file', { path: 'example.txt', expectedContent: 'before\n', content: 'after\n' }],
        ];
        response.end(sse({ choices: [{ delta: { tool_calls: calls.map(([id, name, args], index) => ({ index, id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n');
    } else {
        const content = input === 'Branch fixture' ? '分支完成' : tools.length ? '## 完成\n\n已保存修改。' : '重新生成完成';
        response.end(sse({ choices: [{ delta: { content }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete env.ELECTRON_RUN_AS_NODE;
delete env.UAH_DEV_URL;
let app = await electron.launch({ args: ['.'], cwd: root, env });
try {
    let page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    await page.evaluate(url => (async () => {
        const directory = await window.uah.chooseDirectory();
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Fixture', protocol: 'openai-chat', baseUrl: url, models: ['fixture'], enabled: true, revision: 0, apiKey: null } });
        await window.uah.command({ type: 'create-session', title: 'Prototype actions', directory, selection: { endpointId: saved.endpoints[0].id, modelId: 'fixture' }, agentId: 'default', controls: { permissionMode: 'manual', reasoningEffort: 'default' } });
    })(), `http://127.0.0.1:${server.address().port}/v1`);
    await page.reload();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Prototype fixture');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('button', { name: '批准本次操作', exact: true }).waitFor();
    const group = page.locator('.turn .ui-activity').filter({ has: page.locator(':scope > .ui-activity-heading .ui-activity-title').getByText('使用了 3 个工具', { exact: true }) }).first();
    assert.equal(await group.locator(':scope > .ui-activity-heading').getAttribute('aria-expanded'), 'true');
    await page.getByRole('button', { name: '批准本次操作', exact: true }).click();
    await page.getByRole('heading', { name: '完成', exact: true }).waitFor();
    await page.locator('.turn .ui-diff.is-compact').getByText('保存的快照', { exact: false }).waitFor();
    const changes = page.locator('.turn .ui-file-changes');
    assert.equal(await changes.locator('.ui-file-change-row').count(), 1);
    assert.equal(await changes.locator('.ui-file-change-added').textContent(), '+1');
    for (const [theme, width, zoom] of [['light', 1440, 1], ['dark', 900, 1.25]]) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(width, 900); win.webContents.setZoomFactor(zoom); }, { width, zoom });
        await page.locator('.turn .ui-diff.is-compact').scrollIntoViewIfNeeded();
        await page.waitForTimeout(200);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
        await writeFile(path.join(evidence, `prototype-${theme}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    await group.locator(':scope > .ui-activity-heading').click();
    assert.equal(await group.locator(':scope > .ui-activity-heading').getAttribute('aria-expanded'), 'false');
    await changes.getByRole('button', { name: '查看全部', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '会话工作面板' });
    await panel.locator('.ui-file-change-row').click();
    await panel.locator('.ui-diff').getByText('after', { exact: true }).waitFor();
    await panel.getByRole('button', { name: '关闭工作面板' }).click();
    assert.equal(await group.locator(':scope > .ui-activity-heading').getAttribute('aria-expanded'), 'false');
    await page.getByRole('button', { name: '复制回复', exact: true }).click();
    await page.getByText('回复已复制。', { exact: true }).waitFor();
    assert.equal(await app.evaluate(async ({ clipboard }) => (await clipboard.readText()).replaceAll('\r\n', '\n') === '## 完成\n\n已保存修改。'), true);
    const count = requests.length;
    await page.getByRole('button', { name: '编辑历史回复', exact: true }).click();
    await page.getByRole('textbox', { name: '回复正文', exact: true }).fill('手动编辑的回复');
    await page.getByRole('button', { name: '仅保存历史修改', exact: true }).click();
    await page.getByText('手动编辑的回复', { exact: true }).waitFor();
    assert.equal(requests.length, count);
    // Restart clears the process-local directory picker grants. Branching an older
    // session must still inherit that session's directory, not the newest draft's.
    await page.evaluate(() => window.uah.command({ type: 'create-session', title: 'Unrelated no-directory session', directory: null }));
    await app.close();
    app = await electron.launch({ args: ['.'], cwd: root, env });
    page = await app.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.locator('.session-button').filter({ hasText: 'Prototype actions' }).click();
    await page.getByText('手动编辑的回复', { exact: true }).waitFor();
    await page.getByRole('button', { name: '从此回复创建分支', exact: true }).click();
    await page.getByText('分支已保存', { exact: false }).waitFor();
    let snapshot = await page.evaluate(() => window.uah.command({ type: 'snapshot' }));
    assert.equal(snapshot.sessions.length, 3);
    assert.equal(requests.length, count, 'branching itself does not call the model');
    assert.equal(await page.locator('.inherited-message').count(), 2);
    await page.locator('.inherited-message').getByText('手动编辑的回复', { exact: true }).waitFor();
    const branch = snapshot.sessions.find(session => session.branchFromRunId);
    assert.ok(branch.branchAgent);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.waitForTimeout(100);
    const branchPng = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, 'saved-branch.png'), Buffer.from(branchPng.split(',')[1], 'base64'));
    await page.reload();
    await page.getByText('分支已保存', { exact: false }).waitFor();
    await page.locator('.inherited-message').getByText('手动编辑的回复', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('Branch fixture');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('分支完成', { exact: true }).waitFor();
    assert.ok(requests.at(-1).messages.some(item => item.role === 'assistant' && item.content === '手动编辑的回复'));
    await page.getByRole('button', { name: '重新生成最新回复', exact: true }).click();
    await page.getByRole('button', { name: '重新生成', exact: true }).click();
    await page.waitForFunction(async () => {
        const state = await window.uah.command({ type: 'snapshot' });
        return state.runs.some(run => run.retryOfRunId && run.state === 'completed');
    });
    assert.equal(await page.locator('.turn').count(), 1);
    assert.equal(requests.at(-1).messages.filter(item => item.role === 'assistant' && item.content === '分支完成').length, 0);
    assert.ok(requests.at(-1).messages.some(item => item.role === 'assistant' && item.content === '手动编辑的回复'));
    await page.getByRole('button', { name: '删除回复记录', exact: true }).click();
    await page.getByRole('button', { name: '删除记录', exact: true }).click();
    await page.getByText('回复记录已删除', { exact: true }).waitFor();
    await page.locator('.session-button').filter({ hasText: 'Prototype actions' }).filter({ hasNotText: '分支' }).click();
    assert.equal(await page.getByRole('button', { name: '重新生成最新回复', exact: true }).count(), 0);
    const refused = await page.evaluate(async () => {
        const state = await window.uah.command({ type: 'snapshot' });
        const source = state.sessions.find(session => !session.branchFromRunId);
        const run = state.runs.find(run => run.sessionId === source.id);
        try { await window.uah.command({ type: 'regenerate-run', runId: run.id }); return ''; }
        catch (error) { return error.message; }
    });
    assert.match(refused, /文件/);
    assert.equal(await page.locator('.turn').count(), 1);
    assert.equal(await readFile(path.join(project, 'example.txt'), 'utf8'), 'after\n');
    assert.equal(await page.locator('.turn .ui-file-change-row').count(), 1);
    for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
        await writeFile(path.join(evidence, `${theme}.png`), Buffer.from(png.split(',')[1], 'base64'));
    }
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, requests: requests.length, errors }, null, 4));
    console.log('PASS grouped tools, inline diff, round changes, copy/edit/branch/regenerate/delete: ' + evidence);
} finally { await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
