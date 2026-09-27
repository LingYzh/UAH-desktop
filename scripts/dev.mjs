import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import electron from 'electron';
import { createServer } from 'vite';
import { buildDesktop } from './build.mjs';

export async function startDesktopServer(port = 5175) {
    const server = await createServer({
        cacheDir: '../../node_modules/.vite-electron',
        server: { host: '127.0.0.1', port, strictPort: false },
    });
    try {
        await server.listen();
        const address = server.httpServer.address();
        if (!address || typeof address === 'string') throw new Error('Desktop preview did not acquire a TCP port.');
        return { server, url: `http://127.0.0.1:${address.port}/` };
    } catch (error) {
        await server.close();
        throw error;
    }
}

async function main() {
    await buildDesktop();
    const { server, url } = await startDesktopServer();
    const environment = { ...process.env, UAH_DEV_URL: url };
    delete environment.ELECTRON_RUN_AS_NODE;
    console.log(`[UAH] Desktop renderer: ${url}`);
    const desktop = spawn(electron, ['.'], { stdio: 'inherit', env: environment });
    desktop.once('spawn', () => console.log(`[UAH] Electron PID: ${desktop.pid}`));
    desktop.once('exit', async (code) => {
        await server.close();
        process.exitCode = code ?? 1;
    });
    desktop.once('error', async (error) => {
        console.error(error.message);
        await server.close();
        process.exitCode = 1;
    });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
