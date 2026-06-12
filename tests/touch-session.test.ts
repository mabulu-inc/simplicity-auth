import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession, InvalidInputError, revokeSession, touchSession } from '../src/index.js';
import { hashToken } from '../src/internal/hash-token.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('touchSession', () => {
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

  it('stamps last_seen_at and returns true for a live session', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 day' });
    const touched = await touchSession(db.pool, session.token);
    expect(touched).toBe(true);

    const { rows } = await db.pool.query<{ last_seen_at: Date | null }>(
      'SELECT last_seen_at FROM sessions WHERE session_id = $1',
      [hashToken(session.token)],
    );
    expect(rows[0]?.last_seen_at).toBeInstanceOf(Date);
  });

  it('returns false for an unknown token', async () => {
    expect(await touchSession(db.pool, 'no-such-token')).toBe(false);
  });

  it('does not resurrect a revoked session (returns false)', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: 1, ttl: '1 day' });
    await revokeSession(db.pool, session.token);
    expect(await touchSession(db.pool, session.token)).toBe(false);
  });

  it('throws InvalidInputError on empty token', async () => {
    await expect(touchSession(db.pool, '')).rejects.toBeInstanceOf(InvalidInputError);
  });
});
