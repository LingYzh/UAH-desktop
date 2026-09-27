import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts', 'browser-'));
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.UAH_DEV_URL;
const desktop = await electron.launch({ args: ['.'], cwd: process.cwd(), env: environment, timeout: 30000 });
const checks = [];
try {
    const page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await page.getByRole('combobox', { name: '运行模型', exact: true }).selectOption('local-verification');
    await page.getByRole('button', { name: '无目录', exact: true }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('浏览器宿主验证');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('button', { name: '工作面板', exact: true }).click();
    await page.getByRole('tab', { name: '浏览器', exact: true }).click();
    await page.locator('#browser-address').fill('https://example.com');
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.browser-host-area > p'));
    const isolation = await desktop.evaluate(async ({ webContents, BrowserWindow }) => {
        const remote = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith('https://example.com'));
        if (!remote) throw new Error('The remote browser did not load example.com.');
        const preferences = remote.getLastWebPreferences();
        return {
            id: remote.id,
            nodeIntegration: preferences.nodeIntegration,
            contextIsolation: preferences.contextIsolation,
            sandbox: preferences.sandbox,
            preload: preferences.preload ?? null,
            globals: await remote.executeJavaScript('({node:typeof require,bridge:typeof window.uah})'),
            separateSession: remote.session !== BrowserWindow.getAllWindows()[0].webContents.session
        };
    });
    assert.deepEqual(isolation.globals, { node: 'undefined', bridge: 'undefined' });
    assert.equal(isolation.nodeIntegration, false);
    assert.equal(isolation.contextIsolation, true);
    assert.equal(isolation.sandbox, true);
    assert.equal(isolation.preload, null);
    assert.equal(isolation.separateSession, true);
    checks.push('remote HTTPS view has no Node or UAH bridge and uses a separate session');

    await page.getByRole('tab', { name: '历史快照', exact: true }).click();
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().startsWith('https://example.com')).getVisible()), false);
    await page.getByRole('tab', { name: '浏览器', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.browser-host-area > p'));
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().startsWith('https://example.com')).webContents.id), isolation.id);
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().startsWith('https://example.com')).getVisible()), true);
    checks.push('tab changes hide and restore the same native browser host');

    await page.keyboard.press('Control+k');
    await page.getByRole('dialog', { name: '搜索', exact: true }).waitFor();
    assert.equal(await desktop.evaluate(({ BrowserWindow }, firstId) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.id === firstId).getVisible(), isolation.id), false);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog', { name: '搜索', exact: true }).waitFor({ state: 'hidden' });
    await page.waitForFunction(() => !document.querySelector('.browser-host-area > p'));
    assert.equal(await desktop.evaluate(({ BrowserWindow }, firstId) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.id === firstId).getVisible(), isolation.id), true);
    checks.push('search modal hides the remote native view and restores the same host on dismissal');

    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
    await page.waitForFunction(() => window.innerWidth < 1100);
    const rectangle = await page.locator('.browser-host-area').boundingBox();
    let bounds;
    for (let attempt = 0; attempt < 30; attempt++) {
        bounds = await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().startsWith('https://example.com')).getBounds());
        if (Math.abs(bounds.x - Math.round(rectangle.x * 1.5)) <= 1) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.ok(Math.abs(bounds.x - Math.round(rectangle.x * 1.5)) <= 1);
    assert.ok(Math.abs(bounds.y - Math.round(rectangle.y * 1.5)) <= 1);
    assert.ok(Math.abs(bounds.width - Math.floor(rectangle.width * 1.5)) <= 1);
    checks.push('150% application zoom maps browser CSS bounds into native coordinates');

    await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
    await page.getByRole('button', { name: '新对话', exact: true }).click();
    await page.getByRole('combobox', { name: '运行模型', exact: true }).selectOption('local-verification');
    assert.equal(await page.getByRole('button', { name: '无目录', exact: true }).count(), 0, 'new sessions inherit the last created session directory choice');
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('第二个浏览器会话');
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await page.getByRole('button', { name: '工作面板', exact: true }).click();
    await page.getByRole('tab', { name: '浏览器', exact: true }).click();
    await page.locator('#browser-address').fill('https://example.com/?uah-session=2');
    await page.getByRole('button', { name: '打开', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.browser-host-area > p'));
    assert.equal(await desktop.evaluate(({ webContents }, firstId) => {
        const first = webContents.fromId(firstId);
        const second = webContents.getAllWebContents().find((contents) => contents.getURL().includes('?uah-session=2'));
        return Boolean(first && second && first.session !== second.session);
    }, isolation.id), true);
    await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /浏览器宿主验证/ }).click();
    await page.waitForFunction(() => !document.querySelector('.browser-host-area > p'));
    assert.equal(await desktop.evaluate(({ BrowserWindow }, firstId) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.id === firstId).getVisible(), isolation.id), true);
    checks.push('two sessions keep separate browser profiles and restore their own hosts');

    await page.getByRole('button', { name: '设置', exact: true }).click();
    assert.equal(await desktop.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents?.getURL().startsWith('https://example.com')).getVisible()), false);
    checks.push('management view hides remote content before opening dialogs');
    await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /浏览器宿主验证/ }).click();
    await page.getByRole('button', { name: '关闭网页', exact: true }).click();
    assert.equal(await desktop.evaluate(({ webContents }, firstId) => Boolean(webContents.fromId(firstId)), isolation.id), false);
    checks.push('explicit close releases the selected browser host');
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: checks }, null, 4));
    for (const name of checks) console.log(`PASS ${name}`);
    console.log(`Evidence: ${evidence}`);
} finally {
    await desktop.close();
}
