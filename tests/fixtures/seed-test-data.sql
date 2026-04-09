-- Test-only seed data. Applied AFTER the canonical schema migration
-- (which seeds the standard 'user', 'settings', 'security' roles via
-- schema/post/001-seed-roles.sql).
--
-- This file is NOT shipped with the published package — it lives under
-- tests/fixtures/ and is only loaded by the test helper.
--
-- Test users:
--   1 Alice       — single tenant ('user' on tenant 1)
--   2 Bob         — multi-tenant ('user' on tenants 1 and 2)
--   3 GlobalAdmin — global ('settings' with NULL tenant_id)
--   4 NoRoles     — no user_roles rows at all

INSERT INTO tenants (tenant_id, name) VALUES
  (1, 'acme'),
  (2, 'globex')
ON CONFLICT DO NOTHING;

INSERT INTO communication_channels (communication_channel_id, name) VALUES
  (1, 'email'),
  (2, 'phone')
ON CONFLICT DO NOTHING;

INSERT INTO users (user_id, name) VALUES
  (1, 'Alice'),
  (2, 'Bob'),
  (3, 'GlobalAdmin'),
  (4, 'NoRoles')
ON CONFLICT DO NOTHING;

INSERT INTO user_communication_methods
  (user_communication_method_id, user_id, communication_channel_id, code) VALUES
  (1, 1, 1, 'alice@acme.com'),
  (2, 2, 1, 'bob@globex.com'),
  (3, 3, 1, 'admin@system.com'),
  (4, 4, 1, 'noroles@acme.com')
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES
  (1, (SELECT role_id FROM roles WHERE name = 'user'),     1),    -- Alice
  (2, (SELECT role_id FROM roles WHERE name = 'user'),     1),    -- Bob, tenant 1
  (2, (SELECT role_id FROM roles WHERE name = 'user'),     2),    -- Bob, tenant 2
  (3, (SELECT role_id FROM roles WHERE name = 'settings'), NULL)  -- GlobalAdmin
ON CONFLICT DO NOTHING;

-- Note: dev OTP enrollments are created at test runtime by the dev-otp
-- test file's beforeAll hook (using generateDevOtpSecret), not seeded
-- here. This keeps TOTP secrets out of the source tree and avoids
-- false positives from secret scanners.

-- Reset sequences past the manually-assigned IDs so subsequent test
-- INSERTs (e.g. the rollback test that inserts a new tenant) get fresh
-- autoincrement IDs without colliding.
SELECT setval('tenants_tenant_id_seq', (SELECT max(tenant_id) FROM tenants));
SELECT setval(
  'communication_channels_communication_channel_id_seq',
  (SELECT max(communication_channel_id) FROM communication_channels)
);
SELECT setval('users_user_id_seq', (SELECT max(user_id) FROM users));
SELECT setval(
  'user_communication_methods_user_communication_method_id_seq',
  (SELECT max(user_communication_method_id) FROM user_communication_methods)
);
SELECT setval('user_roles_user_role_id_seq', (SELECT max(user_role_id) FROM user_roles));
