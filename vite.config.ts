import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { existsSync, readFileSync, realpathSync } from 'node:fs';

export default defineConfig({
    root: 'src/renderer',
    base: './',
    plugins: [vue({
        // TypeScript 7 no longer supplies ts.sys; Vue needs file access for SFC imported prop types.
        script: {
            fs: {
                fileExists: existsSync,
                readFile: file => readFileSync(file, 'utf8'),
                realpath: realpathSync
            }
        }
    })],
    resolve: { dedupe: ['vue'] },

    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { outDir: '../../dist/renderer', emptyOutDir: true }
});
