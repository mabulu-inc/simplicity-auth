import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Vitest globalSetup — runs once per test run.
 *
 * Provisions Postgres with **Testcontainers** (ephemeral, Ryuk-reaped — no
 * docker-compose, no shared instance to leak between runs), builds the schema
 * **once** into a `auth_template` database, seeds the test fixtures into it,
 * and exposes the admin connection + template name. Each test file then clones
 * the template via `CREATE DATABASE … TEMPLATE` (see tests/helpers/test-db.ts),
 * so the expensive schema-flow migration is paid once, not per file.
 *
 * Requires a reachable Docker daemon (local Docker Desktop / colima; GitHub
 * `ubuntu-latest` and AWS CodeBuild/EC2 all provide one).
 */

const REPO_ROOT = import.meta.dirname;
const FIXTURE = path.join(REPO_ROOT, 'tests/fixtures/seed-test-data.sql');
const TEMPLATE_DB = 'auth_template';

let container: StartedPostgreSqlContainer | undefined;

function withDatabase(uri: string, dbName: string): string {
  const url = new URL(uri);
  url.pathname = `/${dbName}`;
  return url.toString();
}

export default async function setup(): Promise<() => Promise<void>> {
  container = await new PostgreSqlContainer('postgres:16-alpine')
    .withDatabase('postgres')
    .withUsername('postgres')
    .withPassword('postgres')
    .start();

  const adminUri = container.getConnectionUri();
  const templateUri = withDatabase(adminUri, TEMPLATE_DB);

  // 1. Create the template database (from the maintenance `postgres` db).
  const admin = new pg.Pool({ connectionString: adminUri, max: 1 });
  try {
    await admin.query(`CREATE DATABASE ${TEMPLATE_DB}`);
  } finally {
    await admin.end();
  }

  // 2. Migrate the shipped schema into the template via the schema-flow CLI —
  //    the documented path. imports (@smplcty/schema-std + params) come from
  //    schema-flow.config.yaml; --db points at the template; the post/ script
  //    back-fills audit attribution before the NOT NULL tighten.
  execFileSync('pnpm', ['exec', 'schema-flow', 'run', '--db', templateUri, '--dir', 'schema', '--quiet'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: templateUri },
  });

  // 3. Seed the test fixtures into the template (acting as app-init so the
  //    audit triggers stamp created_by/updated_by). Clones inherit all of this.
  const fixture = await readFile(FIXTURE, 'utf8');
  const seed = new pg.Pool({ connectionString: templateUri, max: 1 });
  try {
    // Resolve the app-init principal by name — the schema pins no id. The id
    // is a trusted integer from our own DB, so it's safe to inline (a
    // parameterized query can't carry the fixture's multiple statements).
    const { rows } = await seed.query<{ userId: string }>(
      `SELECT user_id AS "userId" FROM users WHERE name = 'app-init' AND kind = 'service'`,
    );
    const appInitId = rows[0]?.userId;
    if (!appInitId) throw new Error('app-init service principal not found after migration');
    await seed.query(`SELECT set_config('app.actor_id', '${appInitId}', false);\n${fixture}`);
  } finally {
    await seed.end();
  }

  process.env.AUTH_TEST_ADMIN_URL = adminUri;
  process.env.AUTH_TEST_TEMPLATE_DB = TEMPLATE_DB;

  return async () => {
    await container?.stop();
  };
}
