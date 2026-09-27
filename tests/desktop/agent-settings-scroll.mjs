import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts/agent-scroll-'));
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
const app = await electron.launch({ args: ['.'], env });
try {
    const page = await app.firstWindow(); page.setDefaultTimeout(10000);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.evaluate(async () => {
        const settings = await window.uah.agents({ type: 'get' });
        for (let index = 0; index < 24; index++) settings.profiles.push({ id: `scroll-${index}`, name: `滚动测试 ${index}`, description: '检验列表超过窗口高度时的滚轮、键盘和末项访问。', instructions: '', kind: 'subagent', model: null, enabled: true, allowDelegation: false });
        await window.uah.agents({ type: 'save', settings });
    });
    await page.getByRole('button', { name: '刷新配置', exact: true }).click();
    const region = page.getByRole('region', { name: 'Agent 配置列表', exact: true });
    const metrics = [];
    for (const [theme, width, zoom] of [['light', 1440, 1], ['dark', 900, 1.25]]) {
        await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
        await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(width, 850); win.webContents.setZoomFactor(zoom); }, { width, zoom });
        await region.evaluate(element => { element.scrollTop = 0; });
        const bounds = await region.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + 100);
        await page.mouse.wheel(0, 600);
        await page.waitForFunction(() => document.querySelector('[aria-label="Agent 配置列表"]').scrollTop > 100);
        await region.focus(); await page.keyboard.press('Control+End');
        await page.waitForFunction(() => { const e = document.querySelector('[aria-label="Agent 配置列表"]'); return e.scrollHeight - e.clientHeight - e.scrollTop < 5; });
        const last = page.getByRole('button', { name: '编辑 Agent 滚动测试 23', exact: true });
        const lastBox = await last.boundingBox(); const regionBox = await region.boundingBox();
        assert.ok(lastBox.y >= regionBox.y && lastBox.y + lastBox.height <= regionBox.y + regionBox.height + 1);
        metrics.push(await region.evaluate(e => ({ top: e.scrollTop, height: e.clientHeight, contentHeight: e.scrollHeight })));
        await page.waitForTimeout(150);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
        await writeFile(path.join(evidence, `${theme}.png`), Buffer.from(png.split(',')[1], 'base64'));
        await last.click();
        const dialog = page.getByRole('dialog', { name: '编辑 Agent 配置', exact: true });
        assert.equal(await dialog.getByRole('textbox', { name: '名称', exact: true }).inputValue(), '滚动测试 23');
        await dialog.getByRole('button', { name: '关闭', exact: true }).click();
        await dialog.waitFor({ state: 'hidden' });
        await region.focus(); await page.keyboard.press('Control+Home');
        await page.waitForFunction(() => document.querySelector('[aria-label="Agent 配置列表"]').scrollTop === 0);
    }
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, metrics }, null, 4));
    console.log('PASS wheel, keyboard, last-item editing and return to top: ' + evidence);
} finally { await app.close(); }
