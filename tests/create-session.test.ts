import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession, InvalidInputError } from '../src/index.js';
import { hashToken } from '../src/internal/hash-token.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('createSession', () => {
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

  it('returns a raw opaque token and stores only its hash', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '30 days' });

    // 32 random bytes, base64url → 43 chars, URL/cookie-safe.
    expect(session.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.userId).toBe(2);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.expiresAt).toBeInstanceOf(Date);

    // The stored primary key is the hash, never the raw token.
    const { rows } = await db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions WHERE session_id = $1',
      [hashToken(session.token)],
    );
    expect(rows[0]?.n).toBe(1);
    const raw = await db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM sessions WHERE session_id = $1', [
      session.token,
    ]);
    expect(raw.rows[0]?.n).toBe(0);

    const days = (session.expiresAt.getTime() - session.createdAt.getTime()) / (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('round-trips a bigint user id beyond int4 range', async () => {
    // > 2^32, which an int4 column would reject — proves the ids are int8 —
    // and within JS safe-integer range so it still returns as a `number`.
    const BIG_USER = 5_000_000_000;
    const BIG_UCM = 5_000_000_001;
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SELECT set_config('app.actor_id', '1', true)`);
      await client.query(`INSERT INTO users (user_id, name, kind) VALUES ($1, 'BigInt User', 'human')`, [BIG_USER]);
      await client.query(
        `INSERT INTO user_communication_methods (user_communication_method_id, user_id, communication_channel_id, code)
         VALUES ($1, $2, 1, 'bigint@example.test')`,
        [BIG_UCM, BIG_USER],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const session = await createSession(db.pool, { userCommunicationMethodId: BIG_UCM, ttl: '1 hour' });
    expect(session.userId).toBe(BIG_USER);
    expect(typeof session.userId).toBe('number');
  });

  it('persists IP and geo metadata', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 day',
      ip: '203.0.113.42',
      geo: { city: 'Springfield', region: 'IL', country: 'US', latitude: '39.7817', longitude: '-89.6501' },
    });

    const { rows } = await db.pool.query(
      'SELECT ip, city, region, country, latitude, longitude FROM sessions WHERE session_id = $1',
      [hashToken(session.token)],
    );
    expect(rows[0]).toEqual({
      ip: '203.0.113.42',
      city: 'Springfield',
      region: 'IL',
      country: 'US',
      latitude: '39.7817',
      longitude: '-89.6501',
    });
  });

  it('omits geo fields when not provided', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });

    const { rows } = await db.pool.query(
      'SELECT ip, city, region, country, latitude, longitude FROM sessions WHERE session_id = $1',
      [hashToken(session.token)],
    );
    expect(rows[0]).toEqual({ ip: null, city: null, region: null, country: null, latitude: null, longitude: null });
  });

  it('throws InvalidInputError on missing ttl', async () => {
    await expect(createSession(db.pool, { userCommunicationMethodId: 1, ttl: '' })).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('throws InvalidInputError on invalid userCommunicationMethodId', async () => {
    await expect(createSession(db.pool, { userCommunicationMethodId: -1, ttl: '1 hour' })).rejects.toBeInstanceOf(
      InvalidInputError,
    );

    await expect(
      // @ts-expect-error testing runtime validation
      createSession(db.pool, { userCommunicationMethodId: 'not-an-id', ttl: '1 hour' }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rejects malicious ttl strings via the parameterized interval cast', async () => {
    await expect(
      createSession(db.pool, { userCommunicationMethodId: 1, ttl: "1 day'); DROP TABLE sessions; --" }),
    ).rejects.toThrow();
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0]?.n).toBe(0);
  });

  it('generates unique tokens across calls', async () => {
    const a = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    const b = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    const c = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
  });
});
