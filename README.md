# @smplcty/auth

Robust, type-safe **stateful-session** authentication primitives for PostgreSQL apps using Row-Level Security.

[![npm](https://img.shields.io/npm/v/@smplcty/auth.svg)](https://www.npmjs.com/package/@smplcty/auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

📖 **[Documentation](https://mabulu-inc.github.io/simplicity-auth)**

## Why

The library owns **identity, sessions, roles/privileges, tenants, sign-in federation, and per-request context**. Each app owns only its **intra-tenant authorization scope** (its RLS model). See [`docs/v1-design.md`](docs/v1-design.md) for the full design.

Stateful sessions (not JWT) because the requirements decide it: track sign-ins/activity, force immediate sign-off for a whole tenant, and make role/privilege changes take effect immediately. All three need per-request server authority — resolved in one indexed query folded into the RLS transaction every request already opens.

Every request sets four **identity GUCs** on its transaction-bound connection, transaction-scoped so they can't leak across requests:

| GUC               | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `app.actor_id`    | the acting user (human **or** service); `current_user_id()` reads it |
| `app.session_id`  | the session hash, for correlation/audit                              |
| `app.active_role` | the chosen mode/persona role for the request                         |
| `app.privileges`  | comma-separated capability flags the user holds                      |

Intra-tenant **scope** GUCs (tenant ids, region/plant, visible reps, …) are **not** in this contract — they're app-owned, set by a scope hook you supply (or a provided preset).

## Install

```sh
pnpm add @smplcty/auth @smplcty/db pg
```

`pg` is a peer dependency; `@smplcty/db` provides the transaction primitive. Sign-in method handlers are opt-in subpaths with their own optional peers (see [Sign-in methods](#sign-in-methods-pluggable)).

## High-level usage — `withSession`

The default API. Hand it a pool, the raw session token, and a callback. It opens a `@smplcty/db` transaction, resolves and validates the session, picks the active role, sets the identity GUCs, runs your (optional) scope hook, runs your code, and commits — or rolls back on throw.

```ts
import { withSession } from '@smplcty/auth';

const widgets = await withSession(pool, { token, roleName: 'user' }, async (client, ctx) => {
  // ctx = { userId, activeRole, roles, privileges }
  const { rows } = await client.query('SELECT * FROM widgets');
  return rows;
});
```

Active-role selection happens in TypeScript: the requested `roleName` if given (must be one the user holds), else the user's **default** role, else none — a privilege-only request is not an error. If the session doesn't exist, is expired/revoked, or the requested role isn't held, `withSession` throws **before** your callback runs.

### Errors thrown by `withSession`

| Error                  | When                                          |
| ---------------------- | --------------------------------------------- |
| `SessionNotFoundError` | token matches no session                      |
| `SessionExpiredError`  | session has expired (or was revoked)          |
| `RoleNotHeldError`     | a requested `roleName` the user does not hold |
| `InvalidInputError`    | `token` is empty / wrong type                 |

All errors extend `AuthError` and carry a `code`:

```ts
try {
  await withSession(pool, { token, roleName: 'user' }, fn);
} catch (err) {
  if (err instanceof AuthError && err.code === 'SESSION_EXPIRED') {
    // redirect to login
  }
  throw err;
}
```

## Authorization scope (app-owned)

`withSession` sets identity GUCs only. To set intra-tenant **scope** GUCs your RLS needs, pass a `scope` hook — it runs inside the request transaction, after the identity GUCs are set:

```ts
await withSession(pool, { token, roleName: 'user' }, fn, {
  scope: async (client, identity) => {
    // identity = { userId, activeRole, roles, privileges }
    // set whatever scope GUCs your RLS policies read
  },
});
```

For the common flat multi-tenant case (the 0.6.x behavior), a ready-made preset ships at a subpath:

```ts
import { withSession } from '@smplcty/auth';
import { flatTenantScope } from '@smplcty/auth/flat-tenant';

const scope = flatTenantScope(); // sets app.tenant_ids + app.all_tenants from user_roles
await withSession(pool, { token, roleName: 'user' }, fn, { scope });
```

Apps with a richer model (producer/region/plant, rep hierarchy) ship their own hook, or enforce scope "function-carried" (RLS policies call functions that read `current_user_id()`).

## Background work — `withServiceContext`

Background writers (ingestion, workers, app-init) have no human session, but audit attribution is NOT NULL. Run them as a named **service principal** (a `users` row of `kind='service'`) so `app.actor_id` is set and writes are attributed:

```ts
import { withServiceContext } from '@smplcty/auth';

await withServiceContext(pool, 'transform-worker', async (client) => {
  await client.query('INSERT INTO metrics (...) VALUES (...)'); // audited to the service
});
```

## Low-level usage — `withTransaction` + identity setters

For migrating existing code, tests, or unusual cases. `withTransaction` is re-exported from `@smplcty/db`.

```ts
import { withTransaction, setIdentityContext } from '@smplcty/auth';

await withTransaction(pool, async (client) => {
  await setIdentityContext(client, {
    actorId: 42,
    sessionId: tokenHash,
    activeRole: 'user',
    privileges: ['can_export'],
  });
  return client.query('SELECT * FROM widgets');
});
```

Individual setters (`setActorId`, `setSessionId`, `setActiveRole`, `setPrivileges`, `setLocal`) and the `IDENTITY_GUC` name map are also exported. Every setter requires a `PoolClient` already inside a transaction; the variables are set transaction-scoped (`set_config(_, _, true)`) and discarded on COMMIT/ROLLBACK. The low-level setters do **not** validate the session — use `withSession` for that.

## Session lifecycle

`createSession`, `validateSession`, `revokeSession`, `revokeUserSessions`, `revokeTenantSessions`, `touchSession`, and `findUserByCommunicationMethod` build sign-in / sign-out / activity / authorizer flows. None are coupled to a specific OTP provider, identity model, or transport.

### `findUserByCommunicationMethod`

```ts
const lookup = await findUserByCommunicationMethod(db, { channel: 'email', code: 'alice@example.com' });
// lookup = { userId, userCommunicationMethodId } | null
```

### `createSession`

```ts
const session = await createSession(db, {
  userCommunicationMethodId: lookup.userCommunicationMethodId,
  ttl: '30 days',
  ip: req.ip,
  geo: { country: 'US', region: 'CA' },
});
// session = { token, userId, createdAt, expiresAt }
setCookie('session', session.token); // raw token to the client, ONCE
```

A fresh opaque token (256 bits) is generated server-side; **only its SHA-256 hash is stored** (as the `sessions` primary key). `session.token` is the raw bearer credential — return it once and don't persist it. `ttl` is a Postgres interval evaluated server-side (`now() + interval $ttl`), so there's no app/DB clock skew.

### `validateSession`

For authorizers / "is this token alive?" checks. Returns `SessionInfo` (`{ userId, createdAt, expiresAt, lastSeenAt }`) or throws. Sets no GUCs.

```ts
try {
  const info = await validateSession(db, token);
  return { allow: true, principalId: String(info.userId) };
} catch {
  return { allow: false };
}
```

### Revocation & activity

```ts
await revokeSession(db, token); // force sign-off of one session (idempotent)
await revokeUserSessions(db, userId); // sign off every session of a user
await revokeTenantSessions(db, tenantId); // tenant-wide sign-off
await touchSession(db, token); // record activity (last_seen_at); returns whether a live session matched
```

Revoke is a **soft-revoke** — it sets `expires_at = now()`, so the row survives for audit but the session is locked out immediately. Role/privilege changes take effect on the next request automatically (nothing is baked into the token). `revokeTenantSessions` resolves membership from `user_roles.tenant_id` and deliberately spares wildcard (all-tenant) members like global admins.

## Sign-in methods

Sign-in is **tenant-centric**: the app resolves the tenant from the request sub-domain (`tenants.slug`), and the router lists that tenant's IdPs. A tenant has **0..N** OIDC IdPs (mergers, mixed workforces, multi-domain orgs):

- **0 IdPs** → OTP only.
- **1 IdP** → straight redirect, no chooser.
- **N IdPs** → a chooser (one button per IdP, labeled `displayName`, valued by `auth_domain_id`).

The user-bound **OTP** path is gated by the tenant's `allow_otp` flag, **enforced in the router** (not just hidden in the UI) so an SSO-only tenant can't be bypassed. **OIDC** is handled by a dedicated `@smplcty/auth/oidc` handler (built on [`oauth4webapi`](https://github.com/panva/oauth4webapi)) — its `authorize`/`callback` shape is richer than the OTP two-phase, so it's driven directly rather than through the router. See [ADR-0001](docs/adr/0001-oidc-via-oauth4webapi.md).

```ts
import { createMethodRouter } from '@smplcty/auth';
import { oidcHandler } from '@smplcty/auth/oidc'; // optional peer: oauth4webapi
import { twilioVerifyHandler } from '@smplcty/auth/twilio'; // optional peer: @smplcty/twilio
import { createTwilioVerifyClient } from '@smplcty/twilio';

const router = createMethodRouter({
  db: pool,
  otpHandler: twilioVerifyHandler({ client: createTwilioVerifyClient(cfg) }), // user-bound, tenant-gated
});
const oidc = oidcHandler({ clientSecret: (ad) => secrets.get(ad.tenantId) }); // secret from your store, NOT the DB

// Sign-in page — app parsed Host → 'acme':
const opts = await router.signInOptions({ tenantSlug: 'acme' });
// opts = { tenantId, authDomains: AuthDomain[], otpAllowed: boolean }
//   render: a button per opts.authDomains + an OTP form iff opts.otpAllowed

// OIDC — user picked an IdP (an AuthDomain from opts.authDomains):
const { redirectUrl, loginState } = await oidc.initiate(authDomain);
// persist loginState (signed cookie keyed by loginState.state), redirect to redirectUrl...
// ...on the provider callback, hand back the stored loginState + the callback URL:
const user = await oidc.complete({ db: pool, authDomain, callbackUrl, loginState });

// OTP (only when opts.otpAllowed):
await router.initiateOtp({ tenantId: opts.tenantId, identifier: phone });
const user2 = await router.completeOtp({ tenantId: opts.tenantId, identifier: phone, credential: code });

const session = await createSession(pool, {
  userCommunicationMethodId: user.userCommunicationMethodId,
  ttl: '30 days',
});
```

Auth **core** depends on neither `oauth4webapi` nor Twilio — the handler subpaths do, as **optional peers**. A password-only app installs neither. OIDC is org-bound (`oauth4webapi` does discovery + PKCE + token exchange + `id_token` verification); Twilio Verify is user-bound (phone/email) and integrates the [dev-OTP](#developer-otp--for-devs-whose-phones-cant-receive-sms) fallback automatically.

**What stays app-side:** parsing the request `Host` → slug, the chooser/redirect UI, and the OIDC **login-state store** — `oidc.initiate` returns `loginState` (`state`/`nonce`/`codeVerifier`) for you to persist in a short-lived signed cookie keyed by `state`, and hand back to `oidc.complete`. The **`client_secret`** lives in your secret store (passed via the `clientSecret` resolver), **not** in `auth_domains` (which holds only `issuer`/`clientId`). The [`@smplcty/auth/http`](#http-transport--smpltyauthhttp) tier handles the routes, cookies, and login-state store for you — drop it in and you write only the slug parser + the sign-in screen.

## HTTP transport — `@smplcty/auth/http`

The pieces above are primitives. **`@smplcty/auth/http`** wires them into
ready-made, framework-agnostic HTTP handlers so you don't hand-write the
`/auth/*` routes, the session cookie, the OIDC login-state cookie, or the
per-request auth middleware. Every handler is a Web-standard
`(Request) => Promise<Response>`, so it mounts directly in Hono and Next.js App
Router — no adapter, and no new heavy dependency (it's built on Web
`Request`/`Response` + Web Crypto). Twilio and `oauth4webapi` stay optional
peers: you pass the handlers you constructed.

```ts
import { createAuthHandlers } from '@smplcty/auth/http';
import { oidcHandler } from '@smplcty/auth/oidc';
import { twilioVerifyHandler } from '@smplcty/auth/twilio';

const handlers = createAuthHandlers({
  pool,
  cookie: { name: 'app_session', domain: '.app.example.com' },
  loginStateSecret: process.env.LOGIN_STATE_SECRET,
  tenantSlugFromRequest: (req) => new URL(req.url).hostname.split('.')[0],
  otpHandler: twilioVerifyHandler({ client }), // omit for SSO-only
  oidc: oidcHandler({ clientSecret: (ad) => secrets.get(ad.tenantId) }), // omit if no OIDC
});

// Hono — one line:
app.all('/auth/*', (c) => handlers.handle(c.req.raw).then((r) => r ?? c.notFound()));
// Next.js App Router — the handlers ARE route handlers:
//   export const GET = (req) => handlers.handle(req).then((r) => r ?? new Response(null, { status: 404 }));
```

It exposes `GET …/sign-in/options`, `POST …/otp/initiate`, `POST …/otp/complete`,
`GET …/oidc/start`, `GET …/oidc/callback`, `POST …/sign-out`, and
`GET …/session`, plus `getSessionToken` / `withRequestSession` for authenticating
every other request. `returnTo` is open-redirect-guarded, `allow_otp` is enforced
server-side, and the OIDC login-state cookie is HMAC-signed and freshness-checked.

Full reference: **[HTTP transport](https://mabulu-inc.github.io/simplicity-auth/http/transport/)**.

## Developer OTP — for devs whose phones can't receive SMS

Twilio's Verify service doesn't deliver SMS to every carrier reliably (especially overseas, certain pre-paid carriers, and some VoIP numbers). Real-world projects need a way for developers to sign in even when SMS delivery is broken.

`@smplcty/auth` ships per-developer TOTP enrollment for exactly this case. Each enrolled dev has their own time-based one-time password secret stored in `dev_otp_enrollments`, scanned into a standard authenticator app (1Password, Authy, Google Authenticator, etc.). The verify side tries the dev OTP first; if it doesn't match, it falls through to Twilio. (The `twilioVerifyHandler` does this for you; the primitives below are for hand-rolled flows.)

### How the codes are distinguished from Twilio codes

**They aren't, by format.** A 6-digit TOTP code from an authenticator app is indistinguishable from a 6-digit SMS code from Twilio. Users type whatever they have into the same input field. The backend figures out which one was used by **trying dev OTP first, then falling through to Twilio**.

The 1-in-1,000,000 collision risk between a wrong Twilio code and the user's current TOTP is negligible, and the audit trail (`dev_otp_enrollments.last_used_at` + `used_count`) lets you tell after the fact which path succeeded for any given sign-in.

### Send side: skip Twilio for dev-enrolled users

When a user is enrolled in dev OTP, you don't need to send them an SMS at all — they'll generate their code from their authenticator app. Use `isDevOtpEnrolled` to skip the Twilio call:

```ts
import { findUserByCommunicationMethod, isDevOtpEnrolled } from '@smplcty/auth';
import { createTwilioVerifyClient } from '@smplcty/twilio';

const twilio = createTwilioVerifyClient({
  /* ... */
});

// Sign-in send handler:
const lookup = await findUserByCommunicationMethod(db, { channel: 'phone', code: phone });
if (!lookup) {
  // User not registered. Return success anyway to avoid the enumeration oracle.
  return ok();
}

const enrolled = await isDevOtpEnrolled(db, lookup.userCommunicationMethodId);
if (!enrolled) {
  // Normal user — send the SMS code.
  await twilio.sendVerificationCode({ channel: 'sms', to: phone });
}
// Dev-enrolled user gets the same response shape with no SMS — they
// already know to open their authenticator app.

return ok();
```

`isDevOtpEnrolled(db, userCommunicationMethodId)` returns `boolean`. Cheap one-row lookup. Throws `InvalidInputError` if the id is malformed.

### Verify side: try dev OTP first, fall through to Twilio

```ts
import { verifyDevOtp, createSession, findUserByCommunicationMethod } from '@smplcty/auth';
import { createTwilioVerifyClient } from '@smplcty/twilio';

const twilio = createTwilioVerifyClient({
  /* ... */
});

// Sign-in verify handler:
const lookup = await findUserByCommunicationMethod(db, { channel: 'phone', code: phone });
if (!lookup) return badRequest('Invalid code');

// 1. Try dev OTP first.
const devOk = await verifyDevOtp(db, lookup.userCommunicationMethodId, submittedCode);
if (devOk) {
  // dev_otp_enrollments.last_used_at and used_count have been updated
  // — that's your built-in audit signal that the dev path was taken.
  return await createSessionResponse(db, lookup, ip, geo);
}

// 2. Fall through to Twilio. For users without a dev enrollment this
//    is the only path; for users with one whose code didn't match (e.g.
//    they happened to type the SMS code), this is the fallback.
const twilioOk = await twilio.verifyVerificationCode({ to: phone, code: submittedCode });
if (twilioOk) {
  return await createSessionResponse(db, lookup, ip, geo);
}

return badRequest('Invalid code');
```

`verifyDevOtp` returns `false` (does not throw) when:

- The user has no row in `dev_otp_enrollments`
- The submitted code doesn't match a TOTP for the stored secret within the ±30s tolerance window
- The stored secret is malformed (caught and treated as a non-match)

On success it updates the enrollment row's `last_used_at` and `used_count`, giving you a built-in audit signal that the dev OTP path was taken.

Both `verifyDevOtp` and `isDevOtpEnrolled` return `false` regardless of whether the user is enrolled or not (just with different conditions), so neither leaks enrollment status to the caller.

### Enrolling a dev

There's no shipped CLI — at the team sizes this library is designed for, manual enrollment via SQL is fine and explicit. Here's the recipe:

```ts
// One-off enrollment script: scripts/enroll-dev.mts
import { generateDevOtpSecret, getDevOtpEnrollmentUri } from '@smplcty/auth';
import qrcode from 'qrcode'; // pnpm add -D qrcode

const phone = process.argv[2]; // e.g. '+15558675309'
const label = process.argv[3]; // e.g. 'sam@salez1.com'
const issuer = 'Salez1';

const secret = generateDevOtpSecret();
const uri = getDevOtpEnrollmentUri({ secret, label, issuer });

console.log('\nScan this QR code with your authenticator app:\n');
console.log(await qrcode.toString(uri, { type: 'terminal', small: true }));
console.log(`\nManual entry secret: ${secret}\n`);
console.log('After scanning, run this SQL against your database:');
console.log(`
INSERT INTO dev_otp_enrollments (user_communication_method_id, totp_secret)
SELECT ucm.user_communication_method_id, '${secret}'
FROM user_communication_methods ucm
JOIN communication_channels cc ON cc.communication_channel_id = ucm.communication_channel_id
WHERE cc.name = 'phone' AND ucm.code = '${phone}';
`);
```

The script generates a fresh secret, prints a scannable QR code, and gives you the SQL to run against your database.

### Revoking a dev's enrollment

```sql
DELETE FROM dev_otp_enrollments
WHERE user_communication_method_id = (
  SELECT user_communication_method_id
  FROM user_communication_methods ucm
  JOIN communication_channels cc ON cc.communication_channel_id = ucm.communication_channel_id
  WHERE cc.name = 'phone' AND ucm.code = '+15558675309'
);
```

The next verify call for that user will fall through to Twilio as if they were never enrolled.

### Why per-dev TOTP instead of a shared bypass code?

A single static bypass code shared across all devs has a large blast radius, no per-dev revocation, and no audit trail, and bakes a "how to sign in without OTP" recipe into the source. Per-dev TOTP fixes all of these: one-account blast radius, delete-one-row revocation, a `last_used_at`/`used_count` audit trail per enrollment, codes that rotate every 30s, and a possession factor (the authenticator app on a specific device). Secrets live per-dev in the DB, not in source.

## Roles & privileges

One `roles` table, one `user_roles` assignment, a flag:

- `is_privilege = false` — selectable **mode/persona** roles. These drive the role switcher and become `app.active_role`. One should be marked `is_default`.
- `is_privilege = true` — always-on **capability flags**. Every privilege the user holds is exported in `app.privileges`.

`ctx.roles` is the selectable roles the user holds; `ctx.privileges` is their capability flags. RLS policies parse `app.privileges` with `string_to_array(current_setting('app.privileges', true), ',')`.

### Typed roles

By default `roleName` is `string`. For autocomplete and typo detection, write a thin wrapper:

```ts
// src/lib/auth.ts
import {
  withSession as baseWithSession,
  type SessionContext as BaseContext,
  type Pool,
  type PoolClient,
} from '@smplcty/auth';

export type RoleName = 'user' | 'settings' | 'security';
export type SessionContext = BaseContext<RoleName>;

export function withSession<T>(
  pool: Pool,
  auth: { token: string; roleName?: RoleName },
  fn: (client: PoolClient, ctx: SessionContext) => Promise<T>,
  options?: Parameters<typeof baseWithSession<RoleName, T>>[3],
): Promise<T> {
  return baseWithSession<RoleName, T>(pool, auth, fn, options);
}

export * from '@smplcty/auth';
```

## Logging

The library logs nothing by default. Pass a logger to `withSession`:

```ts
import pino from 'pino';
const logger = pino();
await withSession(pool, { token, roleName: 'user' }, fn, { logger });
```

The `Logger` interface matches pino's `(data, msg)` shape. The library never logs the raw token or PII — only structural events with safe identifiers (a hash fingerprint, `userId`, role).

## Required database schema

The library ships its schema as schema-flow YAML inside the package at `@smplcty/auth/schema/`. It does **not** run migrations — you own that. Generic mixins (`audit`, `soft_delete`) are **consumed from [`@smplcty/schema-std`](https://www.npmjs.com/package/@smplcty/schema-std)**, parameterized to auth's `users` table + `app.actor_id`.

```
@smplcty/auth/schema/
├── tables/
│   ├── users.yaml                       # + audit; seeds the app-init service user (matched by name)
│   ├── tenants.yaml                      # + audit; slug (sub-domain), allow_otp (SSO-only switch)
│   ├── roles.yaml                        # + audit; seeds 'user' (default), 'settings', 'security'
│   ├── user_roles.yaml                   # + audit; tenant_id NULL = wildcard / all tenants
│   ├── communication_channels.yaml      # + audit
│   ├── user_communication_methods.yaml  # + audit
│   ├── auth_domains.yaml                 # + audit; tenant's IdP(s), 1:N, resolved by id (display_name = button)
│   ├── sessions.yaml                     # PK = token hash; last_seen_at; geo
│   └── dev_otp_enrollments.yaml
├── functions/
│   ├── resolve_session.yaml              # pure resolver (SECURITY DEFINER)
│   └── current_user_id.yaml              # reads app.actor_id
└── post/
    └── 0001-backfill-audit-by.sql        # attributes seeded rows to app-init before NOT NULL tighten
```

### Consuming with [`@smplcty/schema-flow`](https://www.npmjs.com/package/@smplcty/schema-flow)

Requires **`@smplcty/schema-flow >= 0.13.0`** — the shipped seeds assign no primary keys (the app-init user and the standard roles are matched by their natural keys, `name`/`kind`) and rely on insert-only seeding, where an existing row is never overwritten. `0.13.0` makes insert-only the default (the old per-table `seeds_on_conflict` knob is gone); on older versions these seeds would upsert and clobber any consumer edits to the standard roles on every migration.

Import auth's schema and `@smplcty/schema-std` from your schema-flow config. See the reference [`schema-flow.config.yaml`](schema-flow.config.yaml):

```yaml
default:
  imports:
    - package: '@smplcty/schema-std' # generic mixins, parameterized to users / user_id / app.actor_id
    - package: '@smplcty/auth' # identity/tenant/auth_domains tables + resolve_session/current_user_id
```

The `audit` mixin makes `created_by`/`updated_by` NOT NULL, stamped from `app.actor_id`. Rows seeded during migration have no request actor, so the shipped `post/` script back-fills them to the seeded `app-init` service user (resolved by name, not a fixed id) before the NOT NULL tighten phase — see the config for details.

### Soft delete

Every table carries the `soft_delete` mixin (`deleted_at`). The library **honors** it — `resolve_session`, `validateSession`, `findUserByCommunicationMethod`, `getUserRoleNames`, and the flat-tenant preset all exclude soft-deleted rows — so a soft-deleted session, user, communication method, or role assignment stops taking effect immediately. Unique indexes are partial (`WHERE deleted_at IS NULL`) so a name/code can be reused after its row is archived. Setting/clearing `deleted_at` is a plain write your app owns; the library ships no delete setter. (Note: writing `deleted_at` on an _audited_ table goes through the audit trigger, so set `app.actor_id` first — e.g. inside `withSession`/`withServiceContext`.)

### Functions the library calls

| Function                | Role                                                                                                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `resolve_session(hash)` | SECURITY DEFINER **pure resolver** → `{ user_id, expires_at, roles[], default_role, privileges[] }`; validates nothing (validation/role-selection live in `withSession`) |
| `current_user_id()`     | reads `app.actor_id` — the join key app RLS/scope functions should use                                                                                                   |

## Security model

- Every query parameterized — no string interpolation in the library.
- **Session tokens hashed at rest** (SHA-256); the raw 256-bit token is returned once and never stored. A DB leak exposes only hashes.
- Identity GUCs set via `set_config($1, $2, true)`, transaction-scoped — injection and cross-request leakage are impossible.
- `withSession` validates existence, expiry/revocation, and role membership before running the callback. Fails closed.
- Force sign-off is a row update (per-session, per-user, or per-tenant); role/privilege changes apply on the next request.
- Auth core has no `jose`/Twilio dependency; method handlers are opt-in subpaths with optional peers.

## License

MIT — see [LICENSE](LICENSE).
