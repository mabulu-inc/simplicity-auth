---
title: Required database schema
description: The shipped schema-flow YAML, consumed mixins from @smplcty/schema-std, and the functions the library calls.
---

The library ships its schema as schema-flow YAML under `@smplcty/auth/schema/`.
It does **not** run migrations — you own that. Generic mixins (`audit`,
`soft_delete`) are **consumed from
[`@smplcty/schema-std`](https://www.npmjs.com/package/@smplcty/schema-std)**,
parameterized to auth's `users` table + `app.actor_id`. The library also owns the
**grants** on its tables, **role-aware RLS** on the identity tables, and the RLS
helper functions plus `auth_create_user` — so a consuming app drops the schema in
and writes only its own domain.

```
@smplcty/auth/schema/
├── tables/                           # all grant CRUD to app_user (auth_grants mixin)
│   ├── users.yaml                    # + audit, RLS; seeds the app-init service user
│   ├── tenants.yaml                  # + audit, RLS; slug (sub-domain), allow_otp (SSO-only switch)
│   ├── roles.yaml                    # + audit; seeds 'user' (default), 'settings', 'security' — public
│   ├── user_roles.yaml               # + audit, RLS; tenant_id NULL = wildcard / all tenants
│   ├── communication_channels.yaml   # public
│   ├── user_communication_methods.yaml  # + audit, RLS
│   ├── auth_domains.yaml             # + audit, RLS; tenant's IdP(s), 1:N, resolved by id (display_name = button)
│   ├── sessions.yaml                 # PK = token hash; last_seen_at; geo — bypass-only
│   └── dev_otp_enrollments.yaml      # bypass-only
├── mixins/
│   └── auth_grants.yaml              # CRUD → app_user on every table
├── functions/
│   ├── resolve_session.yaml          # pure resolver (SECURITY DEFINER)
│   ├── current_user_id.yaml          # reads app.actor_id
│   ├── auth_has_role.yaml            # RLS helper — holds role over tenant
│   ├── auth_in_tenant.yaml           # RLS helper — any role reaching tenant
│   ├── auth_can_admin_user.yaml      # RLS helper — security admin shares a tenant with the user
│   └── auth_create_user.yaml         # authority-checked atomic provisioning
└── post/
    ├── 0001-backfill-audit-by.sql    # attributes seeded rows to app-init before NOT NULL tighten
    └── 0002-backfill-role-values.sql # back-fills the standard role values on pre-existing rows
```

## Consuming with schema-flow

Import auth's schema and `@smplcty/schema-std` from your schema-flow config (see
the shipped `schema-flow.config.yaml`):

```yaml
default:
  imports:
    - package: '@smplcty/schema-std' # generic mixins → users / user_id / app.actor_id
    - package: '@smplcty/auth' # identity/tenant/auth_domains + resolve_session/current_user_id
```

The `audit` mixin makes `created_by`/`updated_by` NOT NULL, stamped from
`app.actor_id`. Migration seeds have no request actor, so the shipped `post/`
script back-fills them to the seeded **app-init** service user (resolved by name,
no pinned id) before the NOT NULL tighten phase.

## Grants

Every auth table grants `SELECT, INSERT, UPDATE, DELETE` to an **`app_user`**
role (the `auth_grants` mixin), with sequence `USAGE` auto-derived — so you never
hand-write a grant-only extend per table, and a new table can't ship without its
grants. The library **grants to** `app_user` but does **not declare the role**:
the consuming app (or its infra) owns role creation and credentials, so the
grants land on whatever `app_user` the deployment already provisions and never
collide with that declaration. On a database where the role doesn't exist yet the
`GRANT` fails fast — provision the role first. A consumer whose login role is
named differently creates `app_user` and grants it to that role
(`GRANT app_user TO <role>`).

## Row-level security

The identity tables ship **role-aware, tenant-scoped RLS** keyed on `user_roles`
and the standard `user`/`settings`/`security` roles — see
[Authorization scope](/simplicity-auth/sessions/scope/#role-aware-rls-on-the-identity-tables).
The helper functions behind it (`current_user_id`, `auth_in_tenant`,
`auth_has_role`) are a [reusable contract](/simplicity-auth/sessions/scope/#the-rls-toolkit)
your own policies can call.

## Provisioning with `auth_create_user`

Raw `INSERT` on `users` is denied by RLS — a user must never exist without the
roles and contact methods that make it usable, and the grant of access must be
authorized. Create users through `auth_create_user(jsonb)` instead
(`SECURITY DEFINER`, atomic):

```sql
SELECT auth_create_user(jsonb_build_object(
  'name', 'Ada Lovelace',
  'communication_methods', jsonb_build_array(jsonb_build_object('channel', 'email', 'code', 'ada@acme.com')),
  'accesses', jsonb_build_array(jsonb_build_object('tenant_id', 5, 'role_id', 2))
));
```

It requires at least one communication method and one access, and checks
authority per access: the caller must hold `security` over every tenant being
granted — an all-tenants (`tenant_id` null) grant requires holding `security`
globally. A tenant-scoped admin therefore cannot create a global user or grant a
tenant it doesn't administer. OIDC auto-provisioning still runs through the
bypass pool.

## Soft delete

Every table carries `soft_delete` (`deleted_at`). The library **honors** it —
`resolve_session`, `validateSession`, `findUserByCommunicationMethod`,
`getUserRoleNames`, and the flat-tenant preset all exclude soft-deleted rows.
Unique indexes are partial (`WHERE deleted_at IS NULL`) so a name/code can be
reused after archive. Setting/clearing `deleted_at` is a plain write your app
owns.

## Functions

All `SECURITY DEFINER`. The first two are called by the library's runtime; the
rest power the shipped RLS and are a stable contract your own policies can reuse.

| Function                              | Role                                                                                                                                                                     |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve_session(hash)`               | **pure resolver** → `{ user_id, expires_at, roles[], default_role, privileges[] }`; validates nothing (validation/role-selection live in `withSession`)                  |
| `current_user_id()`                   | reads `app.actor_id` — the join key app RLS/scope functions should use                                                                                                  |
| `auth_in_tenant(tenant_id)`           | the current actor holds **any** role reaching that tenant                                                                                                               |
| `auth_has_role(role_name, tenant_id)` | the actor holds `role_name` over that tenant; a wildcard assignment reaches every tenant, and a `NULL` tenant requires **global** authority                              |
| `auth_can_admin_user(user_id)`        | the actor holds `security` over a tenant the target user belongs to (used by the `users`/`user_communication_methods` policies)                                          |
| `auth_create_user(jsonb)`             | authority-checked, atomic provisioning (user + communication methods + roles); the app's path to create a user since raw `INSERT` on `users` is closed under RLS         |
