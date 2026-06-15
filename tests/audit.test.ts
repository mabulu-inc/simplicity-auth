import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession, withServiceContext, withSession } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

// Proves the audit mixin consumed from @smplcty/schema-std is wired to auth's
// identity contract: the audit_stamp trigger stamps created_by/updated_by
// from app.actor_id, which withSession / withServiceContext set.
describe('audit mixin (consumed from @smplcty/schema-std)', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });
  afterAll(async () => {
    await db.shutdown();
  });
  beforeEach(async () => {
    await db.resetSessions();
  });

  it('seeds carry audit columns, attributed to the app-init principal', async () => {
    const { rows } = await db.pool.query<{ created_by: string; updated_by: string }>(
      `SELECT created_by, updated_by FROM roles WHERE name = 'user'`,
    );
    // bigint comes back as a string from pg.
    const appInit = String(db.ids.appInit);
    expect(rows[0]).toEqual({ created_by: appInit, updated_by: appInit });
  });

  it('stamps created_by from app.actor_id on a write inside withSession', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });

    const createdBy = await withSession(db.pool, { token: session.token, roleName: 'user' }, async (client) => {
      const { rows } = await client.query<{ created_by: string }>(
        `INSERT INTO tenants (name) VALUES ('audited-by-alice') RETURNING created_by`,
      );
      return rows[0]!.created_by;
    });

    expect(createdBy).toBe(String(db.ids.users.alice)); // Alice
  });

  it('stamps created_by from the service principal inside withServiceContext', async () => {
    const createdBy = await withServiceContext(db.pool, 'transform-worker', async (client) => {
      const { rows } = await client.query<{ created_by: string }>(
        `INSERT INTO tenants (name) VALUES ('audited-by-service') RETURNING created_by`,
      );
      return rows[0]!.created_by;
    });

    expect(createdBy).toBe(String(db.ids.users.transformWorker)); // transform-worker
  });
});
