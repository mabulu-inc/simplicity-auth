# @smplcty/auth

Robust, type-safe session and role-based authentication primitives for PostgreSQL apps using Row-Level Security.

[![npm](https://img.shields.io/npm/v/@smplcty/auth.svg)](https://www.npmjs.com/package/@smplcty/auth)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## Why

Multi-tenant Postgres apps that use Row-Level Security need three things in every request:

1. A validated session attached to a real user.
2. A role for that session that gates which RLS policies apply.
3. A list of tenant IDs the session is allowed to see.

These need to be set as session variables (`app.session_id`, `app.role_name`, `app.tenant_ids`, `app.all_tenants`) on a dedicated database connection, inside a transaction so they don't leak across requests.

`@smplcty/auth` makes that boring and safe. The high-level `withSession` does the whole dance in one call. The low-level `set*` helpers and `withTransaction` are there for migration and unusual cases.

## Install

```sh
pnpm add @smplcty/auth pg
```

`pg` is a peer dependency.

## High-level usage — `withSession`

The default API. Hand it a pool, an authenticated session, and a callback. It checks out a connection, opens a transaction, validates the session, sets all four session variables via parameterized `set_config`, runs your code, and commits (or rolls back on throw).

```ts
import { withSession } from '@smplcty/auth';

const widgets = await withSession(
  pool,
  { sessionId, roleName: 'user' },
  async (client, ctx) => {
    // ctx = { userId, tenantIds, allTenants, roles }
    const { rows } = await client.query('SELECT * FROM widgets');
    return rows;
  }
);
```

If the session doesn't exist, is expired, or the user doesn't have the requested role, `withSession` throws **before** your callback runs. Your code never sees an invalid context.

### Errors thrown by `withSession`

| Error | When |
|---|---|
| `SessionNotFoundError` | sessionId doesn't match any row |
| `SessionExpiredError` | session row exists but `expires_at` has passed |
| `RoleNotAssignedError` | user does not have the requested role |
| `InvalidInputError` | sessionId or roleName is empty / wrong type |

All errors extend `AuthError` and have a `code` property:

```ts
try {
  await withSession(pool, { sessionId, roleName: 'user' }, fn);
} catch (err) {
  if (err instanceof AuthError && err.code === 'SESSION_EXPIRED') {
    // redirect to login
  }
  throw err;
}
```

## Low-level usage — `withTransaction` + `set*` helpers

For migrating existing code that has its own session-extraction logic, or for tests, or for any case where you need more control than `withSession` gives you.

```ts
import {
  withTransaction,
  setSessionId,
  setRoleName,
  setTenantIds,
  setAllTenants,
} from '@smplcty/auth';

await withTransaction(pool, async (client) => {
  await setSessionId(client, sessionId);
  await setRoleName(client, 'user');
  await setTenantIds(client, [1, 2, 3]);
  await setAllTenants(client, false);

  return client.query('SELECT * FROM widgets');
});
```

Or all four at once:

```ts
import { withTransaction, setSessionContext } from '@smplcty/auth';

await withTransaction(pool, async (client) => {
  await setSessionContext(client, {
    sessionId,
    roleName: 'user',
    tenantIds: [1, 2, 3],
    allTenants: false,
  });
  return client.query('SELECT * FROM widgets');
});
```

**Important contract:** every `set*` helper requires a `PoolClient` that is already inside an open transaction. The `withTransaction` wrapper guarantees that. If you try to pass a `Pool`, the type checker rejects it. The variables are set with **transaction scope** (`set_config(name, value, true)`) — they are automatically discarded when the transaction commits or rolls back, so cross-request leakage is impossible.

The low-level helpers do **not** validate that the session exists or that the user has the role. If you need validation, use `withSession`. If you bypass `withSession`, validate session and role yourself before setting them.

## Sign-in flow primitives

`createSession`, `validateSession`, `revokeSession`, and `findUserByCommunicationMethod` are the helpers you need to build a sign-in / sign-out / authorizer flow. None of them are coupled to a specific OTP provider, identity model, or transport.

### `findUserByCommunicationMethod`

```ts
import { findUserByCommunicationMethod } from '@smplcty/auth';

const lookup = await findUserByCommunicationMethod(db, {
  channel: 'email',
  code: 'alice@example.com',
});
if (!lookup) {
  // user not registered
  return;
}
// lookup = { userId, userCommunicationMethodId }
```

### `createSession`

```ts
import { createSession } from '@smplcty/auth';

const session = await createSession(db, {
  userCommunicationMethodId: lookup.userCommunicationMethodId,
  ttl: '30 days',
  ip: req.ip,
  geo: { country: 'US', region: 'CA' },
});
// session = { sessionId, userId, createdAt, expiresAt }
```

`ttl` is a Postgres interval string, evaluated server-side via `now() + interval $ttl`. This means the expiration time has zero clock-skew between your app and the database.

### `validateSession`

For authorizers and other "is this token alive?" checks. Returns the Session if valid, throws if not. Does not set any database context.

```ts
import { validateSession, SessionExpiredError } from '@smplcty/auth';

try {
  const session = await validateSession(db, sessionId);
  return { allow: true, principalId: String(session.userId) };
} catch (err) {
  return { allow: false };
}
```

### `revokeSession`

```ts
import { revokeSession } from '@smplcty/auth';

await revokeSession(db, sessionId); // idempotent — no error if already revoked
```

Hard-deletes the session row.

## Typed roles

By default `roleName` is typed as `string`, which works for any consumer. To get autocomplete and typo detection for your specific role names, write a thin wrapper in your application code:

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

export async function withSession<T>(
  pool: Pool,
  auth: { sessionId: string; roleName: RoleName },
  fn: (client: PoolClient, ctx: SessionContext) => Promise<T>,
): Promise<T> {
  return baseWithSession<RoleName, T>(pool, auth, fn);
}

export * from '@smplcty/auth';
```

Now everywhere in your app:

```ts
import { withSession, type RoleName } from './lib/auth';

await withSession(pool, { sessionId, roleName: 'user' }, async (client, ctx) => {
  ctx.roles; // readonly RoleName[]
});
```

A typo in `roleName` becomes a compile error.

## Logging

`@smplcty/auth` does not log anything by default. To get diagnostic logs, pass an optional logger to `withSession`:

```ts
import { withSession } from '@smplcty/auth';
import pino from 'pino';

const logger = pino({ redact: ['*.sessionId', 'headers.authorization'] });

await withSession(
  pool,
  { sessionId, roleName: 'user' },
  fn,
  { logger }
);
```

The `Logger` interface matches pino's structured-logging shape (`(data, msg)`), so you can pass a pino logger directly with no adapter. The library never logs the session ID or any PII; it logs structural events like `'session validated'` with non-sensitive identifiers like `userId` and a hash prefix of the session ID.

If you don't pass a logger, the library is silent.

## Required database schema

This library reads and writes specific tables and session variables. It does **not** run migrations — you own your schema. The exact schema the library expects is shipped inside the package at `node_modules/@smplcty/auth/schema/`:

```
@smplcty/auth/schema/
└── tables/
    ├── tenants.yaml
    ├── roles.yaml                       # includes inline seeds for the
    │                                    # canonical 'user', 'settings',
    │                                    # 'security' roles (IDs 1-3)
    ├── users.yaml
    ├── communication_channels.yaml
    ├── user_communication_methods.yaml
    ├── user_roles.yaml
    └── sessions.yaml
```

These files **are** the schema. They are validated end-to-end by the library's own test suite on every release — if the library passes its tests, your database will accept them.

The canonical role seeds are colocated with the table definition in `roles.yaml`. Role IDs 1-3 are reserved for the standard `'user'`, `'settings'`, `'security'` rows; consumers adding their own roles should use IDs >= 100. The library never references these IDs directly — it always looks up by name — so the IDs are just a stable convention for migration-time conflict detection.

### If you use [`@smplcty/schema-flow`](https://www.npmjs.com/package/@smplcty/schema-flow)

Copy the shipped files into your own schema directory:

```sh
cp node_modules/@smplcty/auth/schema/tables/*.yaml schema/tables/
npx @smplcty/schema-flow run
```

You can edit the copies if you need additional columns (e.g. add a `last_seen_at` to `sessions`) — just keep the columns the library reads/writes intact.

### If you use any other migration tool (Drizzle, Prisma, hand-rolled SQL, …)

Translate the YAML manually. The equivalent DDL is:

```sql
CREATE TABLE tenants (
  tenant_id    SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE
);

CREATE TABLE roles (
  role_id      SERIAL PRIMARY KEY,
  name         TEXT NOT NULL UNIQUE
);
INSERT INTO roles (role_id, name) VALUES
  (1, 'user'),
  (2, 'settings'),
  (3, 'security')
ON CONFLICT (role_id) DO NOTHING;

CREATE TABLE users (
  user_id      SERIAL PRIMARY KEY,
  name         TEXT
);

CREATE TABLE communication_channels (
  communication_channel_id  SERIAL PRIMARY KEY,
  name                      TEXT NOT NULL UNIQUE
);

CREATE TABLE user_communication_methods (
  user_communication_method_id  SERIAL PRIMARY KEY,
  user_id                       INT NOT NULL REFERENCES users(user_id),
  communication_channel_id      INT NOT NULL REFERENCES communication_channels(communication_channel_id),
  code                          TEXT NOT NULL,
  UNIQUE (communication_channel_id, code)
);

CREATE TABLE user_roles (
  user_role_id  SERIAL PRIMARY KEY,
  user_id       INT NOT NULL REFERENCES users(user_id),
  role_id       INT NOT NULL REFERENCES roles(role_id),
  tenant_id     INT REFERENCES tenants(tenant_id)  -- NULL = global / all tenants
);

CREATE TABLE sessions (
  session_id                    TEXT PRIMARY KEY,
  user_communication_method_id  INT NOT NULL REFERENCES user_communication_methods(user_communication_method_id),
  created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at                    TIMESTAMPTZ NOT NULL,
  ip                            TEXT,
  city                          TEXT,
  region                        TEXT,
  country                       TEXT,
  latitude                      TEXT,
  longitude                     TEXT
);
```

The DDL above is kept in sync with the shipped YAML files by hand. If you're paranoid about drift between this snippet and what the library actually requires, copy the YAML files instead — they are the source of truth.

The library also expects four custom Postgres session variables to be readable from your RLS policies:

| GUC | Set by | Type |
|---|---|---|
| `app.session_id` | `setSessionId` / `setSessionContext` / `withSession` | text |
| `app.role_name` | `setRoleName` / `setSessionContext` / `withSession` | text |
| `app.tenant_ids` | `setTenantIds` / `setSessionContext` / `withSession` | comma-separated text (parsed into int[] in policies) |
| `app.all_tenants` | `setAllTenants` / `setSessionContext` / `withSession` | text `'true'` or `'false'` |

These are set with **transaction scope** (`set_config(name, value, true)`) and discarded automatically on COMMIT or ROLLBACK.

## Security model

- Every parameterized query — no string interpolation anywhere in the library.
- Session variables set via `set_config($1, $2, true)`, not `SET ... TO ...` with concatenation. SQL injection in session/role names is impossible.
- Transaction scope on every session variable. Cross-request leaks are impossible.
- `withSession` validates session existence, expiration, and role assignment before running the callback. Fails closed on any check.
- `crypto.randomUUID()` for session IDs (122 bits of entropy).
- No `console.*` calls in library code. PII in logs is the consumer's choice, not the library's default.
- No transitive runtime dependencies — only `pg` as a peer dependency.

## License

MIT — see [LICENSE](LICENSE).
