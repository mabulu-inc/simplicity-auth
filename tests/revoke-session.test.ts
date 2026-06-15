import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createSession,
  InvalidInputError,
  revokeSession,
  revokeTenantSessions,
  revokeUserSessions,
  SessionExpiredError,
  validateSession,
} from '../src/index.js';
import { hashToken } from '../src/internal/hash-token.js';
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

  it('soft-expires the session row', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    await revokeSession(db.pool, session.token);

    const { rows } = await db.pool.query<{ expires_at: Date }>(
      'SELECT expires_at FROM sessions WHERE session_id = $1',
      [hashToken(session.token)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.expires_at.getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('makes a previously-valid session fail validateSession', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    await validateSession(db.pool, session.token);
    await revokeSession(db.pool, session.token);
    await expect(validateSession(db.pool, session.token)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it('is idempotent — revoking unknown / already-revoked is not an error', async () => {
    await expect(revokeSession(db.pool, 'no-such-token')).resolves.toBeUndefined();
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    await revokeSession(db.pool, session.token);
    await expect(revokeSession(db.pool, session.token)).resolves.toBeUndefined();
  });

  it('throws InvalidInputError on empty token', async () => {
    await expect(revokeSession(db.pool, '')).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('revokeUserSessions', () => {
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

  it('revokes every active session for the user', async () => {
    const a = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    const b = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    await revokeUserSessions(db.pool, db.ids.users.alice);

    await expect(validateSession(db.pool, a.token)).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(validateSession(db.pool, b.token)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("does not touch a different user's sessions", async () => {
    const alice = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    const bob = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.bob, ttl: '1 day' });
    await revokeUserSessions(db.pool, db.ids.users.alice);

    await expect(validateSession(db.pool, alice.token)).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(validateSession(db.pool, bob.token)).resolves.toMatchObject({ userId: db.ids.users.bob });
  });

  it('throws InvalidInputError on a bad userId', async () => {
    await expect(revokeUserSessions(db.pool, 0)).rejects.toBeInstanceOf(InvalidInputError);
  });
});

describe('revokeTenantSessions', () => {
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

  it('signs off members of the tenant but not wildcard (NULL) members', async () => {
    // Seed: Alice is on acme; Bob on acme and globex; GlobalAdmin is a
    // wildcard member (tenant_id IS NULL).
    const alice = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    const bob = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.bob, ttl: '1 day' });
    const admin = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.globalAdmin, ttl: '1 day' });

    await revokeTenantSessions(db.pool, db.ids.tenants.acme);

    // Alice and Bob are explicit members of tenant 1 → signed off.
    await expect(validateSession(db.pool, alice.token)).rejects.toBeInstanceOf(SessionExpiredError);
    await expect(validateSession(db.pool, bob.token)).rejects.toBeInstanceOf(SessionExpiredError);
    // GlobalAdmin is a wildcard member of no single tenant → untouched.
    await expect(validateSession(db.pool, admin.token)).resolves.toMatchObject({ userId: db.ids.users.globalAdmin });
  });

  it('leaves other tenants alone', async () => {
    // Only revoke globex; Alice (acme only) keeps her session.
    const alice = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.alice, ttl: '1 day' });
    await revokeTenantSessions(db.pool, db.ids.tenants.globex);
    await expect(validateSession(db.pool, alice.token)).resolves.toMatchObject({ userId: db.ids.users.alice });
  });

  it('throws InvalidInputError on a bad tenantId', async () => {
    await expect(revokeTenantSessions(db.pool, -1)).rejects.toBeInstanceOf(InvalidInputError);
  });
});
