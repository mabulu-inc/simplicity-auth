import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    globalSetup: ['./vitest.global-setup.ts'],
    // Files parallelize safely: clones don't re-migrate (see globalSetup).
  },
});
