import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = process.cwd();
await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts/git-context-'));
const project = path.join(evidence, 'project');
const nonRepository = path.join(evidence, 'not-repository');
const unauthorized = path.join(evidence, 'unauthorized');
await Promise.all([project, nonRepository, unauthorized].map(directory => mkdir(directory)));
// Stop ancestor discovery into the UAH checkout without creating a repository.
await writeFile(path.join(nonRepository, '.git'), 'gitdir: missing-git-directory\n');
const git = (...args) => execFileSync('git', ['-C', project, ...args], { encoding: 'utf8', windowsHide: true }).trim();
git('init', '-b', 'qa-context');
git('config', 'user.name', 'Offline QA'); git('config', 'user.email', 'offline@example.invalid');
await writeFile(path.join(project, 'tracked.txt'), 'BASE LINE\n'); git('add', '--', 'tracked.txt'); git('commit', '-m', 'Offline fixture initial commit');
await writeFile(path.join(project, 'tracked.txt'), 'STAGED LINE\n'); git('add', '--', 'tracked.txt');
await writeFile(path.join(project, 'tracked.txt'), 'UNSTAGED LINE\n');
await writeFile(path.join(project, '中文 空格.txt'), 'UNTRACKED PRIVATE BODY');
for (let index = 0; index < 24; index++) await writeFile(path.join(project, `scroll-file-${String(index).padStart(2, '0')}.txt`), 'untracked');
const before = { head: git('rev-parse', 'HEAD'), index: createHash('sha256').update(await readFile(path.join(project, '.git/index'))).digest('hex') };
const requests = []; const errors = []; const consoleErrors = []; const checks = [];
const check = (name, condition) => { assert.ok(condition, name); checks.push(name); };
const frame = body => `data: ${JSON.stringify(body)}\n\n`;
const server = http.createServer(async (request, response) => {
    try {
        const chunks = []; for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
        const input = body.messages.filter(message => message.role === 'user' && !message.content?.startsWith('[UAH runtime context update v2]')).at(-1)?.content;
        const result = body.messages.find(message => message.role === 'tool' && message.tool_call_id === 'fixture-read');
        const tool = input === 'LOOP TASK' && !result;
        const delta = tool ? { tool_calls: [{ index: 0, id: 'fixture-read', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'tracked.txt' }) } }] } : { content: result ? 'Loop verified.' : 'Usage verified.' };
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.write(frame({ choices: [{ delta, finish_reason: tool ? 'tool_calls' : 'stop' }] }));
        if (input === 'USAGE TASK' || tool) response.write(frame({ choices: [], usage: { prompt_tokens: 1234, completion_tokens: 67, total_tokens: 1301, prompt_tokens_details: { cached_tokens: 234 } } }));
        response.end('data: [DONE]\n\n');
    } catch (cause) { errors.push(String(cause)); response.writeHead(500); response.end('fixture failed'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app; let page; let savedEndpoint; let firstRun; let loopRun; let knownSession;
async function launch() {
    app = await electron.launch({ args: ['.'], cwd: root, env }); page = await app.firstWindow(); page.setDefaultTimeout(20000);
    page.on('pageerror', error => errors.push(error.message)); page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()); });
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
}
const snapshot = () => page.evaluate(() => window.uah.command({ type: 'snapshot' }));
async function choose(directory) {
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, directory);
    return page.evaluate(() => window.uah.chooseDirectory());
}
async function create(title, directory, modelId = 'known') {
    const state = await page.evaluate(({ title, directory, endpointId, modelId }) => window.uah.command({ type: 'create-session', title, directory, selection: { endpointId, modelId }, agentId: 'default', controls: { permissionMode: 'readonly', reasoningEffort: 'default' } }), { title, directory, endpointId: savedEndpoint, modelId });
    await page.reload();
    await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: new RegExp(title) }).click();
    return state.sessions.at(-1).id;
}
async function send(input) {
    await page.getByRole('textbox', { name: '消息', exact: true }).fill(input); await page.getByRole('button', { name: '发送消息', exact: true }).click();
    for (let attempt = 0; attempt < 400; attempt++) {
        const run = (await snapshot()).runs.find(run => run.input === input);
        if (run && ['completed', 'failed', 'stopped'].includes(run.state)) { assert.equal(run.state, 'completed', run.error); return run; }
        await page.waitForTimeout(50);
    }
    throw new Error('Desktop fixture run did not complete: ' + input);
}
async function capture(name, theme = 'light', width = 1440, zoom = 1) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(width, 900); win.webContents.setZoomFactor(zoom); }, { width, zoom });
    await page.waitForTimeout(250);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
}
async function rejected(query) {
    return page.evaluate(async query => { try { await window.uah.git(query); return false; } catch { return true; } }, query);
}
async function assertContextGeometry(dialog, label) {
    await dialog.evaluate(element => {
        const outer = element.querySelector('.ui-dialog-scroll > .ui-scroll-viewport');
        const code = element.querySelector('.ui-code-block');
        const inner = code.querySelector('.ui-scroll-viewport'); inner.scrollTop = 0;
        outer.scrollTop += code.getBoundingClientRect().top - outer.getBoundingClientRect().top - 12;
    });
    await page.waitForTimeout(150);
    const geometry = await dialog.evaluate(element => {
        const shell = element.querySelector('.ui-dialog-scroll');
        const outer = shell.querySelector(':scope > .ui-scroll-viewport');
        const code = element.querySelector('.ui-collapse.is-open .ui-code-block code');
        const inner = code.closest('.ui-scroll-viewport');
        const walker = document.createTreeWalker(code, NodeFilter.SHOW_TEXT);
        let text; while ((text = walker.nextNode()) && !text.textContent.trim()) {}
        const range = document.createRange(); const start = text.textContent.search(/\S/);
        range.setStart(text, start); range.setEnd(text, Math.min(text.textContent.length, start + 24));
        const rect = range.getBoundingClientRect(); const outside = outer.getBoundingClientRect(); const inside = inner.getBoundingClientRect();
        const visibleTop = Math.max(outside.top, inside.top); const visibleBottom = Math.min(outside.bottom, inside.bottom);
        return { shellScroll: shell.scrollTop, aligned: Math.abs(outside.top - shell.getBoundingClientRect().top) < 1,
            rangeVisible: rect.height > 0 && rect.top >= visibleTop - 1 && rect.bottom <= visibleBottom + 1 && rect.right > Math.max(outside.left, inside.left) && rect.left < Math.min(outside.right, inside.right),
            range: { top: rect.top, bottom: rect.bottom }, viewport: { top: outside.top, bottom: outside.bottom } };
    });
    check(`${label}: outer scroll shell never scrolls`, geometry.shellScroll === 0);
    check(`${label}: viewport remains aligned with shell`, geometry.aligned);
    check(`${label}: actual source text Range is inside visible clipping bounds`, geometry.rangeVisible);
    return geometry;
}
try {
    await launch(); await choose(project);
    const saved = await page.evaluate(baseUrl => window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Git context offline', protocol: 'openai-chat', baseUrl, models: ['known', 'unknown'], modelDetails: [{ id: 'known', contextWindow: 64000, tools: true }, { id: 'unknown', tools: true }], enabled: true, revision: 0, apiKey: null } }), `http://127.0.0.1:${server.address().port}/v1`);
    savedEndpoint = saved.endpoints[0].id; knownSession = await create('Git context known', project);
    await page.getByRole('button', { name: /qa-context · 26 项改动/ }).waitFor(); check('branch chip uses real branch and dirty count', true);
    const status = await page.evaluate(directory => window.uah.git({ directory, kind: 'status' }), project);
    check('authorized status preserves Chinese spaced untracked path', status.snapshot.files.some(file => file.path === '中文 空格.txt' && file.untracked));
    const diff = await page.evaluate(directory => window.uah.git({ directory, kind: 'diff' }), project);
    const staged = await page.evaluate(directory => window.uah.git({ directory, kind: 'diff', staged: true }), project);
    const log = await page.evaluate(directory => window.uah.git({ directory, kind: 'log' }), project);
    check('unstaged diff compares index to working tree', diff.diff.includes('-STAGED LINE') && diff.diff.includes('+UNSTAGED LINE'));
    check('staged diff compares HEAD to index', staged.diff.includes('-BASE LINE') && staged.diff.includes('+STAGED LINE'));
    check('log reads fixture commit', log.commits.some(commit => commit.subject === 'Offline fixture initial commit'));
    check('unauthorized directory rejected by desktop bridge', await rejected({ directory: unauthorized, kind: 'status' }));
    check('relative directory rejected', await rejected({ directory: '.', kind: 'status' }));
    check('traversal path rejected', await rejected({ directory: project, kind: 'diff', path: '../outside' }));
    check('unsupported write operation rejected', await rejected({ directory: project, kind: 'commit' }));
    await page.getByRole('button', { name: /qa-context · 26 项改动/ }).click();
    const panel = page.getByRole('complementary', { name: '会话工作面板' }); await panel.getByText('Git · 只读', { exact: true }).waitFor();
    await panel.getByText('Offline fixture initial commit', { exact: true }).waitFor();
    check('Git panel offers no write actions', !await panel.getByRole('button', { name: /^(提交|暂存|签出|重置|Commit|Stage)$/ }).count());
    await panel.getByRole('combobox', { name: '工作区文件 · 26' }).selectOption('中文 空格.txt');
    await panel.getByText('未跟踪文件尚无 Git 差异；这里不会读取其文件正文。', { exact: true }).waitFor();
    check('untracked file body is not read into Git panel', !(await panel.innerText()).includes('UNTRACKED PRIVATE BODY'));
    await panel.getByRole('combobox', { name: '工作区文件 · 26' }).selectOption('tracked.txt');
    await panel.getByRole('combobox', { name: '磁盘当前差异' }).selectOption('index'); await panel.getByText('+STAGED LINE', { exact: false }).waitFor();
    const fileScroll = panel.getByRole('region', { name: 'Git 文件状态' });
    check('Git file list scrolls through real statuses', await fileScroll.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollHeight > element.clientHeight && element.scrollTop > 0; }));
    for (const [theme, width, zoom] of [['light', 1440, 1], ['dark', 900, 1.25]]) await capture(`git-${theme}`, theme, width, zoom);
    await panel.getByRole('button', { name: '关闭工作面板' }).click(); await capture('reset-size', 'light', 1440, 1);
    firstRun = await send('USAGE TASK');
    const context = await page.evaluate(runId => window.uah.requestContext({ runId }), firstRun.id);
    check('provider usage reaches persisted request summary', context.capacity === 64000 && context.usage.inputTokens === 1234 && context.usage.outputTokens === 67 && context.usage.cachedInputTokens === 234);
    check('request projection contains actual Git environment', context.sections.find(section => section.id === 'history').content.includes('qa-context'));
    await page.getByRole('button', { name: /会话上下文：/ }).click();
    const dialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '会话上下文', exact: true }) }); await dialog.getByText('累计输出 token：67', { exact: true }).waitFor();
    await dialog.getByText('累计缓存读取 token：234', { exact: true }).waitFor();
    await dialog.getByText('会话缓存命中率（累计缓存读取 / 累计输入）：18.96%', { exact: true }).waitFor();
    const remaining = await dialog.locator('.ui-usage-legend li').filter({ hasText: '剩余可用上下文' }).innerText();
    check('remaining category accounts for pressure/reserves', remaining.includes(Math.max(0, context.capacity - Math.max(context.estimatedInputTokens + context.pressure.outputReserve + context.pressure.toolReserve + context.pressure.errorReserve, context.pressure.requiredTokens)).toLocaleString()));
    check('context dialog shows model/capacity and measured usage', (await dialog.innerText()).includes('known') && (await dialog.innerText()).includes('64,000'));
    for (const [theme, width, zoom] of [['light', 1440, 1], ['dark', 900, 1.25]]) {
        await capture(`context-usage-${theme}`, theme, width, zoom);
        const geometry = await dialog.evaluate(element => { const shell = element.querySelector('.ui-dialog-scroll'); const viewport = shell.querySelector(':scope > .ui-scroll-viewport'); return { shell: shell.scrollTop, top: viewport.scrollTop, aligned: Math.abs(viewport.getBoundingClientRect().top - shell.getBoundingClientRect().top) < 1 }; });
        check(`${theme}: unopened sections show usage at viewport top`, geometry.shell === 0 && geometry.top === 0 && geometry.aligned);
    }
    await dialog.getByRole('button', { name: /^消息与工具结果 ·/ }).click();
    check('context section expands through library collapse', await dialog.getByRole('button', { name: /^消息与工具结果 ·/ }).getAttribute('aria-expanded') === 'true');
    await dialog.getByText(/qa-context/).first().waitFor();
    for (const [theme, width, zoom] of [['light', 1440, 1], ['dark', 900, 1.25]]) {
        await app.evaluate(({ BrowserWindow }, { width, zoom }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(width, 900); window.webContents.setZoomFactor(zoom); }, { width, zoom });
        await page.waitForTimeout(250);
        await assertContextGeometry(dialog, `${theme} ${width}/${zoom}`);
        await capture(`context-expanded-${theme}`, theme, width, zoom);
        if (theme === 'dark') { const scroll = dialog.getByRole('region', { name: '会话上下文详情' }); check('context dialog scrolls expanded content at 900px/125%', await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; return element.scrollHeight > element.clientHeight && element.scrollTop > 0; })); await capture('context-scrolled-dark', theme, width, zoom); }
    }
    await dialog.getByRole('button', { name: /^消息与工具结果 ·/ }).click(); await capture('context-collapsed-dark', 'dark', 900, 1.25);
    await dialog.getByRole('button', { name: '关闭', exact: true }).click(); await capture('reset-size-loop', 'light', 1440, 1);
    loopRun = await send('LOOP TASK'); const loop = await page.evaluate(runId => window.uah.requestContext({ runId }), loopRun.id);
    check('second tool request records native call/result', loop.round === 1 && loop.sections.find(section => section.id === 'history').content.includes('fixture-read') && loop.sections.find(section => section.id === 'history').content.includes('UNSTAGED LINE'));
    check('usage-less tool continuation does not reuse prior request usage', loop.usage === undefined && loop.estimatedInputTokens > 0);
    check('Git remains in actual tool continuation environment', loop.sections.find(section => section.id === 'history').content.includes('qa-context'));
    await page.getByRole('button', { name: /会话上下文：.*本地估算/ }).waitFor();
    await app.close(); await launch();
    check('relaunch opens a new-session draft without restoring history', await page.getByRole('button', { name: /会话上下文：未统计/ }).isVisible());
    check('context survives real Electron restart', (await page.evaluate(runId => window.uah.requestContext({ runId }), loopRun.id)).requestId === loop.requestId);
    await choose(nonRepository); await create('Git context nonrepo', nonRepository, 'unknown');
    await page.getByRole('button', { name: '非 Git 仓库', exact: true }).waitFor();
    check('nonrepository state is explicit', (await page.evaluate(directory => window.uah.git({ directory, kind: 'status' }), nonRepository)).snapshot.state === 'not-repository');
    await send('UNKNOWN CAPACITY'); const unknown = (await snapshot()).runs.at(-1);
    check('unknown model capacity remains unknown', unknown.requestContext.capacity === undefined);
    await page.getByRole('button', { name: /会话上下文：容量未知.*本地估算/ }).click();
    const laterDialog = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: '会话上下文', exact: true }) });
    await laterDialog.locator('p').filter({ hasText: 'unknown ·' }).waitFor();
    await laterDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await create('Git context empty', null, 'unknown'); await page.getByRole('button', { name: '没有仓库', exact: true }).waitFor();
    check('no-directory state is explicit', (await page.evaluate(() => window.uah.git({ directory: null, kind: 'status' }))).snapshot.state === 'no-directory');
    await page.getByRole('button', { name: /会话上下文：未统计/ }).click(); await page.getByText('此会话尚无可用的 API 上下文记录。', { exact: true }).waitFor();
    await laterDialog.getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('navigation', { name: '会话列表' }).getByRole('button', { name: /Git context known/ }).click();
    await page.getByRole('button', { name: /qa-context · 26 项改动/ }).waitFor(); await page.getByRole('button', { name: /会话上下文：.*本地估算/ }).waitFor(); check('session switch restores correct Git and context', true);
    await page.evaluate(runId => window.uah.command({ type: 'delete-reply', runId }), loopRun.id);
    check('deleted response context detail is unavailable', await page.evaluate(async runId => (await window.uah.requestContext({ runId })) === null, loopRun.id));
    await page.getByRole('button', { name: /会话上下文：未统计/ }).waitFor();
    check('history mutation clears displayed request estimate', true);
    await app.close(); await launch();
    check('deleted context remains unavailable after restart', await page.evaluate(async runId => (await window.uah.requestContext({ runId })) === null, loopRun.id));
    const after = { head: git('rev-parse', 'HEAD'), index: createHash('sha256').update(await readFile(path.join(project, '.git/index'))).digest('hex') };
    check('all Git inspection preserved HEAD and index bytes', JSON.stringify(after) === JSON.stringify(before));
    assert.deepEqual(errors, []); assert.deepEqual(consoleErrors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, errors, consoleErrors, requests: requests.length, before, after }, null, 2));
    console.log(`PASS Git/context desktop: ${evidence}`);
} catch (error) {
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, checks, errors, consoleErrors, failure: String(error), requests: requests.length }, null, 2));
    if (page && !page.isClosed()) await writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText());
    throw error;
} finally { if (app) await app.close().catch(() => {}); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
