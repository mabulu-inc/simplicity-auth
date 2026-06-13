# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/mabulu-inc/simplicity-auth/compare/v2.0.1...HEAD
[2.0.1]: https://github.com/mabulu-inc/simplicity-auth/compare/v2.0.0...v2.0.1
[2.0.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v1.0.0...v2.0.0
[1.0.0]: https://github.com/mabulu-inc/simplicity-auth/compare/v0.6.4...v1.0.0
[0.6.4]: https://github.com/mabulu-inc/simplicity-auth/compare/v0.6.3...v0.6.4
[0.6.3]: https://github.com/mabulu-inc/simplicity-auth/releases/tag/v0.6.3
