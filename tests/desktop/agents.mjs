import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const requests = [];
const serverErrors = [];
const pageErrors = [];
const checks = [];
const modelIds = ['fixture-model', 'fixture-model-alt'];
const modelParameters = [
    {
        id: modelIds[0],
        parameters: {
            temperature: 0.4,
            topP: 0.7,
            maxOutputTokens: 128,
            reasoningEffort: 'default',
            thinkingBudget: null,
            historyTurns: 0,
            timeoutSeconds: 90,
            stop: ['STOP-A'],
        },
    },
    {
        id: modelIds[1],
        parameters: {
            temperature: 1.1,
            topP: 0.3,
            maxOutputTokens: 64,
            reasoningEffort: 'default',
            thinkingBudget: null,
            historyTurns: 0,
            timeoutSeconds: 120,
            stop: ['STOP-B'],
        },
    },
];

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

const server = http.createServer((request, response) => {
    void (async () => {
        const url = new URL(request.url || '/', 'http://127.0.0.1');
        if (request.method !== 'POST' || url.pathname !== '/v1/chat/completions') {
            response.writeHead(404, { 'content-type': 'application/json' });
            response.end(JSON.stringify({ error: 'unknown fixture route' }));
            return;
        }
        const body = await readRequest(request);
        requests.push({
            body,
            authorization: request.headers.authorization,
            apiKey: request.headers['x-api-key'],
        });
        const input = body.messages?.at(-1)?.content;
        const output = input === 'fixture first turn' ? 'fixture reply one'
            : input === 'fixture second turn' ? 'fixture reply two'
                : 'fixture response';
        response.writeHead(200, {
            'cache-control': 'no-cache',
            connection: 'keep-alive',
            'content-type': 'text/event-stream; charset=utf-8',
        });
        writeSse(response, JSON.stringify({ choices: [{ delta: { content: output.slice(0, 8) }, finish_reason: null }] }));
        writeSse(response, JSON.stringify({ choices: [{ delta: { content: output.slice(8) }, finish_reason: 'stop' }] }));
        writeSse(response, '[DONE]');
        response.end();
    })().catch((error) => {
        serverErrors.push(error instanceof Error ? error.message : String(error));
        if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
        response.end();
    });
});

await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
});
const address = server.address();
assert.ok(address && typeof address === 'object');
const baseUrl = `http://127.0.0.1:${address.port}/v1`;

await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'agents-'));
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.UAH_DEV_URL;
let desktop;
let page;
let endpointId;
let alternateAgentId;
let reviewerAgentId;
let parentRunId;
let lockedRuns = [];

async function launch() {
    desktop = await electron.launch({ args: ['.'], cwd: root, env: environment, timeout: 30000 });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(window.uah?.agents && window.uah?.endpoints && window.uah?.previewDelegation));
}

async function closeDesktop() {
    if (!desktop) return;
    await desktop.close();
    desktop = null;
}

async function check(name, action) {
    await action();
    checks.push(name);
    console.log(`PASS ${name}`);
}

async function settle() {
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}

async function captureWindow(name) {
    const data = await desktop.evaluate(async ({ BrowserWindow }) => (
        await BrowserWindow.getAllWindows()[0].capturePage()
    ).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64'));
}

async function captureScrollDialog(dialog, name, position) {
    const viewport = dialog.locator('.ui-dialog-scroll > .ui-scroll-viewport');
    await viewport.waitFor();
    await viewport.evaluate((element, target) => {
        element.scrollTop = target === 'bottom' ? element.scrollHeight : 0;
    }, position);
    await settle();
    const scroll = await viewport.evaluate((element) => ({
        top: element.scrollTop,
        bottom: element.scrollTop + element.clientHeight,
        height: element.scrollHeight,
    }));
    if (position === 'top') assert.equal(scroll.top, 0, `${name} did not reach the top`);
    else assert.ok(scroll.bottom >= scroll.height - 1, `${name} did not reach the bottom`);
    await captureWindow(name);
}

async function profileDialog() {
    const dialog = page.getByRole('dialog', { name: '编辑 Agent 配置', exact: true });
    await dialog.waitFor({ state: 'visible' });
    await settle();
    return dialog;
}

async function endpointDialog() {
    const dialog = page.getByRole('dialog', { name: '编辑端点', exact: true });
    await dialog.waitFor({ state: 'visible' });
    await settle();
    return dialog;
}

async function settings() {
    return page.evaluate(() => window.uah.agents({ type: 'get' }));
}

async function snapshot() {
    return page.evaluate(() => window.uah.command({ type: 'snapshot' }));
}

async function setTheme(theme) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const label = theme === 'dark' ? '深色' : '浅色';
    const radio = page.getByRole('radio', { name: label, exact: true });
    if (await radio.getAttribute('aria-checked') !== 'true') {
        await radio.click();
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
    }
    await page.waitForFunction((expected) => document.documentElement.dataset.theme === expected, theme);
    await page.getByRole('button', { name: '关闭通知', exact: true }).evaluateAll(elements => elements.forEach(element => element.click()));
}

