import { defineConfig } from 'vite';
import metadata from './package.json' with { type: 'json' };
export default defineConfig({
  clearScreen: false,
  base: './',
  publicDir: '../desktop/public',
  define: { __CONNECTOR_APP_VERSION__: JSON.stringify(metadata.version) },
  server: { host: '127.0.0.1', port: 1420, strictPort: true },
  build: { outDir: 'dist', target: 'safari15', emptyOutDir: true },
});
