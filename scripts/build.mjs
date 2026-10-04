import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';
import { spawn } from 'node:child_process';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function buildExecutionHelper() {
    if (process.platform !== 'win32') return;
    await new Promise((resolve, reject) => {
        const child = spawn('dotnet', ['build', path.join(repositoryRoot, 'native/UAH.ExecutionHelper/UAH.ExecutionHelper.csproj'), '-c', 'Release', '--nologo'], {
            cwd: repositoryRoot, stdio: 'inherit', windowsHide: true,
        });
        child.once('error', () => reject(new Error('Windows ExecutionHelper build could not start; .NET 10 SDK is required.')));
        child.once('close', code => code === 0 ? resolve() : reject(new Error(`Windows ExecutionHelper build failed (exit ${code ?? 'unconfirmed'}).`)));
    });
}

export async function buildDesktop() {
    await buildExecutionHelper();
    await bundle({
        entryPoints: { 'main/index': 'src/main/index.ts', 'preload/index': 'src/preload/index.ts', 'runtime/worker': 'src/main/runtime-worker.ts' },
        outdir: 'dist',
        bundle: true,
        platform: 'node',
        target: 'node24',
        format: 'cjs',
        outExtension: { '.js': '.cjs' },
        external: ['electron'],
        sourcemap: true
    });
    cpSync(
        path.join(repositoryRoot, 'resources/builtin-skills'),
        path.join(repositoryRoot, 'dist/builtin-skills'),
        { recursive: true, force: true },
    );
}

if (process.argv[1]?.endsWith('build.mjs')) {
    await buildDesktop();
    await buildRenderer();
}
