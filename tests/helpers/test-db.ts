import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { useTestProject, writeSchema } from '@smplcty/schema-flow/testing';
import type { TestProject } from '@smplcty/schema-flow/testing';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');
const SHIPPED_SCHEMA_DIR = path.join(REPO_ROOT, 'schema');
const TEST_FIXTURES_DIR = path.resolve(HERE, '../fixtures');
const TEST_SEED_PATH = path.join(TEST_FIXTURES_DIR, 'seed-test-data.sql');

// The app-init service principal seeded by schema/tables/users.yaml. The
// audit triggers stamp created_by/updated_by from app.actor_id, so the
// post-migration test seed (which writes audited tables) must act as it too.
const APP_INIT_USER_ID = '1';

const require = createRequire(import.meta.url);
// schema-std's shipped schema/ — the real artifact consumers import.
const SCHEMA_STD_SCHEMA_DIR = path.join(path.dirname(require.resolve('@smplcty/schema-std/package.json')), 'schema');

/**
 * Discover all files inside SHIPPED_SCHEMA_DIR (recursively, capped at
 * the directories schema-flow recognises) and return them as an
 * { 'tables/foo.yaml': '<contents>' } map suitable for `writeSchema`.
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

/**
 * Install @smplcty/schema-std's real shipped `schema/` into the test
 * project's node_modules so schema-flow's `imports:` resolution (which walks
 * up from baseDir) finds it. Mirrors schema-std's own e2e `installSelf`.
 */
async function installSchemaStd(projectDir: string): Promise<void> {
  const pkgRoot = path.join(projectDir, 'node_modules', '@smplcty', 'schema-std');
  await mkdir(pkgRoot, { recursive: true });
  await writeFile(
    path.join(pkgRoot, 'package.json'),
    JSON.stringify({ name: '@smplcty/schema-std', version: '0.0.0' }),
  );
  await cp(SCHEMA_STD_SCHEMA_DIR, path.join(pkgRoot, 'schema'), { recursive: true });
}

export interface TestDb {
  /** A pg.Pool connected to this test file's isolated database. */
  pool: pg.Pool;
  /** Connection string for the same isolated database. */
  connectionString: string;
  /** The isolated Postgres schema name. Put it on a connection's
   *  search_path (`-c search_path=<schema>`) when opening your own pool. */
  schema: string;
  /** TRUNCATE the sessions table. Used by tests that need a clean slate. */
  resetSessions: () => Promise<void>;
  /** Drop the isolated database and clean up the schema-flow temp dir. */
  shutdown: () => Promise<void>;
}

/**
 * Bring up a fresh isolated schema for a test file.
 *
 * Each call:
 *   1. Carves out a new isolated Postgres schema under DATABASE_URL.
 *   2. Copies the SHIPPED YAML from `simplicity-auth/schema/` into the
 *      project temp dir, and installs `@smplcty/schema-std` into its
 *      node_modules (so the audit/soft_delete mixins resolve via `imports`).
 *   3. Wires `imports` (+ params) onto the config, then runs `ctx.migrate()`.
 *      Migration seeds land with NULL audit _by columns; the shipped
 *      `post/` script back-fills them to app-init before the NOT NULL tighten.
 *   4. Loads the test-only seed data (Alice, Bob, etc.), acting as app-init.
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

  // Everything after useTestProject can throw (a bad migration, a seed
  // error). If it does, drop the schema we just created before rethrowing —
  // otherwise a failing beforeAll leaks an orphaned test_* schema that the
  // file's afterAll can't reach (its `db` was never assigned).
  try {
    return await buildTestDb(ctx);
  } catch (err) {
    await ctx.cleanup().catch(() => {
      // Best-effort: surface the original error, not a cleanup failure.
    });
    throw err;
  }
}

async function buildTestDb(ctx: TestProject): Promise<TestDb> {
  // Copy the shipped YAML schema into the schema-flow project's working
  // directory so the test database is migrated using the same files we ship.
  const shippedFiles = await loadShippedSchemaFiles();
  writeSchema(ctx.dir, shippedFiles);

  // Make @smplcty/schema-std resolvable from the project, and wire the import
  // (+ params) exactly as the shipped schema-flow.config.yaml documents for
  // consumers. The migration-time audit attribution is handled by the shipped
  // post/ back-fill script, not a per-tx actor.
  await installSchemaStd(ctx.dir);
  ctx.config.imports = [
    { package: '@smplcty/schema-std', params: { user_table: 'users', user_pk: 'user_id', actor_guc: 'app.actor_id' } },
  ];

  // Apply tables, imported mixins/functions, seeds, the post/ audit back-fill,
  // and the NOT NULL tighten.
  await ctx.migrate();

  // schema-flow 0.11 isolates each test in a fresh Postgres *schema*
  // (not a fresh database), so every connection must put that schema on
  // its search_path or it'll resolve names against `public`.
  const searchPathOption = `-c search_path=${ctx.schema}`;

  // Apply test-only seed data (Alice/Bob/etc.) on top of the canonical
  // schema. It writes audited tables (users/tenants/roles/...), so it acts
  // as app-init — otherwise audit_stamp would leave created_by NULL and the
  // NOT NULL constraint would reject the insert.
  const testSeed = await readFile(TEST_SEED_PATH, 'utf8');
  const seedSql = `SELECT set_config('app.actor_id', '${APP_INIT_USER_ID}', false);\n${testSeed}`;
  const seedPool = new pg.Pool({ connectionString: ctx.connectionString, max: 1, options: searchPathOption });
  try {
    await seedPool.query(seedSql);
  } finally {
    await seedPool.end();
  }

  // The pool every test query goes through. Separate from the seed
  // pool above so each test file gets a fresh connection pool that's
  // sized for parallelism within the file.
  const pool = new pg.Pool({ connectionString: ctx.connectionString, max: 4, options: searchPathOption });

  return {
    pool,
    connectionString: ctx.connectionString,
    schema: ctx.schema,
    async resetSessions() {
      await pool.query('TRUNCATE sessions');
    },
    async shutdown() {
      await pool.end();
      await ctx.cleanup();
    },
  };
}
