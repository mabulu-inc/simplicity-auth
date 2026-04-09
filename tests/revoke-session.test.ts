import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  InvalidInputError,
  revokeSession,
  SessionNotFoundError,
  validateSession,
} from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('revokeSession', () => {
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

  it('hard-deletes the session row', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 day',
    });
    await revokeSession(db.pool, session.sessionId);

    const { rows } = await db.pool.query(
      'SELECT * FROM sessions WHERE session_id = $1',
      [session.sessionId],
    );
    expect(rows).toHaveLength(0);
  });

  it('makes a previously-valid session unfindable by validateSession', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 day',
    });
    // Sanity: it's valid
    await validateSession(db.pool, session.sessionId);
    await revokeSession(db.pool, session.sessionId);
    await expect(
      validateSession(db.pool, session.sessionId),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it('is idempotent — revoking a non-existent session is not an error', async () => {
    await expect(
      revokeSession(db.pool, '00000000-0000-0000-0000-000000000000'),
    ).resolves.toBeUndefined();
  });

  it('is idempotent — double-revoke is not an error', async () => {
    const session = await createSession(db.pool, {
      userCommunicationMethodId: 1,
      ttl: '1 day',
    });
    await revokeSession(db.pool, session.sessionId);
    await expect(
      revokeSession(db.pool, session.sessionId),
    ).resolves.toBeUndefined();
  });

  it('throws InvalidInputError on empty sessionId', async () => {
    await expect(revokeSession(db.pool, '')).rejects.toBeInstanceOf(
      InvalidInputError,
    );
  });
});
