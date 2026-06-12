-- Test-only seed data. Applied AFTER the canonical schema migration
-- (which seeds the standard 'user', 'settings', 'security' roles via
-- the seeds: block in schema/tables/roles.yaml).
--
-- This file is NOT shipped with the published package — it lives under
-- tests/fixtures/ and is only loaded by the test helper.
--
-- user_id=1 is the shipped app-init service principal (seeded by the
-- migration). Test users therefore start at 2:
--   2 Alice            — single tenant ('user' on tenant 1)
--   3 Bob              — multi-tenant ('user' on tenants 1 and 2) + 'can_export' privilege
--   4 GlobalAdmin      — global ('settings' with NULL tenant_id)
--   5 NoRoles          — no user_roles rows at all
--   6 transform-worker — service principal (kind='service'), no session
--
-- This whole file runs with app.actor_id = '1' (set by the test helper) so
-- the audit triggers stamp created_by/updated_by on every audited insert.

-- Tenants exercise the three sign-in shapes:
--   1 acme    (slug 'acme')    — two OIDC IdPs, SSO-only (allow_otp=false) → chooser
--   2 globex  (slug 'globex')  — one OIDC IdP, OTP also allowed          → auto-redirect
--   3 initech (slug 'initech') — no IdP                                  → OTP only
INSERT INTO tenants (tenant_id, name, slug, allow_otp) VALUES
  (1, 'acme', 'acme', false),
  (2, 'globex', 'globex', true),
  (3, 'initech', 'initech', true)
ON CONFLICT DO NOTHING;

INSERT INTO communication_channels (communication_channel_id, name) VALUES
  (1, 'email'),
  (2, 'phone')
ON CONFLICT DO NOTHING;

-- A privilege (is_privilege=true) for exercising app.privileges export.
INSERT INTO roles (role_id, name, display_name, is_privilege) VALUES
  (100, 'can_export', 'Can Export', true)
ON CONFLICT DO NOTHING;

INSERT INTO users (user_id, name, kind) VALUES
  (2, 'Alice', 'human'),
  (3, 'Bob', 'human'),
  (4, 'GlobalAdmin', 'human'),
  (5, 'NoRoles', 'human'),
  (6, 'transform-worker', 'service')
ON CONFLICT DO NOTHING;

INSERT INTO user_communication_methods
  (user_communication_method_id, user_id, communication_channel_id, code) VALUES
  (1, 2, 1, 'alice@acme.com'),
  (2, 3, 1, 'bob@globex.com'),
  (3, 4, 1, 'admin@system.com'),
  (4, 5, 1, 'noroles@acme.com')
ON CONFLICT DO NOTHING;

INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES
  (2, (SELECT role_id FROM roles WHERE name = 'user'),       1),    -- Alice
  (3, (SELECT role_id FROM roles WHERE name = 'user'),       1),    -- Bob, tenant 1
  (3, (SELECT role_id FROM roles WHERE name = 'user'),       2),    -- Bob, tenant 2
  (3, (SELECT role_id FROM roles WHERE name = 'can_export'), 1),    -- Bob, privilege
  (4, (SELECT role_id FROM roles WHERE name = 'settings'),   NULL)  -- GlobalAdmin
ON CONFLICT DO NOTHING;

-- Org-bound sign-in federation. acme (tenant 1) has two IdPs (chooser);
-- globex (tenant 2) has one (auto-redirect); initech (tenant 3) has none.
INSERT INTO auth_domains (auth_domain_id, tenant_id, display_name, integration_type, integration_params) VALUES
  (1, 1, 'Microsoft', 'oidc',
     '{"issuer":"https://login.microsoftonline.com/acme","clientId":"acme-ms","authorizationEndpoint":"https://login.microsoftonline.com/acme/oauth2/v2.0/authorize","redirectUri":"https://acme.app.com/callback"}'::jsonb),
  (2, 1, 'Google', 'oidc',
     '{"issuer":"https://accounts.google.com","clientId":"acme-goog","authorizationEndpoint":"https://accounts.google.com/o/oauth2/v2/auth","redirectUri":"https://acme.app.com/callback"}'::jsonb),
  (3, 2, 'Okta', 'oidc',
     '{"issuer":"https://globex.okta.com","clientId":"globex-okta","authorizationEndpoint":"https://globex.okta.com/oauth2/v1/authorize","redirectUri":"https://globex.app.com/callback"}'::jsonb)
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
SELECT setval('roles_role_id_seq', (SELECT max(role_id) FROM roles));
SELECT setval('auth_domains_auth_domain_id_seq', (SELECT max(auth_domain_id) FROM auth_domains));
SELECT setval(
  'user_communication_methods_user_communication_method_id_seq',
  (SELECT max(user_communication_method_id) FROM user_communication_methods)
);
SELECT setval('user_roles_user_role_id_seq', (SELECT max(user_role_id) FROM user_roles));
