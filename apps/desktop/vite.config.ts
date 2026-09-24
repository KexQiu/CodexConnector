import { defineConfig } from 'vite';
export default defineConfig({
  base: './',
  build: { outDir: 'dist/ui', emptyOutDir: true },
  server: { host: '127.0.0.1' },
});
