import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'tool-chat-'));
const project = path.join(evidence, 'project');
await mkdir(project);
const original = 'Original tool fixture content.\n';
const replacement = 'Updated through the approved tool call.\n';
const markdownResponse = '# Fixture summary\n\n**Fixture tool task complete.**\n\n- Approved edit\n- Snapshot preserved\n\n| Check | Result |\n| --- | --- |\n| Tool | Passed |\n\n```js\nconst fixture = true;\n```';
const childMarkdownResponse = '## Child observation\n\n**Child fixture response.**\n\n- Readonly child result';
const target = path.join(project, 'fixture.txt');
await writeFile(target, original);
const requests = [];
const errors = [];
const checks = [];
const screenshots = [];
const sse = data => `data: ${JSON.stringify(data)}\n\n`;
const delta = data => sse({ choices: [{ delta: data, finish_reason: null }] });
const taskIndex = messages => messages.findLastIndex(message => message.role === 'user' && typeof message.content === 'string' && !message.content.startsWith('[UAH'));
const currentTask = body => body.messages[taskIndex(body.messages)]?.content;
const toolRound = (id, name, args, reasoning) => delta({ reasoning_content: reasoning })
    + delta({ tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: args.slice(0, 10) } }] })
    + sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: args.slice(10) } }] }, finish_reason: 'tool_calls' }] })
    + 'data: [DONE]\n\n';
