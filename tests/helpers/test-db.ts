import { randomBytes } from 'node:crypto';
import pg from 'pg';

// Serializes `CREATE DATABASE … TEMPLATE` across concurrently-starting test
// files: Postgres rejects the clone if another session is touching the
// template, so overlapping clones must not race. Held only for the (fast)
// copy of the small template, then released — tests still run in parallel.
const TEMPLATE_CLONE_LOCK = 982451653;

function withDatabase(uri: string, dbName: string): string {
  const url = new URL(uri);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export interface TestDb {
  /** A pg.Pool connected to this test file's cloned database. */
  pool: pg.Pool;
  /** Connection string for the same cloned database. */
  connectionString: string;
  /** TRUNCATE the sessions table. Used by tests that need a clean slate. */
  resetSessions: () => Promise<void>;
  /** Drop the cloned database and close pools. */
  shutdown: () => Promise<void>;
}

/**
 * Bring up an isolated database for a test file by **cloning the migrated +
 * seeded template** that `vitest.global-setup.ts` built once via Testcontainers
 * (`CREATE DATABASE <unique> TEMPLATE auth_template`). The clone already has the
 * full schema + fixtures, so there's no per-file migration — the expensive
 * schema-flow run is paid once for the whole suite.
 *
 * `shutdown()` drops the clone. The container itself is reaped by
 * Testcontainers (Ryuk) even on a hard crash, so nothing leaks between runs.
 */
export async function startTestDb(): Promise<TestDb> {
  const adminUrl = process.env.AUTH_TEST_ADMIN_URL;
  const template = process.env.AUTH_TEST_TEMPLATE_DB;
  if (!adminUrl || !template) {
    throw new Error(
      'AUTH_TEST_ADMIN_URL / AUTH_TEST_TEMPLATE_DB are not set. The vitest ' +
        'globalSetup provisions Postgres via Testcontainers and builds the ' +
        'template — make sure vitest.config.ts has globalSetup wired up.',
    );
  }

  const dbName = `test_${randomBytes(8).toString('hex')}`;
  const admin = new pg.Pool({ connectionString: adminUrl, max: 1 });

  // Lock + clone + unlock on one connection so the advisory lock is held by
  // the same session that runs CREATE DATABASE.
  const client = await admin.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [TEMPLATE_CLONE_LOCK]);
    try {
      await client.query(`CREATE DATABASE "${dbName}" TEMPLATE "${template}"`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [TEMPLATE_CLONE_LOCK]);
    }
  } finally {
    client.release();
  }

  const connectionString = withDatabase(adminUrl, dbName);
  const pool = new pg.Pool({ connectionString, max: 4 });

  return {
    pool,
    connectionString,
    async resetSessions() {
      await pool.query('TRUNCATE sessions');
    },
    async shutdown() {
      await pool.end();
      // Drop the clone. Terminate any straggler connections first so DROP
      // DATABASE doesn't fail on "database is being accessed by other users".
      await admin.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
        [dbName],
      );
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}"`);
      await admin.end();
    },
  };
}
