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
    // Alice has the 'user' role on acme
    const roles = await getUserRoleNames(db.pool, db.ids.users.alice);
    expect(roles).toEqual(['user']);
  });

  it('returns deduplicated roles for a multi-tenant user', async () => {
    // Bob has the 'user' role on acme and globex (deduped to a single entry)
    // plus the 'can_export' privilege. getUserRoleNames returns every role
    // row the user holds — privileges included — alphabetically.
    const roles = await getUserRoleNames(db.pool, db.ids.users.bob);
    expect(roles).toEqual(['can_export', 'user']);
  });

  it('returns the correct role for a global admin', async () => {
    // GlobalAdmin has the 'settings' role with null tenant
    const roles = await getUserRoleNames(db.pool, db.ids.users.globalAdmin);
    expect(roles).toEqual(['settings']);
  });

  it('returns an empty array for a user with no roles', async () => {
    // NoRoles has no user_roles rows
    const roles = await getUserRoleNames(db.pool, db.ids.users.noRoles);
    expect(roles).toEqual([]);
  });

  it('returns an empty array for a non-existent userId', async () => {
    const roles = await getUserRoleNames(db.pool, 999999);
    expect(roles).toEqual([]);
  });

  it('throws InvalidInputError for non-positive userId', async () => {
    await expect(getUserRoleNames(db.pool, 0)).rejects.toThrow(InvalidInputError);
    await expect(getUserRoleNames(db.pool, -1)).rejects.toThrow(InvalidInputError);
  });
});
