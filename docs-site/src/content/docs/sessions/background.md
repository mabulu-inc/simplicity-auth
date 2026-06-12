---
title: Background work
description: withServiceContext — run background writes as an audited service principal.
---

```ts
withServiceContext<T>(pool: Pool, serviceName: string, fn: (client: PoolClient) => Promise<T>): Promise<T>
```

Background writers (ingestion, transform workers, app-init) have no human
session, but audit attribution (`created_by`/`updated_by`, stamped from
`app.actor_id`) is NOT NULL. Run them as a named **service principal** — a
`users` row of `kind = 'service'` — so the actor is set and writes are
attributed:

```ts
await withServiceContext(pool, 'transform-worker', async (client) => {
  await client.query('INSERT INTO metrics (...) VALUES (...)'); // audited to the service
});
```

It opens a `@smplcty/db` transaction, looks up the `kind='service'` user by name,
sets `app.actor_id` (its `user_id`) and `app.session_id` (the service name, for
correlation), then runs `fn`. No active role or privileges — service principals
act through `current_user_id()` and RLS, not roles.

Throws `ServicePrincipalNotFoundError` if no `kind='service'` user has that name
(usually a missing seed), or `InvalidInputError` if `serviceName` is empty.
