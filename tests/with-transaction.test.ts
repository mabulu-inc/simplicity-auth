import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withTransaction } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('withTransaction', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it('runs the callback inside an open transaction and commits on success', async () => {
    const result = await withTransaction(db.pool, async (client) => {
      const { rows } = await client.query<{ in_xact: boolean }>(
        // pg_current_xact_id() throws if not in a transaction
        `SELECT pg_current_xact_id() IS NOT NULL AS in_xact`,
      );
      expect(rows[0]?.in_xact).toBe(true);
      return 'ok';
    });
    expect(result).toBe('ok');
  });

  it('rolls back when the callback throws', async () => {
    const before = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenants WHERE name = 'rollback-canary'`,
    );
    expect(before.rows[0]?.n).toBe(0);

    await expect(
      withTransaction(db.pool, async (client) => {
        await client.query(
          `INSERT INTO tenants (name) VALUES ('rollback-canary')`,
        );
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    const after = await db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM tenants WHERE name = 'rollback-canary'`,
    );
    expect(after.rows[0]?.n).toBe(0);
  });

  it('releases the connection back to the pool even on throw', async () => {
    const initialIdle = db.pool.idleCount;
    await expect(
      withTransaction(db.pool, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // After release, idle count should not be lower than where we started
    expect(db.pool.idleCount).toBeGreaterThanOrEqual(initialIdle);
  });

  it('does not leak transaction-scoped session variables across calls', async () => {
    // Use set_config inside one transaction and verify it's gone in the next
    await withTransaction(db.pool, async (client) => {
      await client.query(`SELECT set_config('app.session_id', 'leak-test', true)`);
      const { rows } = await client.query<{ v: string }>(
        `SELECT current_setting('app.session_id', true) AS v`,
      );
      expect(rows[0]?.v).toBe('leak-test');
    });

    await withTransaction(db.pool, async (client) => {
      const { rows } = await client.query<{ v: string }>(
        `SELECT current_setting('app.session_id', true) AS v`,
      );
      // Setting was transaction-local, so the new transaction sees empty
      expect(rows[0]?.v).toBe('');
    });
  });
});
