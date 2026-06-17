import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withServiceContext } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

// A live service user's name must be unique: service principals are resolved
// by name (withServiceContext / audit_backfill_by), so a duplicate would make
// that lookup ambiguous. Enforced by the partial-unique index
// users_service_name_key in schema/tables/users.yaml.
describe('service user name uniqueness', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });

  // Inserts touch the audited users table, so they need an actor in context.
  const insertUser = (name: string, kind: 'human' | 'service') =>
    withServiceContext(db.pool, 'transform-worker', (client) =>
      client.query(`INSERT INTO users (name, kind) VALUES ($1, $2)`, [name, kind]),
    );

  it('rejects a second live service user with the same name', async () => {
    await insertUser('ingestion', 'service');
    await expect(insertUser('ingestion', 'service')).rejects.toMatchObject({ code: '23505' });
  });

  it('allows two human users to share a name (humans are not constrained)', async () => {
    await insertUser('Jordan', 'human');
    await expect(insertUser('Jordan', 'human')).resolves.toBeDefined();
  });

  it('frees the name for reuse once the service user is soft-deleted', async () => {
    await insertUser('reaper', 'service');
    await withServiceContext(db.pool, 'transform-worker', (client) =>
      client.query(`UPDATE users SET deleted_at = now() WHERE name = 'reaper' AND kind = 'service'`),
    );
    await expect(insertUser('reaper', 'service')).resolves.toBeDefined();
  });
});
