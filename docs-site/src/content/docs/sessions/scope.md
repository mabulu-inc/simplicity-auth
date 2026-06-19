---
title: Authorization scope
description: The role-aware RLS the library ships, the reusable RLS toolkit, the app-owned scope hook, and the flat-tenant preset.
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

## Role-aware RLS on the identity tables

Scope is app-owned, but the library ships **role-aware, tenant-scoped RLS on its
own tables** so multi-tenant isolation of identity data works out of the box —
keyed only on `user_roles` and the standard `user`/`settings`/`security` roles,
never an app column:

- **`users` / `user_roles` / `user_communication_methods`** — a user sees its
  own rows; a `security` admin manages the users (and their roles and contact
  methods) of tenants where it holds `security`. Raw `INSERT` on `users` is
  closed — provision through [`auth_create_user`](/simplicity-auth/schema/overview/#provisioning-with-auth_create_user).
- **`tenants`** — visible to any member; a `settings` admin maintains it, and a
  **global** `settings` admin creates and deletes tenants.
- **`auth_domains`** — a `settings` admin maintains the IdPs of tenants it
  administers.
- **`roles` / `communication_channels`** are public; **`sessions` /
  `dev_otp_enrollments`** are reached only through the bypass pool.

The migration/admin pool owns the tables and bypasses all of this.

## The RLS toolkit

Those policies are built from a few `SECURITY DEFINER` functions in `public`
that **your own policies can call too** — they read `user_roles` without the
policies on it recursing, and `EXECUTE` is public. Treat the three names as a
**stable contract**:

| Function                            | Use in a policy                                                                                                                                                      |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current_user_id()`                 | the request actor (`app.actor_id`) — the join key; `NULL` when unauthenticated                                                                                       |
| `auth_in_tenant(tenant_id)`         | the actor holds **any** role reaching that tenant                                                                                                                    |
| `auth_has_role(role_name, tenant_id)` | the actor holds `role_name` over that tenant; a wildcard assignment (`tenant_id IS NULL`) reaches every tenant, and passing `NULL` requires **global** authority |

So any business table with a `tenant_id` gets isolation directly, and the checks
compose with your own predicates:

```yaml
policies:
  - { name: read, for: SELECT, to: app_rls, using: 'auth_in_tenant(widgets.tenant_id)' }
  - name: manage
    for: ALL
    to: app_rls
    using: "auth_has_role('settings', widgets.tenant_id)"
    check: "auth_has_role('settings', widgets.tenant_id)"
```

**The `user_roles` contract.** Membership is `user_roles(user_id, role_id,
tenant_id)`, where `tenant_id IS NULL` means *all tenants*. To model a finer
hierarchy, `extend` `user_roles` with your own scope columns (`producer_id`,
`region_id`, … — each `NULL` = wildcard at that level) and write a `SECURITY
DEFINER` view or function that expands a user's assignments down **your**
hierarchy tables. That expansion stays app-owned (only your app has those
tables); auth gives you the identity key and the tenant/role checks to build it
on. The same wildcard rule applies at every level: `scope_col IS NULL OR
scope_col = row.scope_col`.
