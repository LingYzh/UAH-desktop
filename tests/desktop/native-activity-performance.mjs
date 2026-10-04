import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root = process.cwd();
const targetJsonBytes = 30 * 1024;
await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'native-activity-performance-'));
const dataDirectory = path.join(evidence, 'data');
const project = path.join(evidence, 'project');
const fixtureRecord = path.join(evidence, 'native-app-server.jsonl');
const scenarioPath = path.join(evidence, 'scenario.json');
const wrapperPath = path.join(evidence, 'fixture-wrapper.mjs');
const fixturePath = path.join(root, 'tests', 'fixtures', 'codex-app-server-fixture.mjs');
await mkdir(project);

const scenario = {
    recordFile: fixtureRecord,
    textChunks: ['Fixture response for the native activity performance run.'],
    nativeActivityEvents: {
        inputMatch: 'NATIVE_PERF_',
        reasoning: { summary: ['Fixture reasoning summary.'] },
        command: {
            command: 'fixture-only command',
            cwd: project,
            outputDeltas: ['Fixture command output.'],
            aggregatedOutput: 'Fixture command output.',
            exitCode: 0,
        },
        mcpToolCall: {
            server: 'performance-fixture',
            tool: 'fixture_payload',
            arguments: { source: 'isolated performance fixture' },
            resultText: 'Fixture MCP result.',
        },
    },
};

const wrapper = `
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const scenarioFile = process.argv[2];
const fixtureFile = process.argv[3];
const scenario = JSON.parse(await readFile(scenarioFile, 'utf8'));
const targetBytes = ${targetJsonBytes};
const prefix = '{"fixture":"isolated native activity performance payload","payload":"';
const suffix = '"}';
const jsonResult = prefix + 'x'.repeat(targetBytes - Buffer.byteLength(prefix + suffix)) + suffix;
if (Buffer.byteLength(jsonResult) !== targetBytes) throw new Error('Fixture JSON payload size mismatch');
const activity = scenario.nativeActivityEvents;
activity.reasoning.summary = ['Fixture reasoning summary. '.repeat(44)];
activity.command.outputDeltas = [
    'Fixture command output line. '.repeat(36),
    'Second bounded command output line. '.repeat(36),
];
activity.command.aggregatedOutput = activity.command.outputDeltas.join('');
activity.mcpToolCall.resultText = jsonResult;
process.argv[2] = JSON.stringify(scenario);
await import(pathToFileURL(fixtureFile).href);
`;
await writeFile(scenarioPath, JSON.stringify(scenario), 'utf8');
await writeFile(wrapperPath, wrapper, 'utf8');

async function fingerprintDirectory(directory) {
    const hash = createHash('sha256');
    let bytes = 0;
    async function visit(current) {
        const entries = await readdir(current, { withFileTypes: true });
        entries.sort((left, right) => left.name.localeCompare(right.name));
        for (const entry of entries) {
            const fullPath = path.join(current, entry.name);
            if (entry.isDirectory()) await visit(fullPath);
            else if (entry.isFile()) {
                const content = await readFile(fullPath);
                bytes += content.byteLength;
                hash.update(path.relative(directory, fullPath));
                hash.update('\0');
                hash.update(content);
            }
        }
    }
    await visit(directory);
    return { sha256: hash.digest('hex'), filesBytes: bytes };
}

async function metrics(cdp) {
    const result = await cdp.send('Performance.getMetrics');
    return Object.fromEntries(result.metrics.map(({ name, value }) => [name, value]));
}

function summarizeFrames(frames) {
    const intervals = frames.slice(1).map((time, index) => time - frames[index]).sort((a, b) => a - b);
    const percentile = fraction => intervals.length ? intervals[Math.min(intervals.length - 1, Math.floor((intervals.length - 1) * fraction))] : null;
    return {
        samples: intervals.length,
        medianMs: percentile(0.5),
        p95Ms: percentile(0.95),
        p99Ms: percentile(0.99),
        maxMs: intervals.length ? intervals.at(-1) : null,
        over16_7Ms: intervals.filter(value => value > 16.7).length,
        over50Ms: intervals.filter(value => value > 50).length,
    };
}

const errors = [];
const externalRequests = [];
const measurements = [];
const screenshots = [];
let app;
let cdp;
let page;
let report;