async function setWindowSize(width, height, zoom, theme) {
    await desktop.evaluate(({ BrowserWindow }, dimensions) => {
        const current = BrowserWindow.getAllWindows()[0];
        current.setSize(dimensions.width, dimensions.height);
        current.webContents.setZoomFactor(dimensions.zoom);
    }, { width, height, zoom });
    await page.waitForFunction((expected) => {
        const state = document.documentElement.dataset;
        return window.uah && window.innerWidth > 0 && state.theme === expected.theme;
    }, { theme });
    await settle();
    const actual = await desktop.evaluate(({ BrowserWindow }) => {
        const current = BrowserWindow.getAllWindows()[0];
        return { size: current.getSize(), zoom: current.webContents.getZoomFactor() };
    });
    assert.deepEqual(actual.size, [width, height]);
    assert.equal(actual.zoom, zoom);
}

async function navigateToAgents() {
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('heading', { name: 'Agent 设置', exact: true }).waitFor();
}

async function captureAgentEditor(profileName, filePrefix) {
    await page.getByRole('button', { name: `编辑 Agent ${profileName}`, exact: true }).click();
    const dialog = await profileDialog();
    await captureScrollDialog(dialog, `${filePrefix}-top.png`, 'top');
    await captureScrollDialog(dialog, `${filePrefix}-bottom.png`, 'bottom');
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
}

