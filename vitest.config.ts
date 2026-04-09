import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ['./vitest.global-setup.ts'],
    // Each test file gets its own isolated Postgres database via
    // schema-flow's useTestProject, so files can run in parallel safely.
    // Default vitest behavior is fine — no special pool config required.
  },
});
