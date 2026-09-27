import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts/agent-presets-'));
const requests = []; const errors = [];
const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requests.push(body);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const task = body.messages.filter(item => item.role === 'user').at(-1)?.content;
    const spawn = /^Delegate (claude|gpt) fixture$/.test(task) && !body.messages.some(item => item.role === 'tool');
    const delta = spawn ? { tool_calls: [{ index: 0, id: 'spawn-fixture', type: 'function', function: { name: 'spawn_agent', arguments: JSON.stringify({ prompt: `Subagent ${task.includes('gpt') ? 'gpt' : 'claude'} fixture`, agent: { type: 'preset', id: `${task.includes('gpt') ? 'gpt' : 'claude'}-subagent-default` }, permissionMode: 'readonly', context: { mode: 'none' } }) } }] } : { content: 'Fixture complete' };
    response.end(`data: ${JSON.stringify({ choices: [{ delta, finish_reason: spawn ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const env = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL;
let app;
async function waitCompleted(page, id) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
        const run = await page.evaluate(async id => (await window.uah.command({ type: 'snapshot' })).runs.find(run => run.id === id), id);
        if (run?.state === 'completed') return run;
        assert.notEqual(run?.state, 'failed', run?.error);
        await page.waitForTimeout(20);
    }
    throw new Error(`Run did not complete: ${id}`);
}
try {
    app = await electron.launch({ args: ['.'], env });
    let page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    for (const name of ['Claude 默认 Agent', 'GPT 默认 Agent', '通用 Coding Agent']) {
        await page.getByRole('button', { name: `编辑 Agent ${name}`, exact: true }).waitFor();
    }
    const initial = await page.evaluate(() => window.uah.agents({ type: 'get' }));
    const settings = initial.settings ?? initial;
    const profiles = settings.profiles.filter(profile => ['claude-default', 'gpt-default', 'coding-general'].includes(profile.id));
    assert.equal(profiles.length, 3);
    const endpointId = await page.evaluate(async baseUrl => {
        const saved = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Agent fixture', protocol: 'openai-chat', baseUrl, models: ['fixture'], enabled: true, revision: 0, apiKey: null } });
        return saved.endpoints[0].id;
    }, `http://127.0.0.1:${server.address().port}/v1`);
    for (const profile of profiles) {
        const runId = await page.evaluate(async ({ endpointId, agentId }) => {
            const before = await window.uah.command({ type: 'snapshot' });
            const snapshot = await window.uah.command({ type: 'create-session', title: agentId, directory: null, selection: { endpointId, modelId: 'fixture' }, agentId, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
            const session = snapshot.sessions.find(item => !before.sessions.some(previous => previous.id === item.id));
            const started = await window.uah.command({ type: 'start-run', sessionId: session.id, input: 'Local preset fixture' });
            return started.runs.find(item => item.sessionId === session.id).id;
        }, { endpointId, agentId: profile.id });
        await waitCompleted(page, runId);
        const system = requests.at(-1).messages.find(message => message.role === 'system').content;
        if (profile.id === 'claude-default') {
            assert.ok(system.includes('# 角色与职责'));
            assert.match(system, /"directory":null/);
            assert.match(system, /"permissionMode":"readonly"/);
            assert.doesNotMatch(system, /\{\{[A-Z_]+\}\}/);
        } else if (profile.id === 'gpt-default') {
            assert.match(system, /# Host compatibility contract/);
            assert.match(system, /# Main-agent role/);
            assert.doesNotMatch(system, /# Subagent role/);
            assert.match(system, /"role":"primary"/);
            assert.match(system, /"parentRunId":null/);
            assert.doesNotMatch(system, /\{\{[A-Z_]+\}\}/);
        } else assert.ok(system.includes(profile.instructions.replace(/^<!-- UAH_PROMPT_PROFILE:[a-z]+:v1 -->\n/, '')));
    }
    for (const brand of ['claude', 'gpt']) {
        const delegated = await page.evaluate(async ({ endpointId, brand }) => {
            const before = await window.uah.command({ type: 'snapshot' });
            const snapshot = await window.uah.command({ type: 'create-session', title: 'Delegate fixture', directory: null, selection: { endpointId, modelId: 'fixture' }, agentId: `${brand}-default`, controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
            const session = snapshot.sessions.find(item => !before.sessions.some(previous => previous.id === item.id));
            const started = await window.uah.command({ type: 'start-run', sessionId: session.id, input: `Delegate ${brand} fixture` });
            return started.runs.find(item => item.sessionId === session.id).id;
        }, { endpointId, brand });
        await waitCompleted(page, delegated);
        const childRequest = requests.find(body => body.messages.at(-1)?.content === `Subagent ${brand} fixture`);
        assert.ok(childRequest, 'real child used the new preset');
        const childSystem = childRequest.messages.find(message => message.role === 'system').content;
        if (brand === 'claude') {
            assert.match(childSystem, /# 角色与职责/);
            assert.match(childSystem, /# 子代理角色与交付约定/);
        } else {
            assert.match(childSystem, /# Host compatibility contract/);
            assert.match(childSystem, /# Subagent role/);
            assert.doesNotMatch(childSystem, /# Main-agent role/);
            assert.ok(childSystem.includes(`"parentRunId":"${delegated}"`));
            assert.doesNotMatch(childSystem, /\{\{[A-Z_]+\}\}/);
        }
        assert.match(childSystem, /"role":"subagent"/);
        assert.ok(!childRequest.tools.some(tool => ['spawn_agent', 'submit_plan'].includes(tool.function.name)));
    }
    await page.getByRole('button', { name: '编辑 Agent GPT 默认 Agent', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '编辑 Agent 配置', exact: true });
    const input = dialog.getByRole('textbox', { name: 'Agent 指令', exact: true });
    assert.ok((await input.inputValue()).includes('# Host compatibility contract'));
    await dialog.getByRole('tab', { name: '预览', exact: true }).click();
    await dialog.getByRole('heading', { name: 'Host compatibility contract', exact: true }).waitFor();
    await dialog.getByRole('tab', { name: '编辑', exact: true }).click();
    const markdown = '# 编程约定\n\n**先读代码**，再实施。\n\n- [x] 保留用户更改\n- [ ] 验证结果\n\n| 操作 | 方式 |\n| --- | --- |\n| 编辑 | 审批 |\n\n```ts\nconst mode = "manual";\n```\n\n<script>window.promptInjected = true</script>';
    await input.fill(markdown);
    await dialog.getByRole('tab', { name: '编辑', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await dialog.getByRole('heading', { name: '编程约定', exact: true }).waitFor();
    assert.equal(await dialog.locator('table').count(), 1);
    assert.equal(await page.evaluate(() => Boolean(window.promptInjected)), false);
    const capture = async name => {
        await page.waitForTimeout(180);
        const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
        await writeFile(path.join(evidence, `${name}.png`), Buffer.from(png.split(',')[1], 'base64'));
    };
    await capture('preview-light');
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await app.evaluate(({ BrowserWindow }) => { const win = BrowserWindow.getAllWindows()[0]; win.setSize(900, 850); win.webContents.setZoomFactor(1.25); });
    await dialog.getByRole('heading', { name: '编程约定', exact: true }).evaluate(element => element.scrollIntoView({ block: 'start' }));
    await capture('preview-dark-narrow');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await dialog.getByRole('tab', { name: '编辑', exact: true }).click();
    assert.equal(await input.inputValue(), markdown, 'preview keeps the exact Markdown source');
    await input.scrollIntoViewIfNeeded(); await capture('editor-dark-narrow');
    await dialog.getByRole('button', { name: '保存 Agent', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await app.close();
    app = await electron.launch({ args: ['.'], env });
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '编辑 Agent GPT 默认 Agent', exact: true }).click();
    assert.equal(await page.getByRole('textbox', { name: 'Agent 指令', exact: true }).inputValue(), markdown);
    assert.equal(requests.length, 9);
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, requests: requests.length, errors }, null, 4));
    console.log('PASS preset requests, Markdown edit/preview, keyboard, safe rendering and restart: ' + evidence);
} catch (error) {
    if (app) {
        const page = await app.firstWindow();
        const snapshot = await page.evaluate(() => window.uah.command({ type: 'snapshot' }));
        await writeFile(path.join(evidence, 'failure.json'), JSON.stringify({ requests, snapshot }, null, 4));
    }
    throw error;
} finally {
    if (app) await app.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
