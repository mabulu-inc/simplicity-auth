# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **(runtime): `withSession` now auto-selects a user's sole role.** When no
  `roleName` is requested, a user who holds exactly one role gets it as their
  active role — whether or not it is flagged default — so an admin who only
  holds `security` (or a settings-only admin) no longer needs to also be granted
  the default `user` role just to get an active role. Roles are counted by name,
  so the same role held across several tenants still counts as one. A user with
  two or more distinct roles (e.g. different roles in different tenants) is
  unchanged: it falls back to the default role, or none if there isn't one.

### Added

- **(schema): role-aware, tenant-scoped row-level security on the auth tables.**
  The library now ships RLS so a consuming app gets correct multi-tenant
  isolation out of the box — keyed entirely on its own `user_roles` and the
  standard `user` / `settings` / `security` roles, with no app-specific columns,
  so it never reaches into the business domain. `app_user` sees `tenants` it
  belongs to; a `settings` admin maintains `auth_domains` for tenants they
  administer and (with global access) creates tenants; a `security` admin manages
  the `users`, `user_roles`, and `user_communication_methods` of the tenants they
  administer, while a plain user sees only its own identity rows. `roles` and
  `communication_channels` stay public; `sessions` and `dev_otp_enrollments` are
  reached only through the bypass pool. The admin/bypass pool and the
  `SECURITY DEFINER resolve_session` are unaffected.

- **(schema): `auth_create_user(jsonb)` — authority-checked, atomic user
  provisioning.** Creating a user, its communication methods, and its role
  assignments now happens in one call that refuses to leave a half-provisioned
  user behind (at least one access and one contact method are required) and
  enforces that the caller holds `security` over every tenant being granted — a
  tenant-scoped admin cannot create a global user or grant access to a tenant
  they do not administer. Raw `INSERT` on `users` is closed under RLS, so this is
  the app's path to provision a user; OIDC auto-provisioning still runs through
  the bypass pool.

- **(schema): the library now ships the grants on its own tables.** Every auth
  table grants `SELECT, INSERT, UPDATE, DELETE` to an `app_user` role, so a
  consuming app no longer hand-writes a grant-only extend per table and can't
  miss one — the failure mode that silently broke OTP sign-in when
  `dev_otp_enrollments` was overlooked (the pre-send enrollment read ran through
  the app pool and hit `permission denied`, while `/sign-in` still returned 200).
  The library grants to `app_user` but deliberately does **not** declare the
  role — the consuming app (or its infra) owns role creation and credentials —
  so the grants land on whatever `app_user` the deployment already provisions
  and never collide with that declaration. On a database where the role does not
  yet exist the migration's `GRANT` fails fast, which is the correct signal to
  provision it first. A consumer whose login role is named differently creates
  `app_user` and grants it to that role (`GRANT app_user TO <role>`). Sequence
  `USAGE` for the serial primary keys is granted automatically, so inserts work
  without extra configuration.

### Fixed

- **(schema): back-fill the standard role values on databases that already had
  the `roles` rows.** Seeds are insert-only, so a database that gained the
  `display_name` / `description` / `is_default` / `is_privilege` columns _after_
  its role rows already existed kept the column defaults — most importantly
  `is_default = false` on every role, which left `withSession` with no default
  role to select. A migration post-script now sets the canonical values on any
  never-seeded standard role (`user`, `settings`, `security`), guarded so it is
  a no-op on a fresh database and never touches a role a consumer has renamed or
  customised.

## [5.0.0] - 2026-06-16

### Added

- **(schema): ship the `email` and `phone` communication channels as seeds.**
  These are the two channels the library already resolves by name — the OIDC
  handler matches users on `email`, and the Twilio method router maps an
  identifier to `email` or `phone` — so a fresh database now has them out of
  the box instead of requiring the app to insert them. Matched by name with no
  pinned id and seeded insert-only, so re-runs are a no-op and consumers can
  add their own channels by name.

- **(schema): service user names are now unique.** A partial-unique index
  prevents two live service principals (`kind = 'service'`) from sharing a
  name. Service users are looked up by name (background workers, audit
  attribution), so a duplicate name made that lookup ambiguous. Human users
  are unaffected — real people legitimately share names and are referenced by
  id. The name frees up again once a service user is soft-deleted.

