import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withServiceContext, InvalidInputError, ServicePrincipalNotFoundError } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('withServiceContext', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it("sets app.actor_id to the service principal's user_id (and session_id to its name)", async () => {
    const gucs = await withServiceContext(db.pool, 'transform-worker', async (client) => {
      const { rows } = await client.query<{ actor: string; sid: string; cui: number }>(
        `SELECT
            current_setting('app.actor_id', true)   AS actor,
            current_setting('app.session_id', true) AS sid,
            current_user_id()                        AS cui`,
      );
      return rows[0]!;
    });

    expect(gucs.actor).toBe('6'); // transform-worker = user 6 in the fixture
    expect(gucs.sid).toBe('transform-worker');
    expect(gucs.cui).toBe(6);
  });

  it('returns the callback result', async () => {
    const result = await withServiceContext(db.pool, 'transform-worker', async () => 42);
    expect(result).toBe(42);
  });

  it('rolls back and releases the client on error', async () => {
    const before = db.pool.totalCount;
    await expect(
      withServiceContext(db.pool, 'transform-worker', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(db.pool.totalCount).toBe(before);
  });

  it('throws ServicePrincipalNotFoundError for an unknown service', async () => {
    await expect(withServiceContext(db.pool, 'no-such-service', async () => {})).rejects.toBeInstanceOf(
      ServicePrincipalNotFoundError,
    );
  });

  it("throws ServicePrincipalNotFoundError for a human user's name", async () => {
    // 'Alice' is kind='human', not a service principal.
    await expect(withServiceContext(db.pool, 'Alice', async () => {})).rejects.toBeInstanceOf(
      ServicePrincipalNotFoundError,
    );
  });

  it('throws InvalidInputError on empty serviceName', async () => {
    await expect(withServiceContext(db.pool, '', async () => {})).rejects.toBeInstanceOf(InvalidInputError);
  });
});
