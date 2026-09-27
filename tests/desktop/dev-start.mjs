import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { _electron as electron } from 'playwright';
import { startDesktopServer } from '../../scripts/dev.mjs';
import { buildDesktop } from '../../scripts/build.mjs';

await mkdir('artifacts', { recursive: true });
const evidence = await mkdtemp(path.resolve('artifacts', 'dev-start-'));
const occupied = createServer((_request, response) => response.end('existing preview stays alive'));
await new Promise((resolve) => occupied.listen(0, '127.0.0.1', resolve));
const port = occupied.address().port;
let server;
let desktop;
try {
    await buildDesktop();
    const started = await startDesktopServer(port);
    server = started.server;
    assert.notEqual(new URL(started.url).port, String(port));
    assert.match(await (await fetch(started.url)).text(), /UAH/);
    const env = { ...process.env, UAH_DEV_URL: started.url, UAH_DATA_DIR: path.join(evidence, 'data') };
    delete env.ELECTRON_RUN_AS_NODE;
    desktop = await electron.launch({ args: ['.'], cwd: process.cwd(), env });
    const page = await desktop.firstWindow();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.getByRole('textbox', { name: '消息', exact: true }).waitFor();
    const result = await page.evaluate(async () => {
        const endpoints = await window.uah.endpoints({ type: 'list' });
        const created = await window.uah.command({ type: 'create-session', title: 'Development startup test', directory: null });
        await window.uah.command({ type: 'start-run', sessionId: created.sessions.at(-1).id, input: 'Verify development IPC' });
        return { endpointCount: endpoints.endpoints.length, node: typeof window.require };
    });
    assert.deepEqual(result, { endpointCount: 0, node: 'undefined' });
    await page.waitForFunction(async () => (await window.uah.command({ type: 'snapshot' })).runs.some((run) => run.state === 'completed'));
    assert.deepEqual(errors, []);
    await desktop.close();
    desktop = null;
    await server.close();
    server = null;
    assert.equal(await (await fetch(`http://127.0.0.1:${port}/`)).text(), 'existing preview stays alive');
    await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: ['occupied port is skipped', 'Electron loads actual bound URL with isolated renderer', 'endpoint and runtime IPC work', 'closing owned server preserves existing listener'], errors }, null, 4));
    console.log(`PASS development startup and port conflict integration. Evidence: ${evidence}`);
} finally {
    await desktop?.close();
    await server?.close();
    await new Promise((resolve) => occupied.close(resolve));
}
