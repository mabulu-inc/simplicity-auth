import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  InvalidInputError,
  setAllTenants,
  setRoleName,
  setSessionContext,
  setSessionId,
  setTenantIds,
  withTransaction,
} from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('set helpers', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.shutdown();
  });

  describe('setSessionId', () => {
    it('sets app.session_id and is parameterized', async () => {
      // Use a value that would be lethal if interpolated
      const malicious = "'; DROP TABLE sessions; --";

      await withTransaction(db.pool, async (client) => {
        await setSessionId(client, malicious);
        const { rows } = await client.query<{ v: string }>(
          `SELECT current_setting('app.session_id', true) AS v`,
        );
        expect(rows[0]?.v).toBe(malicious);
      });

      // Confirm sessions table is intact
      const { rows } = await db.pool.query(
        `SELECT to_regclass('sessions') AS exists`,
      );
      expect(rows[0]?.exists).toBe('sessions');
    });

    it('throws InvalidInputError on empty input', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(setSessionId(client, '')).rejects.toBeInstanceOf(
          InvalidInputError,
        );
      });
    });

    it('throws InvalidInputError on non-string input', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(
          // @ts-expect-error testing runtime validation
          setSessionId(client, 42),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });
    });
  });

  describe('setRoleName', () => {
    it('sets app.role_name with dollar-quote-injection-shaped input safely', async () => {
      const malicious = '$$; DROP TABLE roles; --';
      await withTransaction(db.pool, async (client) => {
        await setRoleName(client, malicious);
        const { rows } = await client.query<{ v: string }>(
          `SELECT current_setting('app.role_name', true) AS v`,
        );
        expect(rows[0]?.v).toBe(malicious);
      });
      const { rows } = await db.pool.query(
        `SELECT to_regclass('roles') AS exists`,
      );
      expect(rows[0]?.exists).toBe('roles');
    });

    it('rejects empty role name', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(setRoleName(client, '')).rejects.toBeInstanceOf(
          InvalidInputError,
        );
      });
    });
  });

  describe('setTenantIds', () => {
    it('encodes the array as a comma-separated string', async () => {
      await withTransaction(db.pool, async (client) => {
        await setTenantIds(client, [1, 2, 3]);
        const { rows } = await client.query<{ v: string }>(
          `SELECT current_setting('app.tenant_ids', true) AS v`,
        );
        expect(rows[0]?.v).toBe('1,2,3');
      });
    });

    it('handles empty array as empty string', async () => {
      await withTransaction(db.pool, async (client) => {
        await setTenantIds(client, []);
        const { rows } = await client.query<{ v: string }>(
          `SELECT current_setting('app.tenant_ids', true) AS v`,
        );
        expect(rows[0]?.v).toBe('');
      });
    });

    it('rejects non-integer values', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(
          setTenantIds(client, [1, 2.5, 3]),
        ).rejects.toBeInstanceOf(InvalidInputError);
        await expect(
          // @ts-expect-error testing runtime validation
          setTenantIds(client, [1, 'two', 3]),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });
    });

    it('rejects non-array input', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(
          // @ts-expect-error testing runtime validation
          setTenantIds(client, '1,2,3'),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });
    });
  });

  describe('setAllTenants', () => {
    it('sets app.all_tenants to "true"', async () => {
      await withTransaction(db.pool, async (client) => {
        await setAllTenants(client, true);
        const { rows } = await client.query<{ v: string }>(
          `SELECT current_setting('app.all_tenants', true) AS v`,
        );
        expect(rows[0]?.v).toBe('true');
      });
    });

    it('sets app.all_tenants to "false"', async () => {
      await withTransaction(db.pool, async (client) => {
        await setAllTenants(client, false);
        const { rows } = await client.query<{ v: string }>(
          `SELECT current_setting('app.all_tenants', true) AS v`,
        );
        expect(rows[0]?.v).toBe('false');
      });
    });

    it('rejects non-boolean input', async () => {
      await withTransaction(db.pool, async (client) => {
        await expect(
          // @ts-expect-error testing runtime validation
          setAllTenants(client, 'true'),
        ).rejects.toBeInstanceOf(InvalidInputError);
      });
    });
  });

  describe('setSessionContext', () => {
    it('sets all four variables in one call', async () => {
      await withTransaction(db.pool, async (client) => {
        await setSessionContext(client, {
          sessionId: 'sess-1',
          roleName: 'user',
          tenantIds: [1, 2],
          allTenants: false,
        });
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
        expect(rows[0]).toEqual({
          s: 'sess-1',
          r: 'user',
          t: '1,2',
          a: 'false',
        });
      });
    });
  });

  describe('cross-transaction isolation', () => {
    it('does not leak any session variable to the next transaction on the same connection', async () => {
      // Force a single-connection pool to maximize the chance of physical
      // connection reuse between transactions.
      const pool = new (await import('pg')).default.Pool({
        connectionString: db.connectionString,
        max: 1,
      });
      try {
        await withTransaction(pool, async (client) => {
          await setSessionContext(client, {
            sessionId: 'leaked-id',
            roleName: 'leaked-role',
            tenantIds: [99],
            allTenants: true,
          });
        });

        await withTransaction(pool, async (client) => {
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
        });
      } finally {
        await pool.end();
      }
    });
  });
});