async function configureModelParameters(modelId, values, screenshotPrefix) {
    await page.getByRole('button', { name: `编辑模型参数 ${modelId}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '模型生成设置', exact: true });
    await dialog.waitFor({ state: 'visible' });
    await dialog.getByRole('spinbutton', { name: 'Temperature', exact: true }).fill(String(values.temperature));
    await dialog.getByRole('spinbutton', { name: 'Top P', exact: true }).fill(String(values.topP));
    await dialog.getByRole('spinbutton', { name: '最大输出 tokens', exact: true }).fill(String(values.maxOutputTokens));
    await dialog.getByRole('spinbutton', { name: '携带历史轮数', exact: true }).fill(String(values.historyTurns));
    await dialog.getByRole('spinbutton', { name: '请求超时（秒）', exact: true }).fill(String(values.timeoutSeconds));
    assert.equal(await dialog.getByRole('combobox', { name: '思考强度', exact: true }).count(), 0);
    await dialog.getByRole('textbox', { name: '停止序列', exact: true }).fill(values.stop.join('\n'));
    await captureScrollDialog(dialog, `${screenshotPrefix}-top.png`, 'top');
    await captureScrollDialog(dialog, `${screenshotPrefix}-bottom.png`, 'bottom');
    await dialog.getByRole('button', { name: '应用到端点草稿', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
}

async function delegationPreview(request) {
    return page.evaluate(async (value) => {
        try {
            return { plan: await window.uah.previewDelegation(value) };
        } catch (error) {
            return { error: error instanceof Error ? error.message : String(error) };
        }
    }, { parentRunId, request });
}

async function requirePlan(request) {
    const result = await delegationPreview(request);
    assert.ok(result.plan, result.error || 'delegation preview did not return a plan');
    assert.equal(result.plan.executionAvailable, false);
    return result.plan;
}

async function requirePreviewError(request, pattern) {
    const result = await delegationPreview(request);
    assert.ok(result.error, 'delegation preview unexpectedly succeeded');
    if (pattern) assert.match(result.error, pattern);
    return result.error;
}

async function sendTurn(input, expectedReply) {
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(input);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
    await page.getByText(expectedReply, { exact: true }).waitFor();
}

try {
    await launch();
    await setTheme('light');
    await setWindowSize(900, 800, 1.25, 'light');

    const seeded = await page.evaluate(({ url, models }) => window.uah.endpoints({
        type: 'save',
        draft: {
            id: null,
            name: 'Fixture Agent API',
            protocol: 'openai-chat',
            baseUrl: url,
            models,
            enabled: true,
            revision: 0,
            apiKey: null,
        },
    }), { url: baseUrl, models: modelIds });
    assert.equal(seeded.endpoints.length, 1);
    endpointId = seeded.endpoints[0].id;
    await page.reload();
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(window.uah?.agents && window.uah?.endpoints));

    await check('configures independent parameters for each provider model', async () => {
        await page.getByRole('button', { name: '模型与账号', exact: true }).click();
        await page.getByRole('heading', { name: '模型与账号', exact: true }).waitFor();
        await page.getByRole('button', { name: '编辑 Fixture Agent API', exact: true }).click();
        const dialog = await endpointDialog();

        await configureModelParameters(modelIds[0], modelParameters[0].parameters, 'model-settings-fixture-light-900-800-125');
        await configureModelParameters(modelIds[1], modelParameters[1].parameters, 'model-settings-alt-light-900-800-125');
        await dialog.getByRole('button', { name: '保存端点', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });

        const listed = await page.evaluate(() => window.uah.endpoints({ type: 'list' }));
        assert.deepEqual(listed.endpoints[0].modelParameters, modelParameters);
    });

    await navigateToAgents();
    await check('keeps model and generation settings outside the primary Agent editor', async () => {
        await page.getByRole('button', { name: '编辑 Agent 默认助手', exact: true }).waitFor();
        await captureWindow('agent-list-light-900-800-125.png');
        const initial = await settings();
        const primary = initial.profiles.find((item) => item.id === 'default');
        assert.ok(primary);
        assert.equal(primary.allowDelegation, true);

        await page.getByRole('button', { name: '编辑 Agent 默认助手', exact: true }).click();
        const dialog = await profileDialog();
        assert.equal(await dialog.getByRole('combobox', { name: '默认模型', exact: true }).count(), 0);
        assert.equal(await dialog.getByRole('spinbutton', { name: 'Temperature', exact: true }).count(), 0);
        await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('Fixture Agent');
        await dialog.getByRole('textbox', { name: 'Agent 指令', exact: true }).fill('fixture agent instruction');
        assert.equal(await dialog.getByRole('combobox', { name: '权限模式', exact: true }).count(), 0);
        const delegationSwitch = dialog.getByRole('checkbox', { name: '允许继续委派', exact: true });
        assert.equal(await delegationSwitch.isChecked(), true);
        await captureScrollDialog(dialog, 'primary-editor-light-900-800-125-top.png', 'top');
        await captureScrollDialog(dialog, 'primary-editor-light-900-800-125-bottom.png', 'bottom');
        await dialog.getByRole('button', { name: '保存 Agent', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });

        const saved = await settings();
        const configured = saved.profiles.find((item) => item.id === 'default');
        assert.ok(configured);
        assert.equal(configured.name, 'Fixture Agent');
        assert.equal(configured.instructions, 'fixture agent instruction');
        assert.equal('permissionMode' in configured, false);
        assert.equal(configured.allowDelegation, true);
        assert.equal('model' in configured, false);
        assert.equal('parameters' in configured, false);
    });

    await check('adds another primary Agent and a restricted reviewer preset with an optional model', async () => {
        await page.getByRole('button', { name: '添加主 Agent', exact: true }).click();
        let dialog = await profileDialog();
        await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('Alternate Agent');
        await dialog.getByRole('textbox', { name: 'Agent 指令', exact: true }).fill('alternate primary instructions');
        await dialog.getByRole('button', { name: '保存 Agent', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        alternateAgentId = (await settings()).profiles.find((item) => item.name === 'Alternate Agent')?.id;
        assert.ok(alternateAgentId);

        await page.getByRole('button', { name: '添加子代理角色', exact: true }).click();
        dialog = await profileDialog();
        assert.equal(await dialog.getByRole('spinbutton', { name: 'Temperature', exact: true }).count(), 0);
        await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('reviewer');
        await dialog.getByRole('textbox', { name: '用途说明', exact: true }).fill('Reviews fixture agent changes.');
        await dialog.getByRole('textbox', { name: 'Agent 指令', exact: true }).fill('reviewer fixture instructions');
        assert.equal(await dialog.getByRole('combobox', { name: '权限模式', exact: true }).count(), 0);
        await dialog.getByRole('combobox', { name: '可选绑定模型', exact: true }).selectOption(JSON.stringify([endpointId, modelIds[1]]));
        const enabledSwitch = dialog.getByRole('checkbox', { name: '可供选择', exact: true });
        assert.equal(await enabledSwitch.isChecked(), true);
        await captureScrollDialog(dialog, 'subagent-role-light-900-800-125-top.png', 'top');
        await captureScrollDialog(dialog, 'subagent-role-light-900-800-125-bottom.png', 'bottom');
        await dialog.getByRole('button', { name: '保存 Agent', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });

        const saved = await settings();
        const reviewer = saved.profiles.find((item) => item.name === 'reviewer');
        assert.ok(reviewer);
        reviewerAgentId = reviewer.id;
        assert.equal(reviewer.kind, 'subagent');
        assert.equal(reviewer.description, 'Reviews fixture agent changes.');
        assert.equal(reviewer.instructions, 'reviewer fixture instructions');
        assert.equal('permissionMode' in reviewer, false);
        assert.deepEqual(reviewer.model, { endpointId, modelId: modelIds[1] });
        assert.equal('parameters' in reviewer, false);
    });

    await check('saves only global scheduling controls and captures the light scheduler', async () => {
        await page.getByRole('button', { name: '调度预设', exact: true }).click();
        const scheduler = page.getByRole('dialog', { name: '子代理调度预设', exact: true });
        await scheduler.waitFor({ state: 'visible' });
        await scheduler.getByRole('checkbox', { name: '启用子代理', exact: true }).check();
        await scheduler.getByRole('spinbutton', { name: '最大并发子代理', exact: true }).fill('3');
        await scheduler.getByRole('spinbutton', { name: '最大委派深度', exact: true }).fill('2');
        await scheduler.getByRole('checkbox', { name: '默认继承主代理历史', exact: true }).check();
        await scheduler.getByRole('spinbutton', { name: '子代理超时（秒）', exact: true }).fill('120');
        await captureScrollDialog(scheduler, 'subagent-scheduler-light-900-800-125-top.png', 'top');
        await captureScrollDialog(scheduler, 'subagent-scheduler-light-900-800-125-bottom.png', 'bottom');
        await scheduler.getByRole('button', { name: '保存调度预设', exact: true }).click();
        await scheduler.waitFor({ state: 'hidden' });
        const saved = await settings();
        assert.deepEqual(saved.subagents, {
            enabled: true,
            maxConcurrentThreads: 3,
            maxDepth: 2,
            inheritHistory: true,
            timeoutSeconds: 120,
        });
        assert.deepEqual(Object.keys(saved.subagents).sort(), ['enabled', 'inheritHistory', 'maxConcurrentThreads', 'maxDepth', 'timeoutSeconds']);
    });

    await setTheme('dark');
    await navigateToAgents();
    await check('captures primary, child and scheduler controls at 125 percent in dark mode', async () => {
        await captureWindow('agent-list-dark-900-800-125.png');
        await captureAgentEditor('Fixture Agent', 'primary-editor-dark-900-800-125');
        await captureAgentEditor('reviewer', 'subagent-role-dark-900-800-125');
        await page.getByRole('button', { name: '调度预设', exact: true }).click();
        const scheduler = page.getByRole('dialog', { name: '子代理调度预设', exact: true });
        await scheduler.waitFor({ state: 'visible' });
        await captureScrollDialog(scheduler, 'subagent-scheduler-dark-900-800-125-top.png', 'top');
        await captureScrollDialog(scheduler, 'subagent-scheduler-dark-900-800-125-bottom.png', 'bottom');
        await scheduler.getByRole('button', { name: '关闭', exact: true }).click();
        await scheduler.waitFor({ state: 'hidden' });
    });

    await check('captures saved per-model settings at 125 percent in dark mode', async () => {
        await page.getByRole('button', { name: '模型与账号', exact: true }).click();
        await page.getByRole('heading', { name: '模型与账号', exact: true }).waitFor();
        await page.getByRole('button', { name: '编辑 Fixture Agent API', exact: true }).click();
        const dialog = await endpointDialog();
        for (const modelId of modelIds) {
            await page.getByRole('button', { name: `编辑模型参数 ${modelId}`, exact: true }).click();
            const modelDialog = page.getByRole('dialog', { name: '模型生成设置', exact: true });
            await modelDialog.waitFor({ state: 'visible' });
            const prefix = modelId === modelIds[0] ? 'model-settings-fixture-dark-900-800-125' : 'model-settings-alt-dark-900-800-125';
            await captureScrollDialog(modelDialog, `${prefix}-top.png`, 'top');
            await captureScrollDialog(modelDialog, `${prefix}-bottom.png`, 'bottom');
            await modelDialog.getByRole('button', { name: '关闭', exact: true }).click();
            await modelDialog.waitFor({ state: 'hidden' });
        }
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
    });

    await setWindowSize(1440, 960, 1, 'dark');
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    const agentPicker = page.getByRole('combobox', { name: '主 Agent', exact: true });
    const modelPicker = page.getByRole('combobox', { name: '运行模型', exact: true });
    const permissionPicker = page.getByRole('combobox', { name: '权限模式', exact: true });
    const effortPicker = page.getByRole('combobox', { name: '思考强度', exact: true });

    await check('first-use configuration requires explicit Agent, model, permission, effort and directory choice', async () => {
        assert.equal(await agentPicker.inputValue(), '');
        assert.equal(await modelPicker.inputValue(), '');
        assert.equal(await permissionPicker.inputValue(), '');
        assert.equal(await effortPicker.inputValue(), '');
        assert.equal(await effortPicker.locator('option[value="model-default"]').count(), 0);
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('configuration probe');
        assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('');
    });

    await check('changing the primary Agent leaves model selection independent', async () => {
        await modelPicker.selectOption(JSON.stringify([endpointId, modelIds[0]]));
        const before = await modelPicker.inputValue();
        await agentPicker.selectOption(alternateAgentId);
        assert.equal(await modelPicker.inputValue(), before);
        await agentPicker.selectOption('default');
        assert.equal(await modelPicker.inputValue(), before);
    });

    await check('streams two real turns with model-specific parameters and locks the Agent after the first run', async () => {
        assert.equal(await permissionPicker.inputValue(), '');
        assert.equal(await effortPicker.inputValue(), '');
        await permissionPicker.selectOption('accept-edits');
        await effortPicker.selectOption('high');
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('fixture first turn');
        assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
        await page.getByRole('button', { name: '无目录', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), false);
        await sendTurn('fixture first turn', 'fixture reply one');
        assert.equal(await agentPicker.isDisabled(), true);
        assert.equal(await agentPicker.inputValue(), 'default');
        await modelPicker.selectOption(JSON.stringify([endpointId, modelIds[1]]));
        assert.equal(await permissionPicker.isDisabled(), false);
        assert.equal(await effortPicker.isDisabled(), false);
        await effortPicker.selectOption('low');
        await sendTurn('fixture second turn', 'fixture reply two');
        assert.equal(await agentPicker.isDisabled(), true);
        assert.equal(await agentPicker.inputValue(), 'default');

        assert.equal(requests.length, 2);
        const [first, second] = requests;
        assert.equal(first.body.model, modelIds[0]);
        assert.equal(first.body.temperature, 0.4);
        assert.equal(first.body.top_p, 0.7);
        assert.equal(first.body.max_completion_tokens, 128);
        assert.equal(first.body.reasoning_effort, 'high');
        assert.deepEqual(first.body.stop, ['STOP-A']);
        assert.equal(first.body.messages[0].role, 'system');
        assert.ok(first.body.messages[0].content.startsWith('fixture agent instruction\n'));
        assert.match(first.body.messages[0].content, /spawn_agent/);
        assert.deepEqual(first.body.messages.slice(1), [
            { role: 'user', content: 'fixture first turn' },
        ]);
        assert.equal(second.body.model, modelIds[1]);
        assert.equal(second.body.temperature, 1.1);
        assert.equal(second.body.top_p, 0.3);
        assert.equal(second.body.max_completion_tokens, 64);
        assert.equal(second.body.reasoning_effort, 'low');
        assert.deepEqual(second.body.stop, ['STOP-B']);
        assert.equal(second.body.messages[0].role, 'system');
        assert.ok(second.body.messages[0].content.startsWith('fixture agent instruction\n'));
        assert.match(second.body.messages[0].content, /spawn_agent/);
        assert.deepEqual(second.body.messages.slice(1), [
            { role: 'user', content: 'fixture second turn' },
        ]);
        for (const request of requests) {
            assert.equal(request.authorization, undefined);
            assert.equal(request.apiKey, undefined);
        }

        const current = await snapshot();
        lockedRuns = current.runs.filter((run) => ['fixture first turn', 'fixture second turn'].includes(run.input));
        assert.equal(lockedRuns.length, 2);
        const firstRun = lockedRuns.find((run) => run.input === 'fixture first turn');
        const secondRun = lockedRuns.find((run) => run.input === 'fixture second turn');
        assert.ok(firstRun);
        assert.ok(secondRun);
        parentRunId = secondRun.id;
        for (const [run, expected] of [[firstRun, { ...modelParameters[0].parameters, reasoningEffort: 'high' }], [secondRun, { ...modelParameters[1].parameters, reasoningEffort: 'low' }]]) {
            assert.equal(run.effective.agentId, 'default');
            assert.equal(run.effective.agentName, 'Fixture Agent');
            assert.equal(run.effective.agentInstructions, 'fixture agent instruction');
            assert.equal(run.effective.permissionMode, 'accept-edits');
            assert.equal(run.effective.allowDelegation, true);
            assert.deepEqual(run.effective.modelParameters, expected);
        }
    });

    await check('previews inherit, none, all and selected context from the stored parent run', async () => {
        const all = await requirePlan({ agent: { type: 'inherit' }, context: { mode: 'all' } });
        assert.equal(all.contextMode, 'all');
        assert.ok(all.contextMessages.length > 0);
        assert.deepEqual(all.contextMessages, [
            { role: 'user', content: 'fixture second turn' },
            { role: 'assistant', content: 'fixture reply two' },
        ]);
        assert.equal(all.permissionMode, 'accept-edits');
        assert.equal(all.agentInstructions, 'fixture agent instruction');
        assert.equal(all.inheritHistory, true);
        assert.equal(all.timeoutSeconds, 120);

        const none = await requirePlan({ agent: { type: 'inherit' }, context: { mode: 'none' } });
        assert.equal(none.contextMode, 'none');
        assert.deepEqual(none.contextMessages, []);

        const selectedMessages = [
            { role: 'user', content: 'A compact summary of the request.' },
            { role: 'assistant', content: 'The selected observation to preserve.' },
        ];
        const selected = await requirePlan({
            agent: { type: 'inline', name: 'Inline reviewer', instructions: 'inline reviewer instructions' },
            context: { mode: 'selected', messages: selectedMessages },
            permissionMode: 'readonly',
        });
        assert.equal(selected.contextMode, 'selected');
        assert.deepEqual(selected.contextMessages, selectedMessages);
        assert.equal(selected.agentInstructions, 'inline reviewer instructions');
        assert.equal(selected.permissionMode, 'readonly');

        const preset = await requirePlan({ agent: { type: 'preset', id: reviewerAgentId } });
        assert.equal(preset.agentSource, 'preset');
        assert.equal(preset.agentId, reviewerAgentId);
        assert.equal(preset.agentInstructions, 'reviewer fixture instructions');
        assert.equal(preset.permissionMode, 'accept-edits');
        assert.equal(preset.providerId, endpointId);
        assert.equal(preset.modelId, modelIds[1]);
        assert.equal(preset.reasoningEffort, 'low');
    });

    await check('enforces accept-edits delegation limits and validates provider/model/effort overrides', async () => {
        const inheritedReadonly = await requirePlan({ agent: { type: 'inherit' }, permissionMode: 'readonly' });
        assert.equal(inheritedReadonly.permissionMode, 'readonly');
        const inlineReadonly = await requirePlan({
            agent: { type: 'inline', name: 'Read only reviewer', instructions: 'Review only.' },
            permissionMode: 'readonly',
        });
        assert.equal(inlineReadonly.permissionMode, 'readonly');

        const agentSources = [
            { type: 'inherit' },
            { type: 'preset', id: reviewerAgentId },
            { type: 'inline', name: 'Restricted reviewer', instructions: 'No extra permissions.' },
        ];
        for (const mode of ['auto', 'bypass']) {
            for (const agent of agentSources) {
                await requirePreviewError({ agent, permissionMode: mode }, /不能超过父代理/);
            }
        }

        const overridden = await requirePlan({
            agent: { type: 'inline', name: 'Model override', instructions: 'Use the requested model.' },
            providerId: endpointId,
            modelId: modelIds[0],
            reasoningEffort: 'low',
            permissionMode: 'readonly',
        });
        assert.equal(overridden.providerId, endpointId);
        assert.equal(overridden.modelId, modelIds[0]);
        assert.equal(overridden.reasoningEffort, 'low');
        assert.equal(overridden.permissionMode, 'readonly');

        await requirePreviewError({ agent: { type: 'inherit' }, providerId: 'missing-provider', modelId: modelIds[0] }, /端点/);
        await requirePreviewError({ agent: { type: 'inherit' }, providerId: endpointId, modelId: 'missing-model' }, /模型/);
    });

    await check('rejects system-role and oversized selected context', async () => {
        await requirePreviewError({
            agent: { type: 'inherit' },
            context: { mode: 'selected', messages: [{ role: 'system', content: 'Not allowed as history.' }] },
        }, /上下文|角色|字段/);
        await requirePreviewError({
            agent: { type: 'inherit' },
            context: { mode: 'selected', messages: [{ role: 'user', content: '中'.repeat(400_000) }] },
        }, /1 MB/);
    });

    await check('post-start Agent and child edits do not alter locked run identity or stored authority', async () => {
        const originalRuns = structuredClone(lockedRuns.map((run) => ({ id: run.id, effective: run.effective })));
        await navigateToAgents();
        await page.getByRole('button', { name: '编辑 Agent Fixture Agent', exact: true }).click();
        let dialog = await profileDialog();
        await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('Fixture Agent Updated');
        await dialog.getByRole('textbox', { name: 'Agent 指令', exact: true }).fill('updated after the first run');
        assert.equal(await dialog.getByRole('combobox', { name: '权限模式', exact: true }).count(), 0);
        await dialog.getByRole('button', { name: '保存 Agent', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });

        let afterEdit = await snapshot();
        for (const original of originalRuns) {
            assert.deepEqual(afterEdit.runs.find((run) => run.id === original.id)?.effective, original.effective);
        }
        await requirePreviewError({ agent: { type: 'inline', name: 'Permission probe', instructions: '' }, permissionMode: 'auto' }, /不能超过父代理/);

        await page.getByRole('button', { name: '编辑 Agent Fixture Agent Updated', exact: true }).click();
        dialog = await profileDialog();
        await dialog.getByRole('checkbox', { name: '允许继续委派', exact: true }).uncheck();
        await dialog.getByRole('button', { name: '保存 Agent', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        const stillAuthorized = await requirePlan({ agent: { type: 'inherit' }, permissionMode: 'readonly' });
        assert.equal(stillAuthorized.agentName, 'Fixture Agent');
        assert.equal(stillAuthorized.permissionMode, 'readonly');
        assert.equal(stillAuthorized.allowDelegation, true);

        await page.getByRole('button', { name: '编辑 Agent reviewer', exact: true }).click();
        dialog = await profileDialog();
        await dialog.getByRole('textbox', { name: '名称', exact: true }).fill('reviewer disabled after start');
        await dialog.getByRole('textbox', { name: 'Agent 指令', exact: true }).fill('changed after start');
        await dialog.getByRole('checkbox', { name: '可供选择', exact: true }).uncheck();
        await dialog.getByRole('button', { name: '保存 Agent', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });

        afterEdit = await snapshot();
        for (const original of originalRuns) {
            assert.deepEqual(afterEdit.runs.find((run) => run.id === original.id)?.effective, original.effective);
        }
        await requirePreviewError({ agent: { type: 'preset', id: reviewerAgentId } }, /不存在或已停用/);
    });

    await check('session-only modes and effort update after Agent lock without changing profiles or prior runs', async () => {
        const configuredProfiles = await settings();
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        // Reopen the existing session through its sidebar button, preserving its immutable Agent.
        const existing = await snapshot();
        const session = existing.sessions.find(item => item.id === lockedRuns[0].sessionId);
        assert.ok(session);
        await page.locator('.session-button').filter({ has: page.getByText(session.title, { exact: true }) }).click();
        assert.equal(await agentPicker.isDisabled(), true);
        assert.equal(await permissionPicker.isDisabled(), false);
        assert.equal(await effortPicker.isDisabled(), false);
        await permissionPicker.selectOption('plan');
        await effortPicker.selectOption('high');
        await page.waitForFunction((id) => window.uah.command({ type: 'snapshot' }).then(state =>
            state.sessions.find(item => item.id === id)?.controls?.permissionMode === 'plan'
                && state.sessions.find(item => item.id === id)?.controls?.reasoningEffort === 'high'), session.id);
        await captureWindow('session-controls-plan-dark-1440-960.png');
        const beforePlan = await snapshot();
        assert.equal(beforePlan.runs.length, existing.runs.length);
        await sendTurn('fixture plan turn', 'fixture response');
        const planRequest = requests.at(-1).body;
        assert.equal(planRequest.reasoning_effort, 'high');
        assert.match(planRequest.messages[0].content, /\[会话模式：Plan\]/);
        assert.match(planRequest.messages[0].content, /禁止修改工作区文件或执行命令/);
        assert.ok(planRequest.messages[0].content.startsWith('fixture agent instruction'));
        const planSnapshot = await snapshot();
        const planRun = planSnapshot.runs.find(run => run.input === 'fixture plan turn');
        assert.ok(planRun);
        assert.equal(planRun.effective.agentInstructions, 'fixture agent instruction');
        assert.equal(planRun.effective.permissionMode, 'plan');
        assert.equal(planRun.effective.agentId, 'default');
        await permissionPicker.selectOption('bypass');
        await effortPicker.selectOption('none');
        await page.waitForFunction((id) => window.uah.command({ type: 'snapshot' }).then(state => {
            const controls = state.sessions.find(item => item.id === id)?.controls;
            return controls?.permissionMode === 'bypass' && controls.reasoningEffort === 'none';
        }), session.id);
        assert.deepEqual(await settings(), configuredProfiles);
        const afterControls = await snapshot();
        for (const original of lockedRuns) assert.deepEqual(afterControls.runs.find(run => run.id === original.id)?.effective, original.effective);
        assert.deepEqual(afterControls.runs.find(run => run.id === planRun.id)?.effective, planRun.effective);
        for (const theme of ['light', 'dark']) {
            await setTheme(theme);
            await page.locator('.session-button').filter({ has: page.getByText(session.title, { exact: true }) }).click();
            await setWindowSize(900, 800, 1.25, theme);
            for (const [picker, suffix] of [[permissionPicker, 'permission-menu'], [effortPicker, 'effort-menu']]) {
                await picker.click();
                await settle();
                await captureWindow(`session-${suffix}-${theme}-900-800-125.png`);
                await picker.press('Escape');
                await settle();
            }
        }
        await setWindowSize(1440, 960, 1, 'dark');
    });

    await closeDesktop();
    await check('restart restores per-model settings, current permissions and the locked Agent snapshot', async () => {
        await launch();
        const persisted = await settings();
        const primary = persisted.profiles.find((item) => item.id === 'default');
        const reviewer = persisted.profiles.find((item) => item.id === reviewerAgentId);
        assert.ok(primary);
        assert.equal(primary.name, 'Fixture Agent Updated');
        assert.equal(primary.instructions, 'updated after the first run');
        assert.equal('permissionMode' in primary, false);
        assert.equal(primary.allowDelegation, false);
        assert.ok(reviewer);
        assert.equal(reviewer.name, 'reviewer disabled after start');
        assert.equal(reviewer.enabled, false);
        assert.deepEqual(persisted.subagents, {
            enabled: true,
            maxConcurrentThreads: 3,
            maxDepth: 2,
            inheritHistory: true,
            timeoutSeconds: 120,
        });

        const endpointList = await page.evaluate(() => window.uah.endpoints({ type: 'list' }));
        assert.equal(endpointList.endpoints[0].id, endpointId);
        assert.deepEqual(endpointList.endpoints[0].modelParameters, modelParameters);
        const restored = await snapshot();
        for (const original of lockedRuns) {
            assert.deepEqual(restored.runs.find((run) => run.id === original.id)?.effective, original.effective);
        }

        const agentPicker = page.getByRole('combobox', { name: '主 Agent', exact: true });
        const modelPicker = page.getByRole('combobox', { name: '运行模型', exact: true });
        await agentPicker.waitFor({ state: 'visible' });
        assert.equal(await agentPicker.isDisabled(), true);
        assert.equal(await agentPicker.inputValue(), 'default');
        assert.equal(await modelPicker.inputValue(), JSON.stringify([endpointId, modelIds[1]]));
        assert.equal(await page.getByRole('combobox', { name: '权限模式', exact: true }).inputValue(), 'bypass');
        assert.equal(await page.getByRole('combobox', { name: '思考强度', exact: true }).inputValue(), 'none');
        assert.equal(await page.getByRole('combobox', { name: '权限模式', exact: true }).isDisabled(), false);
        assert.equal(await page.getByRole('combobox', { name: '思考强度', exact: true }).isDisabled(), false);

        const restoredAuthority = await delegationPreview({
            agent: { type: 'inherit' },
            permissionMode: 'readonly',
            context: { mode: 'none' },
        });
        assert.ok(restoredAuthority.plan, restoredAuthority.error || 'persisted run authority was not restored');
        assert.equal(restoredAuthority.plan.agentName, 'Fixture Agent');
        assert.equal(restoredAuthority.plan.allowDelegation, true);
        assert.deepEqual(restoredAuthority.plan.contextMessages, []);
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        assert.equal(await agentPicker.isDisabled(), false);
        assert.equal(await agentPicker.inputValue(), 'default');
        assert.equal(await modelPicker.inputValue(), JSON.stringify([endpointId, modelIds[0]]));
        assert.equal(await page.getByRole('combobox', { name: '权限模式', exact: true }).inputValue(), 'accept-edits');
        assert.equal(await page.getByRole('combobox', { name: '思考强度', exact: true }).inputValue(), 'high');
        assert.equal(await page.getByRole('button', { name: '无目录', exact: true }).count(), 0);
        const originalSession = restored.sessions.find(item => item.id === lockedRuns[0].sessionId);
        assert.deepEqual(originalSession.initialConfig, {
            agentId: 'default', selection: { endpointId, modelId: modelIds[0] },
            controls: { permissionMode: 'accept-edits', reasoningEffort: 'high' }, directory: null,
        });
    });

    assert.deepEqual(pageErrors, []);
    assert.deepEqual(serverErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({
        passed: checks,
        pageErrors,
        serverErrors,
        streamedRequests: requests.length,
        screenshots: [
            'model-settings-fixture-light-900-800-125-top.png',
            'model-settings-fixture-light-900-800-125-bottom.png',
            'model-settings-alt-light-900-800-125-top.png',
            'model-settings-alt-light-900-800-125-bottom.png',
            'agent-list-light-900-800-125.png',
            'primary-editor-light-900-800-125-top.png',
            'primary-editor-light-900-800-125-bottom.png',
            'subagent-role-light-900-800-125-top.png',
            'subagent-role-light-900-800-125-bottom.png',
            'subagent-scheduler-light-900-800-125-top.png',
            'subagent-scheduler-light-900-800-125-bottom.png',
            'agent-list-dark-900-800-125.png',
            'primary-editor-dark-900-800-125-top.png',
            'primary-editor-dark-900-800-125-bottom.png',
            'subagent-role-dark-900-800-125-top.png',
            'subagent-role-dark-900-800-125-bottom.png',
            'subagent-scheduler-dark-900-800-125-top.png',
            'subagent-scheduler-dark-900-800-125-bottom.png',
            'model-settings-fixture-dark-900-800-125-top.png',
            'model-settings-fixture-dark-900-800-125-bottom.png',
            'model-settings-alt-dark-900-800-125-top.png',
            'model-settings-alt-dark-900-800-125-bottom.png',
            'session-controls-plan-dark-1440-960.png',
            'session-permission-menu-light-900-800-125.png',
            'session-effort-menu-light-900-800-125.png',
            'session-permission-menu-dark-900-800-125.png',
            'session-effort-menu-dark-900-800-125.png',
        ],
    }, null, 4));
    console.log(`Evidence: ${evidence}`);
} finally {
    await closeDesktop();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
