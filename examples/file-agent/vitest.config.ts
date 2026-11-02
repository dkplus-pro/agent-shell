import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * The root `vitest.config.ts` only globs `packages/*` and `tooling/*`, and this
 * example must not change root config. This file exists so the reference
 * scenario stays runnable on its own, from anywhere:
 *
 *   npx vitest run --config examples/file-agent/vitest.config.ts
 */
export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
