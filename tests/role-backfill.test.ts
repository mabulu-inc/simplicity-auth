import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startTestDb, type TestDb } from './helpers/test-db.js';

const POST_SCRIPT = path.join(import.meta.dirname, '../schema/post/0002-backfill-role-values.sql');

let db: TestDb;
let backfillSql: string;

// roles carries the audit mixin, so its *_by columns are NOT NULL — any UPDATE
// needs an actor set. Run the mutation as one multi-statement string so the
// LOCAL set_config applies to the UPDATE in the same implicit transaction.
async function asAppInit(sql: string): Promise<void> {
  await db.pool.query(`SELECT set_config('app.actor_id', '${db.ids.appInit}', true);\n${sql}`);
}

beforeAll(async () => {
  db = await startTestDb();
  backfillSql = await readFile(POST_SCRIPT, 'utf8');
});

afterAll(async () => {
  await db.shutdown();
});

describe('standard role value back-fill (post/0002)', () => {
  beforeEach(async () => {
    // Recreate the bug: a database that had the role rows before the value
    // columns existed keeps the column defaults — display_name NULL and, the
    // breaking part, is_default = false on every role. Seeds are insert-only,
    // so they never repair an existing row.
    await asAppInit(
      `UPDATE roles SET display_name = NULL, description = NULL, is_default = false, is_privilege = false
        WHERE name IN ('user', 'settings', 'security');`,
    );
  });

  it('restores the canonical values, including user.is_default = true', async () => {
    await db.pool.query(backfillSql);

    const { rows } = await db.pool.query<{
      name: string;
      display_name: string | null;
      is_default: boolean;
      is_privilege: boolean;
    }>(
      `SELECT name, display_name, is_default, is_privilege FROM roles
        WHERE name IN ('user', 'settings', 'security')`,
    );
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.user).toMatchObject({ display_name: 'User', is_default: true, is_privilege: false });
    expect(byName.settings).toMatchObject({ display_name: 'Settings', is_default: false, is_privilege: false });
    expect(byName.security).toMatchObject({ display_name: 'Security', is_default: false, is_privilege: false });
  });

  it('leaves a role a consumer has renamed untouched', async () => {
    // The guard is `display_name IS NULL`, so a row the consumer has already
    // customised is skipped entirely — its is_default stays as they left it.
    await asAppInit(`UPDATE roles SET display_name = 'Member' WHERE name = 'user';`);

    await db.pool.query(backfillSql);

    const { rows } = await db.pool.query<{ display_name: string; is_default: boolean }>(
      `SELECT display_name, is_default FROM roles WHERE name = 'user'`,
    );
    expect(rows[0]?.display_name).toBe('Member');
    expect(rows[0]?.is_default).toBe(false);
  });
});
