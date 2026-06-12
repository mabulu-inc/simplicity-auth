---
title: Identity GUC contract
description: The four GUCs the library sets, and the low-level setters.
---

`@smplcty/auth` sets exactly four transaction-local GUCs per request
(`set_config(name, value, true)` — discarded on COMMIT/ROLLBACK, so
cross-request leakage is impossible). Reference them in your RLS policies.

| GUC               | Set to                                                       |
| ----------------- | ------------------------------------------------------------ |
| `app.actor_id`    | the acting user (human or service) — powers `current_user_id()` and audit |
| `app.session_id`  | the session hash, for correlation/audit                      |
| `app.active_role` | the chosen mode/persona role (empty when privilege-only)     |
| `app.privileges`  | comma-separated privilege names (`string_to_array(_, ',')` in policies) |

Scope GUCs (tenant ids, region/plant, visible reps, …) are **not** in this
contract — they're [app-owned](/simplicity-auth/sessions/scope/).

## Low-level setters

`withSession` sets these for you. For migrating existing code, tests, or unusual
cases, the setters are exported — each requires a `PoolClient` already inside a
transaction (`withTransaction` is re-exported from `@smplcty/db`):

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

Individual setters — `setActorId`, `setSessionId`, `setActiveRole`,
`setPrivileges`, `setLocal` — and the `IDENTITY_GUC` name map are also exported.
The low-level setters do **not** validate the session; use `withSession` for
that.
