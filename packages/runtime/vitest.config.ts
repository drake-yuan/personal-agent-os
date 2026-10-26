import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.vitest-cache',
  test: {
    include: ['test/**/*.test.ts'],
    server: {
      deps: {
        // node:sqlite is a Node builtin (experimental); keep it external
        // so Vite never tries to transform it.
        external: ['node:sqlite', 'sqlite'],
      },
    },
  },
});
