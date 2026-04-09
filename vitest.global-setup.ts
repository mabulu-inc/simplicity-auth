import { execSync } from 'node:child_process';

/**
 * Vitest globalSetup hook.
 *
 * Two modes:
 *
 * 1. **Local dev (default).** No `DATABASE_URL` is set. We start the
 *    docker-compose Postgres defined in `docker-compose.yml`, leave
 *    it running between test runs for fast cold starts, and export
 *    `DATABASE_URL` pointing at it.
 *
 * 2. **CI / external Postgres.** `DATABASE_URL` is already set by the
 *    caller (e.g. a GitHub Actions service container). We skip the
 *    docker-compose dance entirely and just use what was provided.
 *
 * Either way, test files use `useTestProject(DATABASE_URL)` from
 * `@smplcty/schema-flow/testing` to carve out an isolated database
 * with a random name. Each test file gets its own database; cleanup
 * happens per file.
 */
export default function setup(): void {
  if (process.env.DATABASE_URL) {
    // External Postgres provided — nothing for us to start.
    return;
  }

  execSync('docker compose up -d --wait', {
    stdio: 'inherit',
    cwd: import.meta.dirname,
  });

  process.env.DATABASE_URL =
    'postgresql://postgres:postgres@localhost:54320/postgres';
}
