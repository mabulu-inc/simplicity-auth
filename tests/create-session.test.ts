import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  InvalidInputError,
} from '../src/index.js';
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

  it('creates a session row and returns the populated Session', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '30 days',
    });

    expect(session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(session.userId).toBe(1);
    expect(session.createdAt).toBeInstanceOf(Date);
    expect(session.expiresAt).toBeInstanceOf(Date);
    // expiresAt should be ~30 days in the future
    const days =
      (session.expiresAt.getTime() - session.createdAt.getTime()) /
      (24 * 60 * 60 * 1000);
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });

  it('persists IP and geo metadata', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 day',
      ip: '203.0.113.42',
      geo: {
        city: 'Springfield',
        region: 'IL',
        country: 'US',
        latitude: '39.7817',
        longitude: '-89.6501',
      },
    });

    const { rows } = await db.pool.query(
      'SELECT ip, city, region, country, latitude, longitude FROM sessions WHERE session_id = $1',
      [session.sessionId],
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
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });

    const { rows } = await db.pool.query(
      'SELECT ip, city, region, country, latitude, longitude FROM sessions WHERE session_id = $1',
      [session.sessionId],
    );
    expect(rows[0]).toEqual({
      ip: null,
      city: null,
      region: null,
      country: null,
      latitude: null,
      longitude: null,
    });
  });

  it('throws InvalidInputError on missing ttl', async () => {
    await expect(
      createSession(db.pool, {
        userCommunicationMethodId: 1,
        ttl: '',
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('throws InvalidInputError on invalid userCommunicationMethodId', async () => {
    await expect(
      createSession(db.pool, {
        userCommunicationMethodId: -1,
        ttl: '1 hour',
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);

    await expect(
      createSession(db.pool, {
        // @ts-expect-error testing runtime validation
        userCommunicationMethodId: 'not-an-id',
        ttl: '1 hour',
      }),
    ).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rejects malicious ttl strings via the parameterized interval cast', async () => {
    // The library passes ttl as a parameter into `now() + ($3)::interval`,
    // so SQL injection via ttl is not possible. The cast just fails.
    await expect(
      createSession(db.pool, {
        userCommunicationMethodId: 1,
        ttl: "1 day'); DROP TABLE sessions; --",
      }),
    ).rejects.toThrow();
    // Confirm the table is intact
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0]?.n).toBe(0);
  });

  it('generates unique session IDs across calls', async () => {
    const a = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    const b = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    const c = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 hour' });
    expect(new Set([a.sessionId, b.sessionId, c.sessionId]).size).toBe(3);
  });
});
