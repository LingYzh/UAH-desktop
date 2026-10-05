import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts', 'appearance-'));
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.UAH_DEV_URL;
const desktop = await electron.launch({ args: ['.'], cwd: process.cwd(), env: environment, timeout: 30000 });
const checks = [];
try {
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(10000);
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    assert.equal(await page.locator('.sidebar-brand').count(), 0);
    const navigationToggle = page.getByRole('button', { name: '收起或展开导航', exact: true });
    assert.equal(await navigationToggle.evaluate(button => button.closest('.titlebar') !== null), true);
    assert.equal(await navigationToggle.evaluate(button => getComputedStyle(button).getPropertyValue('-webkit-app-region')), 'no-drag');
    const toggleBounds = await navigationToggle.boundingBox();
    const titleBounds = await page.locator('.titlebar-brand').boundingBox();
    assert(toggleBounds.y >= titleBounds.y && toggleBounds.y + toggleBounds.height <= titleBounds.y + titleBounds.height);
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    const settle = () => page.evaluate(async () => {
        await Promise.all(document.getAnimations().map((animation) => animation.finished.catch(() => {})));
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const frameSample = (selector) => page.locator(selector).evaluate(async (element) => {
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return element.getBoundingClientRect().width;
    });
    // Playwright's page screenshot clips Electron's viewport under application zoom.
    // Capture the complete native content area instead.
    const capture = async (filename) => {
        const data = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
        await writeFile(path.join(evidence, filename), Buffer.from(data.split(',')[1], 'base64'));
    };
    const centers = await page.locator('.composer-main').evaluate((row) => {
        const center = (element) => {
            const box = element.getBoundingClientRect();
            return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
        };
        return { row: center(row), input: center(row.querySelector('textarea')), buttons: [...row.querySelectorAll('button')].filter(button => button.getClientRects().length > 0).map((button) => ({ button: center(button), icon: center(button.querySelector('svg')) })) };
    });
    assert.ok(Math.abs(centers.input.y - centers.row.y) < 0.5);
    assert.equal(centers.buttons.length, 2, 'attachment and send actions are the two visible composer buttons');
    for (const item of centers.buttons) {
        assert.ok(Math.abs(item.button.y - centers.row.y) < 0.5);
        assert.ok(Math.abs(item.button.x - item.icon.x) < 0.5);
        assert.ok(Math.abs(item.button.y - item.icon.y) < 0.5);
    }
    checks.push('composer text and buttons share one vertical center; SVGs are centered on both axes');
    await capture('01-home.png');
    await page.getByRole('button', { name: '收起或展开导航', exact: true }).click();
    const leftMiddle = await frameSample('.sidebar');
    assert.ok(leftMiddle > 57 && leftMiddle < 254, `left transition intermediate width: ${leftMiddle}`);
    await settle();
    assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width), 57);
    await page.getByRole('button', { name: '收起或展开导航', exact: true }).click();
    await settle();
    assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width), 254);
    checks.push('left navigation has an actual intermediate width and returns to its original size');

    await page.getByRole('button', { name: '工作面板', exact: true }).click();
    const rightMiddle = await frameSample('.workspace-panel');
    assert.ok(rightMiddle > 1 && rightMiddle < 470, `right transition intermediate width: ${rightMiddle}`);
    // Keyboard activation targets the moving control itself; forced coordinates
    // can miss it while the grid is changing width.
    await page.getByRole('button', { name: '收起面板', exact: true }).press('Enter');
    await page.getByRole('button', { name: '工作面板', exact: true }).press('Enter');
    assert.equal(await page.getByRole('button', { name: '收起面板', exact: true }).getAttribute('aria-expanded'), 'true');
    await settle();
    assert.equal(Math.round((await page.locator('.workspace-panel').boundingBox()).width), 470);
    assert.equal(await page.locator('.workspace-panel').getAttribute('inert'), null);
    assert.equal(await page.locator('.panel-tabs').evaluate((element) => element.classList.contains('is-dense')), true);
    assert.equal(Math.round((await page.locator('.panel-tabs [role="tab"]').first().boundingBox()).height), 32);
    await capture('02-split-panel.png');
    await page.getByRole('button', { name: '收起面板', exact: true }).click();
    assert.notEqual(await page.locator('.workspace-panel').getAttribute('inert'), null);
    await settle();
    assert.equal(await page.locator('.workspace-panel').isVisible(), false);
    checks.push('right panel animates, reverses to the last intent, and becomes inert immediately on close');

    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 900));
    await page.waitForFunction(() => window.innerWidth === 800);
    await page.getByRole('button', { name: '工作面板', exact: true }).click();
    await settle();
    await page.getByRole('button', { name: '收起或展开导航', exact: true }).click();
    await settle();
    assert.equal(Math.round((await page.locator('.sidebar').boundingBox()).width), 254);
    assert.equal(await page.locator('.workspace-panel').isVisible(), false);
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).isVisible(), true);
    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 960));
    await page.waitForFunction(() => window.innerWidth === 1440);
    await settle();
    checks.push('expanding navigation at 800px closes the auxiliary panel and restores full navigation');

    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.getByRole('button', { name: '工作面板', exact: true }).click();
    await settle();
    assert.equal(await page.locator('.desktop').evaluate((element) => getComputedStyle(element).transitionDuration), '0s');
    assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
    await page.getByRole('button', { name: '收起面板', exact: true }).click();
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    checks.push('system reduced motion reaches the same end state without active animations');

    await page.getByRole('button', { name: '设置', exact: true }).click();
    const font = page.getByRole('combobox', { name: '阅读字体', exact: true });
    await settle();
    await capture('03-settings-light.png');
    await font.click();
    await settle();
    await capture('04-select-open.png');
    await page.keyboard.press('Escape');
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    assert.notEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('uah-desktop-preferences-v1') || '{}').theme), 'dark');
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('button', { name: '继续编辑', exact: true }).click();
    await settle();
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('button', { name: '放弃更改', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('radio', { name: '跟随系统', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.getByRole('radio', { name: '浅色', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('button', { name: '放弃更改', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('uah-desktop-preferences-v1')).theme), 'dark');
    checks.push('theme previews immediately without persistence, follows system changes, survives cancelled navigation and reverts to the last saved theme on discard');
    await settle();
    await capture('05-settings-dark.png');
    for (const factor of [1.5, 2]) {
        await desktop.evaluate(({ BrowserWindow }, value) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(value), factor);
        await settle();
        assert.equal(await font.evaluate((element) => {
            const rectangle = element.getBoundingClientRect();
            return rectangle.width > 100 && rectangle.left >= 0 && rectangle.right <= window.innerWidth;
        }), true);
        await capture(`06-settings-${factor * 100}.png`);
    }
    await page.getByRole('button', { name: '关闭通知', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).scrollIntoViewIfNeeded();
    assert.equal(await page.getByRole('button', { name: '保存设置', exact: true }).evaluate((element) => {
        const rectangle = element.getBoundingClientRect();
        return rectangle.top >= 35 && rectangle.bottom <= window.innerHeight && rectangle.right <= window.innerWidth;
    }), true);
    await capture('07-settings-200-scrolled.png');
    checks.push('settings controls remain visible at 100%, 150% and 200% zoom; light, dark and open select screenshots captured');
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: checks, composerCenters: centers, intermediateWidths: { left: leftMiddle, right: rightMiddle } }, null, 4));
    for (const name of checks) console.log(`PASS ${name}`);
    console.log(`Evidence: ${evidence}`);
} finally {
    await desktop.close();
}
