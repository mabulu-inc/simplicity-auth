---
title: Session lifecycle
description: createSession, validateSession, revoke (single/user/tenant), touchSession, findUserByCommunicationMethod.
---

These build sign-in / sign-out / activity / authorizer flows. None are coupled
to a specific OTP provider, identity model, or transport.

## `findUserByCommunicationMethod`

```ts
const lookup = await findUserByCommunicationMethod(db, { channel: 'email', code: 'alice@example.com' });
// { userId, userCommunicationMethodId } | null
```

## `createSession`

```ts
const session = await createSession(db, {
  userCommunicationMethodId,
  ttl: '30 days',
  ip: req.ip,
  geo: { country: 'US', region: 'CA' },
});
// session = { token, userId, createdAt, expiresAt }
```

A fresh opaque token (256 bits) is generated server-side; **only its SHA-256
hash is stored** as the `sessions` primary key. `session.token` is the raw
bearer credential — return it once, don't persist it. `ttl` is a Postgres
interval evaluated server-side (`now() + interval $ttl`), so there's no clock
skew.

## `validateSession`

For authorizers / "is this token alive?" checks. Returns `SessionInfo`
(`{ userId, createdAt, expiresAt, lastSeenAt }`) or throws. Sets no GUCs.

## Revocation & activity

```ts
await revokeSession(db, token); // force sign-off of one session (idempotent)
await revokeUserSessions(db, userId); // every session of a user
await revokeTenantSessions(db, tenantId); // tenant-wide sign-off
await touchSession(db, token); // record activity (last_seen_at); returns whether a live session matched
```

Revoke is a **soft-revoke** — `expires_at = now()`, so the row survives for
audit but the session is locked out immediately. `revokeTenantSessions` resolves
membership from `user_roles.tenant_id` and deliberately **spares wildcard
(all-tenant) members** like global admins — only users explicitly in the tenant
are signed out.

## Soft delete

Sessions also honor `deleted_at` (the `soft_delete` mixin): a soft-deleted
session, user, or communication method is treated as gone by `resolve_session`
and `validateSession`. The library honors `deleted_at` but ships no delete
setter — setting it is a plain write your app owns. See
[Schema](/simplicity-auth/schema/overview/).
