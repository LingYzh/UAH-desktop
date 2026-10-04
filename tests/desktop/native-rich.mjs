import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const attachmentsOnly = process.argv.includes('--attachments-only');
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'native-rich-'));
const dataDirectory = path.join(evidence, 'data');
const project = path.join(evidence, 'project');
const fixtureRecord = path.join(evidence, 'native-app-server.jsonl');
const notesPath = path.join(evidence, 'notes.txt');
const pdfPath = path.join(evidence, 'reference.pdf');
await mkdir(project);
await writeFile(notesPath, 'Fixture text attachment body.\n', 'utf8');
await writeFile(pdfPath, '%PDF-1.4\nFixture PDF attachment.\n', 'utf8');

const scenario = {
    recordFile: fixtureRecord,
    modelContextWindow: 131_072,
    usageLast: { inputTokens: 21, outputTokens: 4, cachedInputTokens: 5, reasoningOutputTokens: 2, totalTokens: 25 },
    usageTotal: { inputTokens: 210, outputTokens: 40, cachedInputTokens: 50, reasoningOutputTokens: 20, totalTokens: 250 },
    planDeltas: ['Fixture plan body from the native stream.'],
    textChunks: ['Fixture response after plan execution.'],
    nativeActivityEvents: {
        inputMatch: 'NATIVE_RICH_PLAN',
        reasoning: { summary: ['Fixture public reasoning summary.'] },
        command: {
            command: 'fixture-only command',
            cwd: project,
            outputDeltas: ['Fixture command output.'],
            aggregatedOutput: 'Fixture command output.',
            exitCode: 0,
        },
        mcpToolCall: {
            server: 'fixture-mcp',
            tool: 'fixture_lookup',
            arguments: { query: 'fixture' },
            resultText: 'Fixture MCP result.',
        },
    },
};

