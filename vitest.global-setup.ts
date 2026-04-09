import { execSync } from 'node:child_process';

/**
 * Vitest globalSetup hook. Starts the docker-compose Postgres before
 * any test file imports run, and exports DATABASE_URL so the test
 * helpers can build isolated databases on top of it via
 * `@smplcty/schema-flow/testing`.
 *
 * The container is created once per test run and stays up between
 * test files. Each test file uses `useTestProject(DATABASE_URL)` to
 * carve out an isolated database with a random name; cleanup happens
 * per test file. The container itself is left running so subsequent
 * `pnpm test` invocations are warm.
 */
export default function setup(): void {
  execSync('docker compose up -d --wait', {
    stdio: 'inherit',
    cwd: import.meta.dirname,
  });

  // Make the connection string available to test files. The host port
  // is fixed in docker-compose.yml. The default postgres database is
  // the "admin" connection that useTestProject uses to CREATE DATABASE
  // for each test.
  process.env.DATABASE_URL =
    process.env.DATABASE_URL ??
    'postgresql://postgres:postgres@localhost:54320/postgres';
}
