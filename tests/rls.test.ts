import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { startTestDb, type TestDb } from './helpers/test-db.js';

// Role-aware, tenant-scoped RLS on the auth tables, exercised AS app_rls.
// We impersonate different actors by setting app.actor_id inside an app_rls
// transaction (always rolled back, so write-authority probes don't persist),
// which is exactly what the policies key on via current_user_id().

let db: TestDb;
let appRls: pg.Pool;

// Personas created in setup (beyond the fixtures' Alice = 'user' on acme,
// GlobalAdmin = 'settings' wildcard).
let secAcme: number; // security on acme
let setAcme: number; // settings on acme (not global)
let secGlobal: number; // security wildcard (global)

// Create a user + email + one role assignment as the superuser pool (which
// bypasses RLS); actor set local so the audit triggers stamp created_by.
async function makeUser(name: string, email: string, roleId: number, tenantId: number | null): Promise<number> {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.actor_id', $1, true)`, [String(db.ids.appInit)]);
    const u = await c.query<{ user_id: string }>(
      `INSERT INTO users (name, kind) VALUES ($1, 'human') RETURNING user_id`,
      [name],
    );
    const userId = Number(u.rows[0]!.user_id);
    await c.query(
      `INSERT INTO user_communication_methods (user_id, communication_channel_id, code) VALUES ($1, $2, $3)`,
      [userId, db.ids.channels.email, email],
    );
    await c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)`, [
      userId,
      roleId,
      tenantId,
    ]);
    await c.query('COMMIT');
    return userId;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}

// Run fn as app_rls impersonating `actorId`, in a transaction that is always
// rolled back so authority probes leave no trace.
async function asUser<T>(actorId: number, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await appRls.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.actor_id', $1, true)`, [String(actorId)]);
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => {});
    c.release();
  }
}

const provision = (over: Record<string, unknown>) =>
  JSON.stringify({
    name: 'Provisioned',
    communication_methods: [{ channel: 'email', code: 'provisioned@example.com' }],
    accesses: [{ tenant_id: db.ids.tenants.acme, role_id: db.ids.roles.user }],
    ...over,
  });

beforeAll(async () => {
  db = await startTestDb();
  appRls = new pg.Pool({ connectionString: db.appRlsConnectionString, max: 4 });
  secAcme = await makeUser('SecAcme', 'secacme@acme.com', db.ids.roles.security, db.ids.tenants.acme);
  setAcme = await makeUser('SetAcme', 'setacme@acme.com', db.ids.roles.settings, db.ids.tenants.acme);
  secGlobal = await makeUser('SecGlobal', 'secglobal@system.com', db.ids.roles.security, null);
});

afterAll(async () => {
  await appRls.end();
  await db.shutdown();
});

describe('users visibility', () => {
  it('a plain user sees only themselves', async () => {
    const rows = await asUser(db.ids.users.alice, (c) =>
      c.query<{ user_id: string }>(`SELECT user_id FROM users`).then((r) => r.rows.map((x) => Number(x.user_id))),
    );
    expect(rows).toEqual([db.ids.users.alice]);
  });

  it('a security admin sees the users in their tenant but not a global admin', async () => {
    const rows = await asUser(secAcme, (c) =>
      c.query<{ user_id: string }>(`SELECT user_id FROM users`).then((r) => r.rows.map((x) => Number(x.user_id))),
    );
    expect(rows).toEqual(expect.arrayContaining([db.ids.users.alice, db.ids.users.bob, secAcme, setAcme]));
    expect(rows).not.toContain(db.ids.users.globalAdmin);
  });
});

describe('user provisioning (auth_create_user)', () => {
  it('a security admin can provision a user into their own tenant', async () => {
    const id = await asUser(secAcme, (c) =>
      c.query<{ id: string }>(`SELECT auth_create_user($1::jsonb) AS id`, [provision({})]).then((r) => r.rows[0]!.id),
    );
    expect(Number(id)).toBeGreaterThan(0);
  });

  it('refuses provisioning into a tenant the admin does not administer', async () => {
    await expect(
      asUser(secAcme, (c) =>
        c.query(`SELECT auth_create_user($1::jsonb)`, [
          provision({ accesses: [{ tenant_id: db.ids.tenants.globex, role_id: db.ids.roles.user }] }),
        ]),
      ),
    ).rejects.toThrow(/not authorized/i);
  });

  it('refuses a tenant-scoped admin creating a global user', async () => {
    await expect(
      asUser(secAcme, (c) =>
        c.query(`SELECT auth_create_user($1::jsonb)`, [provision({ accesses: [{ role_id: db.ids.roles.user }] })]),
      ),
    ).rejects.toThrow(/not authorized/i);
  });

  it('lets a global security admin create a global user', async () => {
    const id = await asUser(secGlobal, (c) =>
      c
        .query<{
          id: string;
        }>(`SELECT auth_create_user($1::jsonb) AS id`, [provision({ accesses: [{ role_id: db.ids.roles.user }] })])
        .then((r) => r.rows[0]!.id),
    );
    expect(Number(id)).toBeGreaterThan(0);
  });

  it('requires at least one access and one communication method', async () => {
    await expect(
      asUser(secAcme, (c) => c.query(`SELECT auth_create_user($1::jsonb)`, [provision({ accesses: [] })])),
    ).rejects.toThrow(/at least one access/i);
    await expect(
      asUser(secAcme, (c) => c.query(`SELECT auth_create_user($1::jsonb)`, [provision({ communication_methods: [] })])),
    ).rejects.toThrow(/at least one communication/i);
  });

  it('blocks a raw INSERT on users (creation must go through auth_create_user)', async () => {
    // Denied at the grant layer now (app_rls holds no INSERT on users) — even
    // before RLS is consulted. Defense in depth: the RLS policy is the second
    // gate, the missing grant is the first.
    await expect(
      asUser(secAcme, (c) => c.query(`INSERT INTO users (name, kind) VALUES ('raw', 'human')`)),
    ).rejects.toThrow(/permission denied|row-level security/i);
  });
});

