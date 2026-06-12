import { execSync } from 'node:child_process';
import pg from 'pg';

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
 * Each test file then carves out an isolated `test_<hex>` Postgres schema
 * via `useTestProject` and drops it on `shutdown()`. This hook does a
 * one-time **sweep of stale `test_*` schemas** first, so orphans left by a
 * previous crashed/interrupted run (or a setup that threw before its
 * `afterAll` could clean up) don't accumulate — no manual `DROP SCHEMA`.
 */
export default async function setup(): Promise<void> {
  if (!process.env.DATABASE_URL) {
    execSync('docker compose up -d --wait', {
      stdio: 'inherit',
      cwd: import.meta.dirname,
    });
    process.env.DATABASE_URL = 'postgresql://postgres:postgres@localhost:54320/postgres';
  }

  await sweepStaleTestSchemas(process.env.DATABASE_URL);
}

/**
 * Drop any leftover `test_<hex>` schemas from prior runs. Assumes no other
 * test run is using this database concurrently (true for the local docker
 * instance and CI's per-job container). Names are matched against the
 * harness's own `test_<hex>` shape before use, so the identifier is safe.
 */
async function sweepStaleTestSchemas(connectionString: string): Promise<void> {
  const pool = new pg.Pool({ connectionString, max: 1 });
  try {
    const { rows } = await pool.query<{ schema_name: string }>(
      `SELECT schema_name FROM information_schema.schemata WHERE schema_name LIKE 'test\\_%'`,
    );
    for (const { schema_name } of rows) {
      if (!/^test_[0-9a-f]+$/i.test(schema_name)) continue;
      await pool.query(`DROP SCHEMA "${schema_name}" CASCADE`);
    }
  } finally {
    await pool.end();
  }
}
