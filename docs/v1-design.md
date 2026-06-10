# @smplcty/auth v1 — Design

Status: proposal. Target: the next major (1.0). Supersedes the 0.6.x model.

## Goal

One auth approach shared by **productionnow** and **salez1-next**, with as little
duplication between them as possible, while staying usable by other apps.

The library owns **identity, sessions, roles/privileges, tenants, sign-in
federation, and per-request context application.** Each app owns only its
**intra-tenant authorization scope**. After adoption, the two apps' auth differs
in essentially one adapter (their scope model) plus their RLS policies.

## Settled decisions

- **Stateful sessions, not JWT** — for both apps.
- **PK naming:** `{singular_table}_id` (`user_id`, `role_id`, `session_id`, …).
- **Privileges = `roles.is_privilege`** — one `roles` table, one `user_roles`
  assignment, a flag. No separate privileges/role_privileges tables.
- **Identity GUCs:** `app.actor_id`, `app.session_id`, `app.active_role`,
  `app.privileges`. Scope GUCs are **not** in the contract (app-owned).
- **Audit** via a shared `audit` mixin keyed on `app.actor_id`.
- **Sign-in methods** are pluggable handlers: Twilio Verify (user-bound), OIDC
  (org-bound via `auth_domains`), dev-OTP, BYO. Injected, not hard-deps.
- **CRM service integration is NOT auth** — it's app/tenant-specific.
- **Depends on `@smplcty/db`** for the transaction primitive.
- **Session tokens hashed at rest.**

## Why sessions, not JWT

The requirements decide it: track sign-ins/activity, force immediate sign-off
for a whole tenant, and force immediate sign-off on a role/privilege change. All
three need **per-request server authority** — exactly what JWT trades away. To
revoke a JWT immediately or record activity you must add a per-request server
check, i.e. reinvent sessions, worse. Both apps already open an RLS transaction
per request, so a session lookup is one indexed query folded into work already
happening — no extra round-trip. With sessions: revocation is a row update;
role/privilege changes are immediate because they're resolved per request
(nothing is baked into the token).

## Architecture: the one seam

**Identity + tenant + federation** is universal → the library.
**Intra-tenant authorization scope** is a domain model → the app. (productionnow:
tenant→producer→region→plant with wildcards. salez1: tenant→salesperson
hierarchy. These are genuinely different and will never be one schema.)

Three tiers:

1. **Identity core** (always): users, communication, sessions, roles/privileges,
   sign-in, session lifecycle, resolution, identity GUCs.
2. **Multitenancy + federation** (both apps; optional for others): tenants,
   `user_roles.tenant_id`, `auth_domains`, the method router, provisioning.
3. **App scope** (each app, NOT in the library): the intra-tenant model + RLS.

Two pluggable axes — **authentication method** (front door) and **authorization
scope** (intra-tenant) — over a shared spine (identity + tenant + auth_domains).

## Schema (shipped by the library, schema-flow YAML)

All PKs `{singular}_id`. Auditable tables include the `audit` mixin.

- **users** — `user_id` PK, `name`, `kind` (`human` | `service`), + audit.
  `kind='service'` rows are the actor for background writes (ingestion,
  transform-worker). Self-referential audit FK ⇒ a bootstrap app-init service
  user seeds first.
- **communication_channels** — `communication_channel_id` PK, `name` unique
  (`email`, `phone`).
- **user_communication_methods** — `user_communication_method_id` PK, `user_id`
  FK, `communication_channel_id` FK, `code`; unique `(channel, code)`.
- **sessions** — `session_id` PK = **hash of the opaque token** (never the raw
  token), `user_communication_method_id` FK, `created_at`, `expires_at`,
  `last_seen_at`, `ip`, geo. Soft-revoke = `expires_at = now()`.
- **tenants** — `tenant_id` PK, `name` unique, + audit.
- **roles** — `role_id` PK, `name` unique, `display_name`, `description`,
  `is_default`, **`is_privilege`**, + audit. `is_privilege=false` = selectable
  mode/persona roles (drive the role switcher + `app.active_role`);
  `is_privilege=true` = always-on capability flags (drive `app.privileges`).
