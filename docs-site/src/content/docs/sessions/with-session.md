---
title: withSession
description: The high-level request entry point — resolve, validate, set identity GUCs, run under RLS.
---

```ts
withSession<TRole, T>(
  pool: Pool,
  auth: { token: string; roleName?: TRole },
  fn: (client: PoolClient, ctx: SessionContext<TRole>) => Promise<T>,
  options?: { scope?: ScopeHook; logger?: Logger },
): Promise<T>
```

The default API. It opens a `@smplcty/db` transaction, resolves the session from
its token, validates it, picks the active role, sets the
[identity GUCs](/simplicity-auth/reference/identity-gucs/), runs your optional
[scope hook](/simplicity-auth/sessions/scope/), runs your callback, and commits —
or rolls back on throw.

```ts
const widgets = await withSession(pool, { token, roleName: 'user' }, async (client, ctx) => {
  // ctx = { userId, activeRole, roles, privileges }
  const { rows } = await client.query('SELECT * FROM widgets');
  return rows;
});
```

## Active-role selection (in TypeScript, not the resolver)

`resolve_session` is a **pure resolver** that validates nothing. `withSession`
picks the active role:

1. the requested `roleName` if given — must be one the user holds, else `RoleNotHeldError`;
2. otherwise the user's **default** role (`roles.is_default`);
3. otherwise **none** — a privilege-only request, which is **not** an error.

## Errors

`withSession` throws **before** your callback runs if anything's wrong:

| Error                  | When                                          |
| ---------------------- | --------------------------------------------- |
| `SessionNotFoundError` | token matches no session                      |
| `SessionExpiredError`  | session has expired (or was revoked)          |
| `RoleNotHeldError`     | a requested `roleName` the user does not hold |
| `InvalidInputError`    | `token` is empty / wrong type                 |

All extend `AuthError` and carry a `code`:

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

## Typed roles

`roleName` defaults to `string`. Narrow it in a thin wrapper for autocomplete:

```ts
export function withSession<T>(
  pool: Pool,
  auth: { token: string; roleName?: 'user' | 'settings' | 'security' },
  fn: (client: PoolClient, ctx: SessionContext<'user' | 'settings' | 'security'>) => Promise<T>,
  options?: Parameters<typeof baseWithSession>[3],
) {
  return baseWithSession(pool, auth, fn, options);
}
```
