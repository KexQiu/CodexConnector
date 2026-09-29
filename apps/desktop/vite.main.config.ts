import { defineConfig } from 'vite';
import { builtinModules } from 'node:module';
export default defineConfig({
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    lib: {
      entry: { main: 'src/main.ts', preload: 'src/preload.ts' },
      formats: ['cjs'],
      fileName: (_, name) => `${name}.cjs`,
    },
    rollupOptions: {
      external: ['electron', ...builtinModules, ...builtinModules.map((name) => `node:${name}`)],
    },
  },
});
