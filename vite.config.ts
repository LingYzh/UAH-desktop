import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';

export default defineConfig({
    root: 'src/renderer',
    base: './',
    plugins: [vue()],
    resolve: { dedupe: ['vue'] },

    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    build: { outDir: '../../dist/renderer', emptyOutDir: true }
});
