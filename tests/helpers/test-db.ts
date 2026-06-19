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

// Swap the admin credentials on a connection string for one of the two
// non-superuser roles the global setup created. Lets a test exercise the grant
// matrix as the role the app actually runs as, instead of a superuser that
// holds every privilege.
function asRole(uri: string, userEnv: string, passEnv: string, fallback: string): string {
  const url = new URL(uri);
  url.username = process.env[userEnv] ?? fallback;
  url.password = process.env[passEnv] ?? '';
  return url.toString();
}
const withAppRls = (uri: string) => asRole(uri, 'AUTH_TEST_APP_RLS', 'AUTH_TEST_APP_RLS_PASSWORD', 'app_rls');
const withAppPrivileged = (uri: string) =>
  asRole(uri, 'AUTH_TEST_APP_PRIVILEGED', 'AUTH_TEST_APP_PRIVILEGED_PASSWORD', 'app_privileged');

/**
 * Ids of the seeded rows, resolved by natural key once per clone. Nothing in
 * the schema or fixtures pins a literal id, so tests reference seeded rows
 * through these semantic names instead of hard-coded numbers.
 */
export interface SeededIds {
  /** The app-init service principal (migration-seeded). */
  appInit: number;
  /** user_id by persona name. */
  users: { alice: number; bob: number; globalAdmin: number; noRoles: number; transformWorker: number };
  /** user_communication_method_id by owning persona. */
  ucm: { alice: number; bob: number; globalAdmin: number; noRoles: number };
  /** communication_channel_id by channel name. */
  channels: { email: number; phone: number };
  /** tenant_id by slug. */
  tenants: { acme: number; globex: number; initech: number };
  /** role_id by name. */
  roles: { user: number; settings: number; security: number; canExport: number };
}

export interface TestDb {
  /** A pg.Pool connected to this test file's cloned database. */
  pool: pg.Pool;
  /** Connection string for the same cloned database. */
  connectionString: string;
  /** Same cloned database, authenticated as the RLS-bound `app_rls` role. */
  appRlsConnectionString: string;
  /** Same cloned database, authenticated as the BYPASSRLS `app_privileged` role. */
  appPrivilegedConnectionString: string;
  /** Ids of the seeded rows, resolved by natural key (see {@link SeededIds}). */
  ids: SeededIds;
  /** TRUNCATE the sessions table. Used by tests that need a clean slate. */
  resetSessions: () => Promise<void>;
  /** Drop the cloned database and close pools. */
  shutdown: () => Promise<void>;
}

// bigint ids arrive from pg as strings; tests want numbers.
async function loadIds(pool: pg.Pool): Promise<SeededIds> {
  const userRows = await pool.query<{ name: string; id: string }>(
    `SELECT name, user_id AS id FROM users WHERE name = ANY($1)`,
    [['app-init', 'Alice', 'Bob', 'GlobalAdmin', 'NoRoles', 'transform-worker']],
  );
  const ucmRows = await pool.query<{ name: string; id: string }>(
    `SELECT u.name, ucm.user_communication_method_id AS id
     FROM user_communication_methods ucm
     JOIN users u ON u.user_id = ucm.user_id`,
  );
  const channelRows = await pool.query<{ name: string; id: string }>(
    `SELECT name, communication_channel_id AS id FROM communication_channels`,
  );
  const tenantRows = await pool.query<{ slug: string; id: string }>(`SELECT slug, tenant_id AS id FROM tenants`);
  const roleRows = await pool.query<{ name: string; id: string }>(`SELECT name, role_id AS id FROM roles`);

  const pick = (rows: Record<string, string>[], keyCol: string, val: string): number => {
    const row = rows.find((r) => r[keyCol] === val);
    if (!row) throw new Error(`seeded row not found: ${keyCol}=${val}`);
    return Number(row.id);
  };
  const byName = (rows: { name: string; id: string }[], name: string) => pick(rows, 'name', name);
  const bySlug = (rows: { slug: string; id: string }[], slug: string) => pick(rows, 'slug', slug);

  return {
    appInit: byName(userRows.rows, 'app-init'),
    users: {
      alice: byName(userRows.rows, 'Alice'),
      bob: byName(userRows.rows, 'Bob'),
      globalAdmin: byName(userRows.rows, 'GlobalAdmin'),
      noRoles: byName(userRows.rows, 'NoRoles'),
      transformWorker: byName(userRows.rows, 'transform-worker'),
    },
    ucm: {
      alice: byName(ucmRows.rows, 'Alice'),
      bob: byName(ucmRows.rows, 'Bob'),
      globalAdmin: byName(ucmRows.rows, 'GlobalAdmin'),
      noRoles: byName(ucmRows.rows, 'NoRoles'),
    },
    channels: { email: byName(channelRows.rows, 'email'), phone: byName(channelRows.rows, 'phone') },
    tenants: {
      acme: bySlug(tenantRows.rows, 'acme'),
      globex: bySlug(tenantRows.rows, 'globex'),
      initech: bySlug(tenantRows.rows, 'initech'),
    },
    roles: {
      user: byName(roleRows.rows, 'user'),
      settings: byName(roleRows.rows, 'settings'),
      security: byName(roleRows.rows, 'security'),
      canExport: byName(roleRows.rows, 'can_export'),
    },
  };
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
  const ids = await loadIds(pool);

  return {
    pool,
    connectionString,
    appRlsConnectionString: withAppRls(connectionString),
    appPrivilegedConnectionString: withAppPrivileged(connectionString),
    ids,
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
