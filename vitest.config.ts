import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ['./vitest.global-setup.ts'],
    // Each test file gets its own isolated Postgres schema (within one shared
    // database) via schema-flow's useTestProject, so files run in parallel
    // safely — the per-schema constraint guards landed in schema-flow 0.11.2
    // (mabulu-inc/simplicity-schema-flow#58).
  },
});
