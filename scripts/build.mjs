import { build as bundle } from 'esbuild';
import { build as buildRenderer } from 'vite';

export async function buildDesktop() {
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
}

if (process.argv[1]?.endsWith('build.mjs')) {
    await buildDesktop();
    await buildRenderer();
}