describe('user_roles authority', () => {
  it('a security admin can grant a role in their tenant but not in another', async () => {
    await expect(
      asUser(secAcme, (c) =>
        c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)`, [
          db.ids.users.alice,
          db.ids.roles.settings,
          db.ids.tenants.acme,
        ]),
      ),
    ).resolves.toBeDefined();

    await expect(
      asUser(secAcme, (c) =>
        c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, $3)`, [
          db.ids.users.bob,
          db.ids.roles.user,
          db.ids.tenants.globex,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('only a global security admin can grant an all-tenants role', async () => {
    await expect(
      asUser(secAcme, (c) =>
        c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, NULL)`, [
          db.ids.users.alice,
          db.ids.roles.user,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);

    await expect(
      asUser(secGlobal, (c) =>
        c.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1, $2, NULL)`, [
          db.ids.users.alice,
          db.ids.roles.user,
        ]),
      ),
    ).resolves.toBeDefined();
  });
});

describe('tenants and auth_domains (settings domain)', () => {
  it('only a global settings admin can create a tenant', async () => {
    await expect(
      asUser(db.ids.users.globalAdmin, (c) => c.query(`INSERT INTO tenants (name, slug) VALUES ('newco', 'newco')`)),
    ).resolves.toBeDefined();

    await expect(
      asUser(setAcme, (c) => c.query(`INSERT INTO tenants (name, slug) VALUES ('nope', 'nope')`)),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a settings admin maintains auth_domains only for tenants they administer', async () => {
    await expect(
      asUser(setAcme, (c) =>
        c.query(`INSERT INTO auth_domains (tenant_id, display_name, integration_type) VALUES ($1, 'New IdP', 'oidc')`, [
          db.ids.tenants.acme,
        ]),
      ),
    ).resolves.toBeDefined();

    await expect(
      asUser(setAcme, (c) =>
        c.query(`INSERT INTO auth_domains (tenant_id, display_name, integration_type) VALUES ($1, 'New IdP', 'oidc')`, [
          db.ids.tenants.globex,
        ]),
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it('a tenant is visible only to its members', async () => {
    const rows = await asUser(db.ids.users.alice, (c) =>
      c.query<{ slug: string }>(`SELECT slug FROM tenants`).then((r) => r.rows.map((x) => x.slug)),
    );
    expect(rows).toEqual(['acme']);
  });
});

describe('admins do not require the user role', () => {
  it('a security-only admin holds no user role yet has full self-service and admin reach', async () => {
    // secAcme holds only `security` on acme — no `user` role. Nothing in the
    // policies keys on `user`, so this is a complete principal on its own.
    const ownRoles = await asUser(secAcme, (c) =>
      c
        .query<{
          name: string;
        }>(
          `SELECT r.name FROM user_roles ur JOIN roles r ON r.role_id = ur.role_id WHERE ur.user_id = current_user_id()`,
        )
        .then((r) => r.rows.map((x) => x.name)),
    );
    expect(ownRoles).toEqual(['security']); // no 'user' role granted

    // Self-service: sees its own user row and its own contact methods.
    const self = await asUser(secAcme, (c) =>
      c.query(`SELECT 1 FROM users WHERE user_id = current_user_id()`).then((r) => r.rowCount),
    );
    expect(self).toBe(1);

    // Admin reach: manages a tenant member without holding `user`. A real
    // change (not a no-op, which the audit_skip_noop trigger would cancel).
    await expect(
      asUser(secAcme, (c) =>
        c.query(`UPDATE users SET name = 'Alice (edited)' WHERE user_id = $1`, [db.ids.users.alice]),
      ).then((r) => r.rowCount),
    ).resolves.toBe(1);
  });
});
