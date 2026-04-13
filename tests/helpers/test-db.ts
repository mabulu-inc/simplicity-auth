import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { useTestProject, writeSchema } from '@smplcty/schema-flow/testing';
import type { TestProject } from '@smplcty/schema-flow/testing';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHIPPED_SCHEMA_DIR = path.resolve(HERE, '../../schema');
const TEST_FIXTURES_DIR = path.resolve(HERE, '../fixtures');
const TEST_SEED_PATH = path.join(TEST_FIXTURES_DIR, 'seed-test-data.sql');

/**
 * Discover all files inside SHIPPED_SCHEMA_DIR (recursively, capped at
 * the directories schema-flow recognises) and return them as an
 * { 'tables/foo.yaml': '<contents>' } map suitable for `writeSchema`.
 *
 * The shipped layout has `schema/tables/*.yaml` and `schema/post/*.sql`,
 * so we walk those subdirectories explicitly.
 */
async function loadShippedSchemaFiles(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const subdir of ['tables', 'functions', 'post']) {
    const dir = path.join(SHIPPED_SCHEMA_DIR, subdir);
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry);
      const content = await readFile(abs, 'utf8');
      out[`${subdir}/${entry}`] = content;
    }
  }
  return out;
}

export interface TestDb {
  /** A pg.Pool connected to this test file's isolated database. */
  pool: pg.Pool;
  /** Connection string for the same isolated database. */
  connectionString: string;
  /** TRUNCATE the sessions table. Used by tests that need a clean slate. */
  resetSessions: () => Promise<void>;
  /** Drop the isolated database and clean up the schema-flow temp dir. */
  shutdown: () => Promise<void>;
}

/**
 * Bring up a fresh isolated database for a test file.
 *
 * Each call:
 *   1. Carves out a new database under the admin DATABASE_URL via
 *      schema-flow's `useTestProject`.
 *   2. Copies the SHIPPED YAML files from `simplicity-auth/schema/`
 *      into the project's temp dir (so the test fixture is the same
 *      schema we ship to consumers).
 *   3. Runs `ctx.migrate()` to apply tables, indexes, and post scripts.
 *   4. Loads the test-only seed data (Alice, Bob, etc.) on top.
 *   5. Returns a `pg.Pool` and a `shutdown` function.
 */
export async function startTestDb(): Promise<TestDb> {
  const adminUrl = process.env.DATABASE_URL;
  if (!adminUrl) {
    throw new Error(
      'DATABASE_URL is not set. The vitest globalSetup is responsible for ' +
        'starting docker compose and exporting DATABASE_URL — make sure ' +
        'vitest.config.ts has globalSetup wired up.',
    );
  }

  const ctx: TestProject = await useTestProject(adminUrl);

  // Copy the shipped YAML schema into the schema-flow project's working
  // directory so the test database is migrated using the same files we
  // ship to consumers.
  const shippedFiles = await loadShippedSchemaFiles();
  writeSchema(ctx.dir, shippedFiles);

  // Apply tables + post scripts.
  await ctx.migrate();

  // Apply test-only seed data (Alice/Bob/etc.) on top of the canonical
  // schema. This is NOT shipped — it lives under tests/fixtures/.
  const testSeed = await readFile(TEST_SEED_PATH, 'utf8');
  const seedPool = new pg.Pool({ connectionString: ctx.connectionString, max: 1 });
  try {
    await seedPool.query(testSeed);
  } finally {
    await seedPool.end();
  }

  // The pool every test query goes through. Separate from the seed
  // pool above so each test file gets a fresh connection pool that's
  // sized for parallelism within the file.
  const pool = new pg.Pool({ connectionString: ctx.connectionString, max: 4 });

  return {
    pool,
    connectionString: ctx.connectionString,
    async resetSessions() {
      await pool.query('TRUNCATE sessions');
    },
    async shutdown() {
      await pool.end();
      await ctx.cleanup();
    },
  };
}
