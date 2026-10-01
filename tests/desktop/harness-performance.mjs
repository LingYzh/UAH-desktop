import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldFrame, setTimeout as delay } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
await mkdir(path.resolve('artifacts'), { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts/harness-desktop-performance-'));
const epoch = () => performance.timeOrigin + performance.now();
const chunk = 'PERF0123456789abcdef'; assert.equal(chunk.length, 20);
const reasoningChunk = 'REASON0123456789abcd'; assert.equal(reasoningChunk.length, 20);
const expected = chunk.repeat(5000); const expectedReasoning = reasoningChunk.repeat(20);
const report = { passed: false, evidence, platform: process.platform, node: process.version, checks: [], errors: [], requests: [] };
const check = (label, condition) => { assert.ok(condition, label); report.checks.push(label); };
const sse = value => `data: ${JSON.stringify(value)}\n\n`;
const contentFrame = value => sse({ choices: [{ delta: value, finish_reason: null }] });
let stopCloseEpoch = null;
const server = http.createServer(async (request, response) => {
    try {
        const bytes = []; for await (const value of request) bytes.push(value);
        const body = JSON.parse(Buffer.concat(bytes).toString('utf8'));
        const prompt = body.messages.filter(value => value.role === 'user').at(-1)?.content;
        const trial = { purpose: prompt === 'STOP_STREAM_PERF' ? 'stop' : '100k', receivedEpoch: epoch(), firstFrameEpoch: null, lastFrameEpoch: null, contentFrames: 0, reasoningFrames: 0, closeEpoch: null };
        report.requests.push(trial);
        response.on('close', () => { trial.closeEpoch = epoch(); if (trial.purpose === 'stop') stopCloseEpoch = trial.closeEpoch; });
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        await delay(50);
        trial.firstFrameEpoch = epoch();
        if (trial.purpose === 'stop') {
            for (let index = 0; index < 10_000 && !response.destroyed; index++) {
                response.write(contentFrame({ content: 'STOP_VISIBLE_' })); trial.contentFrames++;
                await delay(10);
            }
            return;
        }
        for (let index = 0; index < 20; index++) { response.write(contentFrame({ reasoning_content: reasoningChunk })); trial.reasoningFrames++; }
        for (let index = 0; index < 5000; index++) {
            response.write(contentFrame({ content: chunk })); trial.contentFrames++;
            if (index % 10 === 9) await yieldFrame();
        }
        trial.lastFrameEpoch = epoch();
        response.end(sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 50, completion_tokens: 5000, total_tokens: 5050 } }) + 'data: [DONE]\n\n');
    } catch (error) { report.errors.push(`fixture:${error.message}`); response.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let app; let page;
const environment = directory => { const env = { ...process.env, UAH_DATA_DIR: directory }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL; return env; };
const distribution = values => {
    const sorted = [...values].sort((a, b) => a - b); const pick = p => sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
    return { count: sorted.length, p50Ms: pick(.5), p95Ms: pick(.95), maxMs: sorted.at(-1) ?? null };
};
async function launch(directory) {
    app = await electron.launch({ args: ['.'], cwd: root, env: environment(directory), timeout: 30000 });
    page = await app.firstWindow(); page.setDefaultTimeout(60000);
    page.on('pageerror', error => report.errors.push(`renderer:${error.message}`));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    // Observe only command type/count, never credentials or request bodies.
    await app.evaluate(({ ipcMain }) => {
        const handler = ipcMain._invokeHandlers.get('uah:command');
        if (!handler) throw new Error('Cannot install IPC command counter');
        globalThis.__perfCommands = {};
        ipcMain.removeHandler('uah:command');
        ipcMain.handle('uah:command', (event, command, view) => {
            const type = command?.type || 'unknown'; globalThis.__perfCommands[type] = (globalThis.__perfCommands[type] || 0) + 1;
            return handler(event, command, view);
        });
    });
}
const counts = () => app.evaluate(() => ({ ...globalThis.__perfCommands }));
async function processMemory() {
    return app.evaluate(({ app }) => app.getAppMetrics().map(value => ({ type: value.type, name: value.name ?? null, pid: value.pid, memory: value.memory })));
}
async function screenshot(name) {
    const image = await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].capturePage()).toDataURL());
    await writeFile(path.join(evidence, name), Buffer.from(image.split(',')[1], 'base64'));
}
async function installProbe(sessionId, mode) {
    await page.evaluate(({ sessionId, mode, expectedLength, prefix }) => {
        const now = () => performance.timeOrigin + performance.now();
        const result = { mode, startEpoch: now(), firstDeltaEpoch: null, firstDomEpoch: null, firstPaintProxyEpoch: null,
            terminalDomEpoch: null, terminalPaintProxyEpoch: null, deltaEvents: 0, reasoningEvents: 0, runStateEvents: 0, frameIntervals: [], lastFrameTime: null, terminal: false };
        window.__harnessPerformance = result;
        const unsubscribe = window.uah.onEvent(event => {
            if (event.sessionId !== sessionId) return;
            if (event.type === 'delta') { result.deltaEvents++; result.firstDeltaEpoch ??= now(); }
            if (event.type === 'activity-delta') result.reasoningEvents++;
            if (event.type === 'run-state') result.runStateEvents++;
        });
        const inspect = () => {
            const turn = document.querySelector('.turn:last-child');
            const content = [...(turn?.querySelectorAll('.assistant-message') || [])].map(element => element.textContent.trimEnd()).join('');
            if (content.startsWith(prefix) && !result.firstDomEpoch) {
                result.firstDomEpoch = now(); requestAnimationFrame(() => requestAnimationFrame(() => { result.firstPaintProxyEpoch = now(); }));
            }
            const terminalState = turn?.querySelector('.status')?.dataset.state;
            if ((mode === 'stop' ? terminalState === 'stopped' : terminalState === 'completed' && content.length === expectedLength) && !result.terminalDomEpoch) {
                result.terminalDomEpoch = now(); result.terminal = true;
                requestAnimationFrame(() => requestAnimationFrame(() => { result.terminalPaintProxyEpoch = now(); }));
            }
        };
        const observer = new MutationObserver(inspect); observer.observe(document.querySelector('.messages'), { subtree: true, childList: true, characterData: true, attributes: true });
        const tick = timestamp => { if (result.lastFrameTime !== null) result.frameIntervals.push(timestamp - result.lastFrameTime); result.lastFrameTime = timestamp; if (!result.terminal) requestAnimationFrame(tick); };
        requestAnimationFrame(tick);
        window.__stopHarnessProbe = () => { observer.disconnect(); unsubscribe(); };
    }, { sessionId, mode, expectedLength: expected.length, prefix: mode === 'stop' ? 'STOP_VISIBLE_' : chunk });
}
async function diskStats(directory) {
    const result = {};
    for (const name of ['runtime.sqlite', 'runtime.sqlite-wal', 'runtime.sqlite-shm']) { try { result[name] = (await stat(path.join(directory, name))).size; } catch { result[name] = 0; } }
    return result;
}
try {
    const data = path.join(evidence, 'stream-data'); await launch(data);
    const sessionId = await page.evaluate(async baseUrl => {
        const endpoint = await window.uah.endpoints({ type: 'save', draft: { id: null, name: 'Performance local SSE', protocol: 'openai-chat', baseUrl,
            models: ['perf-model'], modelDetails: [{ id: 'perf-model', tools: false }], enabled: true, revision: 0, apiKey: 'LOCAL_PERFORMANCE_FIXTURE_ONLY' } });
        const settings = await window.uah.agents({ type: 'get' });
        settings.profiles.push({ id: 'perf-agent', name: 'Performance fixture', description: 'Offline local SSE', kind: 'primary', enabled: true, allowDelegation: false, instructions: 'Return the fixture stream.' });
        await window.uah.agents({ type: 'save', settings });
        const state = await window.uah.command({ type: 'create-session', title: '100k performance fixture', directory: null,
            selection: { endpointId: endpoint.endpoints[0].id, modelId: 'perf-model' }, agentId: 'perf-agent', controls: { permissionMode: 'readonly', reasoningEffort: 'default' } });
        return state.sessions[0].id;
    }, `http://127.0.0.1:${server.address().port}/v1`);
    await page.locator('.session-button').filter({ hasText: '100k performance fixture' }).click();
    const commandsBefore = await counts(); const memoryBefore = await processMemory();
    await installProbe(sessionId, '100k');
    const initial = await page.evaluate(sessionId => window.uah.command({ type: 'start-run', sessionId, input: '100K_STREAM_PERF' }), sessionId);
    const runId = initial.runs.find(run => run.sessionId === sessionId).id;
    await page.waitForFunction(() => window.__harnessPerformance.terminalPaintProxyEpoch, null, { timeout: 120000 });
    const commandsAfter = await counts();
    const measured = await page.evaluate(() => { const value = window.__harnessPerformance; window.__stopHarnessProbe(); return { ...value, memory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize, jsHeapSizeLimit: performance.memory.jsHeapSizeLimit } : null }; });
    await writeFile(path.join(evidence, 'stream-timings.json'), JSON.stringify(measured, null, 2));
    const state = await page.evaluate(() => window.uah.command({ type: 'snapshot' })); const run = state.runs.find(value => value.id === runId);
    check('100k run terminates completed with exact full output', run.state === 'completed' && run.output === expected);
    check('text activities exactly reconstruct the full output', run.activities.filter(value => value.kind === 'text').map(value => value.content).join('') === expected);
    check('reasoning activities reconstruct the independent 400-character stream', run.activities.filter(value => value.kind === 'reasoning').map(value => value.content).join('') === expectedReasoning);
    const domOutput = await page.locator('.turn').last().locator('.assistant-message').evaluateAll(elements => elements.map(element => element.textContent.trimEnd()).join(''));
    check('visible assistant DOM contains the same 100000 characters', domOutput === run.output);
    await page.getByRole('button', { name: /已思考/ }).first().click();
    await page.getByText(expectedReasoning, { exact: true }).waitFor();
    check('expanded actual reasoning activity displays the stored reasoning text', await page.getByText(expectedReasoning, { exact: true }).count() > 0);
    check('renderer received all 5000 text deltas and 20 reasoning deltas', measured.deltaEvents === 5000 && measured.reasoningEvents === 20);
    const applicationSnapshots = (commandsAfter.snapshot || 0) - (commandsBefore.snapshot || 0);
    check('application snapshot IPC calls are not per token', applicationSnapshots < 50);
    const summary = await page.evaluate(sessionId => window.uah.journal({ action: 'summary', sessionId }), sessionId);
    check('stream durable and exported watermarks converge', summary.health.status === 'healthy' && summary.health.durableSeq === summary.health.exportedSeq && summary.health.durableSeq > 0);
    const db = new DatabaseSync(path.join(data, 'runtime.sqlite'), { readOnly: true });
    const saved = JSON.parse(db.prepare('SELECT data FROM runs WHERE id = ?').get(runId).data);
    check('SQLite terminal run and activity bytes agree with IPC state', saved.state === run.state && saved.output === run.output && JSON.stringify(saved.activities) === JSON.stringify(run.activities));
    const countsDb = { runs: db.prepare('SELECT COUNT(*) AS count FROM runs').get().count, canonicalEvents: db.prepare('SELECT COUNT(*) AS count FROM canonical_events').get().count }; db.close();
    const trial = report.requests.find(value => value.purpose === '100k');
    report.stream = { sampleCount: 1, characters: expected.length, contentFrames: 5000, reasoningFrames: 20, applicationSnapshotIpcCalls: applicationSnapshots,
        ttftRendererEventMs: measured.firstDeltaEpoch - measured.startEpoch, firstDomMs: measured.firstDomEpoch - measured.startEpoch,
        firstPaintProxyMs: measured.firstPaintProxyEpoch - measured.startEpoch, lastFixtureFrameToTerminalDomMs: measured.terminalDomEpoch - trial.lastFrameEpoch,
        lastFixtureFrameToTerminalPaintProxyMs: measured.terminalPaintProxyEpoch - trial.lastFrameEpoch, elapsedToTerminalPaintProxyMs: measured.terminalPaintProxyEpoch - measured.startEpoch,
        rendererFrameIntervals: distribution(measured.frameIntervals), rendererMemory: measured.memory, processMemoryBefore: memoryBefore, processMemoryAfter: await processMemory(),
        diskBytes: await diskStats(data), dbCounts: countsDb, health: summary.health, instrumentation: { commandTypesBefore: commandsBefore, commandTypesAfter: commandsAfter } };
    await screenshot('stream-terminal.png');
    // A second independent run remains open until real transport cancellation closes the fixture response.
    await installProbe(sessionId, 'stop');
    await page.evaluate(sessionId => window.uah.command({ type: 'start-run', sessionId, input: 'STOP_STREAM_PERF' }), sessionId);
    await page.waitForFunction(() => window.__harnessPerformance.firstDomEpoch);
    await page.getByRole('button', { name: '停止当前任务', exact: true }).waitFor();
    const stopStartEpoch = epoch(); await page.getByRole('button', { name: '停止当前任务', exact: true }).click();
    await page.waitForFunction(() => window.__harnessPerformance.terminalPaintProxyEpoch);
    for (let attempts = 0; stopCloseEpoch === null && attempts < 500; attempts++) await delay(10);
    check('stop closes the actual local SSE response', stopCloseEpoch !== null);
    const stopped = await page.evaluate(() => { window.__stopHarnessProbe(); return window.__harnessPerformance; });
    report.stop = { sampleCount: 1, clickStartToTerminalDomMs: stopped.terminalDomEpoch - stopStartEpoch,
        clickStartToTerminalPaintProxyMs: stopped.terminalPaintProxyEpoch - stopStartEpoch, clickStartToFixtureResponseCloseMs: stopCloseEpoch - stopStartEpoch };
    await screenshot('stream-stopped.png'); await app.close(); app = null;
    // Materialize exactly 1000 completed runs once; do not issue provider requests.
    const listData = path.join(evidence, 'list-data');
    const setup = path.join(evidence, 'setup-list.mjs');
    await writeFile(setup, `import { RuntimeStore } from ${JSON.stringify(pathToFileURL(path.join(root, 'src/runtime/store.ts')).href)};\n` +
        `const store = new RuntimeStore(${JSON.stringify(listData)}); const timestamp='2026-10-01T00:00:00Z'; const config={runtimeId:'local-verification',modelId:'fixture',agentId:'local-verification',policyVersion:1};\n` +
        `store.commit({sessions:[{id:'list-session',title:'1000 completed runs',directory:null,requested:config,createdAt:timestamp}],runs:Array.from({length:1000},(_,index)=>({id:'list-run-'+String(index).padStart(4,'0'),sessionId:'list-session',turnId:'turn-'+index,state:'completed',input:'PERF_LIST_INPUT_'+String(index+1).padStart(4,'0'),output:'PERF_LIST_OUTPUT_'+String(index+1).padStart(4,'0'),effective:config,sequence:1,createdAt:timestamp,finishedAt:timestamp,activities:[]}))}); store.assertCanCreateRun(); const capacity=store.historyCapacity(); store.close(); console.log(JSON.stringify({runs:1000,run1001Admitted:true,capacity}));\n`);
    const setupResult = spawnSync(process.execPath, ['--import', 'tsx', setup], { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(setupResult.status, 0, setupResult.stdout + setupResult.stderr); report.listFixture = JSON.parse(setupResult.stdout);
    const listLaunchEpoch = epoch(); await launch(listData);
    await page.locator('.turn').nth(49).waitFor();
    check('1000 run history initially mounts exactly the latest 50 turns', await page.locator('.turn').count() === 50);
    const historyWindow = await page.evaluate(() => window.uah.command({ type: 'snapshot' }, { sessionId: 'list-session', turnLimit: 50 }));
    check('runtime transmits only 50 visible roots plus required identity evidence', historyWindow.historyWindow.total === 1000
        && historyWindow.historyWindow.rootIds.length === 50 && historyWindow.runs.length <= 51
        && !historyWindow.runs.some(run => run.id === 'list-run-0500'));
    check('initial batch preserves global turn labels 951 through 1000', await page.locator('.turn').first().getAttribute('aria-label') === '第 951 轮'
        && await page.locator('.turn').last().getAttribute('aria-label') === '第 1000 轮');
    check('last turn file changes and response actions both display global turn 1000', await page.locator('.turn').last().getByText('第 1000 轮文件改动', { exact: true }).count() === 1
        && await page.locator('.turn').last().getByText(/第 1000 轮 ·/).count() === 1);
    check('default store admits run 1001 after saving all 1000 fixture runs', report.listFixture.run1001Admitted);
    const listReadyMs = epoch() - listLaunchEpoch;
    await page.emulateMedia({ colorScheme: 'light' });
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
    await screenshot('list-1000-light-initial-50.png');
    const loadEarlier = page.getByRole('button', { name: /加载更早的对话/ });
    await loadEarlier.scrollIntoViewIfNeeded();
    const anchorBefore = await page.locator('.turn').first().evaluate(element => ({ label: element.getAttribute('aria-label'), top: element.getBoundingClientRect().top }));
    await loadEarlier.click();
    await page.waitForFunction(() => document.querySelectorAll('.turn').length === 100);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const anchorAfter = await page.getByRole('article', { name: anchorBefore.label, exact: true }).evaluate(element => element.getBoundingClientRect().top);
    const anchorDriftPx = Math.abs(anchorAfter - anchorBefore.top);
    check('loading earlier turns mounts 100 and retains the previous first turn position', anchorDriftPx <= 2 && await page.locator('.turn').count() === 100);
    await screenshot('list-1000-light-loaded-100.png');
    await loadEarlier.scrollIntoViewIfNeeded(); await loadEarlier.focus();
    check('load earlier control receives actual keyboard focus', await loadEarlier.evaluate(element => document.activeElement === element));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.querySelectorAll('.turn').length === 150);
    check('keyboard Enter loads the next 50 turns with global labels intact', await page.locator('.turn').first().getAttribute('aria-label') === '第 851 轮'
        && await page.locator('.turn').last().getAttribute('aria-label') === '第 1000 轮');
    const listSampling = await page.evaluate(async () => {
        const scroll = document.querySelector('.chat-scroll'); const composer = document.querySelector('textarea[aria-label="消息"]');
        const frameIntervals = []; let previous = null; const start = performance.now(); let lastInputTime = null;
        scroll.scrollTop = 0;
        const inputStart = performance.now(); composer.value = 'PERF_LIST_COMPOSER'; composer.dispatchEvent(new Event('input', { bubbles: true }));
        for (let index = 0; index < 180; index++) {
            const timestamp = await new Promise(resolve => requestAnimationFrame(resolve));
            if (previous !== null) frameIntervals.push(timestamp - previous); previous = timestamp;
            if (index === 1) lastInputTime = performance.now();
            if (index < 120) scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) * index / 119;
        }
        scroll.scrollTop = scroll.scrollHeight;
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const last = document.querySelector('.turn:last-child'); const bounds = last.getBoundingClientRect(); const viewport = scroll.getBoundingClientRect();
        return { frameIntervals, elapsedMs: performance.now() - start, inputDispatchToSecondFrameMs: lastInputTime - inputStart,
            scrollTop: scroll.scrollTop, scrollHeight: scroll.scrollHeight, clientHeight: scroll.clientHeight,
            lastTurnVisible: bounds.bottom > viewport.top && bounds.top < viewport.bottom, composerValue: composer.value,
            rendererMemory: performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null };
    });
    check('long list scroll reaches the last completed turn', listSampling.lastTurnVisible && listSampling.scrollTop > 0);
    check('long list composer accepts interaction with 150 of 1000 turns mounted', listSampling.composerValue === 'PERF_LIST_COMPOSER');
    await writeFile(path.join(evidence, 'list-timings.json'), JSON.stringify(listSampling, null, 2));
    report.longList = { sampleCount: 1, runs: 1000, initialMountedTurns: 50, measuredMountedTurns: 150, earlierLoadAnchorDriftPx: anchorDriftPx,
        sessionHistoryStillFull: false, historyPanelLoadsFullSessionOnAccess: true, runtimeTerminalCacheLimit: 128, rendererScope: 'selected_session_window', launchToReadyMs: listReadyMs, interactionInputDispatchToSecondFrameMs: listSampling.inputDispatchToSecondFrameMs,
        rendererFrameIntervals: distribution(listSampling.frameIntervals), samplingElapsedMs: listSampling.elapsedMs,
        scroll: { top: listSampling.scrollTop, height: listSampling.scrollHeight, clientHeight: listSampling.clientHeight, lastTurnVisible: listSampling.lastTurnVisible },
        rendererMemory: listSampling.rendererMemory, processMemory: await processMemory(), diskBytes: await diskStats(listData), commandTypes: await counts() };
    await screenshot('list-1000-light-end.png');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('radio', { name: '深色', exact: true }).click();
    await page.getByRole('button', { name: '保存设置', exact: true }).click();
    await page.locator('.session-button').filter({ hasText: '1000 completed runs' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
    await screenshot('list-1000-dark-end.png');
    // Let route/theme scrolling settle, then use real scroll input to disable follow-bottom.
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.locator('.chat-scroll').hover(); await page.mouse.wheel(0, -100000);
    await page.waitForFunction(() => {
        const button = [...document.querySelectorAll('button')].find(element => element.textContent.includes('加载更早的对话'));
        const scroll = document.querySelector('.chat-scroll');
        if (!button || !scroll) return false;
        const bounds = button.getBoundingClientRect(); const viewport = scroll.getBoundingClientRect();
        return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    });
    check('dark earlier-load button is actually within the visible scroll viewport', await loadEarlier.evaluate(element => {
        const bounds = element.getBoundingClientRect(); const viewport = document.querySelector('.chat-scroll').getBoundingClientRect();
        return bounds.top >= viewport.top && bounds.bottom <= viewport.bottom;
    }));
    await screenshot('list-1000-dark-earlier-control.png');
    check('no renderer or fixture errors occurred', report.errors.length === 0);
    report.passed = true; console.log(`PASS desktop harness performance: ${evidence}`);
} catch (error) {
    report.failure = String(error);
    if (page) { try { report.failureProbe = await page.evaluate(() => ({ probe: window.__harnessPerformance,
        status: document.querySelector('.turn:last-child .status')?.dataset.state,
        domContentLengths: [...document.querySelectorAll('.turn:last-child .assistant-message')].map(element => element.textContent.length) })); } catch {} }
    if (app) { try { await screenshot('failure.png'); } catch {} }
    console.error(`Performance evidence: ${evidence}`); throw error;
} finally {
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
    if (app) await app.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
