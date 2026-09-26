import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts', 'search-'));
const project = path.join(evidence, 'Orchid Project');
await mkdir(project);
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.UAH_DEV_URL;
const desktop = await electron.launch({ args: ['.'], cwd: process.cwd(), env: environment, timeout: 30000 });
const passed = [];
const pageErrors = [];
try {
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    page.on('pageerror', (error) => pageErrors.push(error.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await desktop.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    await page.evaluate(async () => {
        const directory = await window.uah.chooseDirectory();
        await window.uah.command({ type: 'create-session', title: '修复输入框布局', directory });
        await window.uah.command({ type: 'create-session', title: '整理发布说明', directory: null });
    });
    await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /整理发布说明/ }).waitFor();
    const search = page.getByRole('dialog', { name: '搜索', exact: true });
    const input = search.getByRole('textbox', { name: '搜索会话、项目与设置', exact: true });
    const open = () => page.keyboard.press('Control+k');
    const capture = async (filename) => {
        await page.evaluate(async () => {
            await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
            await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
        const data = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
        await writeFile(path.join(evidence, filename), Buffer.from(data.split(',')[1], 'base64'));
    };
    await page.locator('.search-toggle').click();
    await search.waitFor();
    assert.equal(await input.evaluate((element) => document.activeElement === element), true);
    await page.waitForFunction(() => document.querySelector('.search-dialog')?.dataset.state === 'open');
    assert.equal(Math.round((await search.boundingBox()).width), 800);
    assert.equal(await search.getByRole('button', { name: /修复输入框布局/ }).count(), 1);
    assert.equal(await search.getByRole('button', { name: /模型与账号/ }).isDisabled(), true);
    await capture('01-search-all.png');
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'hidden' });
    assert.equal(await page.locator('.search-toggle').evaluate((element) => document.activeElement === element), true);
    passed.push('prototype-sized global modal, grouped sessions and shortcuts, autofocus and Escape focus restoration');

    await open();
    await input.fill('  ORCHID  ');
    assert.equal(await search.getByRole('button', { name: /修复输入框布局/ }).count(), 1);
    assert.equal(await search.getByRole('button', { name: /整理发布说明/ }).count(), 0);
    await capture('02-search-directory.png');
    await input.press('Enter');
    await search.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /修复输入框布局/ }).getAttribute('aria-current'), 'page');
    passed.push('directory search is case-insensitive and trims whitespace; Enter opens the matching real session');

    await page.getByRole('textbox', { name: '消息', exact: true }).fill('搜索切换时保留的草稿');
    await page.getByRole('button', { name: '收起或展开导航', exact: true }).click();
    await open();
    assert.equal(await input.inputValue(), '');
    await input.fill('发布');
    await input.press('ArrowDown');
    assert.equal(await search.getByRole('button', { name: /整理发布说明/ }).evaluate((element) => document.activeElement === element), true);
    await page.keyboard.press('Enter');
    await search.waitFor({ state: 'hidden' });
    await open();
    await input.fill('输入框');
    await search.getByRole('button', { name: /修复输入框布局/ }).click();
    await search.waitFor({ state: 'hidden' });
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '搜索切换时保留的草稿');
    passed.push('collapsed navigation opens global search; arrow/Enter navigation preserves per-session drafts');

    await open();
    await input.fill('不存在的条目');
    assert.equal(await search.getByText('没有匹配的会话。', { exact: true }).count(), 1);
    await input.press('Enter');
    assert.equal(await search.isVisible(), true);
    await open();
    assert.equal(await input.evaluate((element) => element.selectionEnd - element.selectionStart), '不存在的条目'.length);
    await input.fill('设置');
    await search.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await open();
    await input.fill('发布');
    await input.press('Enter');
    await page.getByRole('dialog', { name: '保存设置更改？', exact: true }).waitFor();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: '深色', exact: true }).getAttribute('aria-checked'), 'true');
    passed.push('empty results do not navigate; repeat shortcut selects query; search navigation honors dirty settings');

    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await open();
    await capture('03-search-dark.png');
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(2));
    const bounds = await search.boundingBox();
    const viewport = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight }));
    assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height);
    await search.getByRole('button', { name: '设置', exact: true }).scrollIntoViewIfNeeded();
    await capture('04-search-200.png');
    await page.keyboard.press('Escape');
    await search.waitFor({ state: 'hidden' });
    assert.deepEqual(pageErrors, []);
    passed.push('dark theme and 200% zoom keep search within the window with scrollable results; no page errors');
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed, pageErrors }, null, 4));
    passed.forEach((name) => console.log(`PASS ${name}`));
    console.log(`Evidence: ${evidence}`);
} finally {
    await desktop.close();
}
