import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  findUserByCommunicationMethod,
  getUserRoleNames,
  SessionNotFoundError,
  validateSession,
  withServiceContext,
  withSession,
} from '../src/index.js';
import { hashToken } from '../src/internal/hash-token.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('soft delete', () => {
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

  it('honors a soft-deleted session: excluded entirely (treated as not found)', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    await validateSession(db.pool, session.token); // sanity: valid

    // The app sets deleted_at (sessions is not audited, so no actor needed);
    // the library has no delete setter of its own.
    await db.pool.query(`UPDATE sessions SET deleted_at = now() WHERE session_id = $1`, [hashToken(session.token)]);

    // Soft-deleted → excluded entirely, so it reads as "not found", not "expired".
    await expect(validateSession(db.pool, session.token)).rejects.toBeInstanceOf(SessionNotFoundError);
    await expect(
      withSession(db.pool, { token: session.token, roleName: 'user' }, async () => 'nope'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);

    // Row retained for audit.
    const { rows } = await db.pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM sessions`);
    expect(rows[0]?.n).toBe(1);
  });

  it("a soft-deleted user's session no longer resolves", async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    await withServiceContext(db.pool, 'transform-worker', async (client) => {
      await client.query(`UPDATE users SET deleted_at = now() WHERE user_id = ${db.ids.users.alice}`);
    });
    await expect(
      withSession(db.pool, { token: session.token, roleName: 'user' }, async () => 'nope'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('a soft-deleted role assignment drops out of the resolved roles', async () => {
    // Bob (user 3) holds 'user' + the 'can_export' privilege.
    expect(await getUserRoleNames(db.pool, db.ids.users.bob)).toEqual(['can_export', 'user']);

    await withServiceContext(db.pool, 'transform-worker', async (client) => {
      await client.query(
        `UPDATE user_roles SET deleted_at = now()
         WHERE user_id = ${db.ids.users.bob} AND role_id = (SELECT role_id FROM roles WHERE name = 'can_export')`,
      );
    });

    expect(await getUserRoleNames(db.pool, db.ids.users.bob)).toEqual(['user']);

    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.bob, ttl: '1 hour' }); // Bob
    const ctx = await withSession(db.pool, { token: session.token, roleName: 'user' }, async (_c, ctx) => ctx);
    expect(ctx.privileges).toEqual([]); // can_export assignment soft-deleted
  });

  it('findUserByCommunicationMethod excludes a soft-deleted communication method', async () => {
    // ucm is audited, so the soft-delete UPDATE needs an actor for updated_by.
    await withServiceContext(db.pool, 'transform-worker', async (client) => {
      await client.query(
        `UPDATE user_communication_methods SET deleted_at = now() WHERE user_communication_method_id = 1`,
      );
    });
    const found = await findUserByCommunicationMethod(db.pool, { channel: 'email', code: 'alice@acme.com' });
    expect(found).toBeNull();
  });

  it('partial unique index lets a name be reused after soft delete', async () => {
    await withServiceContext(db.pool, 'transform-worker', async (client) => {
      await client.query(`INSERT INTO tenants (name) VALUES ('reuse-me')`);
      await client.query(`UPDATE tenants SET deleted_at = now() WHERE name = 'reuse-me' AND deleted_at IS NULL`);
      // Same name again — allowed because the unique index is WHERE deleted_at IS NULL.
      await client.query(`INSERT INTO tenants (name) VALUES ('reuse-me')`);
    });
    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenants WHERE name = 'reuse-me'`,
    );
    expect(rows[0]?.n).toBe(2); // one deleted, one live
  });
});