### Changed

- **(schema): seeding is now insert-only; requires `@smplcty/schema-flow >=
0.13.0`.** The shipped seeds (the `app-init` service user, the standard
  roles) no longer carry the `seeds_on_conflict` setting — `schema-flow`
  `0.13.0` makes "insert new rows, never overwrite existing ones" the default,
  which is exactly the behaviour those seeds always wanted. Re-running a
  migration stays a no-op, and a consumer's edits to the standard role rows
  are no longer at risk of being clobbered on the next migration. Migrating
  this schema now requires `@smplcty/schema-flow >= 0.13.0`.

## [4.0.0] - 2026-06-15

### Changed

- **(schema): seeded rows no longer pin literal ids.** The `app-init` service
  principal and the standard `user` / `settings` / `security` roles are now
  seeded without explicit primary keys — schema-flow matches them by their
  natural keys (`name` + `kind` for the user, `name` for the roles), so re-runs
  stay idempotent without a hard-coded id. The library already resolves these
  rows by name, never by id, so nothing functional changes; the previous
  "reserved ids 1–3, consumers use ≥ 100" convention for roles no longer
  applies — add your own roles by name. Existing databases are unaffected
  (their rows match by name and keep whatever ids they already have).
  **Migrating this schema now requires `@smplcty/schema-flow >= 0.12.0`**,
  which fully supports seeds with no primary keys.

### Added

- **(schema): audit attribution on `communication_channels` and
  `user_communication_methods`.** These long-lived tables previously tracked
  only soft-delete state; they now carry the full `audit` mixin (`created_at` /
  `updated_at` / `created_by` / `updated_by`), so you can see who added a
  contact channel or registered a user's communication method, and when —
  matching the attribution already on `users`, `tenants`, `roles`,
  `user_roles`, and `auth_domains`. Rows seeded during migration are
  back-filled to the `app-init` service principal by the existing audit
  back-fill post-script, so no new migration step is required.

### Removed

