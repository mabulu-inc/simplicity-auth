import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSession, withSession } from '../src/index.js';
import { flatTenantScope } from '../src/scope/flat-tenant.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

const scope = flatTenantScope();

async function tenantGucs(db: TestDb, ucmId: number, roleName?: string) {
  const session = await createSession(db.pool, { userCommunicationMethodId: ucmId, ttl: '1 hour' });
  return withSession(
    db.pool,
    { token: session.token, roleName },
    async (client) => {
      const { rows } = await client.query<{ t: string; a: string }>(
        `SELECT current_setting('app.tenant_ids', true) AS t, current_setting('app.all_tenants', true) AS a`,
      );
      return rows[0]!;
    },
    { scope },
  );
}

describe('flatTenantScope preset', () => {
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

  it('sets a single tenant id for a single-tenant user', async () => {
    const g = await tenantGucs(db, db.ids.ucm.alice, 'user'); // Alice, acme
    expect(g.t).toBe(String(db.ids.tenants.acme));
    expect(g.a).toBe('false');
  });

  it('sets multiple tenant ids for a multi-tenant user', async () => {
    const g = await tenantGucs(db, db.ids.ucm.bob, 'user'); // Bob, acme & globex
    expect(
      g.t
        .split(',')
        .map(Number)
        .sort((a, b) => a - b),
    ).toEqual([db.ids.tenants.acme, db.ids.tenants.globex].sort((a, b) => a - b));
    expect(g.a).toBe('false');
  });

  it('sets all_tenants=true for a wildcard (NULL tenant) member', async () => {
    const g = await tenantGucs(db, db.ids.ucm.globalAdmin, 'settings'); // GlobalAdmin, NULL tenant
    expect(g.a).toBe('true');
  });
});

describe('privilege export', () => {
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

  it('exports the user privileges, split from selectable roles', async () => {
    const session = await createSession(db.pool, { userCommunicationMethodId: db.ids.ucm.bob, ttl: '1 hour' }); // Bob
    const { ctx, guc } = await withSession(db.pool, { token: session.token, roleName: 'user' }, async (client, ctx) => {
      const { rows } = await client.query<{ p: string }>(`SELECT current_setting('app.privileges', true) AS p`);
      return { ctx, guc: rows[0]!.p };
    });

    // 'can_export' is a privilege (is_privilege=true), so it's in privileges,
    // not roles, and 'user' is a selectable role.
    expect(ctx.roles).toEqual(['user']);
    expect(ctx.privileges).toEqual(['can_export']);
    expect(guc).toBe('can_export');
  });
});
