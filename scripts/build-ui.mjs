import { build } from 'vite';
import path from 'node:path';

// Separate output keeps documentation out of the desktop application's trusted renderer.
await build({
    build: {
        outDir: path.resolve('dist/ui-docs'),
        emptyOutDir: true,
        rollupOptions: { input: path.resolve('src/renderer/ui.html') }
    }
});
