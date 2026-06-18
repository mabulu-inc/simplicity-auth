import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  RoleNotHeldError,
  SessionExpiredError,
  SessionNotFoundError,
  withSession,
} from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('withSession', () => {
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

  // Create a user holding two distinct, non-default roles in two different
  // tenants (settings@acme, security@globex), plus an email method to anchor a
  // session. Runs as the superuser pool with the app-init actor so the audit
  // triggers stamp created_by. Returns the new user_communication_method_id.
  async function seedMultiTenantUser(): Promise<number> {
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query(`SELECT set_config('app.actor_id', $1, true)`, [String(db.ids.appInit)]);
      const u = await c.query<{ user_id: string }>(
        `INSERT INTO users (name, kind) VALUES ('MultiRole', 'human') RETURNING user_id`,
      );
      const userId = u.rows[0]!.user_id;
      const ucm = await c.query<{ id: string }>(
        `INSERT INTO user_communication_methods (user_id, communication_channel_id, code)
         VALUES ($1, $2, 'multirole@example.com') RETURNING user_communication_method_id AS id`,
        [userId, db.ids.channels.email],
      );
      await c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3), ($1, $4, $5)`, [
        userId,
        db.ids.roles.settings,
        db.ids.tenants.acme,
        db.ids.roles.security,
        db.ids.tenants.globex,
      ]);
      await c.query('COMMIT');
      return Number(ucm.rows[0]!.id);
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }

  it('runs the callback with a resolved identity context', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });

    const ctx = await withSession(db.pool, { token: session.token, roleName: 'user' }, async (_client, ctx) => ctx);

    expect(ctx.userId).toBe(db.ids.users.alice);
    expect(ctx.activeRole).toBe('user');
    expect(ctx.roles).toContain('user');
    expect(ctx.privileges).toEqual([]);
  });

  it('selects the default role when no roleName is requested', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });

    // Alice holds 'user', which is the is_default role.
    const ctx = await withSession(db.pool, { token: session.token }, async (_client, ctx) => ctx);

    expect(ctx.activeRole).toBe('user');
  });

  it('auto-selects a sole role even when it is not the default', async () => {
    // GlobalAdmin holds only 'settings' (a non-default role). One role is
    // unambiguous, so it is activated without the caller requesting it.
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.globalAdmin, ttl: '1 hour' });

    const ctx = await withSession(db.pool, { token: session.token }, async (_client, ctx) => ctx);

    expect(ctx.roles).toEqual(['settings']);
    expect(ctx.activeRole).toBe('settings');
  });

  it('treats the same role held across tenants as one role', async () => {
    // Bob holds 'user' in both acme and globex — one distinct role, still
    // auto-selected (roles are distinct by name, not per tenant assignment).
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.bob, ttl: '1 hour' });

    const ctx = await withSession(db.pool, { token: session.token }, async (_client, ctx) => ctx);

    expect(ctx.roles).toEqual(['user']);
    expect(ctx.activeRole).toBe('user');
  });

  it('does not auto-select when the user holds different roles in different tenants', async () => {
    // Two distinct, non-default roles (settings in one tenant, security in
    // another) are genuinely ambiguous: no sole role, no default, so activeRole
    // is null and the caller must request one explicitly.
    const ucmId = await seedMultiTenantUser();
    const session = await createSession(db.pool, { userCommunicationMethodId: ucmId, ttl: '1 hour' });

    const ctx = await withSession(db.pool, { token: session.token }, async (_client, ctx) => ctx);

    expect(ctx.roles).toEqual(['security', 'settings']);
    expect(ctx.activeRole).toBeNull();
  });

  it('sets the four identity GUCs on the transaction-bound client', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });

    await withSession(db.pool, { token: session.token, roleName: 'user' }, async (client) => {
      const { rows } = await client.query<{ actor: string; sess: string; role: string; privs: string }>(
        `SELECT
            current_setting('app.actor_id', true)    AS actor,
            current_setting('app.session_id', true)  AS sess,
            current_setting('app.active_role', true) AS role,
            current_setting('app.privileges', true)  AS privs`,
      );
      expect(rows[0]?.actor).toBe(String(db.ids.users.alice));
      // app.session_id is the token hash (64 hex chars), never the raw token.
      expect(rows[0]?.sess).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.sess).not.toBe(session.token);
      expect(rows[0]?.role).toBe('user');
      expect(rows[0]?.privs).toBe('');
    });
  });

  it('current_user_id() reflects app.actor_id inside the request', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });
    await withSession(db.pool, { token: session.token, roleName: 'user' }, async (client) => {
      const { rows } = await client.query<{ id: number }>('SELECT current_user_id()::int AS id');
      expect(rows[0]?.id).toBe(db.ids.users.alice);
    });
  });

  it('throws SessionNotFoundError before invoking fn for an unknown token', async () => {
    let called = false;
    await expect(
      withSession(db.pool, { token: 'not-a-real-token', roleName: 'user' }, async () => {
        called = true;
      }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(called).toBe(false);
  });

  it('throws SessionExpiredError when expires_at has passed', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });
    await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    await expect(
      withSession(db.pool, { token: session.token, roleName: 'user' }, async () => 'never reached'),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('throws RoleNotHeldError when the user lacks the requested role', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });
    // Alice has 'user' but not 'settings'.
    await expect(
      withSession(db.pool, { token: session.token, roleName: 'settings' }, async () => 'never reached'),
    ).rejects.toBeInstanceOf(RoleNotHeldError);
  });

  it('runs the scope hook after identity GUCs are set', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });
    let seenActor: string | undefined;
    await withSession(db.pool, { token: session.token, roleName: 'user' }, async () => {}, {
      scope: async (client, identity) => {
        expect(identity.userId).toBe(db.ids.users.alice);
        const { rows } = await client.query<{ actor: string }>(`SELECT current_setting('app.actor_id', true) AS actor`);
        seenActor = rows[0]?.actor;
      },
    });
    expect(seenActor).toBe(String(db.ids.users.alice));
  });

  it('rolls back the transaction when fn throws', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });
    await expect(
      withSession(db.pool, { token: session.token, roleName: 'user' }, async (client) => {
        await client.query(`INSERT INTO tenants (name) VALUES ('with-session-rollback')`);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenants WHERE name = 'with-session-rollback'`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('does not leak identity GUCs to subsequent transactions', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.bob, ttl: '1 hour' });

    const pool = new (await import('pg')).default.Pool({
      connectionString: db.connectionString,
      max: 1,
    });
    try {
      await withSession(pool, { token: session.token, roleName: 'user' }, async () => {});

      const client = await pool.connect();
      try {
        const { rows } = await client.query<{ actor: string; sess: string; role: string; privs: string }>(
          `SELECT
            current_setting('app.actor_id', true)    AS actor,
            current_setting('app.session_id', true)  AS sess,
            current_setting('app.active_role', true) AS role,
            current_setting('app.privileges', true)  AS privs`,
        );
        expect(rows[0]).toEqual({ actor: '', sess: '', role: '', privs: '' });
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('returns the value produced by fn', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });
    const value = await withSession(db.pool, { token: session.token, roleName: 'user' }, async () => ({ answer: 42 }));
    expect(value).toEqual({ answer: 42 });
  });
});
