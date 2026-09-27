import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const secret = 'fixture-secret-not-for-rendering';
const requests = [];
const openResponses = new Set();
let mode = 'normal';

function readRequest(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
            } catch (error) {
                reject(error);
            }
        });
        request.on('error', reject);
    });
}

function writeSse(response, data) {
    response.write(`data: ${data}\n\n`);
}

const server = http.createServer(async (request, response) => {
    const url = new URL(request.url || '/', 'http://127.0.0.1');
    const authorized = request.headers.authorization === `Bearer ${secret}` || request.headers['x-api-key'] === secret;
    if (!authorized) {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'missing fixture authorization' }));
        return;
    }
    if (request.method === 'GET' && url.pathname === '/v1/models') {
        if (mode === 'invalid-models') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ data: Array.from({ length: 501 }, (_, i) => ({ id: 'fixture-model-' + i })) }));
            return;
        }
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'fixture-model', context_length: 128000, input_modalities: ['text','image'], output_modalities: ['text'], supports_tools: false, capabilities: { reasoning: true } }] }));
        return;
    }
    if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'unknown fixture route' }));
        return;
    }

    const body = await readRequest(request);
    requests.push({ body, authorized });
    if (mode === 'unauthorized') {
        response.writeHead(401, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'fixture unauthorized response' }));
        return;
    }

    response.writeHead(200, {
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
        'content-type': 'text/event-stream; charset=utf-8',
    });
    if (mode === 'hang') {
        writeSse(response, JSON.stringify({ choices: [{ delta: { content: '正在等待停止' }, finish_reason: null }] }));
        openResponses.add(response);
        response.on('close', () => openResponses.delete(response));
        return;
    }
    const input = body.messages?.at(-1)?.content;
    const output = input === '第一轮真实流式'
        ? '你好，第一轮流式回复。'
        : input === '第二轮带历史'
            ? '第二轮已经读取历史。'
            : '连接测试通过。';
    writeSse(response, JSON.stringify({ choices: [{ delta: { content: output.slice(0, 4) }, finish_reason: null }] }));
    writeSse(response, JSON.stringify({ choices: [{ delta: { content: output.slice(4) }, finish_reason: 'stop' }] }));
    writeSse(response, '[DONE]');
    response.end();
});

await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const serverAddress = server.address();
assert.ok(serverAddress && typeof serverAddress === 'object');
const baseUrl = `http://127.0.0.1:${serverAddress.port}/v1`;

await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'endpoints-'));
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.UAH_DEV_URL;
const checks = [];
const pageErrors = [];
let desktop;
let page;
let endpointId;
let firstSessionCount;

async function launch() {
    desktop = await electron.launch({ args: ['.'], cwd: root, env: environment, timeout: 30000 });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(window.uah?.endpoints));
}

async function closeDesktop() {
    if (desktop) {
        await desktop.close();
        desktop = null;
    }
}

async function endpointList() {
    return page.evaluate(() => window.uah.endpoints({ type: 'list' }));
}

async function snapshot() {
    return page.evaluate(() => window.uah.command({ type: 'snapshot' }));
}

async function check(name, action) {
    await action();
    checks.push(name);
    console.log(`PASS ${name}`);
}

function dialogHeading(name) {
    return page.getByRole('heading', { name, exact: true });
}

