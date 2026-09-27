import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(value => value !== '--list' && !/^--(models|workflow|plan-review)=.+$/.test(value))
    || (!args.includes('--list') && !args.some(value => value.startsWith('--models=') || value.startsWith('--plan-review=')))) {
    console.error('Usage: node scripts/test-kiro-prompts.mjs --list | --models=id1,id2 [--workflow=id1] | --plan-review=modelID');
    process.exitCode = 1;
} else {
    const root = join(workspace, 'artifacts', `kiro-prompts-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    mkdirSync(root, { recursive: true });
    const helper = join(root, 'helper.cjs');
    await build({ entryPoints: [join(workspace, 'tests/manual/kiro-prompts.ts')], outfile: helper, bundle: true, platform: 'node', target: 'node24', format: 'cjs', external: ['electron'], sourcemap: false });
    const require = createRequire(import.meta.url);
    const electron = resolve(require('electron'));
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    // This helper creates no BrowserWindow and runs no console-dependent .NET program.
    const child = spawn(electron, [helper, ...args, `--artifacts=${root}`], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    child.stdout.on('data', chunk => process.stdout.write(chunk));
    // Electron/provider stderr can contain arbitrary content; expose only a fixed status.
    let hadStderr = false;
    const stderrCodes = new Set();
    child.stderr.on('data', chunk => {
        hadStderr = true;
        const source = chunk.toString('utf8');
        for (const code of ['kiro_harness_failed', 'ERR_UNKNOWN_BUILTIN_MODULE', 'MODULE_NOT_FOUND', 'SyntaxError', 'TypeError', 'ERR_SQLITE_ERROR', 'ExperimentalWarning']) {
            if (source.includes(code)) stderrCodes.add(code);
        }
    });
    child.once('error', () => { console.error('kiro_helper_spawn_failed'); process.exitCode = 1; });
    child.once('exit', code => {
        if (hadStderr) console.error(JSON.stringify({ stderr: 'kiro_helper_stderr_present', codes: [...stderrCodes] }));
        console.log(JSON.stringify({ exitCode: code, artifacts: root }));
        process.exitCode = code ?? 1;
    });
}
