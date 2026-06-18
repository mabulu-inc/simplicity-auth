import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import pg from 'pg';
import { isDevOtpEnrolled } from '../src/index.js';
import { startTestDb, type TestDb } from './helpers/test-db.js';

// Every table the library ships. app_user — the role the app/admin pool runs
// as — needs full CRUD on all of them: reads and writes go through that pool,
// so a missing grant throws `permission denied` (42501) at runtime. It only
// shows up in staging/prod, because the test admin pool is a superuser that
// holds every privilege — which is exactly how the dev_otp_enrollments grant
// was missed. These tests connect AS app_user so that gap can't reopen.
const AUTH_TABLES = [
  'users',
  'sessions',
  'user_communication_methods',
  'communication_channels',
  'user_roles',
  'roles',
  'tenants',
  'auth_domains',
  'dev_otp_enrollments',
];
const CRUD = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];

let db: TestDb;
// A pool authenticated as the non-superuser app_user role.
let appUser: pg.Pool;

beforeAll(async () => {
  db = await startTestDb();
  appUser = new pg.Pool({ connectionString: db.appUserConnectionString, max: 2 });
});

afterAll(async () => {
  await appUser.end();
  await db.shutdown();
});

describe('app_user grants', () => {
  it('lets app_user read dev_otp_enrollments — the read that silently broke OTP sign-in', async () => {
    // isDevOtpEnrolled runs before an OTP send, through the app/admin pool.
    // When app_user lacked SELECT here the read threw 42501, the send aborted,
    // and /sign-in still returned 200 for anti-enumeration — so no code was
    // ever delivered and the failure was invisible. Run the real function as
    // app_user; a permission error would reject this call.
    await expect(isDevOtpEnrolled(appUser, db.ids.ucm.alice)).resolves.toBe(false);
  });

  it('grants app_user full CRUD on every auth table', async () => {
    // has_table_privilege answers regardless of the connected role, so the
    // superuser pool can introspect app_user's grants directly. A new auth
    // table that forgets the auth_grants mixin fails here.
    const { rows } = await db.pool.query<{ table_name: string; privilege: string; ok: boolean }>(
      `SELECT t.table_name, p.privilege,
              has_table_privilege('app_user', 'public.' || t.table_name, p.privilege) AS ok
         FROM unnest($1::text[]) AS t(table_name)
         CROSS JOIN unnest($2::text[]) AS p(privilege)`,
      [AUTH_TABLES, CRUD],
    );
    for (const row of rows) {
      expect(row.ok, `app_user is missing ${row.privilege} on ${row.table_name}`).toBe(true);
    }
  });

  it('grants app_user USAGE on the serial PK sequences so INSERTs do not trip a sequence-permission error', async () => {
    // schema-flow auto-derives `GRANT USAGE, SELECT ON SEQUENCE` from a table's
    // INSERT grant for serial/bigserial columns; tenants.tenant_id is one. This
    // guards the gotcha where a table grant alone still fails the INSERT.
    const { rows } = await db.pool.query<{ ok: boolean }>(
      `SELECT has_sequence_privilege('app_user', 'public.tenants_tenant_id_seq', 'USAGE') AS ok`,
    );
    expect(rows[0]?.ok).toBe(true);
  });
});
