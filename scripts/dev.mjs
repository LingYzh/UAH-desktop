import { spawn } from 'node:child_process';
import electron from 'electron';
import { createServer } from 'vite';
import { buildDesktop } from './build.mjs';

await buildDesktop();
const server = await createServer();
await server.listen();
const environment = { ...process.env, UAH_DEV_URL: 'http://127.0.0.1:5173' };
delete environment.ELECTRON_RUN_AS_NODE;
const desktop = spawn(electron, ['.'], { stdio: 'inherit', env: environment });
desktop.once('exit', async (code) => {
    await server.close();
    process.exitCode = code ?? 1;
});
desktop.once('error', async (error) => {
    console.error(error.message);
    await server.close();
    process.exitCode = 1;
});