try {
    const distFingerprint = await fingerprintDirectory(path.join(root, 'dist'));
    const env = { ...process.env, UAH_DATA_DIR: dataDirectory };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.UAH_DEV_URL;
    app = await electron.launch({ args: ['.'], cwd: root, env });
    page = await app.firstWindow();
    page.setDefaultTimeout(20_000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (/^https?:\/\//i.test(request.url())) externalRequests.push(request.url());
    });
    await page.waitForFunction(() => Boolean(window.uah?.nativeCodex && window.uah?.command));
    await app.evaluate(({ dialog }, directory) => {
        dialog.showOpenDialog = async (...args) => {
            const options = args.at(-1) || {};
            return options.properties?.includes('openDirectory')
                ? { canceled: false, filePaths: [directory] }
                : { canceled: true, filePaths: [] };
        };
    }, project);
    await page.evaluate(async ({ command, args }) => {
        await window.uah.nativeCodex({ type: 'save', settings: {
            enabled: true,
            command,
            args,
            model: 'gpt-fixture',
            revision: 0,
        } });
        const directory = await window.uah.chooseDirectory();
        await window.uah.command({
            type: 'create-session',
            title: 'Native activity performance fixture',
            directory,
            selection: { endpointId: 'native:codex', modelId: 'gpt-fixture' },
            agentId: 'default',
            controls: { permissionMode: 'manual', reasoningEffort: 'high' },
        });
    }, { command: process.execPath, args: [wrapperPath, scenarioPath, fixturePath] });

    await page.reload();
    await page.getByRole('button', { name: /Native activity performance fixture/ }).click();
    const composer = page.getByRole('textbox', { name: '消息', exact: true });
    await composer.waitFor();
    await app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].setContentSize(1440, 1000);
    });
    await page.waitForFunction(() => innerWidth === 1440 && innerHeight === 1000);

    async function snapshot() {
        return page.evaluate(() => window.uah.command({ type: 'snapshot' }));
    }

    async function waitForRun(input) {
        const deadline = Date.now() + 30_000;
        let state;
        let run;
        while (Date.now() < deadline) {
            state = await snapshot();
            run = state.runs.find(item => item.input === input);
            if (run && ['completed', 'failed', 'stopped', 'cancelled'].includes(run.state)) break;
            await page.waitForTimeout(40);
        }
        assert.ok(run, `Fixture run ${input} is saved.`);
        assert.equal(run.state, 'completed', run.error || `Fixture run ended in ${run.state}.`);
        return { state, run };
    }

    for (let index = 1; index <= 15; index += 1) {
        const input = `NATIVE_PERF_TURN_${String(index).padStart(2, '0')}`;
        await composer.fill(input);
        await page.getByRole('button', { name: '发送消息', exact: true }).click();
        await waitForRun(input);
    }

    const state = await snapshot();
    assert.equal(state.runs.filter(run => run.input.startsWith('NATIVE_PERF_TURN_')).length, 15);
    const fixtureEvents = (await readFile(fixtureRecord, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const turnRequests = fixtureEvents.filter(event => event.direction === 'client' && event.method === 'turn/start');
    assert.equal(turnRequests.length, 15, 'all 15 requests reached only the local app-server fixture');
    const activityStats = state.runs.filter(run => run.input.startsWith('NATIVE_PERF_TURN_')).reduce((result, run) => {
        for (const activity of run.activities || []) {
            result.total += 1;
            result[activity.kind] = (result[activity.kind] || 0) + 1;
            result.textBytes += Buffer.byteLength(JSON.stringify(activity), 'utf8');
        }
        return result;
    }, { total: 0, textBytes: 0 });

    await page.evaluate(() => {
        const scroll = document.querySelector('.chat-scroll');
        if (!scroll) throw new Error('Chat scroll container is missing');
        const counters = { scrollHeightReads: 0, scrollTopReads: 0, scrollTopWrites: 0 };
        for (const [property, counter, writable] of [
            ['scrollHeight', 'scrollHeightReads', false],
            ['scrollTop', 'scrollTopReads', true],
        ]) {
            let prototype = scroll;
            let descriptor;
            while (prototype && !descriptor) {
                descriptor = Object.getOwnPropertyDescriptor(prototype, property);
                prototype = Object.getPrototypeOf(prototype);
            }
            if (!descriptor?.get) continue;
            Object.defineProperty(scroll, property, {
                configurable: true,
                get() {
                    counters[counter] += 1;
                    return descriptor.get.call(this);
                },
                ...(writable && descriptor.set ? { set(value) {
                    counters.scrollTopWrites += 1;
                    return descriptor.set.call(this, value);
                } } : {}),
            });
        }
        window.__nativeActivityPerf = {
            counters,
            start() {
                this.frames = [];
                this.longTasks = [];
                this.active = true;
                this.observer = null;
                if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) {
                    this.observer = new PerformanceObserver(entries => {
                        for (const entry of entries.getEntries()) this.longTasks.push({ startTime: entry.startTime, duration: entry.duration });
                    });
                    this.observer.observe({ type: 'longtask', buffered: false });
                }
                const tick = time => {
                    if (!this.active) return;
                    this.frames.push(time);
                    this.frame = requestAnimationFrame(tick);
                };
                this.frame = requestAnimationFrame(tick);
                return { ...this.counters };
            },
            stop() {
                this.active = false;
                cancelAnimationFrame(this.frame);
                this.observer?.disconnect();
                return { frames: this.frames, longTasks: this.longTasks, counters: { ...this.counters } };
            },
        };
    });

    cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const targetRunId = state.runs.filter(run => run.input.startsWith('NATIVE_PERF_TURN_')).at(-1).id;
    const targetRun = page.locator(`.turn[data-run-id="${targetRunId}"]`);
    await page.evaluate(() => {
        const scroll = document.querySelector('.chat-scroll');
        scroll.scrollTop = scroll.scrollHeight;
    });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

    async function waitForLayoutSettle() {
        await page.evaluate(async () => {
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
            await Promise.race([
                Promise.all(document.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))),
                new Promise(resolve => setTimeout(resolve, 2500)),
            ]);
            await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        });
    }

    async function measure(name, action) {
        const beforeMetrics = await metrics(cdp);
        const beforeProbe = await page.evaluate(() => window.__nativeActivityPerf.start());
        const startedAt = performance.now();
        await action();
        await waitForLayoutSettle();
        const elapsedMs = performance.now() - startedAt;
        const probe = await page.evaluate(() => window.__nativeActivityPerf.stop());
        const afterMetrics = await metrics(cdp);
        const keys = ['LayoutDuration', 'ScriptDuration', 'RecalcStyleDuration', 'TaskDuration', 'Nodes'];
        measurements.push({
            name,
            elapsedMs,
            frames: summarizeFrames(probe.frames),
            longTasks: probe.longTasks,
            scrollAccesses: Object.fromEntries(Object.keys(probe.counters).map(key => [key, probe.counters[key] - beforeProbe[key]])),
            cdp: Object.fromEntries(keys.filter(key => beforeMetrics[key] !== undefined && afterMetrics[key] !== undefined)
                .map(key => [key, { before: beforeMetrics[key], after: afterMetrics[key], delta: afterMetrics[key] - beforeMetrics[key] }])),
        });
    }

    async function setExpanded(locator, expanded) {
        const button = locator.first();
        const current = await button.getAttribute('aria-expanded');
        if ((current === 'true') !== expanded) {
            await button.click();
            await waitForLayoutSettle();
        }
    }

    const reasoning = targetRun.getByRole('button', { name: /已思考|思考过程/ });
    const tools = targetRun.getByRole('button', { name: /使用了\s*2\s*个工具/ });
    await reasoning.waitFor({ state: 'visible' });
    await tools.waitFor({ state: 'visible' });
    await setExpanded(reasoning, false);
    await setExpanded(tools, false);
    const dimensions = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    assert.deepEqual([dimensions.width, dimensions.height], [1440, 1000]);

    async function domStats() {
        return page.evaluate(() => {
            const disclosures = [...document.querySelectorAll('.messages button[aria-expanded]')];
            return {
                documentNodes: document.querySelectorAll('*').length,
                renderedTurns: document.querySelectorAll('.messages article.turn').length,
                disclosureButtons: disclosures.length,
                expandedDisclosures: disclosures.filter(button => button.getAttribute('aria-expanded') === 'true').length,
                collapsedDisclosures: disclosures.filter(button => button.getAttribute('aria-expanded') === 'false').length,
                chatScrollHeight: document.querySelector('.chat-scroll')?.scrollHeight ?? null,
                chatClientHeight: document.querySelector('.chat-scroll')?.clientHeight ?? null,
                panelOpen: document.querySelector('.workspace-header button[aria-expanded]')?.getAttribute('aria-expanded') === 'true',
            };
        });
    }

    const domBefore = await domStats();
    await measure('closed_panel_reasoning_expand', () => reasoning.first().click());
    await setExpanded(reasoning, false);
    await measure('closed_panel_tool_group_expand', () => tools.first().click());
    const closedPanelScreenshot = path.join(evidence, 'panel-closed-tool-group-expanded.png');
    await page.screenshot({ path: closedPanelScreenshot });
    screenshots.push(closedPanelScreenshot);
    await setExpanded(tools, false);
    await measure('workspace_panel_open', () => page.getByRole('button', { name: '工作面板', exact: true }).click());
    assert.equal(await page.locator('aside[aria-label="会话工作面板"]').isVisible(), true);
    await measure('open_panel_reasoning_expand', () => reasoning.first().click());
    await setExpanded(reasoning, false);
    await measure('open_panel_tool_group_expand', () => tools.first().click());
    const openPanelScreenshot = path.join(evidence, 'panel-open-tool-group-expanded.png');
    await page.screenshot({ path: openPanelScreenshot });
    screenshots.push(openPanelScreenshot);
    await setExpanded(tools, false);
    await measure('workspace_panel_close', () => page.getByRole('button', { name: '收起面板', exact: true }).click());
    assert.equal(await page.locator('aside[aria-label="会话工作面板"]').isVisible(), false);
    const domAfter = await domStats();

    const bigJsonBytes = Buffer.byteLength(JSON.stringify({ fixture: 'isolated native activity performance payload', payload: 'x'.repeat(targetJsonBytes) }), 'utf8');
    assert.ok(bigJsonBytes >= targetJsonBytes && bigJsonBytes < targetJsonBytes + 100);
    assert.equal(externalRequests.length, 0, 'the performance run does not call external services');
    assert.deepEqual(errors, [], 'the renderer should not emit page errors');

    report = {
        generatedAt: new Date().toISOString(),
        purpose: 'Measure the currently built dist; compare baseline and post-change runs by dist fingerprint and operation names.',
        environment: {
            platform: `${os.platform()} ${os.release()} ${os.arch()}`,
            cpu: os.cpus()[0]?.model,
            logicalCpus: os.cpus().length,
            node: process.version,
            viewport: dimensions,
            distFingerprint,
        },
        fixture: {
            turns: turnRequests.length,
            reasoningItems: activityStats.reasoning || 0,
            toolItems: activityStats.tool || 0,
            totalActivityItems: activityStats.total,
            serializedActivityBytes: activityStats.textBytes,
            mcpJsonResultBytesPerTurn: targetJsonBytes,
            cumulativeMcpJsonBytesAcrossTurns: targetJsonBytes * turnRequests.length,
            externalRequests: externalRequests.length,
        },
        domBeforeMeasurements: domBefore,
        domAfterMeasurements: domAfter,
        measurements,
        screenshots,
        pageErrors: errors,
    };
    await writeFile(path.join(evidence, 'native-activity-performance.json'), JSON.stringify(report, null, 4), 'utf8');
    console.log(JSON.stringify({ evidence, report: path.join(evidence, 'native-activity-performance.json'), screenshots, measurements: measurements.map(item => ({ name: item.name, elapsedMs: item.elapsedMs, frames: item.frames, layoutSeconds: item.cdp.LayoutDuration?.delta, scriptSeconds: item.cdp.ScriptDuration?.delta, scrollAccesses: item.scrollAccesses })) }, null, 2));
} catch (error) {
    await writeFile(path.join(evidence, 'failure.txt'), `${error.stack || error}\n${page ? await page.locator('body').innerText().catch(() => '') : ''}`, 'utf8');
    console.error('Evidence:', evidence);
    throw error;
} finally {
    await cdp?.detach().catch(() => {});
    await app?.close();
}
