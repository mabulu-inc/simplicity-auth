---
title: Authorization scope
description: The app-owned scope hook, and the flat-tenant preset.
---

`withSession` sets **identity** GUCs only. Intra-tenant **scope** (which tenants,
plants, regions, or reps a request may see) is app-owned — the library ships no
scope model. Pass a `scope` hook; it runs inside the request transaction, after
the identity GUCs are set:

```ts
await withSession(pool, { token, roleName: 'user' }, fn, {
  scope: async (client, identity) => {
    // identity = { userId, activeRole, roles, privileges }
    // set whatever scope GUCs your RLS policies read
  },
});
```

Or enforce scope **function-carried**: omit the hook and let RLS policies call
functions that read `current_user_id()` against your scope tables.

## The flat-tenant preset

For simple multi-tenant apps (the 0.6.x behavior), a ready-made hook ships at a
subpath. It sets `app.tenant_ids` + `app.all_tenants` from the user's
`user_roles`:

```ts
import { withSession } from '@smplcty/auth';
import { flatTenantScope } from '@smplcty/auth/flat-tenant';

const scope = flatTenantScope();
await withSession(pool, { token, roleName: 'user' }, fn, { scope });
```

`tenant_id IS NULL` in `user_roles` is a wildcard (all tenants → `all_tenants`);
concrete ids become `tenant_ids`. Apps with a richer model (producer/region/plant,
rep hierarchy) ship their own hook instead.
