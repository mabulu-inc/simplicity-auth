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

  it('runs the callback with a resolved identity context', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });

    const ctx = await withSession(db.pool, { token: session.token, roleName: 'user' }, async (_client, ctx) => ctx);

    expect(ctx.userId).toBe(2);
    expect(ctx.activeRole).toBe('user');
    expect(ctx.roles).toContain('user');
    expect(ctx.privileges).toEqual([]);
  });

  it('selects the default role when no roleName is requested', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });

    // Alice holds 'user', which is the is_default role.
    const ctx = await withSession(db.pool, { token: session.token }, async (_client, ctx) => ctx);

    expect(ctx.activeRole).toBe('user');
  });

  it('sets the four identity GUCs on the transaction-bound client', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });

    await withSession(db.pool, { token: session.token, roleName: 'user' }, async (client) => {
      const { rows } = await client.query<{ actor: string; sess: string; role: string; privs: string }>(
        `SELECT
            current_setting('app.actor_id', true)    AS actor,
            current_setting('app.session_id', true)  AS sess,
            current_setting('app.active_role', true) AS role,
            current_setting('app.privileges', true)  AS privs`,
      );
      expect(rows[0]?.actor).toBe('2');
      // app.session_id is the token hash (64 hex chars), never the raw token.
      expect(rows[0]?.sess).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0]?.sess).not.toBe(session.token);
      expect(rows[0]?.role).toBe('user');
      expect(rows[0]?.privs).toBe('');
    });
  });

  it('current_user_id() reflects app.actor_id inside the request', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    await withSession(db.pool, { token: session.token, roleName: 'user' }, async (client) => {
      const { rows } = await client.query<{ id: number }>('SELECT current_user_id()::int AS id');
      expect(rows[0]?.id).toBe(2);
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
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute'`);
    await expect(
      withSession(db.pool, { token: session.token, roleName: 'user' }, async () => 'never reached'),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('throws RoleNotHeldError when the user lacks the requested role', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    // Alice has 'user' but not 'settings'.
    await expect(
      withSession(db.pool, { token: session.token, roleName: 'settings' }, async () => 'never reached'),
    ).rejects.toBeInstanceOf(RoleNotHeldError);
  });

  it('runs the scope hook after identity GUCs are set', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    let seenActor: string | undefined;
    await withSession(db.pool, { token: session.token, roleName: 'user' }, async () => {}, {
      scope: async (client, identity) => {
        expect(identity.userId).toBe(2);
        const { rows } = await client.query<{ actor: string }>(`SELECT current_setting('app.actor_id', true) AS actor`);
        seenActor = rows[0]?.actor;
      },
    });
    expect(seenActor).toBe('2');
  });

  it('rolls back the transaction when fn throws', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
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
    const session = await createSession(db.pool, { userCommunicationMethodId: 2, ttl: '1 hour' });

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
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    const value = await withSession(db.pool, { token: session.token, roleName: 'user' }, async () => ({ answer: 42 }));
    expect(value).toEqual({ answer: 42 });
  });
});