- **user_roles** — `user_role_id` PK, `user_id` FK, `role_id` FK, `tenant_id` FK
  **nullable (NULL = wildcard / all tenants)**, + audit. Assigns both roles and
  privileges (they're all `roles` rows).
- **auth_domains** — `auth_domain_id` PK, `tenant_id` FK, `code` unique,
  `integration_type` (`oidc` | …), `integration_params` jsonb (provider config +
  provisioning policy), + audit. **Moved in from `@smplcty/oidc`.**
- **dev_otp_enrollments** — TOTP enrollment for developers, keyed on
  `user_communication_method_id`.

Mixins: auth's auditable tables use the **`audit`** mixin — but `audit` (and
`soft_delete`, `audit_log`) are **generic, not auth's**: they live in
`@smplcty/schema-std` and auth _consumes_ them (see "Package boundary" below).
Auth imports `schema-std` with `{ user_table: users, user_pk: user_id, actor_guc:
app.actor_id }` so the `created_by`/`updated_by` FKs target auth's `users` and the
`audit_stamp` trigger reads `app.actor_id`.

Functions (auth's own, bound to its tables):

- **resolve_session(token_hash, role_name)** — SECURITY DEFINER (bypasses RLS on
  auth tables). Returns `{ user_id, expires_at, roles[], privileges[],
has_requested_role }` (roles split from privileges by `is_privilege`).
- **current_user_id()** — reads `app.actor_id`. App RLS/scope functions key on it.

(`audit_stamp`/`audit_diff`/`audit_skip_noop` are **not** auth's — they ship,
parameterized, from `@smplcty/schema-std`.)

**Not shipped (app-owned):** intra-tenant scope tables (`user_rls_scopes`,
`rep_hierarchies`), scope functions, and all RLS policies.

## Package boundary — who provides which schema

The rule: **a package provides the schema for its own domain, and consumes
generic schema from a shared package.**

- **Own-domain schema → the package provides it.** The identity/tenant/federation
  tables (`users`, `sessions`, `roles`, `user_roles`, communication,
  `auth_domains`) _are_ auth's domain, so `@smplcty/auth` provides them — that's
  not a concern leak, it's auth owning its data model. Its table-bound functions
  (`resolve_session`, `current_user_id`) ship with them.
- **Generic / cross-cutting schema → consumed from `@smplcty/schema-std`.**
  `audit`, `audit_log`, `soft_delete`, `timestamps` belong to no domain; they live
  in `@smplcty/schema-std` and are **parameterized** (`user_table`, `user_pk`,
  `actor_guc`) so they carry no dependency on auth. **Auth consumes them like any
  app** — supplying its own `users` table + `app.actor_id` as the parameters.

So auth is **both**: provider of its own identity schema, consumer of the generic
mixins. Dependency graph is acyclic: `schema-std` ← `auth` ← apps.

**Do not split the identity tables out of auth into a separate schema package.**
Auth's TS and `resolve_session` reference exact table shapes; keeping schema and
logic in one (co-versioned) package guarantees they can't drift. A separate
identity-schema package would buy only "auth-logic over a foreign identity
schema" — which no real consumer needs — at the cost of a rich, fragile
cross-package contract. Schema (`schema/`) and logic (`src/`) live in the **one**
`@smplcty/auth` package, consumed separately (schema-flow `imports` vs TS
`import`). Extract an identity-schema package _only if_ such a consumer actually
appears, behind a narrow function contract — not speculatively.

## Identity GUC contract (the only GUCs the library sets)

Transaction-local (`set_config(name, value, true)`):

- **`app.actor_id`** — `users.user_id` of the human **or service** performing the
  request. Powers `current_user_id()` and the audit trigger. (Not `user_id`: the
  actor is often a service principal.)
- **`app.session_id`** — for correlation/audit.
- **`app.active_role`** — the chosen `is_privilege=false` role for the request.
- **`app.privileges`** — comma-separated `is_privilege=true` names the user holds.

Scope GUCs (`tenant_ids`, plant/region scope, visible rep ids, …) are **not** in
the contract — the app sets them via its scope hook, or enforces scope
"function-carried" (RLS policies call functions that read `current_user_id()`
against the app's scope tables).

## Sessions & authority controls

- Opaque random token returned to the client; only its **hash** is stored.
- `createSession` / `validateSession` / `revokeSession(token)` /
  `revokeUserSessions(userId)` / `touchSession` (activity).
- Expiry is server-side; revoke = `expires_at = now()` (row kept for audit).
- **Role/privilege change → immediate**, free: resolved per request.
- **Tenant-wide sign-off**: the app computes "which users are in tenant X" (its
  scope domain) and calls `revokeUserSessions` for them. (`sessions` belong to a
  user, not a tenant — tenant membership is the app's domain.)

## Request flow

```ts
withSession(pool, { token, roleName }, fn, { scope?, handlers? })
// = @smplcty/db withTransaction
//   → resolve_session(hash(token), roleName)
//   → validate (not-found / expired / role-not-held)
//   → set identity GUCs (actor_id, session_id, active_role, privileges)
//   → scope hook (app sets scope GUCs, or no-op for function-carried)
//   → fn(client, ctx)

withServiceContext(pool, serviceName, fn)
// = withTransaction → set app.actor_id to the service principal's user_id
//   (so service writes pass the NOT-NULL audit attribution) → fn
```

`withTransaction` is re-exported from `@smplcty/db` (the library no longer ships
its own).

## Axis 1 — authentication method

A `MethodHandler` models a two-phase flow (handles both OTP send→check and OIDC
redirect→callback):

```ts
interface MethodHandler {
  initiate(ctx): Promise<{ otpSent: true } | { redirectUrl: string }>;
  complete(ctx): Promise<ResolvedUser>;
}
```

Router: an identifier's domain → `auth_domains.code` → `integration_type` →
handler; if no org config, fall back to the default user-bound method.

- **TwilioVerifyHandler** (user-bound) ← `@smplcty/twilio`. Library does the
  `user_communication_methods` binding + dev-OTP fallback.
- **OidcHandler** (org-bound) ← `@smplcty/oidc` `verifyIdToken` + `auth_domains`
  config + the redirect/callback/token-exchange flow.
- **BYO** — password, SAML, etc.

Handlers are **opt-in / injected** so the core has no `twilio`/`oidc`/`jose`
deps; a password-only app pulls none. OIDC **provisioning** (auto-create the user

- email method + default roles for the tenant) is driven by `auth_domains` policy.

## Axis 2 — authorization scope (app-owned)

The app provides a `scope(client, identity)` hook that either sets app-specific
scope GUCs, or is a no-op when scope is enforced function-carried (RLS policies
call scope functions reading `current_user_id()`). Each app ships its scope
tables, scope functions, and RLS policies.

- **productionnow:** `user_rls_scopes` (tenant/producer/region/plant + wildcards),
  `current_user_can_see_*` functions; hook largely a no-op.
- **salez1:** `rep_hierarchies` + tenant; hook sets visible rep ids / tenant, or
  policies resolve the hierarchy from `current_user_id()`.

A **provided preset** ships the flat `tenant_ids`/`all_tenants` model (the 0.6.x
behavior) for simple multi-tenant apps that don't need a custom scope.

## Boundary: sign-in vs CRM integration

`auth_domains` = **user sign-in** federation (the org's IdP). salez1's
`integrations` / `oauth-apps` / `crm-sources` / `crm-sync-cursors` / `sync-runs`
= **tenant CRM data connections** (HubSpot/Salesforce/Zoho/Pipedrive sync) —
app-owned, tenant-specific, **out of `@smplcty/auth`**. Even for the same vendor,
"log in with Salesforce" (an `auth_domains` row) and "connect our Salesforce
data" (an `integrations` row) are distinct configs in distinct domains.

## Package layout

- **`@smplcty/auth`** — **its own** schema (identity + tenant + `auth_domains` +
  `resolve_session`/`current_user_id`) under `schema/`, plus the TS runtime under
  `src/` (session lifecycle, `withSession`/`withServiceContext`, `MethodHandler`
  interface + router, dev-OTP, errors). Consumed separately: `schema/` via
  schema-flow `imports`, `src/` via TS `import`. Deps: `@smplcty/db`; `pg` peer;
  **imports `@smplcty/schema-std`** (schema) for `audit`/`soft_delete`. **No**
  twilio/oidc/jose.
- **`@smplcty/schema-std`** (new) — generic, parameterized schema mixins
  (`audit`, `audit_log`, `soft_delete`, `timestamps`) + the `audit_stamp` /
  `audit_diff` / `audit_skip_noop` functions + the `audit_log` table. Params:
  `user_table`, `user_pk`, `actor_guc`. No dependency on auth.
- **Method handler adapters** — `TwilioVerifyHandler`, `OidcHandler` — as subpath
  exports with optional peers, or tiny adapter packages. **These** (not auth core)
  depend on `@smplcty/twilio` / `@smplcty/oidc`.
- **`@smplcty/twilio`** — unchanged (generic Verify wrapper).
- **`@smplcty/oidc`** — keep/expand the OIDC **protocol** (verification, and ideally
  the full authorization-URL + PKCE + token-exchange flow); **remove
  `auth_domains` / `getOidcConfig`** (the config registry moves into auth, by the
  own-domain rule). No DB, no user/session knowledge. Used by `OidcHandler`, not
  by auth core.
- **`@smplcty/db`** — provides `withTransaction`.

### Packaging decision (locked)

The OIDC and Twilio **protocol libraries stay separate** from `@smplcty/auth`;
they are not rolled in. Rationale:

- **Coupling test:** both are stateless third-party-protocol wrappers with zero
  dependency on auth's domain (`users`/`sessions`/`auth_domains`) — the same
  category as `@smplcty/db`. Uncoupled generic utilities stay their own focused
  packages; only the auth-domain _glue_ lives in auth.
- **Consistency:** `@smplcty/oidc` and `@smplcty/twilio` are the same kind of
  thing and are treated identically. (Rolling either in but not the other is
  arbitrary; rolling both in drags `jose` + the Twilio HTTP wrapper into auth's
  dependency tree and breaks the small-focused-package philosophy.)
- **Opt-in is preserved without absorbing them:** the auth-domain glue ships as
  **opt-in auth subpaths** — `@smplcty/auth/oidc` (the `OidcHandler`) and
  `@smplcty/auth/twilio` (the `TwilioVerifyHandler`) — each depending on its
  protocol lib as an **optional peer**. Auth _core_ pulls neither `jose` nor
  twilio. An app enables a method by installing the protocol lib and importing
  the handler subpath. This was considered against rolling the protocol packages
  in and chosen deliberately.

## What changes vs 0.6.3 (why it's a major)

1. **Scope un-baked** — `tenant_ids`/`all_tenants` move from the core into a
   provided preset; `withSession` no longer dictates a tenant model.
2. **`app.actor_id`** added; `current_user_id()` reads it.
3. **Session token hashed at rest** (was plaintext).
4. **Privileges** via `roles.is_privilege`; richer `roles` table.
5. **`users.kind`** for service principals.
6. **`withServiceContext` sets `app.actor_id`** (so service writes are audited).
7. **Drops its own `withTransaction`** → depends on `@smplcty/db`.
8. **Consumes `audit`/`soft_delete` from `@smplcty/schema-std`** (parameterized)
   rather than owning generic mixins; requires attribution.
9. **Absorbs `auth_domains`** (own-domain rule); `@smplcty/oidc` slimmed to the
   OIDC protocol only.
10. PK naming retained (`{singular}_id`).

## Per-app convergence

- **productionnow** — adopt-and-extend. Already sessions + `app.actor_id` + audit
  mixin + `current_user_id()` + `user_rls_scopes` + most identity tables. Adopt
  the library's shared schema/mixins/functions, add `auth_domains` + an
  `OidcHandler`, keep producer/region/plant as its scope adapter. `is_privilege`
  arrives whenever it wants privileges (until then all roles are `false`).
- **salez1** — JWT → session migration. Adopt the shared schema (rename
  `roles.id` → `role_id`, add `users.kind`, add `sessions`, `auth_domains`), swap
  `authMiddleware` from JWT-verify to `resolve_session`, replace `app.current_tenant`
  with the identity GUC contract + a rep-hierarchy scope adapter. Its CRM
  integration domain is untouched.

## Open / follow-ups

- **Schema distribution mechanism** — how both repos consume the shipped schema
  (see the consumption note accompanying this design).
- Whether to expand `@smplcty/oidc` to the full redirect/callback flow.
- Hashed-token migration for productionnow's existing live sessions
  (hash-on-next-use, or force re-login).
