import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  InvalidInputError,
  SessionExpiredError,
  SessionNotFoundError,
  validateSession,
} from '../src/index.js';
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

  it('returns the Session for a valid sessionId', async () => {
    const created = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });

    const validated = await validateSession(db.pool, created.sessionId);
    expect(validated.sessionId).toBe(created.sessionId);
    expect(validated.userId).toBe(1);
    expect(validated.expiresAt).toBeInstanceOf(Date);
  });

  it('throws SessionNotFoundError for an unknown sessionId', async () => {
    await expect(
      validateSession(db.pool, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('throws SessionExpiredError when expires_at is in the past', async () => {
    const created = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 hour',
    });
    // Force the row's expires_at backward
    await db.pool.query(
      `UPDATE sessions SET expires_at = now() - interval '1 minute' WHERE session_id = $1`,
      [created.sessionId],
    );

    const err = await validateSession(db.pool, created.sessionId).catch(
      (e) => e as unknown,
    );
    expect(err).toBeInstanceOf(SessionExpiredError);
    expect((err as SessionExpiredError).code).toBe('SESSION_EXPIRED');
    expect((err as SessionExpiredError).expiresAt).toBeInstanceOf(Date);
  });

  it('throws InvalidInputError on empty input', async () => {
    await expect(validateSession(db.pool, '')).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });

  it('rejects SQL-injection-shaped sessionIds via parameterization', async () => {
    // Inject a payload that would be lethal if string-concatenated
    const malicious = "x'; DROP TABLE sessions; --";
    await expect(
      validateSession(db.pool, malicious),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
    // Confirm the table is intact
    const { rows } = await db.pool.query('SELECT count(*)::int AS n FROM sessions');
    expect(rows[0]?.n).toBe(0);
  });
});