- **(schema): dropped the unused `label` column from `dev_otp_enrollments`.**
  It duplicated information already reachable through the foreign key
  (`user_communication_methods` → `users.name` + the method's `code`), and the
  library never read it — the authenticator-visible label is supplied directly
  to `getDevOtpEnrollmentUri`. `dev_otp_enrollments` stays soft-delete-only
  (un-audited, like `sessions`): every write to it is either creation or the
  actor-less usage counter bumped by `verifyDevOtp` during pre-auth
  verification, so there is no `updated_by` to attribute. Capture
  "who enrolled this secret" as an application-level audit-log event if you
  need it.

## [3.0.0] - 2026-06-14

### Changed

- **BREAKING (schema): identity columns are now `bigint` / `bigserial`.** All
  identity primary keys and the foreign keys that reference them — `users`,
  `tenants`, `roles`, `user_roles`, `auth_domains`, `communication_channels`,
  `user_communication_methods`, `sessions`, `dev_otp_enrollments` — widened from
  `serial`/`integer` to `bigserial`/`bigint`, and `current_user_id()` /
  `resolve_session()` now return `bigint`. This matches the already-`bigint`
  audit columns from `@smplcty/schema-std` and lets `bigint` apps consume the
  schema by reference without a type conflict (schema-flow's `extend:` can't
  change an imported column's type). The TypeScript API is unchanged — ids are
  still `number`; the library parses the `bigint` values pg returns as strings
  back to `number` at every boundary. **Fresh installs are unaffected; a
  database already created with the previous `int4` schema must widen its
  identity columns (schema-flow can't do `serial`→`bigserial` declaratively, so
  it needs a one-off pre-script).**

## [2.1.0] - 2026-06-14

### Added

- **`@smplcty/auth/http` — a framework-agnostic transport tier.** New opt-in
  subpath that wires the existing primitives (method router, OIDC handler,
  session lifecycle) into Web-standard `(Request) => Promise<Response>`
  handlers, so an app gets the full sign-in surface without hand-writing it:
  - `createAuthHandlers(config)` exposes `sign-in/options`, `otp/initiate`,
    `otp/complete`, `oidc/start`, `oidc/callback`, `sign-out`, and `session`,
    plus a `handle(request)` dispatcher (returns `null` for non-auth routes).
  - Cookie helpers and a short-lived **HMAC-signed** OIDC login-state cookie
    (state/nonce/codeVerifier) built on Web Crypto — edge-safe, no `Buffer`.
  - `getSessionToken` and `withRequestSession` for per-request auth middleware.
  - Same-origin `returnTo` enforcement (open-redirect guard) and server-side
    enforcement of `allow_otp`.
    Mounts directly in Hono (`app.all('/auth/*', (c) => handlers.handle(c.req.raw))`)
    or as Next.js App Router route handlers. Twilio and `oauth4webapi` stay
    optional peers — the app passes the handlers it constructed via config.

## [2.0.2] - 2026-06-13

### Added

- The documentation site now shows the released version as a badge in its
  header, linking to the matching GitHub release. The version is derived from
  the package version at build time, so it always reflects the current release.

## [2.0.1] - 2026-06-12

### Changed

- Maintenance: refreshed dependencies to their latest patch/minor releases.

## [2.0.0] - 2026-06-12

### Changed

- **OIDC now runs on [`oauth4webapi`](https://github.com/panva/oauth4webapi)**
  (ADR-0001). `@smplcty/auth/oidc`'s `oidcHandler` does the real flow —
  discovery + PKCE/state/nonce (`initiate` → `{ redirectUrl, loginState }`) and
  code→token exchange + `id_token` verification (`complete({ db, authDomain,
callbackUrl, loginState })`). The app persists `loginState` across the
  redirect; the `client_secret` is supplied via a `clientSecret` resolver from
  your secret store (not `auth_domains`). `oauth4webapi` replaces `@smplcty/oidc`
  as the optional peer for the `/oidc` subpath.
- **The method router is OTP-only.** `createMethodRouter` now exposes
  `signInOptions` (discovery) + `initiateOtp`/`completeOtp` (gated by
  `allow_otp`). OIDC is driven directly via `oidcHandler` (its `authorize`/
  `callback` shape is richer than the generic two-phase handler).

### Removed

- `@smplcty/oidc` dependency (deprecated; superseded by `oauth4webapi`).
- The router's generic `handlers` map and `initiate(authDomainId)` /
  `complete(authDomainId, credential)` dispatch, and `UnknownMethodError`
  (OIDC no longer routes through the generic interface).

## [1.0.0] - 2026-06-12

The v1 redesign (see `docs/v1-design.md`): one auth model shared by both apps —
stateful sessions, a pluggable sign-in method, an app-owned authorization scope,
and an identity contract the database reads per request. This is a major,
breaking change.

### Added

- **Privileges** — roles now carry an `is_privilege` flag. `is_privilege=false`
  roles are selectable modes/personas (drive the role switcher and the active
  role); `is_privilege=true` roles are always-on capability flags exported to
  the request. One `roles` table and one `user_roles` assignment cover both.
- **`withServiceContext(pool, serviceName, fn)`** — run background work as a
  named service principal so its writes are audited. Resolves the principal
  from a `users` row of `kind='service'` and sets `app.actor_id`.
- **Pluggable, tenant-centric sign-in methods** — a `MethodHandler` interface
  and a `createMethodRouter` that resolves sign-in by **sub-domain → tenant**:
  `signInOptions({ tenantSlug })` lists the tenant's IdPs (`auth_domains`, 1:N)
  and whether OTP is allowed; `initiate`/`complete` dispatch a chosen IdP by
  `integration_type`; `initiateOtp`/`completeOtp` run the user-bound OTP path,
  **gated by the tenant's `allow_otp`** (enforced in the router, so an SSO-only
  tenant can't be bypassed). One IdP → straight redirect; several → an app-rendered
  chooser. Opt-in handler subpaths `@smplcty/auth/oidc` (org-bound) and
  `@smplcty/auth/twilio` (user-bound); auth core pulls in neither `jose` nor
  Twilio.
- **Tenant sub-domain + SSO-only switch** — `tenants.slug` (the sub-domain the
  router resolves the tenant from, so OIDC needs no "which org?" form) and
  `tenants.allow_otp` (set false to enforce SSO-only). `auth_domains` is now
  1:N per tenant, resolved by `auth_domain_id`, with a `display_name` for the
  chooser button (the old globally-unique `code` is gone).
- **Pluggable authorization scope** — `withSession` accepts an app-supplied
  `scope` hook to set intra-tenant scope GUCs. A ready-made flat-tenant preset
  ships at `@smplcty/auth/flat-tenant` for the common case.
- **`revokeUserSessions(userId)`** and **`revokeTenantSessions(tenantId)`** —
  force sign-off for one user or a whole tenant. Tenant sign-off resolves
  membership from `user_roles.tenant_id` and deliberately spares wildcard
  (all-tenant) members.
- **`touchSession(token)`** — record activity (`last_seen_at`) on a live session.
- **Audit attribution** — auditable tables (`users`, `tenants`, `roles`,
  `user_roles`, `auth_domains`) carry the `audit` mixin, stamping
  `created_by`/`updated_by` from `app.actor_id`.
- **Soft delete** — every table carries the `soft_delete` mixin (`deleted_at`).
  Session resolution (`resolve_session`, `validateSession`),
  `findUserByCommunicationMethod`, `getUserRoleNames`, and the flat-tenant
  preset all treat soft-deleted rows as gone, so a soft-deleted session, user,
  communication method, or role assignment stops taking effect immediately.
  Unique indexes are partial (`WHERE deleted_at IS NULL`) so a name/code can be
  reused after its row is archived. The library honors `deleted_at` but ships
  no delete setter — clearing/setting it is a plain write the app owns.
- **`auth_domains`** table — per-tenant sign-in federation config, owned by auth.
- **`users.kind`** (`human` | `service`) and a seeded `app-init` service
  principal for background/bootstrap writes.

### Changed

- **Session tokens are hashed at rest.** `createSession` returns a raw opaque
  token once (`session.token`); only its SHA-256 hash is stored. `withSession`,
  `validateSession`, `revokeSession`, and `touchSession` now take the raw token.
- **Identity GUC contract** — the library sets exactly `app.actor_id`,
  `app.session_id`, `app.active_role`, and `app.privileges`. The old
  `app.role_name` / `app.tenant_ids` / `app.all_tenants` are gone from the core;
  tenant GUCs move to the flat-tenant preset.
- **Active-role selection moved into `withSession` (TypeScript).**
  `resolve_session` is now a pure resolver that validates nothing and takes no
  role argument; `withSession` picks the requested role, else the user's default
  role, else none (privilege-only is not an error).
- **Generic schema is consumed, not owned** — `audit`/`soft_delete`/`timestamps`
  come from `@smplcty/schema-std` (parameterized); the transaction primitive
  comes from `@smplcty/db`. `withTransaction` is re-exported from `@smplcty/db`.
- Primary-key naming standardized to `{singular}_id` across the schema.

### Removed

- The library's own `withTransaction` implementation (now `@smplcty/db`'s).
- `RoleNotAssignedError` (replaced by `RoleNotHeldError`), and the
  `Session.sessionId` field (replaced by `Session.token`).
- Baked-in tenant scope from `withSession` (now the flat-tenant preset).

## [0.6.4] - 2026-06-10

### Changed

- Maintenance release with no functional or API changes. Internal tooling now
  formats the codebase with Prettier (enforced on commit) and generates GitHub
  release notes from this changelog.

## [0.6.3] - 2026-04-12

Baseline release. Notes for this and earlier versions are on the
[GitHub releases page](https://github.com/mabulu-inc/simplicity-auth/releases);
the Keep a Changelog history starts from the next release.

[Unreleased]: https://github.com/mabulu-inc/simplicity-auth/compare/v5.0.0...HEAD
[5.0.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v4.0.0...v5.0.0
[4.0.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v3.0.0...v4.0.0
[3.0.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v2.1.0...v3.0.0
[2.1.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v2.0.2...v2.1.0
[2.0.2]: https://github.com/mabulu-inc/simplicity-auth/compare/v2.0.1...v2.0.2
[2.0.1]: https://github.com/mabulu-inc/simplicity-auth/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v0.6.4...v1.0.0
[0.6.4]: https://github.com/mabulu-inc/simplicity-auth/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/mabulu-inc/simplicity-auth/releases/tag/v0.6.3