async function settle() {
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function clearNotifications() {
    await page.getByRole('button', { name: '关闭通知', exact: true }).evaluateAll((buttons) => {
        for (const button of buttons) button.click();
    });
    await settle();
    await page.waitForFunction(() => document.querySelectorAll('.ui-snackbar').length === 0);
    await settle();
}

async function waitForDialog(name) {
    const dialog = page.getByRole('dialog', { name, exact: true });
    await dialogHeading(name).waitFor();
    await dialog.waitFor({ state: 'visible' });
    await page.waitForFunction((title) => {
        const heading = [...document.querySelectorAll('h2')].find((element) => element.textContent === title);
        return heading?.closest('dialog')?.dataset.state === 'open';
    }, name);
    await settle();
    return dialog;
}

async function waitForViewport() {
    await page.waitForFunction(async () => {
        const measurements = [];
        for (let index = 0; index < 3; index += 1) {
            measurements.push(`${window.innerWidth}x${window.innerHeight}:${getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--nav-width')}`);
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        return new Set(measurements).size === 1 && getComputedStyle(document.querySelector('.app-shell')).getPropertyValue('--nav-width').trim() === '57px';
    });
    await settle();
}

async function captureWindow(name) {
    const data = await desktop.evaluate(async ({ BrowserWindow }) => (
        await BrowserWindow.getAllWindows()[0].capturePage()
    ).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64'));
}

async function captureEditor(name, position) {
    const dialog = await waitForDialog('编辑端点');
    await clearNotifications();
    const viewport = dialog.locator('.ui-dialog-scroll > .ui-scroll-viewport');
    await viewport.evaluate((element, target) => {
        element.scrollTop = target === 'bottom' ? element.scrollHeight : 0;
    }, position);
    await settle();
    const scroll = await viewport.evaluate((element) => ({ top: element.scrollTop, bottom: element.scrollTop + element.clientHeight, height: element.scrollHeight }));
    if (position === 'top') assert.equal(scroll.top, 0);
    else assert.ok(scroll.bottom >= scroll.height - 1, 'editor did not reach its bottom actions');
    await captureWindow(name);
}

async function captureList(name) {
    await clearNotifications();
    await settle();
    await captureWindow(name);
}

try {
    await launch();
    await check('creates a fixture endpoint through the management UI and tests discovery plus SSE', async () => {
        await page.getByRole('button', { name: '模型与账号', exact: true }).click();
        await page.getByRole('heading', { name: '模型与账号', exact: true }).waitFor();
        await page.getByRole('button', { name: '添加端点', exact: true }).click();
        await waitForDialog('添加端点');
        await page.getByRole('textbox', { name: '名称', exact: true }).fill('Fixture API');
        await page.getByRole('textbox', { name: 'API 基础地址', exact: true }).fill(baseUrl);
        await page.getByRole('textbox', { name: 'API Key', exact: true }).fill(secret);
        await page.getByRole('combobox', { name: '协议', exact: true }).selectOption('anthropic');
        await page.getByRole('button', { name: '读取模型目录', exact: true }).click();
        await page.getByTitle('fixture-model', { exact: true }).waitFor();
        await page.getByRole('combobox', { name: '协议', exact: true }).selectOption('openai-chat');
        await page.getByRole('combobox', { name: '测试模型', exact: true }).selectOption('fixture-model');
        await page.getByRole('button', { name: '测试连接', exact: true }).click();
        await page.getByText('流式对话测试通过', { exact: true }).waitFor();
        await page.getByRole('region', { name: '测试模型实际回复', exact: true }).getByText('连接测试通过。', { exact: true }).waitFor();
        await page.locator('dialog[open] .ui-dialog-scroll > .ui-scroll-viewport').evaluate(e => { e.scrollTop = e.scrollHeight; });
        assert.equal(await page.getByText('流式对话测试通过', { exact: true }).evaluate(e => e.getBoundingClientRect().top >= 0), true);
        await settle();
        await captureWindow('endpoint-test-result.png');
        assert.ok(requests.some((request) => request.body.messages?.[0]?.content === 'Reply with the single word OK.'));
        await page.getByRole('button', { name: '保存端点', exact: true }).click();
        await dialogHeading('添加端点').waitFor({ state: 'hidden' });
        await page.getByLabel('启用 Fixture API', { exact: true }).waitFor();
        assert.equal(await page.getByLabel('启用 Fixture API', { exact: true }).isChecked(), true);
        await captureList('endpoint-list-light.png');

        const listed = await endpointList();
        assert.equal(listed.endpoints.length, 1);
        const endpoint = listed.endpoints[0];
        endpointId = endpoint.id;
        assert.deepEqual(endpoint.modelDetails, [{ id: 'fixture-model', imageInput: true, pdfInput: false, audioInput: false, videoInput: false, inputModalities: ['text','image'], outputModalities: ['text'], contextWindow: 128000, tools: false, vision: true, reasoning: true }]);
        assert.deepEqual(Object.keys(endpoint).sort(), ['baseUrl', 'enabled', 'hasKey', 'id', 'modelDetails', 'models', 'name', 'protocol', 'revision']);
        assert.equal(endpoint.enabled, true);
        assert.equal(endpoint.hasKey, true);
        assert.equal(JSON.stringify(listed).includes(secret), false);
        assert.equal(await page.evaluate((value) => Object.values(localStorage).join('\n').includes(value), secret), false);
    });

    await check('edits without rendering the saved key, retains it, and enables the endpoint', async () => {
        await page.getByRole('button', { name: '编辑 Fixture API', exact: true }).click();
        await waitForDialog('编辑端点');
        await page.getByText(/上下文：128,000 tokens/).waitFor();
        await page.getByRole('img', { name: '图片输入', exact: true }).hover();
        await page.getByRole('tooltip', { name: '图片输入', exact: true }).waitFor();
        await captureWindow('capability-tooltip.png');
        await page.mouse.move(10, 10);
        await page.getByRole('tooltip', { name: '图片输入', exact: true }).waitFor({ state: 'hidden' });
        await captureEditor('endpoint-editor-light-top.png', 'top');
        await captureEditor('endpoint-editor-light-bottom.png', 'bottom');
        assert.equal(await page.locator('body').innerText().then((text) => text.includes(secret)), false);
        await page.getByRole('combobox', { name: '密钥操作', exact: true }).selectOption('keep');
        assert.equal(await page.getByRole('textbox', { name: 'API Key', exact: true }).count(), 0);
        assert.equal(await page.getByLabel('启用端点', { exact: true }).count(), 0);
        await page.getByRole('button', { name: '编辑模型能力 fixture-model', exact: true }).click();
        await page.getByRole('combobox', { name: 'PDF 输入', exact: true }).selectOption('true');
        await page.getByRole('button', { name: '关闭模型能力设置', exact: true }).click();
        await page.getByRole('heading', { name: '模型能力设置', exact: true }).waitFor({ state: 'hidden' });

        await page.getByRole('button', { name: '移除模型 fixture-model', exact: true }).click();
        await page.getByRole('button', { name: '读取模型目录', exact: true }).click();
        await page.getByTitle('fixture-model', { exact: true }).waitFor();
        await page.getByRole('button', { name: '编辑模型能力 fixture-model', exact: true }).click();
        await page.getByRole('combobox', { name: 'PDF 输入', exact: true }).selectOption('true');
        await page.getByRole('combobox', { name: '音频输入', exact: true }).selectOption('true');
        await page.getByRole('combobox', { name: '视频输入', exact: true }).selectOption('false');
        await page.getByRole('textbox', { name: '上下文长度覆盖', exact: true }).fill('200000');
        await settle();
        await captureWindow('model-capabilities-editor.png');
        await page.getByRole('button', { name: '应用到端点草稿', exact: true }).click();
        await page.getByRole('heading', { name: '模型能力设置', exact: true }).waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '读取模型目录', exact: true }).click();
        await page.getByRole('img', { name: 'PDF 输入', exact: true }).waitFor();
        assert.equal(await page.getByRole('img', { name: '视频输入', exact: true }).count(), 0);
        await page.getByRole('button', { name: '保存端点', exact: true }).click();
        await dialogHeading('编辑端点').waitFor({ state: 'hidden' });
        assert.equal(await page.getByLabel('启用 Fixture API', { exact: true }).isChecked(), true);
        const listed = await endpointList();
        assert.equal(listed.endpoints[0].id, endpointId);
        assert.deepEqual(listed.endpoints[0].modelOverrides, [{id:'fixture-model',pdfInput:true,audioInput:true,videoInput:false,contextWindow:200000}]);
        assert.equal(listed.endpoints[0].revision, 1);
        assert.equal(listed.endpoints[0].enabled, true);
    });

    await check('captures dark and narrow endpoint views and confirms visible actions without page overflow', async () => {
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('radio', { name: '深色', exact: true }).click();
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await page.getByRole('button', { name: '模型与账号', exact: true }).click();
        await page.getByRole('heading', { name: '模型与账号', exact: true }).waitFor();
        await captureList('endpoint-list-dark.png');
        await page.getByRole('button', { name: '编辑 Fixture API', exact: true }).click();
        await waitForDialog('编辑端点');
        await captureEditor('endpoint-editor-dark-top.png', 'top');
        await captureEditor('endpoint-editor-dark-bottom.png', 'bottom');
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await dialogHeading('编辑端点').waitFor({ state: 'hidden' });

        await desktop.evaluate(({ BrowserWindow }) => {
            const current = BrowserWindow.getAllWindows()[0];
            current.setSize(900, 800);
            current.webContents.setZoomFactor(1.25);
        });
        await waitForViewport();
        await captureList('endpoint-list-dark-narrow.png');
        const layout = await page.evaluate(() => {
            const button = (name) => [...document.querySelectorAll('button')].find((item) => (item.getAttribute('aria-label') || item.textContent?.trim()) === name);
            return {
                overflow: document.documentElement.scrollWidth > window.innerWidth,
                edit: button('编辑 Fixture API')?.getBoundingClientRect().toJSON(),
                remove: button('删除 Fixture API')?.getBoundingClientRect().toJSON(),
                width: window.innerWidth,
                height: window.innerHeight,
            };
        });
        assert.equal(layout.overflow, false);
        for (const action of [layout.edit, layout.remove]) {
            assert.ok(action && action.width > 0 && action.height > 0);
            assert.ok(action.x >= 0 && action.y >= 0 && action.x + action.width <= layout.width && action.y + action.height <= layout.height);
        }
        await page.getByRole('button', { name: '编辑 Fixture API', exact: true }).click();
        await waitForDialog('编辑端点');
        await captureEditor('endpoint-editor-dark-narrow-top.png', 'top');
        await captureEditor('endpoint-editor-dark-narrow-bottom.png', 'bottom');
        await page.getByRole('button', { name: '编辑模型能力 fixture-model', exact: true }).click();
        await page.getByRole('combobox', { name: '输出模态设置', exact: true }).selectOption('manual');
        await page.getByRole('combobox', { name: '音频输出', exact: true }).selectOption('true');
        await page.getByRole('combobox', { name: 'PDF输出', exact: true }).selectOption('true');
        await settle();
        await captureWindow('model-capabilities-dark-narrow.png');
        await page.getByRole('button', { name: '关闭模型能力设置', exact: true }).click();
        await page.getByRole('heading', { name: '模型能力设置', exact: true }).waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await dialogHeading('编辑端点').waitFor({ state: 'hidden' });
        await desktop.evaluate(({ BrowserWindow }) => {
            const current = BrowserWindow.getAllWindows()[0];
            current.webContents.setZoomFactor(1);
            current.setSize(1440, 960);
        });
    });

    await check('discards unsaved endpoint edits through the confirmation dialog', async () => {
        await page.getByRole('button', { name: '编辑 Fixture API', exact: true }).click();
        await waitForDialog('编辑端点');
        await page.getByRole('textbox', { name: '名称', exact: true }).fill('Should not persist');
        await page.keyboard.press('Control+n');
        await page.keyboard.press('Control+k');
        await waitForDialog('编辑端点');
        assert.equal(await page.getByRole('textbox', { name: '名称', exact: true }).inputValue(), 'Should not persist');
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await waitForDialog('放弃端点更改？');
        await page.getByRole('button', { name: '放弃更改', exact: true }).click();
        await dialogHeading('编辑端点').waitFor({ state: 'hidden' });
        assert.equal((await endpointList()).endpoints[0].name, 'Fixture API');
    });

    await check('sends two real streamed turns and includes completed history in the second request', async () => {
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        const picker = page.getByRole('combobox', { name: '运行模型', exact: true });
        await picker.click();
        assert.equal(await picker.locator('option[hidden]').isVisible(), false);
        assert.equal(await picker.locator('optgroup[label="Fixture API"] option').textContent(), 'fixture-model');
        assert.equal(await picker.locator('.ui-scroll-viewport').count(), 1);
        await page.waitForTimeout(250);
        await captureWindow('model-picker-grouped.png');
        await page.keyboard.press('Escape');
        await picker.selectOption(JSON.stringify([endpointId, 'fixture-model']));
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('第一轮真实流式');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        await page.getByText('你好，第一轮流式回复。', { exact: true }).waitFor();
        assert.equal(await picker.isEnabled(), true);
        await picker.click();
        await picker.locator('optgroup option').click();
        assert.equal(await picker.inputValue(), JSON.stringify([endpointId, 'fixture-model']));
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('第二轮带历史');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        await page.getByText('第二轮已经读取历史。', { exact: true }).waitFor();
        const second = requests.findLast((request) => request.body.messages?.at(-1)?.content === '第二轮带历史');
        assert.ok(second);
        assert.deepEqual(second.body.messages, [
            { role: 'user', content: '第一轮真实流式' },
            { role: 'assistant', content: '你好，第一轮流式回复。' },
            { role: 'user', content: '第二轮带历史' },
        ]);
        firstSessionCount = (await snapshot()).sessions.length;
    });

    await closeDesktop();
    await check('restarts with encrypted persisted data, existing history, and a usable saved key', async () => {
        const database = await readFile(path.join(evidence, 'data', 'endpoints.sqlite'));
        assert.equal(database.includes(Buffer.from(secret, 'utf8')), false);
        await launch();
        const listed = await endpointList();
        assert.equal(listed.endpoints.length, 1);
        assert.equal(JSON.stringify(listed).includes(secret), false);
        assert.equal((await snapshot()).sessions.length, firstSessionCount);
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('combobox', { name: '运行模型', exact: true }).selectOption(JSON.stringify([endpointId, 'fixture-model']));
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('重启后的密钥验证');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        assert.ok(requests.some((request) => request.body.messages?.at(-1)?.content === '重启后的密钥验证' && request.authorized));
    });

    await check('shows a real 401 endpoint test error and stops a hanging API stream', async () => {
        await page.getByRole('button', { name: '模型与账号', exact: true }).click();
        await page.getByRole('button', { name: '编辑 Fixture API', exact: true }).click();
        await dialogHeading('编辑端点').waitFor();
        await page.getByText(/上下文：200,000 tokens/).waitFor();
        assert.deepEqual((await endpointList()).endpoints[0].modelOverrides, [{id:'fixture-model',pdfInput:true,audioInput:true,videoInput:false,contextWindow:200000}]);
        assert.equal((await endpointList()).endpoints[0].modelDetails[0].tools, false);
        mode = 'invalid-models';
        await page.getByRole('button', { name: '读取模型目录', exact: true }).click();
        const diagnostic = page.getByRole('alert').filter({ hasText: '模型目录返回 501 项' });
        await diagnostic.waitFor();
        const errorText = await diagnostic.innerText();
        assert(errorText.includes('当前上限为 500 项'));
        assert(errorText.includes('HTTP 200'));
        const requestId = errorText.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/)?.[0];
        assert(requestId);
        const log = await readFile(path.join(evidence, 'data', 'logs', 'runtime.jsonl'), 'utf8');
        assert(log.includes(requestId));
        assert(log.includes('models.count_limit'));
        const trace = log.trim().split('\n').map(line => JSON.parse(line)).filter(record => record.requestId === requestId);
        assert(trace.every(record => record.operation === 'models' && record.protocol === 'openai-chat'));
        assert.equal(trace.at(-1).event, 'request.failed');
        assert(!log.includes(secret));
        assert(!log.includes('第一轮真实流式'));
        await settle();
        await captureWindow('endpoint-detailed-error.png');
        await desktop.evaluate(({ shell }) => {
            globalThis.originalOpenPath = shell.openPath;
            shell.openPath = async (directory) => { globalThis.openedLogDirectory = directory; return ''; };
        });
        try {
            await page.locator('dialog[open]').getByRole('button', { name: '打开日志目录', exact: true }).click();
            await page.waitForFunction(() => !document.querySelector('dialog[open] button[aria-busy="true"]'));
            assert.equal(await desktop.evaluate(() => globalThis.openedLogDirectory), path.join(evidence, 'data', 'logs'));
        } finally {
            await desktop.evaluate(({ shell }) => { shell.openPath = globalThis.originalOpenPath; });
        }
        mode = 'unauthorized';
        await page.getByRole('button', { name: '测试连接', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: 'HTTP 401' }).waitFor();
        const dialog = page.locator('dialog[open]');
        await dialog.locator('.ui-dialog-scroll > .ui-scroll-viewport').evaluate(e => { e.scrollTop = e.scrollHeight; });
        const bounds = await dialog.evaluate(d => {
            const r=d.getBoundingClientRect(), a=d.querySelector('[role=alert]').getBoundingClientRect(), v=d.querySelector('.ui-dialog-scroll').getBoundingClientRect();
            return { top:r.top, alertTop:a.top, alertBottom:a.bottom, bodyTop:v.top, outerScroll:d.scrollTop };
        });
        assert(bounds.alertTop >= bounds.top && bounds.alertBottom <= bounds.bodyTop + 1);
        assert.equal(bounds.outerScroll, 0);
        await settle();
        await captureWindow('endpoint-error-fixed.png');
        mode = 'normal';
        await page.getByRole('button', { name: '关闭', exact: true }).click();
        await dialogHeading('编辑端点').waitFor({ state: 'hidden' });

        mode = 'hang';
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('combobox', { name: '运行模型', exact: true }).selectOption(JSON.stringify([endpointId, 'fixture-model']));
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('停止挂起流');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByText('正在等待停止', { exact: true }).waitFor();
        await page.getByRole('button', { name: '停止当前任务', exact: true }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已中止' }).waitFor();
        mode = 'normal';
    });

    await check('disables through the UI, blocks new sends after refresh, and deletes without removing history', async () => {
        await page.getByRole('button', { name: '模型与账号', exact: true }).click();
        await page.getByRole('button', { name: '编辑 Fixture API', exact: true }).click();
        await dialogHeading('编辑端点').waitFor();
        await page.getByRole('button', { name: '编辑模型能力 fixture-model', exact: true }).click();
        await page.getByRole('button', { name: '恢复接口声明', exact: true }).click();
        await page.getByRole('heading', { name: '模型能力设置', exact: true }).waitFor({ state: 'hidden' });
        assert.equal(await page.getByRole('img', { name: 'PDF 输入', exact: true }).count(), 0);

        await page.getByRole('button', { name: '保存端点', exact: true }).click();
        await dialogHeading('编辑端点').waitFor({ state: 'hidden' });
        await page.getByLabel('启用 Fixture API', { exact: true }).uncheck();
        await page.waitForFunction(async () => !(await window.uah.endpoints({ type: 'list' })).endpoints[0].enabled);
        assert.equal((await endpointList()).endpoints[0].enabled, false);
        assert.equal((await endpointList()).endpoints[0].modelOverrides, undefined);
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('停用端点后不可发送');
        assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);

        await page.getByRole('button', { name: '模型与账号', exact: true }).click();
        await page.getByRole('button', { name: '删除 Fixture API', exact: true }).click();
        await dialogHeading('删除端点？').waitFor();
        await page.getByRole('button', { name: '确认删除', exact: true }).click();
        await page.getByText('还没有 API 端点', { exact: true }).waitFor();
        assert.deepEqual((await endpointList()).endpoints, []);
        assert.ok((await snapshot()).sessions.length >= firstSessionCount);
    });

    assert.deepEqual(pageErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({
        passed: checks,
        pageErrors,
        requestCount: requests.length,
        screenshots: [
            'endpoint-list-light.png',
            'endpoint-editor-light-top.png',
            'endpoint-editor-light-bottom.png',
            'endpoint-list-dark.png',
            'endpoint-editor-dark-top.png',
            'endpoint-editor-dark-bottom.png',
            'endpoint-list-dark-narrow.png',
            'endpoint-editor-dark-narrow-top.png',
            'endpoint-editor-dark-narrow-bottom.png',
        ],
    }, null, 4));
    console.log(`Evidence: ${evidence}`);
} finally {
    mode = 'normal';
    for (const response of openResponses) {
        response.end();
    }
    await closeDesktop();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