const errors = [];
const checks = [];
const captures = [];
const externalRequests = [];
const fixturePath = path.join(root, 'tests', 'fixtures', 'codex-app-server-fixture.mjs');
const nativeArgs = [fixturePath, JSON.stringify(scenario)];
const env = { ...process.env, UAH_DATA_DIR: dataDirectory };
delete env.ELECTRON_RUN_AS_NODE;
delete env.UAH_DEV_URL;
const app = await electron.launch({ args: ['.'], cwd: root, env });
const page = await app.firstWindow();
page.setDefaultTimeout(20_000);
page.on('pageerror', error => errors.push(error.message));
page.on('request', request => {
    if (/^https?:\/\//i.test(request.url())) externalRequests.push(request.url());
});

const check = (name, condition) => {
    assert.ok(condition, name);
    checks.push(name);
};

async function snapshot() {
    return page.evaluate(() => window.uah.command({ type: 'snapshot' }));
}

async function fixtureEvents() {
    try {
        const text = await readFile(fixtureRecord, 'utf8');
        return text.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
    }
}

async function turnRequests() {
    return (await fixtureEvents()).filter(event => event.method === 'fixture/turnRequest');
}

async function waitForRun(input) {
    const deadline = Date.now() + 30_000;
    let state;
    let run;
    while (Date.now() < deadline) {
        state = await snapshot();
        run = state.runs.find(item => item.input === input);
        if (run && ['completed', 'failed', 'stopped', 'cancelled'].includes(run.state)) break;
        await page.waitForTimeout(50);
    }
    assert.ok(run, `Native fixture run ${input} is saved.`);
    assert.equal(run.state, 'completed', run.error || `Native fixture run ended in ${run.state}.`);
    return state;
}

async function capture(name, theme, width, zoom) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    await app.evaluate(({ BrowserWindow }, value) => {
        const window = BrowserWindow.getAllWindows()[0];
        window.setSize(value.width, 850);
        window.webContents.setZoomFactor(value.zoom);
    }, { width, zoom });
    if (name.startsWith('native-thread-confirm-')) {
        await page.getByRole('button', { name: '新建线程并继续', exact: true }).scrollIntoViewIfNeeded();
    }
    if (name.startsWith('message-time-')) await page.getByText(/完成于 \d{4}\//).first().scrollIntoViewIfNeeded();
    await page.evaluate(async () => {
        await Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    check(`${name}: no horizontal overflow`, dimensions.scrollWidth <= dimensions.width + 1);
    const png = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(png.split(',')[1], 'base64'));
    captures.push(name);
}

async function openAttachmentMenu() {
    await page.getByRole('button', { name: '添加附件与上下文', exact: true }).click();
    await page.getByRole('menuitem', { name: /添加附件/ }).waitFor({ state: 'visible' });
}

async function dispatchDiskFiles(filePaths, type) {
    await page.evaluate(() => {
        document.getElementById('__native-rich-file-input')?.remove();
        const input = document.createElement('input');
        input.type = 'file';
        input.multiple = true;
        input.id = '__native-rich-file-input';
        document.body.append(input);
    });
    await page.locator('#__native-rich-file-input').setInputFiles(filePaths);
    await page.evaluate(eventType => {
        const input = document.getElementById('__native-rich-file-input');
        const transfer = new DataTransfer();
        for (const file of input.files) transfer.items.add(file);
        const event = new Event(eventType, { bubbles: true, cancelable: true });
        Object.defineProperty(event, eventType === 'paste' ? 'clipboardData' : 'dataTransfer', { value: transfer });
        document.querySelector('.composer').dispatchEvent(event);
        input.remove();
    }, type);
}

async function pasteSyntheticPng() {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/nH8AAAAASUVORK5CYII=';
    await page.evaluate(base64 => {
        const bytes = Uint8Array.from(atob(base64), value => value.charCodeAt(0));
        const transfer = new DataTransfer();
        transfer.items.add(new File([bytes], 'clipboard.png', { type: 'image/png' }));
        const event = new Event('paste', { bubbles: true, cancelable: true });
        Object.defineProperty(event, 'clipboardData', { value: transfer });
        document.querySelector('.composer').dispatchEvent(event);
    }, png);
}

async function waitForAttachment(name) {
    await page.getByRole('button', { name: `移除附件 ${name}`, exact: true }).waitFor({ state: 'visible' });
    return page.getByRole('button', { name: `移除附件 ${name}`, exact: true });
}

try {
    await page.waitForFunction(() => Boolean(window.uah?.nativeCodex && window.uah?.importAttachments));
    await app.evaluate(({ dialog }, directories) => {
        dialog.showOpenDialog = async (...args) => {
            const options = args.at(-1) || {};
            return options.properties?.includes('openFile')
                ? { canceled: false, filePaths: [directories.pdfPath] }
                : { canceled: false, filePaths: [directories.project] };
        };
    }, { project, pdfPath });
    await page.evaluate(async ({ command, args }) => {
        await window.uah.nativeCodex({ type: 'save', settings: {
            enabled: true, command, args, model: 'gpt-fixture', revision: 0,
        } });
        const directory = await window.uah.chooseDirectory();
        await window.uah.command({
            type: 'create-session',
            title: 'Native rich fixture',
            directory,
            selection: { endpointId: 'native:codex', modelId: 'gpt-fixture' },
            agentId: 'default',
            controls: { permissionMode: 'manual', reasoningEffort: 'high' },
        });
    }, { command: process.execPath, args: nativeArgs });
    await page.reload();
    await page.getByRole('button', { name: /Native rich fixture/ }).click();
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();

    await openAttachmentMenu();
    check('native action menu exposes attachment, Plan and goal entries',
        await page.getByRole('menuitem', { name: /添加附件/ }).isVisible()
            && await page.getByRole('menuitem', { name: /进入计划模式/ }).isVisible()
            && await page.getByRole('menuitem', { name: /设置目标/ }).isVisible());
    await capture('native-menu-light-1440.png', 'light', 1440, 1);
    await page.keyboard.press('Escape');
    await openAttachmentMenu();
    await capture('native-menu-dark-900-125.png', 'dark', 900, 1.25);
    await page.keyboard.press('Escape');

    await openAttachmentMenu();
    await page.getByRole('menuitem', { name: /设置目标/ }).click();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '/goal ');
    assert.equal((await snapshot()).runs.length, 0, 'choosing a goal command fills the composer without sending');
    check('goal menu action fills its command and waits for the user to send', true);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('');
    await openAttachmentMenu();
    await page.getByRole('menuitem', { name: /进入计划模式/ }).click();
    assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '/plan ');
    assert.equal((await snapshot()).runs.length, 0, 'choosing Plan fills the composer without sending');
    check('Plan menu action fills its command and waits for the user to send', true);
    await page.getByRole('textbox', { name: '消息', exact: true }).fill('');
    check('menu commands do not start an app-server turn', (await turnRequests()).length === 0);

    await openAttachmentMenu();
    await page.getByRole('menuitem', { name: /添加附件/ }).click();
    const chosenPdf = await waitForAttachment('reference.pdf');
    assert.equal(await chosenPdf.getAttribute('title'), pdfPath, 'system chooser keeps a real PDF path reference');
    await chosenPdf.click();
    await page.getByRole('button', { name: '移除附件 reference.pdf', exact: true }).waitFor({ state: 'detached' });
    check('system attachment chooser resolves and removes a real PDF path reference', true);

    await dispatchDiskFiles(notesPath, 'drop');
    const textBadge = await waitForAttachment('notes.txt');
    check('dropping an OS-backed File imports a text snapshot', (await textBadge.innerText()).includes('文本快照'));
    await dispatchDiskFiles(pdfPath, 'paste');
    const pdfBadge = await waitForAttachment('reference.pdf');
    check('pasting an OS-backed File imports a PDF as a path reference',
        (await pdfBadge.innerText()).includes('路径引用') && await pdfBadge.getAttribute('title') === pdfPath);
    await pasteSyntheticPng();
    const imageBadge = await waitForAttachment('clipboard.png');
    check('pasting an in-memory PNG imports its bytes as an image attachment', (await imageBadge.innerText()).includes('图片'));
    check('three attachment kinds remain selected together', await page.locator('[aria-label="待发送附件"] [aria-label^="移除附件 "]').count() === 3);
    await capture('native-attachments-light-1440.png', 'light', 1440, 1);
    await capture('native-attachments-dark-900-125.png', 'dark', 900, 1.25);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows()[0]; window.setSize(1440, 850); window.webContents.setZoomFactor(1); });

    const endpoints = await page.evaluate(() => window.uah.endpoints({ type: 'list' }));
    check('test starts with no API endpoint configured', endpoints.endpoints.length === 0);
    if (attachmentsOnly) {
        check('File/DataTransfer imports completed without a page error', errors.length === 0);
        assert.deepEqual(externalRequests, [], 'the attachment test must not call external APIs');
        assert.deepEqual(errors, []);
        await writeFile(path.join(evidence, 'summary.json'), JSON.stringify({ checks, captures, errors }, null, 4));
        console.log(JSON.stringify({ evidence, mode: 'attachments-only', checks: checks.length, captures, errors }));
    } else {
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('NATIVE_RICH_ATTACHMENTS');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        let state = await waitForRun('NATIVE_RICH_ATTACHMENTS');
        const attachmentRun = state.runs.find(run => run.input === 'NATIVE_RICH_ATTACHMENTS');
        assert.ok(attachmentRun, 'native attachment run is saved');
        const timestamp = page.locator('article.turn time').first();
        assert.equal(await timestamp.getAttribute('datetime'), attachmentRun.createdAt);
        await page.getByText(/完成于 \d{4}\/\d{2}\/\d{2} \d{2}:\d{2}:\d{2}/).first().waitFor();
        check('messages show their stored send and completion timestamps to the second', true);
        await capture('message-time-light-1440.png', 'light', 1440, 1);
        await capture('message-time-dark-900-125.png', 'dark', 900, 1.25);
        assert.deepEqual(new Set(attachmentRun.attachments?.map(item => item.kind)), new Set(['image', 'text', 'file']));
        const firstTurn = (await turnRequests())[0];
        assert.ok(firstTurn, 'attachment send reaches the local app-server fixture');
        const inputItems = firstTurn.params.input;
        const userText = inputItems.filter(item => typeof item.text === 'string').map(item => item.text).join('\n');
        const localImage = inputItems.find(item => item.type === 'localImage');
        assert.ok(localImage && path.isAbsolute(localImage.path), 'PNG bytes are delivered as a local image artifact');
        await access(localImage.path);
        assert.match(userText, /Fixture text attachment body\./, 'text file is sent as a captured text snapshot');
        assert.ok(userText.includes(JSON.stringify(pdfPath)), 'PDF is delivered as its actual path reference');
        check('native app-server receives PNG, text snapshot and PDF path without an API provider', true);

        await page.getByRole('button', { name: /原生上下文/ }).click();
        const contextDialog = page.getByRole('dialog', { name: '原生上下文统计', exact: true });
        await contextDialog.waitFor();
        await contextDialog.getByText('上下文 token（原生 last.total）：25', { exact: true }).waitFor();
        await contextDialog.getByText('最近请求输入：21', { exact: true }).waitFor();
        await contextDialog.getByText('原生上下文 token', { exact: true }).waitFor();
        const capacityText = contextDialog.getByText(/^上下文容量：/);
        await capacityText.waitFor();
        assert.equal((await capacityText.innerText()).replace(/\D/g, ''), '131072');
        await contextDialog.getByText('线程累计 token：250', { exact: true }).waitFor();
        await contextDialog.getByText('缓存写入输入：未上报', { exact: true }).waitFor();
        check('native context panel displays latest total, capacity, and separate cumulative total', true);
        await capture('native-context-light-1440.png', 'light', 1440, 1);
        await capture('native-context-dark-900-125.png', 'dark', 900, 1.25);
        await contextDialog.getByRole('button', { name: '关闭', exact: true }).click();
        await page.keyboard.press('Escape');
        await contextDialog.waitFor({ state: 'hidden' });

        await page.getByRole('textbox', { name: '消息', exact: true }).fill('/plan NATIVE_RICH_PLAN');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        state = await waitForRun('/plan NATIVE_RICH_PLAN');
        const planRun = state.runs.find(run => run.input === '/plan NATIVE_RICH_PLAN');
        assert.ok(planRun);
        assert.equal(planRun.effective.nativeCollaborationMode, 'plan');
        assert.equal(planRun.nativePlan?.content, 'Native fixture plan body');
        assert.deepEqual(planRun.nativePlan?.steps, [{ step: 'Fixture step', status: 'completed' }]);
        assert.ok(planRun.activities?.some(activity => activity.kind === 'reasoning' && activity.content.includes('Fixture public reasoning summary.')));
        assert.ok(planRun.activities?.some(activity => activity.kind === 'tool' && activity.tool?.name === 'native:commandExecution' && activity.content.includes('Fixture command output.')));
        assert.ok(planRun.activities?.some(activity => activity.kind === 'tool' && activity.tool?.name === 'native:mcpToolCall' && activity.content.includes('Fixture MCP result.')));
        check('fixture reasoning, native command, MCP and Plan progress are stored for display', true);

        const toolGroup = page.getByRole('button', { name: /使用了 \d+ 个工具/ }).first();
        await toolGroup.waitFor({ state: 'visible' });
        await toolGroup.click();
        for (const title of ['已思考', '原生命令', 'MCP 工具']) {
            const activity = page.getByRole('button', { name: new RegExp(title) }).first();
            await activity.waitFor({ state: 'visible' });
            await activity.click();
        }
        await page.getByText('Fixture public reasoning summary.', { exact: true }).waitFor();
        await page.getByText(/Fixture command output\./).waitFor();
        await page.getByText('Fixture MCP result.', { exact: true }).waitFor();
        check('renderer displays reasoning, command and MCP activity results', true);
        await capture('native-activity-light-1440.png', 'light', 1440, 1);
        await capture('native-activity-dark-900-125.png', 'dark', 900, 1.25);

        await page.getByRole('button', { name: '工作面板', exact: true }).click();
        await page.getByRole('tab', { name: '计划', exact: true }).click();
        const planPanel = page.getByRole('tabpanel').filter({ has: page.getByRole('heading', { name: 'Codex 原生计划', exact: true }) });
        await planPanel.getByText('Native fixture plan body', { exact: true }).waitFor();
        await planPanel.getByText('Fixture step', { exact: true }).waitFor();
        await capture('native-plan-light-1440.png', 'light', 1440, 1);
        await capture('native-plan-dark-900-125.png', 'dark', 900, 1.25);
        check('native Plan panel renders plan text, progress, execute and Revise actions',
            await planPanel.getByRole('button', { name: '执行计划', exact: true }).isVisible()
                && await planPanel.getByRole('button', { name: '修订计划（Revise）', exact: true }).isVisible());

        await planPanel.getByRole('button', { name: '修订计划（Revise）', exact: true }).click();
        await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
        assert.equal(await page.getByRole('textbox', { name: '消息', exact: true }).inputValue(), '/plan revise ');
        assert.equal((await snapshot()).runs.length, 2, 'Revise prepares feedback without sending a turn');
        check('Revise action stays in Plan mode and only fills the composer', true);
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('');
        check('Revise action did not call the app-server', (await turnRequests()).length === 2);

        await page.getByRole('button', { name: '工作面板', exact: true }).click();
        await page.getByRole('tab', { name: '计划', exact: true }).click();
        const reopenedPlanPanel = page.getByRole('tabpanel').filter({ has: page.getByRole('heading', { name: 'Codex 原生计划', exact: true }) });
        await reopenedPlanPanel.getByRole('button', { name: '执行计划', exact: true }).click();
        state = await waitForRun('/plan execute');
        const executeRun = state.runs.at(-1);
        assert.equal(executeRun.input, '/plan execute');
        assert.equal(executeRun.effective.nativeCollaborationMode, 'default');
        const requests = await turnRequests();
        assert.equal(requests.length, 3);
        assert.equal(requests.at(-1).params.collaborationMode.mode, 'default');
        assert.ok(requests.at(-1).params.input.some(item => item.text === '执行已确认的计划。'));
        check('Execute starts the confirmed-plan request after leaving Plan mode', true);
        await page.getByRole('button', { name: '关闭工作面板', exact: true }).click();
        await page.evaluate(async ({ command, args }) => {
            await window.uah.nativeCodex({ type: 'save', settings: {
                enabled: true, command, args, model: 'gpt-fixture', revision: 1,
            } });
        }, { command: process.execPath, args: nativeArgs });
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('NATIVE_REPLACEMENT_CANCEL');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '新建线程并继续', exact: true }).waitFor();
        assert.equal((await turnRequests()).length, 3, 'no native turn starts before confirmation');
        await capture('native-thread-confirm-light-1440.png', 'light', 1440, 1);
        await capture('native-thread-confirm-dark-900-125.png', 'dark', 900, 1.25);
        await page.getByRole('button', { name: '取消本次发送', exact: true }).click();
        await page.waitForFunction(async () => {
            const state = await window.uah.command({ type: 'snapshot' });
            return state.runs.find(run => run.input === 'NATIVE_REPLACEMENT_CANCEL')?.state === 'stopped';
        });
        assert.equal((await turnRequests()).length, 3, 'cancelled replacement creates no native turn');
        await page.getByRole('textbox', { name: '消息', exact: true }).fill('NATIVE_REPLACEMENT_APPROVE');
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await page.getByRole('button', { name: '新建线程并继续', exact: true }).waitFor();
        assert.equal((await turnRequests()).length, 3);
        await page.getByRole('button', { name: '新建线程并继续', exact: true }).click();
        await waitForRun('NATIVE_REPLACEMENT_APPROVE');
        assert.equal((await turnRequests()).length, 4);
        check('replacement explains the change, requires confirmation, and cancellation starts no native turn', true);
        assert.deepEqual(externalRequests, [], 'the test must not call external APIs');
        check('no external API request occurred', externalRequests.length === 0);
        await writeFile(path.join(evidence, 'summary.json'), JSON.stringify({ checks, captures, errors }, null, 4));
        console.log(JSON.stringify({ evidence, mode: 'full', checks: checks.length, captures, errors }));
    }
    assert.deepEqual(errors, []);
} catch (error) {
    await writeFile(path.join(evidence, 'failure.txt'), await page.locator('body').innerText().catch(() => ''));
    console.error('Evidence:', evidence);
    throw error;
} finally {
    await app.close();
}
