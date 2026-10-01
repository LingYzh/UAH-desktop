import assert from 'node:assert/strict';
import { _electron as electron } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd(); await mkdir(path.join(root, 'artifacts'), { recursive: true });
const evidence = await mkdtemp(path.join(root, 'artifacts', 'browser-purge-')); const runner = path.join(evidence, 'main.cjs');
const checks = []; const check = name => { checks.push(name); console.log(`PASS ${name}`); }; const errors = [];
const server = createServer((request, response) => { response.writeHead(200, { 'cache-control': 'public,max-age=86400', 'content-type': 'text/plain' }); response.end('CACHE FIXTURE '.repeat(32768)); });
await new Promise(done => server.listen(0, '127.0.0.1', done));
await build({ stdin: { contents: `import { app, BrowserWindow, session } from 'electron';
import { BrowserHost } from ${JSON.stringify(path.join(root, 'src/main/browser-host.ts'))};
app.setPath('userData', ${JSON.stringify(path.join(evidence, 'data'))});
globalThis.fixtureStartup=app.whenReady().then(async () => {
const window = new BrowserWindow({show:false,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
await window.loadURL('data:text/html,<title>Isolated BrowserHost test</title>');
globalThis.fixtureWindow=window;globalThis.fixtureHost=new BrowserHost(window);
globalThis.fixtureProfiles={};
globalThis.heldStartedPromise=new Promise(done=>globalThis.heldStartedDone=done);
for(const id of ['source','other','loading','failure']) {
 const profile=session.fromPartition('persist:uah-browser-'+id);globalThis.fixtureProfiles[id]=profile;
 profile.protocol.handle('https',async request=>{
  if(new URL(request.url).pathname==='/held') { globalThis.heldStartedDone();await new Promise(done=>globalThis.releaseHeld=done); }
  return new Response('<html><title>Local partition fixture</title><body>local</body></html>',{headers:{'content-type':'text/html'}});
 });
}
globalThis.fixtureReady=true;
});`, resolveDir: root, loader: 'ts' }, outfile: runner, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] });
const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE; delete env.UAH_DEV_URL; delete env.UAH_DATA_DIR;
let app;
try {
    app = await electron.launch({ args: [runner], cwd: root, env }); const page = await app.firstWindow(); page.on('pageerror', error => errors.push(error.message));
    await app.evaluate(async () => { await globalThis.fixtureStartup; if (!globalThis.fixtureReady) throw new Error('Fixture startup incomplete'); });
    const before = await app.evaluate(async ({}, cacheUrl) => {
        const host = globalThis.fixtureHost;
        for (const id of ['source', 'other']) {
            const profile = globalThis.fixtureProfiles[id];
            await profile.cookies.set({ url: 'https://fixture.invalid', name: 'session_evidence', value: id, expirationDate: Date.now() / 1000 + 86400 });
            await profile.fetch(cacheUrl + '/' + id).then(response => response.arrayBuffer());
            await host.execute({ type: 'open', sessionId: id, url: 'https://fixture.invalid/' });
            const contents = host.views.get(id).webContents;
            await contents.executeJavaScript(`localStorage.setItem('evidence',${JSON.stringify(id)});window.onbeforeunload=()=>false;true;`);
        }
        return { sourceCache: await globalThis.fixtureProfiles.source.getCacheSize(), otherCache: await globalThis.fixtureProfiles.other.getCacheSize(), sourceId: host.views.get('source').webContents.id, otherId: host.views.get('other').webContents.id };
    }, `http://127.0.0.1:${server.address().port}`);
    assert.ok(before.sourceCache > 0); assert.ok(before.otherCache > 0); check('two real persistent profiles have distinct cookies, localStorage and populated HTTP caches');
    const purged = await app.evaluate(async ({ webContents }) => {
        const host = globalThis.fixtureHost; const source = host.views.get('source').webContents; let destroyed = false;
        const profile = globalThis.fixtureProfiles.source; const completedMethods = []; const originals = {};
        for (const name of ['closeAllConnections', 'clearStorageData', 'clearAuthCache', 'clearCache']) {
            const original = profile[name]; originals[name] = original;
            profile[name] = async function (...args) { const result = await original.apply(this, args); completedMethods.push(name); return result; };
        }
        source.once('destroyed', () => { destroyed = true; });
        try { await Promise.all([host.purgeSession('source'), host.purgeSession('source')]); }
        finally { for (const [name, original] of Object.entries(originals)) profile[name] = original; }
        return { destroyed, completedMethods, removed: !host.views.has('source'), sourceCookies: await globalThis.fixtureProfiles.source.cookies.get({}), sourceCache: await globalThis.fixtureProfiles.source.getCacheSize(), otherCookies: await globalThis.fixtureProfiles.other.cookies.get({}), otherCache: await globalThis.fixtureProfiles.other.getCacheSize(), otherText: await host.views.get('other').webContents.executeJavaScript("localStorage.getItem('evidence')"), current: host.current };
    });
    assert.equal(purged.destroyed, true); assert.equal(purged.removed, true); assert.deepEqual(purged.sourceCookies, []); assert.equal(purged.sourceCache, 0);
    assert.deepEqual(purged.completedMethods, ['closeAllConnections', 'clearStorageData', 'clearAuthCache', 'clearCache', 'closeAllConnections']);
    check('concurrent purge coalesces and awaits native storage/auth/cache/network clearing operations');
    assert.equal(purged.otherCookies[0].value, 'other'); assert.ok(purged.otherCache > 0); assert.equal(purged.otherText, 'other'); assert.equal(purged.current, 'other');
    check('purge awaits real destruction despite beforeunload and clears only the selected profile cache/cookies');
    const storage = await app.evaluate(async ({ WebContentsView }) => {
        const probe = new WebContentsView({ webPreferences: { session: globalThis.fixtureProfiles.source, sandbox: true, contextIsolation: true, nodeIntegration: false } });
        try { await probe.webContents.loadURL('https://fixture.invalid/'); return await probe.webContents.executeJavaScript("localStorage.getItem('evidence')"); }
        finally { if (!probe.webContents.isDestroyed()) probe.webContents.close({ waitForBeforeUnload: false }); }
    }); assert.equal(storage, null); check('cleared localStorage stays absent when the same persisted partition is reopened for inspection');
    const blocked = await app.evaluate(async () => {
        const host = globalThis.fixtureHost; const messages = [];
        for (const action of [{ type: 'open', sessionId: 'source', url: 'https://fixture.invalid/' }, { type: 'bounds', sessionId: 'source', x: 0, y: 0, width: 100, height: 100 }]) {
            try { await host.execute(action); messages.push('allowed'); } catch (error) { messages.push(String(error)); }
        }
        await host.purgeSession('source');
        try { await host.purgeSession('../bad'); messages.push('allowed'); } catch (error) { messages.push(String(error)); }
        return messages;
    }); assert.ok(blocked.slice(0, 2).every(value => /已清除/.test(value))); assert.match(blocked[2], /标识无效/); check('purged identity rejects new open/bounds, repeated purge is safe and invalid identity is refused');
    await app.evaluate(() => { globalThis.pendingLoad = globalThis.fixtureHost.execute({ type: 'open', sessionId: 'loading', url: 'https://fixture.invalid/held' }).then(value => ({ value }), error => ({ error: String(error) })); });
    // Wait on a real handler signal, never assume a timer means navigation began.
    await app.evaluate(async () => { await globalThis.heldStartedPromise; });
    const loading = await app.evaluate(async () => {
        const host = globalThis.fixtureHost; await host.purgeSession('loading'); globalThis.releaseHeld(); const result = await globalThis.pendingLoad;
        return { result, noView: !host.views.has('loading'), current: host.current };
    }); assert.match(loading.result.error, /已清除/); assert.equal(loading.noView, true); assert.equal(loading.current, null); check('purge during pending load cannot resurrect a view or access destroyed webContents');
    const retry = await app.evaluate(async () => {
        const host = globalThis.fixtureHost; const profile = globalThis.fixtureProfiles.failure; const original = profile.clearCache;
        profile.clearCache = async () => { throw new Error('fixed local clear failure'); };
        let failure; let blocked;
        try { await host.purgeSession('failure'); } catch (error) { failure = String(error); }
        try { await host.execute({ type: 'open', sessionId: 'failure', url: 'https://fixture.invalid/' }); } catch (error) { blocked = String(error); }
        profile.clearCache = original; await host.purgeSession('failure'); return { failure, blocked, cleared: await profile.getCacheSize() };
    }); assert.match(retry.failure, /fixed local clear failure/); assert.match(retry.blocked, /已清除/); assert.equal(retry.cleared, 0); check('cleanup failure keeps identity blocked and explicit retry completes');
    assert.deepEqual(errors, []); await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: true, checks, before, purged, storage, blocked, loading, retry, errors }, null, 2)); console.log(`PASS browser purge: ${evidence}`);
} catch (error) { await writeFile(path.join(evidence, 'report.json'), JSON.stringify({ passed: false, error: String(error), checks, errors }, null, 2)); throw error; }
finally { if (app) await app.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); }
