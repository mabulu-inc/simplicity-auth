import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withServiceContext, InvalidInputError } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('withServiceContext', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it('sets session_id, role_name, and all_tenants as session-scoped GUCs', async () => {
    const gucs = await withServiceContext(
      db.pool,
      'test-service',
      async (client) => {
        const { rows } = await client.query<{
          sid: string;
          role: string;
          all: string;
        }>(`
          SELECT
            current_setting('app.session_id') AS sid,
            current_setting('app.role_name') AS role,
            current_setting('app.all_tenants') AS "all"
        `);
        return rows[0]!;
      },
    );

    expect(gucs.sid).toBe('test-service');
    expect(gucs.role).toBe('settings');
    expect(gucs.all).toBe('true');
  });

  it('returns the callback result', async () => {
    const result = await withServiceContext(
      db.pool,
      'test-service',
      async () => 42,
    );
    expect(result).toBe(42);
  });

  it('releases the client even on error', async () => {
    const before = db.pool.totalCount;
    await expect(
      withServiceContext(db.pool, 'test-service', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // Pool count should not have grown (client was released, not leaked)
    expect(db.pool.totalCount).toBe(before);
  });

  it('throws InvalidInputError on empty serviceName', async () => {
    await expect(
      withServiceContext(db.pool, '', async () => {}),
    ).rejects.toThrow(InvalidInputError);
  });
});
