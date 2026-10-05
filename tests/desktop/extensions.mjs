import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { startHttpFixture } from '../fixtures/mcp-fixture.mjs';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'extensions-desktop-'));
const plugin = path.join(evidence, 'fixture-plugin');
await mkdir(path.join(plugin, '.claude-plugin'), { recursive: true });
await mkdir(path.join(plugin, 'skills', 'fixture'), { recursive: true });
await writeFile(path.join(plugin, '.claude-plugin', 'plugin.json'), JSON.stringify({ name: 'fixture-plugin', version: '1.0.0', description: '隔离测试插件', hooks: './hooks.json' }));
await writeFile(path.join(plugin, 'skills', 'fixture', 'SKILL.md'), '---\nname: fixture-skill\ndescription: 用于隔离测试的技能\n---\n读取本技能后返回 fixture。\n');
const mcp = await startHttpFixture();
const errors = []; const checks = []; const captures = [];
const app = await electron.launch({ args: ['.'], env: { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data'), UAH_DEV_URL: '' } });
const page = await app.firstWindow(); page.setDefaultTimeout(12_000);
page.on('pageerror', error => errors.push(error.message));
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
async function capture(name, theme, width, zoom) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, value) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(value.width, 850); window.webContents.setZoomFactor(value.zoom); }, { width, zoom });
    await page.evaluate(async () => { await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
    const bounds = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    check(`${name}: no horizontal overflow`, bounds.scroll <= bounds.width + 1);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(png.split(',')[1], 'base64')); captures.push(name);
}
try {
    await page.waitForFunction(() => Boolean(window.uah?.extensions));
    await page.getByRole('button', { name: 'MCP 连接器', exact: true }).click();
    await page.getByRole('button', { name: '添加连接器', exact: true }).click();
    let dialog = page.getByRole('dialog', { name: '添加连接器' });
    await dialog.getByLabel('名称', { exact: true }).fill('Fixture HTTP');
    await dialog.getByLabel('传输方式', { exact: true }).selectOption('http');
    await dialog.getByLabel('服务地址', { exact: true }).fill(mcp.url);
    await dialog.getByRole('checkbox', { name: '保存后启用连接器' }).check();
    await dialog.getByRole('button', { name: '保存连接器' }).click();
    await dialog.waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '测试连接' }).click();
    await page.getByText('连接成功 · 1 个工具', { exact: true }).waitFor();
    check('HTTP MCP handshake and tool discovery through Electron IPC', mcp.methods.includes('tools/list'));
    await capture('mcp-light-1440.png', 'light', 1440, 1);
    await page.getByRole('button', { name: '编辑', exact: true }).click();
    dialog = page.getByRole('dialog', { name: '编辑连接器' });
    await capture('mcp-editor-dark-900-125.png', 'dark', 900, 1.25);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.evaluate(async source => window.uah.extensions({ type: 'install-plugin', source }), plugin);
    await page.getByRole('button', { name: '插件与技能', exact: true }).click();
    await page.getByText('fixture-plugin', { exact: true }).waitFor();
    check('unsupported hook status is visible', await page.getByText(/未启用的组件：.*hooks/).isVisible());
    await capture('plugins-dark-900-125.png', 'dark', 900, 1.25);
    await page.getByRole('checkbox', { name: '启用 fixture-plugin', exact: true }).check();
    await page.waitForFunction(async () => (await window.uah.extensions({ type: 'list' })).plugins[0].enabled);
    await page.getByRole('tab', { name: '技能', exact: true }).click();
    await page.getByText('fixture-skill', { exact: true }).waitFor();
    const skillToggle = page.getByRole('checkbox', { name: '启用 fixture-skill', exact: true });
    await skillToggle.check();
    await page.waitForFunction(async () => (await window.uah.extensions({ type: 'list' })).skills.find(item => item.name === 'fixture-skill').enabled);
    await skillToggle.focus(); await skillToggle.press('Space');
    await page.waitForFunction(async () => !(await window.uah.extensions({ type: 'list' })).skills.find(item => item.name === 'fixture-skill').enabled);
    check('skill enablement persists through keyboard operation', true);
    const builtins = await page.evaluate(async () => (await window.uah.extensions({ type: 'list' })).skills.filter(item => item.builtin));
    check('both shipped skills are enabled by default', builtins.length === 2 && builtins.every(item => item.enabled));
    const grillingToggle = page.getByRole('checkbox', { name: '启用 grilling', exact: true });
    await grillingToggle.uncheck();
    await page.waitForFunction(async () => !(await window.uah.extensions({ type: 'list' })).skills.find(item => item.id === 'builtin:grilling').enabled);
    await grillingToggle.check();
    check('builtins may be disabled and re-enabled', true);
    await capture('skills-light-1440.png', 'light', 1440, 1);
    await page.getByRole('button', { name: '模型与账号', exact: true }).click();
    await page.getByRole('button', { name: '配置原生 Codex' }).click();
    await page.getByRole('dialog', { name: 'Codex 原生运行时' }).waitFor();
    dialog = page.getByRole('dialog', { name: 'Codex 原生运行时' });
    await dialog.getByRole('button', { name: '刷新模型与登录状态', exact: true }).waitFor();
    await page.waitForFunction(() => !document.querySelector('#native-command')?.disabled);
    const detected = await page.evaluate(() => window.uah.nativeCodex({ type: 'discover' }));
    if (detected.candidates.length) check('automatically fills the discovered executable and base arguments', await dialog.getByLabel('可执行文件绝对路径', { exact: true }).inputValue() === detected.candidates[0].command);
    await capture('native-settings-light-1440.png', 'light', 1440, 1);
    await capture('native-settings-dark-900-125.png', 'dark', 900, 1.25);
    await dialog.getByText('子代理边界', { exact: true }).scrollIntoViewIfNeeded();
    await capture('native-boundaries-dark-900-125.png', 'dark', 900, 1.25);
    check('native settings explain the subagent boundary', await dialog.getByText(/原生 Codex 可通过 UAH 工具启动/).count() === 1);
    await dialog.getByRole('button', { name: '启动参数怎么写', exact: true }).click();
    const help = page.getByRole('dialog', { name: '启动参数怎么写', exact: true });
    await help.waitFor();
    await capture('native-args-help-dark-900-125.png', 'dark', 900, 1.25);
    await help.getByRole('button', { name: '知道了', exact: true }).click();
    await help.waitFor({ state: 'hidden' });
    const helpTrigger = dialog.getByRole('button', { name: '启动参数怎么写', exact: true });
    check('pointer dismissal releases the tutorial action focus', await helpTrigger.evaluate(element => element !== document.activeElement));
    check('pointer dismissal preserves the parent settings dialog', await dialog.isVisible());
    await helpTrigger.focus();
    await helpTrigger.press('Enter');
    await help.waitFor();
    await help.press('Escape');
    await help.waitFor({ state: 'hidden' });
    check('keyboard dismissal restores focus to the settings action', await helpTrigger.evaluate(element => element === document.activeElement));
    await dialog.getByLabel('可执行文件绝对路径', { exact: true }).fill(process.execPath);
    await dialog.getByLabel('启动参数（JSON 数组）', { exact: true }).fill(JSON.stringify([path.join(root, 'tests/fixtures/codex-app-server-fixture.mjs'), JSON.stringify({ goalCompletionStatus: 'complete', userInputInputMatch: 'PLAN_QUESTION_FIXTURE', userInputRequest: { questions: [{ id: 'scope', header: '范围', question: '本次计划选择哪个范围？', options: [{ label: '仅测试', description: '只验证原生计划问答链路。' }, { label: '扩展验证', description: '增加一项验证。' }] }] }, dynamicInputMatch: '中文原生桌面测试', dynamicCalls: [
        { tool: 'uah_spawn_agent', arguments: { prompt: '完成独立子任务', agent: { type: 'inherit' }, context: { mode: 'none' } } },
        { tool: 'uah_wait_agents', arguments: { agentIds: ['$lastAgentId'], timeoutMs: 1000 } },
    ], models: [
        { id: 'display-first', model: 'gpt-fixture', displayName: 'Fixture model', isDefault: true },
        { id: 'display-second', model: 'gpt-other', displayName: 'Other fixture', isDefault: false },
    ] })]));
    await dialog.getByLabel('默认模型', { exact: true }).fill('');
    await dialog.getByRole('button', { name: '刷新模型与登录状态', exact: true }).click();
    await dialog.getByText('Codex/0.156.1 fixture', { exact: true }).waitFor();
    check('native probe works before enabling or choosing a model', true);
    check('selects the model/list default using its request model identifier', await dialog.getByLabel('默认模型', { exact: true }).inputValue() === 'gpt-fixture');
    check('discovery and draft probe do not save settings', (await page.evaluate(() => window.uah.nativeCodex({ type: 'get' }))).settings.command === '');
    await dialog.getByRole('checkbox', { name: '启用原生 Codex', exact: true }).check();
    await dialog.getByRole('button', { name: '保存', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, plugin);
    await page.evaluate(async () => window.uah.command({ type: 'create-session', title: 'Native desktop fixture', directory: await window.uah.chooseDirectory(),
        selection: { endpointId: 'native:codex', modelId: 'gpt-fixture' }, controls: { permissionMode: 'manual', reasoningEffort: 'default' } }));
    await page.reload();
    await page.getByRole('button', { name: /Native desktop fixture/ }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll('select[aria-label="运行模型"] option')).some(option => option.value.includes('gpt-other')));
    check('reloading discovers all native models for the chat selector', true);
    check('native model labels use display names while option values retain model IDs', await page.locator('select[aria-label="运行模型"] option').evaluateAll(options => options.some(option => option.value.includes('gpt-fixture') && option.textContent === 'Fixture model')));
    check('native permissions show exactly the three native presets', JSON.stringify(await page.getByRole('combobox', { name: '权限模式', exact: true }).locator('option[value]:not([value=""])').evaluateAll(options => options.map(option => ({ value: option.value, label: option.querySelector('.ui-select-item-label')?.textContent })))) === JSON.stringify([{ value: 'readonly', label: '只读' }, { value: 'manual', label: '默认权限' }, { value: 'bypass', label: '完全访问' }]));
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('中文原生桌面测试');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('你好，native。', { exact: true }).first().waitFor();
    await page.getByText(/原生运行 · 记录为部分覆盖.*本轮输入 11/).waitFor();
    check('native chat renders streamed text and per-turn observed usage', true);
    await page.waitForFunction(async () => {
        const state = await window.uah.command({ type: 'snapshot' });
        return state.runs.some(run => run.parentRunId && run.effective.runtimeId === 'codex-native' && run.state === 'completed')
            && state.runs.some(run => !run.parentRunId && run.state === 'completed');
    });
    check('native parent and native child complete through the desktop bridge', true);
    await capture('native-chat-light-1440.png', 'light', 1440, 1);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('/plan PLAN_QUESTION_FIXTURE');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('Codex 需要你的回答', { exact: true }).waitFor();
    await capture('native-plan-question-light-1440.png', 'light', 1440, 1);
    await capture('native-plan-question-dark-900-125.png', 'dark', 900, 1.25);
    await page.getByRole('combobox', { name: '本次计划选择哪个范围？', exact: true }).selectOption('仅测试');
    await page.getByRole('button', { name: '提交回答', exact: true }).click();
    await page.waitForFunction(async () => {
        const state = await window.uah.command({ type: 'snapshot' });
        return state.runs.some(run => run.input === '/plan PLAN_QUESTION_FIXTURE' && run.state === 'completed' && run.nativeQuestions?.[0]?.status === 'answered');
    });
    check('native Plan question is answered through the client', true);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('/plan off');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByText('已返回 Codex 原生默认模式。', { exact: true }).waitFor();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('/goal Complete fixture.');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.waitForFunction(async () => {
        const state = await window.uah.command({ type: 'snapshot' });
        return state.runs.some(run => run.input === '/goal Complete fixture.' && run.state === 'completed' && run.native?.goal?.status === 'complete');
    });
    check('native goal slash command records the native goal result', true);
    check('memory and file placeholders removed', await page.locator('button[title="记忆文件设置尚未接入"], button[title="工作区文件管理尚未接入"]').count() === 0);
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'summary.json'), JSON.stringify({ checks, captures, errors }, null, 4));
    console.log(JSON.stringify({ evidence, checks: checks.length, captures, errors }));
} catch (error) {
    await writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText());
    console.error('Evidence:', evidence);
    throw error;
} finally { await app.close(); await mcp.close(); }
