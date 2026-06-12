import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvalidInputError,
  setActiveRole,
  setActorId,
  setIdentityContext,
  setPrivileges,
  setSessionId,
  withTransaction,
} from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('identity GUC helpers', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.shutdown();
  });

  describe('setActorId', () => {
    it('sets app.actor_id and current_user_id() reads it', async () => {
      await withTransaction(db.pool, async (client) => {
        await setActorId(client, 42);
        const { rows } = await client.query<{ guc: string; cui: number }>(
          `SELECT current_setting('app.actor_id', true) AS guc, current_user_id() AS cui`,
        );
        expect(rows[0]?.guc).toBe('42');
        expect(rows[0]?.cui).toBe(42);
      });
    });

    it('rejects non-positive / non-integer actorId', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(setActorId(client, 0)).rejects.toBeInstanceOf(InvalidInputError);
        await expect(setActorId(client, 2.5)).rejects.toBeInstanceOf(InvalidInputError);
      });
    });
  });

  describe('setSessionId', () => {
    it('sets app.session_id and is parameterized', async () => {
      const malicious = "'; DROP TABLE sessions; --";
      await withTransaction(db.pool, async (client) => {
        await setSessionId(client, malicious);
        const { rows } = await client.query<{ v: string }>(`SELECT current_setting('app.session_id', true) AS v`);
        expect(rows[0]?.v).toBe(malicious);
      });
      const { rows } = await db.pool.query(`SELECT to_regclass('sessions') AS exists`);
      expect(rows[0]?.exists).toBe('sessions');
    });

    it('throws InvalidInputError on empty / non-string input', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(setSessionId(client, '')).rejects.toBeInstanceOf(InvalidInputError);
        // @ts-expect-error testing runtime validation
        await expect(setSessionId(client, 42)).rejects.toBeInstanceOf(InvalidInputError);
      });
    });
  });

  describe('setActiveRole', () => {
    it('sets app.active_role, and null clears it', async () => {
      await withTransaction(db.pool, async (client) => {
        await setActiveRole(client, 'user');
        let res = await client.query<{ v: string }>(`SELECT current_setting('app.active_role', true) AS v`);
        expect(res.rows[0]?.v).toBe('user');
        await setActiveRole(client, null);
        res = await client.query<{ v: string }>(`SELECT current_setting('app.active_role', true) AS v`);
        expect(res.rows[0]?.v).toBe('');
      });
    });

    it('rejects empty-string role name', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(setActiveRole(client, '')).rejects.toBeInstanceOf(InvalidInputError);
      });
    });
  });

  describe('setPrivileges', () => {
    it('encodes privileges as a comma-separated string', async () => {
      await withTransaction(db.pool, async (client) => {
        await setPrivileges(client, ['can_export', 'can_admin']);
        const { rows } = await client.query<{ v: string }>(`SELECT current_setting('app.privileges', true) AS v`);
        expect(rows[0]?.v).toBe('can_export,can_admin');
      });
    });

    it('empty array → empty string', async () => {
      await withTransaction(db.pool, async (client) => {
        await setPrivileges(client, []);
        const { rows } = await client.query<{ v: string }>(`SELECT current_setting('app.privileges', true) AS v`);
        expect(rows[0]?.v).toBe('');
      });
    });

    it('rejects non-array input and comma-containing names', async () => {
      await withTransaction(db.pool, async (client) => {
        // @ts-expect-error testing runtime validation
        await expect(setPrivileges(client, 'a,b')).rejects.toBeInstanceOf(InvalidInputError);
        await expect(setPrivileges(client, ['a,b'])).rejects.toBeInstanceOf(InvalidInputError);
      });
    });
  });

  describe('setIdentityContext', () => {
    it('sets all four identity GUCs in one call', async () => {
      await withTransaction(db.pool, async (client) => {
        await setIdentityContext(client, {
          actorId: 7,
          sessionId: 'sess-hash',
          activeRole: 'user',
          privileges: ['can_export'],
        });
        const { rows } = await client.query<{ a: string; s: string; r: string; p: string }>(
          `SELECT
            current_setting('app.actor_id', true)    AS a,
            current_setting('app.session_id', true)  AS s,
            current_setting('app.active_role', true) AS r,
            current_setting('app.privileges', true)  AS p`,
        );
        expect(rows[0]).toEqual({ a: '7', s: 'sess-hash', r: 'user', p: 'can_export' });
      });
    });
  });

  describe('cross-transaction isolation', () => {
    it('does not leak identity GUCs to the next transaction on the same connection', async () => {
      const pool = new (await import('pg')).default.Pool({
        connectionString: db.connectionString,
        max: 1,
        options: `-c search_path=${db.schema}`,
      });
      try {
        await withTransaction(pool, async (client) => {
          await setIdentityContext(client, {
            actorId: 99,
            sessionId: 'leaked',
            activeRole: 'leaked-role',
            privileges: ['leaked-priv'],
          });
        });

        await withTransaction(pool, async (client) => {
          const { rows } = await client.query<{ a: string; s: string; r: string; p: string }>(
            `SELECT
              current_setting('app.actor_id', true)    AS a,
              current_setting('app.session_id', true)  AS s,
              current_setting('app.active_role', true) AS r,
              current_setting('app.privileges', true)  AS p`,
          );
          expect(rows[0]).toEqual({ a: '', s: '', r: '', p: '' });
        });
      } finally {
        await pool.end();
      }
    });
  });
});
