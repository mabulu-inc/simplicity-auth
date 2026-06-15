import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  InvalidInputError,
  SessionExpiredError,
  SessionNotFoundError,
  validateSession,
} from '../src/index.js';
import { hashToken } from '../src/internal/hash-token.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('validateSession', () => {
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

  it('returns the SessionInfo for a valid token', async () => {
    const created = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });

    const validated = await validateSession(db.pool, created.token);
    expect(validated.userId).toBe(db.ids.users.alice);
    expect(validated.expiresAt).toBeInstanceOf(Date);
    expect(validated.createdAt).toBeInstanceOf(Date);
    expect(validated.lastSeenAt).toBeNull();
  });

  it('throws SessionNotFoundError for an unknown token', async () => {
    await expect(validateSession(db.pool, 'unknown-token')).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('throws SessionExpiredError when expires_at is in the past', async () => {
    const created = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 hour' });
    await db.pool.query(`UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE session_id = $1`, [
      hashToken(created.token),
    ]);

    const err = await validateSession(db.pool, created.token).catch((e) => e as unknown);
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect((err as SessionExpiredError).code).toBe('SESSION_EXPIRED');
    expect((err as SessionExpiredError).expiresAt).toBeInstanceOf(Date);
  });

  it('throws InvalidInputError on empty input', async () => {
    await expect(validateSession(db.pool, '')).rejects.toBeInstanceOf(InvalidInputError);
  });

  it('rejects SQL-injection-shaped tokens via parameterization', async () => {
    const malicious = "x'; DROP TABLE sessions; --";
    await expect(validateSession(db.pool, malicious)).rejects.toBeInstanceOf(SessionNotFoundError);
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0]?.n).toBe(0);
  });
});
