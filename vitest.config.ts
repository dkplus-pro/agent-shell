import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'packages/*/test/**/*.test.ts',
      'tooling/*/test/**/*.test.ts',
      'examples/*/test/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/coverage/**'],
    environment: 'node',
    testTimeout: 240_000,
    hookTimeout: 240_000,
    teardownFileTimeout: 60_000,
    pool: 'forks',
    // This box is small and the CLI E2E suite spawns node+tsx subprocesses per
    // test; unbounded forking starves the local-HTTP contract tests and makes
    // them hit their timeouts. Cap the worker count instead of retrying tests
    // (AGENT.md §6 forbids masking flakiness with retries).
    maxWorkers: 3,
    minWorkers: 1,
    coverage: {
      provider: 'v8',
      include: ['packages/core/src/**/*.ts'],
      exclude: ['**/*.d.ts', '**/index.ts'],
      reporter: ['text', 'json-summary'],
      // docs/04 §6 gates core on line coverage ≥80%; the rejection paths for
      // approval policy, path guard, registry, config, redaction and event
      // schema are required as explicit tests, not as a branch-percentage proxy.
      thresholds: {
        lines: 80,
        statements: 80,
      },
    },
  },
});
