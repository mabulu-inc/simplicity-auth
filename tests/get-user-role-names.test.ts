import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getUserRoleNames, InvalidInputError } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

describe('getUserRoleNames', () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await startTestDb();
  });

  afterAll(async () => {
    await db.shutdown();
  });

  it('returns roles for a single-tenant user', async () => {
    // Alice (userId 1) has the 'user' role on tenant 1
    const roles = await getUserRoleNames(db.pool, 1);
    expect(roles).toEqual(['user']);
  });

  it('returns deduplicated roles for a multi-tenant user', async () => {
    // Bob (userId 2) has the 'user' role on tenants 1 and 2 — should
    // come back as a single 'user' entry, not two.
    const roles = await getUserRoleNames(db.pool, 2);
    expect(roles).toEqual(['user']);
  });

  it('returns the correct role for a global admin', async () => {
    // GlobalAdmin (userId 3) has the 'settings' role with null tenant
    const roles = await getUserRoleNames(db.pool, 3);
    expect(roles).toEqual(['settings']);
  });

  it('returns an empty array for a user with no roles', async () => {
    // NoRoles (userId 4) has no user_roles rows
    const roles = await getUserRoleNames(db.pool, 4);
    expect(roles).toEqual([]);
  });

  it('returns an empty array for a non-existent userId', async () => {
    const roles = await getUserRoleNames(db.pool, 999999);
    expect(roles).toEqual([]);
  });

  it('throws InvalidInputError for non-positive userId', async () => {
    await expect(getUserRoleNames(db.pool, 0)).rejects.toThrow(
      InvalidInputError,
    );
    await expect(getUserRoleNames(db.pool, -1)).rejects.toThrow(
      InvalidInputError,
    );
  });
});
