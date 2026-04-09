import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  RoleNotAssignedError,
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

  it('runs the callback with a fully resolved single-tenant context', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });

    const ctx = await withSession(
      db.pool,
      { sessionId: session.sessionId, roleName: 'user' },
      async (_client, ctx) => ctx,
    );

    expect(ctx.userId).toBe(1);
    expect([...ctx.tenantIds]).toEqual([1]);
    expect(ctx.allTenants).toBe(false);
    expect(ctx.roles).toContain('user');
  });

  it('returns multi-tenant tenantIds for a user with roles in multiple tenants', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 2,
      ttl: '1 hour',
    });

    const ctx = await withSession(
      db.pool,
      { sessionId: session.sessionId, roleName: 'user' },
      async (_client, ctx) => ctx,
    );

    expect(ctx.userId).toBe(2);
    expect([...ctx.tenantIds].sort()).toEqual([1, 2]);
    expect(ctx.allTenants).toBe(false);
  });

  it('sets allTenants=true for a global admin (NULL tenant_id)', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 3,
      ttl: '1 hour',
    });

    const ctx = await withSession(
      db.pool,
      { sessionId: session.sessionId, roleName: 'settings' },
      async (_client, ctx) => ctx,
    );

    expect(ctx.userId).toBe(3);
    expect(ctx.allTenants).toBe(true);
    expect(ctx.roles).toContain('settings');
  });

  it('sets the four session variables on the transaction-bound client', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });

    await withSession(
      db.pool,
      { sessionId: session.sessionId, roleName: 'user' },
      async (client) => {
        const { rows } = await client.query<{
          s: string;
          r: string;
          t: string;
          a: string;
        }>(
          `SELECT
            current_setting('app.session_id', true) AS s,
            current_setting('app.role_name', true)  AS r,
            current_setting('app.tenant_ids', true) AS t,
            current_setting('app.all_tenants', true) AS a`,
        );
        expect(rows[0]?.s).toBe(session.sessionId);
        expect(rows[0]?.r).toBe('user');
        expect(rows[0]?.t).toBe('1');
        expect(rows[0]?.a).toBe('false');
      },
    );
  });

  it('throws SessionNotFoundError before invoking fn for unknown session', async () => {
    let called = false;
    await expect(
      withSession(
        db.pool,
        { sessionId: '00000000-0000-0000-0000-000000000000', roleName: 'user' },
        async () => {
          called = true;
        },
      ),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    expect(called).toBe(false);
  });

  it('throws SessionExpiredError when expires_at has passed', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });
    await db.pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE session_id = $1`,
      [session.sessionId],
    );
    await expect(
      withSession(
        db.pool,
        { sessionId: session.sessionId, roleName: 'user' },
        async () => 'never reached',
      ),
    ).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('throws RoleNotAssignedError when the user lacks the requested role', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });
    // Alice has 'user' but not 'settings'
    await expect(
      withSession(
        db.pool,
        { sessionId: session.sessionId, roleName: 'settings' },
        async () => 'never reached',
      ),
    ).rejects.toBeInstanceOf(RoleNotAssignedError);
  });

  it('rolls back the transaction when fn throws', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });
    await expect(
      withSession(
        db.pool,
        { sessionId: session.sessionId, roleName: 'user' },
        async (client) => {
          await client.query(
            `INSERT INTO tenants (name) VALUES ('with-session-rollback')`,
          );
          throw new Error('boom');
        },
      ),
    ).rejects.toThrow('boom');

    const { rows } = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenants WHERE name = 'with-session-rollback'`,
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('does not leak session variables to subsequent transactions', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 2, // Bob, multi-tenant
      ttl: '1 hour',
    });

    const pool = new (await import('pg')).default.Pool({
      connectionString: db.connectionString,
      max: 1,
    });
    try {
      await withSession(
        pool,
        { sessionId: session.sessionId, roleName: 'user' },
        async () => {},
      );

      // Now use the same connection for a non-withSession query
      const client = await pool.connect();
      try {
        const { rows } = await client.query<{
          s: string;
          r: string;
          t: string;
          a: string;
        }>(
          `SELECT
            current_setting('app.session_id', true) AS s,
            current_setting('app.role_name', true)  AS r,
            current_setting('app.tenant_ids', true) AS t,
            current_setting('app.all_tenants', true) AS a`,
        );
        expect(rows[0]).toEqual({ s: '', r: '', t: '', a: '' });
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  });

  it('returns the value produced by fn', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });
    const value = await withSession(
      db.pool,
      { sessionId: session.sessionId, roleName: 'user' },
      async () => ({ answer: 42 }),
    );
    expect(value).toEqual({ answer: 42 });
  });
});
