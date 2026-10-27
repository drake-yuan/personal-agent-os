import { defineConfig } from 'vitest/config';

export default defineConfig({
  cacheDir: './.vitest-cache',
  test: {
    include: ['test/**/*.test.ts'],
    // Files are collected serially. Parallel collection can drop test
    // files when the filesystem is brokered (sandboxed dev shells),
    // which silently lowers the measured coverage.
    fileParallelism: false,
    server: {
      deps: {
        // node:sqlite is a Node builtin (experimental); keep it external
        // so Vite never tries to transform it.
        external: ['node:sqlite', 'sqlite'],
      },
    },
  },
});
