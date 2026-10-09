import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'desktop-'));
const project = path.join(evidence, 'workspace');
await mkdir(project);
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.UAH_DEV_URL;
const checks = [];
const errors = [];
let desktop;
let page;

async function launch() {
    desktop = await electron.launch({ args: ['.'], cwd: root, env: environment, timeout: 30000 });
    page = await desktop.firstWindow();
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(10000);
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.waitForFunction(() => Boolean(window.uah));
}
async function snapshot() { return page.evaluate(() => window.uah.command({ type: 'snapshot' })); }
async function check(name, action) {
    await action();
    checks.push(name);
    console.log(`PASS ${name}`);
}
try {
    await launch();
    await check('isolated renderer and explicit model/directory selection', async () => {
        assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
        assert.equal(await page.evaluate(() => typeof window.process), 'undefined');
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('无目录流式验证');
        assert.equal(await page.getByRole('button', { name: '发送消息', exact: true }).isDisabled(), true);
        await page.screenshot({ path: path.join(evidence, 'desktop-home.png') });
        await page.getByRole('combobox', { name: '运行模型', exact: true }).selectOption('local-verification');
        await page.getByRole('button', { name: '无目录', exact: true }).click();
        const composerBefore = await page.locator('.composer').boundingBox();
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.locator('.turn').first().waitFor();
        const composerAfter = await page.locator('.composer').boundingBox();
        for (const dimension of ['x', 'y', 'width', 'height']) {
            assert.ok(Math.abs(composerBefore[dimension] - composerAfter[dimension]) < 2, `composer ${dimension} moved on first send`);
        }
    });
    await check('stream completion preserves composer DOM, focus, selection and text', async () => {
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('下一轮正在编辑的文本');
        await page.getByRole('textbox', { name: '消息', exact: true }).evaluate((element) => {
            window.__composerForTest = element;
            element.focus();
            element.setSelectionRange(2, 5);
        });
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        assert.deepEqual(await page.getByRole('textbox', { name: '消息', exact: true }).evaluate((element) => ({ same: window.__composerForTest === element, focus: document.activeElement === element, start: element.selectionStart, end: element.selectionEnd, text: element.value })), { same: true, focus: true, start: 2, end: 5, text: '下一轮正在编辑的文本' });
    });
    await check('dirty settings can cancel navigation and save with truthful feedback', async () => {
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('radio', { name: '深色', exact: true }).click();
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('button', { name: '继续编辑', exact: true }).click();
        assert.equal(await page.getByRole('radio', { name: '深色', exact: true }).getAttribute('aria-checked'), 'true');
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
        await page.getByRole('button', { name: '关闭通知', exact: true }).click();
        await page.getByRole('radio', { name: '浅色', exact: true }).click();
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        assert.equal(await page.getByRole('button', { name: '无目录', exact: true }).count(), 0, 'new sessions inherit the last created session directory choice');
    });
    await check('directory comes from host picker; approval writes a real immutable snapshot', async () => {
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await desktop.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
        await page.getByRole('button', { name: /选择工作目录/ }).click();
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('验证真实文件审批与历史快照');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '批准本次操作', exact: true }).waitFor();
        const before = await snapshot();
        const approval = before.approvals.find((item) => item.status === 'pending');
        assert.ok(approval);
        const forged = { runtimeId: approval.runtimeId, sessionId: 'wrong-session', runId: approval.runId, turnId: approval.turnId, requestId: approval.requestId, policyVersion: approval.policyVersion };
        const rejected = await page.evaluate(async (identity) => {
            try { await window.uah.command({ type: 'resolve-approval', identity, decision: 'approve' }); return false; }
            catch { return true; }
        }, forged);
        assert.equal(rejected, true);
        await page.getByRole('button', { name: '批准本次操作', exact: true }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        const saved = await snapshot();
        const artifact = saved.artifacts.at(-1);
        assert.equal(await readFile(artifact.path, 'utf8'), artifact.newContent);
        await writeFile(artifact.path, 'Changed outside UAH.', 'utf8');
        assert.equal((await snapshot()).artifacts.at(-1).newContent, artifact.newContent);
        await page.locator('.turn .ui-file-change-row').last().click();
        await page.getByRole('heading', { name: path.basename(artifact.path), exact: true }).waitFor();
        await page.screenshot({ path: path.join(evidence, 'desktop-snapshot.png') });
    });
    await check('stop cancels pending approval without a write', async () => {
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('取消这一轮');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '批准本次操作', exact: true }).waitFor();
        await page.getByRole('button', { name: '停止当前任务', exact: false }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已中止' }).waitFor();
        assert.equal((await snapshot()).artifacts.length, 1);
    });
    await check('narrow layout keeps composer available and panel can return to conversation', async () => {
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 760));
        await page.getByRole('button', { name: '关闭工作面板', exact: true }).click();
        assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).isVisible(), true);
        await page.screenshot({ path: path.join(evidence, 'desktop-800.png') });
        await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    });
    await check('long conversation scroll survives settings, session switching and return', async () => {
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('滚动回归\n' + '保留阅读位置，不跟随回复跳到底部。\n'.repeat(100));
        assert.equal(await page.getByRole('button', { name: '移除工作目录', exact: true }).count(), 1, 'new sessions inherit the last created session directory');
        await page.getByRole('button', { name: '移除工作目录', exact: true }).click();
        await page.getByRole('button', { name: '无目录', exact: true }).click();
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        // Notify the scroll listener before leaving, matching a user's reading intent.
        await page.locator('.chat-scroll').evaluate((element) => { element.scrollTop = 600; element.dispatchEvent(new Event('scroll')); });
        await page.waitForFunction(() => Math.abs(document.querySelector('.chat-scroll').scrollTop - 600) < 1);
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /滚动回归/ }).click();
        assert.ok(Math.abs(await page.locator('.chat-scroll').evaluate((element) => element.scrollTop) - 600) < 1);
        await page.getByRole('button', { name: '设置', exact: true }).click();
        await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /无目录流式验证/ }).click();
        await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /滚动回归/ }).click();
        // Session selection loads its history asynchronously before restoring the reading position.
        await page.waitForFunction(() => Math.abs(document.querySelector('.chat-scroll').scrollTop - 600) < 1);
        assert.ok(Math.abs(await page.locator('.chat-scroll').evaluate((element) => element.scrollTop) - 600) < 1);
    });
    const savedSessions = (await snapshot()).sessions.length;
    await desktop.close();
    desktop = null;
    await check('restart restores sessions and snapshots with no active runs', async () => {
        await launch();
        const restored = await snapshot();
        assert.equal(restored.sessions.length, savedSessions);
        assert.equal(restored.artifacts.length, 1);
        assert.equal(restored.runs.some((run) => ['running', 'approval', 'cancelRequested', 'stopping'].includes(run.state)), false);
    });
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: checks, pageErrors: errors }, null, 4));
    console.log(`Evidence: ${evidence}`);
} finally {
    if (desktop) await desktop.close();
}