const server = http.createServer(async (request, response) => {
    try {
        const chunks = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        requests.push(body);
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        // Native history retains earlier tool messages. Fixture progression is
        // scoped to the latest user task, excluding host terminal-delivery data.
        const results = body.messages.slice(taskIndex(body.messages) + 1).filter(message => message.role === 'tool');
        const lastUser = currentTask(body);
        if (lastUser === 'Live child fixture') {
            response.end(toolRound('pending-child-write', 'write_file', JSON.stringify({ path: 'child-should-not-write.txt',
                content: 'This file must never be written.', expectedContent: null }), 'The live child requests approval for a fixture edit.'));
        } else if (lastUser === 'Blank reason child fixture') {
            response.write(delta({ reasoning_content: 'The live child is waiting for cancellation.' }));
        } else if (lastUser === 'Stop child with reason' || lastUser === 'Stop child without reason') {
            if (!results.length) response.end(toolRound('live-spawn', 'spawn_agent', JSON.stringify({
                prompt: lastUser === 'Stop child with reason' ? 'Live child fixture' : 'Blank reason child fixture',
                agent: { type: 'inline', name: lastUser === 'Stop child with reason' ? 'Live fixture child' : 'Blank reason child', instructions: 'Wait for cancellation.' },
                permissionMode: 'manual', context: { mode: 'none' },
            }), 'I will start the cancellable child fixture.'));
            else if (results.length === 1) response.end(toolRound('live-wait', 'wait_agents', JSON.stringify({ agentIds: [JSON.parse(results[0].content).agentId] }), 'I will wait until the child stops.'));
            else response.end(sse({ choices: [{ delta: { content: `${lastUser} complete.` }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
        } else if (lastUser === 'Child fixture prompt') {
            response.end(delta({ reasoning_content: 'I will report the child fixture observation.' })
                + sse({ choices: [{ delta: { content: childMarkdownResponse }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
        } else if (lastUser === 'Spawn child fixture') {
            if (!results.length) response.end(toolRound('spawn-call', 'spawn_agent', JSON.stringify({ prompt: 'Child fixture prompt',
                agent: { type: 'inline', name: 'Fixture child', instructions: 'Report the fixture observation.' },
                permissionMode: 'readonly', context: { mode: 'none' } }), 'I will delegate an independent fixture observation.'));
            else if (results.length === 1) response.end(toolRound('wait-call', 'wait_agents', JSON.stringify({ agentIds: [JSON.parse(results[0].content).agentId] }), 'I will wait for the child result.'));
            else response.end(sse({ choices: [{ delta: { content: 'Parent child task complete.' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
        } else if (!results.length) response.end(toolRound('read-call', 'read_file', JSON.stringify({ path: 'fixture.txt' }), 'I will inspect the existing file before proposing a change.'));
        else if (results.length === 1) response.end(toolRound('write-call', 'write_file', JSON.stringify({ path: 'fixture.txt', content: replacement, expectedContent: original }), 'The file matches the expected content. I will request approval for the edit.'));
        else response.end(delta({ reasoning_content: 'The correlated tool result confirms the approved edit.' })
            + sse({ choices: [{ delta: { content: markdownResponse }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n');
    } catch (error) { errors.push(String(error)); response.destroy(); }
});
const blockedPorts = new Set([3659, 4045, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669, 6697, 10080]);
while (true) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
    if (!blockedPorts.has(server.address().port)) break;
    await new Promise(resolve => server.close(resolve));
}
const address = server.address();
assert.ok(address && typeof address !== 'string');
const environment = { ...process.env, UAH_DATA_DIR: path.join(evidence, 'data') };
delete environment.ELECTRON_RUN_AS_NODE;
delete environment.UAH_DEV_URL;
let desktop;
let page;
let sessionId;
let currentSessionTitle = 'Tool fixture session';
async function launch() {
    desktop = await electron.launch({ args: ['.'], cwd: root, env: environment, timeout: 30000 });
    page = await desktop.firstWindow();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => errors.push(error.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
}
async function snapshot() { return page.evaluate(() => window.uah.command({ type: 'snapshot' })); }
async function check(label, action) { await action(); checks.push(label); console.log(`PASS ${label}`); }
async function settle() {
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
}
async function capture(name) {
    await settle();
    const data = await desktop.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(data.split(',')[1], 'base64'));
    screenshots.push(name);
}
async function theme(value) {
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const radio = page.getByRole('radio', { name: value === 'light' ? '浅色' : '深色', exact: true });
    if (await radio.getAttribute('aria-checked') !== 'true') {
        await radio.click();
        await page.getByRole('button', { name: '保存设置', exact: true }).click();
    }
    await page.locator('.session-button').filter({ has: page.getByText(currentSessionTitle, { exact: true }) }).click();
    await page.waitForFunction(expected => document.documentElement.dataset.theme === expected, value);
    await page.getByRole('button', { name: '关闭通知', exact: true }).evaluateAll(elements => elements.forEach(element => element.click()));
}
async function agentsPanel() {
    const panel = page.getByRole('complementary', { name: '会话工作面板', exact: true });
    if (!await panel.isVisible()) await page.getByRole('button', { name: '工作面板', exact: true }).click();
    await panel.getByRole('tab', { name: '子代理', exact: true }).click();
    return panel;
}
function activityByTitle(title, scope = page) {
    return scope.locator('.ui-activity').filter({ has: page.locator(':scope > .ui-activity-heading .ui-activity-title').getByText(title, { exact: true }) });
}
async function openToolGroups(scope = page) {
    for (const heading of await scope.locator('.ui-activity-heading').filter({ hasText: /^使用了 \d+ 个工具/ }).all()) {
        if (await heading.isVisible() && await heading.getAttribute('aria-expanded') !== 'true') await heading.click();
    }
}
try {
    await launch();
    await desktop.evaluate(({ BrowserWindow }) => {
        const current = BrowserWindow.getAllWindows()[0]; current.setSize(900, 800); current.webContents.setZoomFactor(1.25);
    });
    await desktop.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, project);
    const configured = await page.evaluate(({ url, directory }) => (async () => {
        const approvedDirectory = await window.uah.chooseDirectory();
        if (approvedDirectory !== directory) throw new Error('Fixture directory was not approved by the host picker.');
        const reply = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Tool Fixture', protocol: 'openai-chat',
            baseUrl: url, models: ['tool-model'], enabled: true, revision: 0, apiKey: null } });
        return window.uah.command({ type: 'create-session', title: 'Tool fixture session', directory: approvedDirectory,
            selection: { endpointId: reply.endpoints[0].id, modelId: 'tool-model' }, agentId: 'default',
            controls: { permissionMode: 'manual', reasoningEffort: 'high' } });
    })(), { url: `http://127.0.0.1:${address.port}/v1`, directory: project });
    sessionId = configured.sessions[0].id;
    await page.reload();
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    await check('tool request reads a real file and pauses a manual write for approval', async () => {
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('Read and update the fixture file.');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '批准本次操作', exact: true }).waitFor();
        assert.equal(await readFile(target, 'utf8'), original);
        const current = await snapshot();
        assert.equal(current.runs[0].state, 'approval');
        assert.equal(current.approvals.filter(item => item.status === 'pending').length, 1);
        assert.equal(requests.length, 2);
        assert.equal(requests[1].messages.find(message => message.role === 'tool').tool_call_id, 'read-call');
        assert.equal(requests[1].messages.find(message => message.role === 'tool').content, original);
        await openToolGroups();
        const write = activityByTitle('编辑文件');
        assert.equal(await write.locator('.ui-activity-heading').getAttribute('aria-expanded'), 'true');
        await write.locator('.ui-diff').getByText('· 待执行', { exact: true }).waitFor();
        assert.equal(await write.locator('.ui-diff-row[data-kind="removed"]').count(), 1);
        assert.equal(await write.locator('.ui-diff-row[data-kind="added"]').count(), 1);
        assert.ok(!(await write.innerText()).includes('"expectedContent"'));
        assert.ok(!(await write.innerText()).includes('"content":'));
        for (const value of ['light', 'dark']) {
            await theme(value);
            await page.getByRole('button', { name: '批准本次操作', exact: true }).scrollIntoViewIfNeeded();
            await capture(`tool-approval-${value}-900-800-125.png`);
        }
    });
    await check('approving once continues the correlated loop and records the real immutable artifact', async () => {
        await page.getByRole('button', { name: '批准本次操作', exact: true }).click();
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        await page.getByText('Fixture tool task complete.', { exact: true }).waitFor();
        assert.equal(await readFile(target, 'utf8'), replacement);
        const current = await snapshot();
        assert.equal(current.approvals[0].status, 'approved');
        assert.equal(current.artifacts.length, 1);
        assert.equal(current.artifacts[0].oldContent, original);
        assert.equal(current.artifacts[0].newContent, replacement);
        assert.equal(current.runs[0].activities.find(activity => activity.tool?.name === 'write_file').tool.artifactId, current.artifacts[0].id);
        await openToolGroups();
        const write = activityByTitle('已编辑');
        const writeHeading = write.locator('.ui-activity-heading');
        if (await writeHeading.getAttribute('aria-expanded') !== 'true') await writeHeading.click();
        await write.locator('.ui-diff').getByText('· 保存的快照', { exact: true }).waitFor();
        assert.equal(await write.locator('.ui-diff').getByText('· 待执行', { exact: true }).count(), 0);
        await page.getByRole('heading', { name: 'Fixture summary', exact: true }).waitFor();
        assert.equal(await page.locator('.ui-markdown strong').getByText('Fixture tool task complete.', { exact: true }).count(), 1);
        assert.equal(await page.locator('.ui-markdown table').count(), 1);
        await page.locator('.ui-markdown code').getByText('const fixture = true;', { exact: true }).waitFor();
        assert.equal(current.runs[0].activities.filter(activity => activity.kind === 'reasoning').length, 3);
        assert.equal(requests.length, 3);
        const toolResults = requests[2].messages.filter(message => message.role === 'tool');
        assert.deepEqual(toolResults.map(message => message.tool_call_id), ['read-call', 'write-call']);
        assert.equal(toolResults[1].content, 'File written.');
        assert.equal(await page.getByRole('button', { name: '批准本次操作', exact: true }).count(), 0);
    });
    await check('reasoning and tool activity expand and collapse independently in light and dark modes', async () => {
        for (const value of ['light', 'dark']) {
            await theme(value);
            await openToolGroups();
            const edit = activityByTitle('已编辑');
            const editHeading = edit.locator('.ui-activity-heading');
            if (await editHeading.getAttribute('aria-expanded') !== 'true') await editHeading.click();
            await edit.locator('.ui-diff').scrollIntoViewIfNeeded();
            await capture(`tool-completed-diff-${value}-900-800-125.png`);
            await page.getByRole('heading', { name: 'Fixture summary', exact: true }).scrollIntoViewIfNeeded();
            await capture(`markdown-completed-${value}-900-800-125.png`);
            const reasoning = activityByTitle('已思考').first();
            const heading = reasoning.locator('.ui-activity-heading');
            if (await heading.getAttribute('aria-expanded') === 'true') await heading.click();
            assert.equal(await heading.getAttribute('aria-expanded'), 'false');
            await heading.scrollIntoViewIfNeeded();
            await capture(`tool-activities-collapsed-${value}-900-800-125.png`);
            await heading.click();
            assert.equal(await heading.getAttribute('aria-expanded'), 'true');
            await reasoning.getByText('I will inspect the existing file before proposing a change.', { exact: true }).waitFor();
            const readHeading = page.locator('.ui-activity-heading').filter({ hasText: '已读取' });
            if (await readHeading.getAttribute('aria-expanded') !== 'true') await readHeading.click();
            await reasoning.scrollIntoViewIfNeeded();
            await capture(`tool-activities-expanded-${value}-900-800-125.png`);
            await heading.click();
            assert.equal(await heading.getAttribute('aria-expanded'), 'false');
        }
    });
    const beforeRestart = await snapshot();
    await desktop.close(); desktop = null;
    await check('restart preserves completed reasoning, tool activity, approval and artifact snapshots', async () => {
        await launch();
        const restored = await snapshot();
        assert.deepEqual(restored.runs, beforeRestart.runs);
        assert.deepEqual(restored.approvals, beforeRestart.approvals);
        assert.deepEqual(restored.artifacts, beforeRestart.artifacts);
        assert.equal(restored.sessions[0].id, sessionId);
        await page.getByText('Fixture tool task complete.', { exact: true }).waitFor();
    });
    await check('inherited directory survives restart and actual child runs display as right-panel read-only conversations', async () => {
        await page.evaluate(async () => {
            const settings = await window.uah.agents({ type: 'get' });
            settings.subagents.enabled = true;
            await window.uah.agents({ type: 'save', settings });
        });
        await page.getByRole('button', { name: '新对话', exact: true }).click();
        assert.equal(await page.getByRole('combobox', { name: '主 Agent', exact: true }).inputValue(), 'default');
        assert.equal(await page.getByRole('combobox', { name: '权限模式', exact: true }).inputValue(), 'manual');
        assert.equal(await page.getByRole('combobox', { name: '思考强度', exact: true }).inputValue(), 'high');
        assert.equal(await page.getByRole('button', { name: '选择工作目录（可选）', exact: true }).getAttribute('title'), project);
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('Spawn child fixture');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByText('Parent child task complete.', { exact: true }).waitFor();
        await page.locator('.turn .status').last().filter({ hasText: '已完成' }).waitFor();
        const current = await snapshot();
        currentSessionTitle = 'Spawn child fixture';
        const parent = current.runs.find(run => run.input === 'Spawn child fixture');
        const child = current.runs.find(run => run.parentRunId === parent?.id);
        assert.ok(parent); assert.ok(child);
        assert.notEqual(parent.sessionId, sessionId);
        assert.equal(current.sessions.find(session => session.id === parent.sessionId)?.directory, project);
        assert.equal(parent.state, 'completed'); assert.equal(child.state, 'completed');
        assert.equal(child.output, childMarkdownResponse);
        assert.equal(child.effective.permissionMode, 'readonly');
        assert.ok(parent.activities.some(activity => activity.kind === 'agent' && activity.childRunId === child.id));
        for (const value of ['light', 'dark']) {
            await theme(value);
            await desktop.evaluate(({ BrowserWindow }) => {
                const currentWindow = BrowserWindow.getAllWindows()[0]; currentWindow.setSize(900, 800); currentWindow.webContents.setZoomFactor(1.25);
            });
            const panel = await agentsPanel();
            assert.equal(await panel.locator('[data-child-id]').count(), 1);
            await panel.getByText('当前会话的全部子代理 · 1 个', { exact: true }).waitFor();
            await capture(`child-panel-list-${value}-900-800-125.png`);
            await panel.getByRole('button', { name: 'Fixture child · 已完成', exact: true }).click();
            await panel.getByText('Child fixture response.', { exact: true }).waitFor();
            await panel.getByRole('heading', { name: 'Child observation', exact: true }).waitFor();
            await openToolGroups(panel);
            const childReasoning = panel.locator('.ui-activity-heading').filter({ hasText: '已思考' });
            if (await childReasoning.getAttribute('aria-expanded') !== 'true') await childReasoning.click();
            try { await panel.getByText('I will report the child fixture observation.', { exact: true }).waitFor(); }
            catch (error) {
                const visibility = await panel.getByText('I will report the child fixture observation.', { exact: true }).evaluate(element => {
                    const ancestors = []; for (let current = element; current; current = current.parentElement) {
                        const style = getComputedStyle(current); const bounds = current.getBoundingClientRect();
                        ancestors.push({ tag: current.tagName, class: current.className, hidden: current.getAttribute('aria-hidden'), display: style.display, visibility: style.visibility, width: bounds.width, height: bounds.height });
                    } return ancestors;
                });
                await writeFile(path.join(evidence, 'child-reasoning-visibility.json'), JSON.stringify(visibility, null, 2));
                await capture('child-reasoning-hidden.png'); console.log(`Failure evidence: ${evidence}`); throw error;
            }
            assert.equal(await panel.getByRole('textbox').count(), 0);
            assert.equal(await panel.getByRole('button', { name: /批准本次操作|确认停止|停止子代理/ }).count(), 0);
            await capture(`child-panel-detail-${value}-900-800-125.png`);
            await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click();
            await desktop.evaluate(({ BrowserWindow }) => {
                const currentWindow = BrowserWindow.getAllWindows()[0]; currentWindow.setSize(1440, 900); currentWindow.webContents.setZoomFactor(1);
            });
            const assertPanelWidth = async () => {
                const dimensions = await panel.getByRole('region', { name: '子代理面板', exact: true }).evaluate(element => ({ width: element.clientWidth, content: element.scrollWidth }));
                assert.ok(dimensions.width + 1 >= dimensions.content, `Child panel overflow: ${JSON.stringify(dimensions)}`);
            };
            await assertPanelWidth();
            await capture(`child-panel-list-${value}-1440-900-100.png`);
            await panel.getByRole('button', { name: 'Fixture child · 已完成', exact: true }).click();
            await panel.getByText('Child fixture response.', { exact: true }).waitFor();
            const wideReasoning = panel.locator('.ui-activity-heading').filter({ hasText: '已思考' });
            if (await wideReasoning.getAttribute('aria-expanded') !== 'true') await wideReasoning.click();
            await assertPanelWidth();
            await capture(`child-panel-detail-${value}-1440-900-100.png`);
            await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click();
        }
        await page.locator('.session-button').filter({ has: page.getByText('Tool fixture session', { exact: true }) }).click();
        const isolated = await agentsPanel();
        assert.equal(await isolated.locator('[data-child-id]').count(), 0);
        await isolated.getByText('当前会话的全部子代理 · 0 个', { exact: true }).waitFor();
        await page.locator('.session-button').filter({ has: page.getByText(currentSessionTitle, { exact: true }) }).click();
        assert.equal(await (await agentsPanel()).locator('[data-child-id]').count(), 1);
    });

    await check('child stop dialog can close without stopping and records optional reasons in parent wait results', async () => {
        for (const [prompt, childName, stopReason] of [['Stop child with reason', 'Live fixture child', 'Parent requested a narrower follow-up.'],
            ['Stop child without reason', 'Blank reason child', '']]) {
            await page.getByRole('button', { name: '关闭工作面板', exact: true }).click();
            await page.getByRole('textbox', { name: '消息', exact: true }).fill(prompt);
            await page.getByRole('button', { name: '发送消息', exact: true }).click();
            let parent; let child;
            for (let attempt = 0; attempt < 100; attempt++) {
                const current = await snapshot();
                parent = current.runs.find(run => run.input === prompt);
                child = current.runs.find(run => run.parentRunId === parent?.id && ['running', 'approval'].includes(run.state));
                if (parent?.activities?.some(activity => activity.title === 'wait_agents') && child) break;
                await page.waitForTimeout(100);
            }
            assert.ok(parent?.activities?.some(activity => activity.title === 'wait_agents') && child);
            const panel = await agentsPanel();
            await panel.getByRole('button', { name: new RegExp(`^${childName} ·`) }).click();
            assert.equal(await panel.getByRole('button', { name: /批准本次操作|拒绝|停止子代理|确认停止/ }).count(), 0);
            assert.equal(await panel.getByRole('textbox').count(), 0);
            await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click();
            const stop = panel.getByRole('button', { name: `停止子代理 ${childName}`, exact: true });
            await stop.click();
            const dialog = page.getByRole('dialog', { name: '停止子代理', exact: true });
            await dialog.waitFor();
            const field = dialog.getByRole('textbox', { name: '停止理由（可选）', exact: true });
            assert.equal(await field.getAttribute('maxlength'), '2000');
            await dialog.getByRole('button', { name: '关闭', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            assert.ok(['running', 'approval'].includes((await snapshot()).runs.find(run => run.id === child.id).state));
            await stop.click();
            await field.fill(stopReason);
            if (stopReason) await capture('child-stop-reason-dark-900-800-125.png');
            await dialog.getByRole('button', { name: '确认停止', exact: true }).click();
            await dialog.waitFor({ state: 'hidden' });
            let settled = false;
            for (let attempt = 0; attempt < 100; attempt++) {
                const current = await snapshot();
                if (current.runs.find(run => run.id === parent.id)?.state === 'completed') { settled = true; break; }
                await page.waitForTimeout(100);
            }
            assert.ok(settled, 'parent completes after receiving the stopped child result');
            const afterStop = await snapshot();
            const stopped = afterStop.runs.find(run => run.id === child.id);
            assert.equal(stopped.state, 'stopped');
            if (stopReason) assert.equal(stopped.stopReason, stopReason);
            else assert.ok(!stopped.stopReason);
            const lastParentRequest = requests.filter(body => currentTask(body) === prompt).at(-1);
            await writeFile(path.join(evidence, 'child-stop-request-evidence.json'), JSON.stringify({ prompt, childId: child.id,
                tools: lastParentRequest.messages.filter(message => message.role === 'tool') }, null, 2));
            const waitResult = JSON.parse(lastParentRequest.messages.filter(message => message.role === 'tool').at(-1).content);
            assert.equal(waitResult[0].agentId, child.id);
            assert.equal(waitResult[0].status, 'stopped');
            if (stopReason) assert.equal(waitResult[0].stopReason, stopReason);
            else assert.ok(!waitResult[0].stopReason);
            await panel.getByRole('button', { name: `${childName} · 已中止`, exact: true }).click();
            assert.equal(await panel.getByRole('textbox').count(), 0);
            assert.equal(await panel.getByRole('button', { name: /批准本次操作|确认停止|停止子代理/ }).count(), 0);
            if (stopReason) await panel.getByText(`停止理由：${stopReason}`, { exact: true }).waitFor();
            await panel.getByRole('button', { name: '返回子代理列表', exact: true }).click();
        }
        const persisted = await snapshot();
        await assert.rejects(readFile(path.join(project, 'child-should-not-write.txt')), { code: 'ENOENT' });
        await desktop.close(); desktop = null;
        await launch();
        const restored = await snapshot();
        assert.deepEqual(restored.runs, persisted.runs);
    });
    assert.deepEqual(errors, []);
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: checks, screenshots, requestCount: requests.length, errors }, null, 4));
    console.log(`Evidence: ${evidence}`);
} finally {
    if (desktop) await desktop.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
