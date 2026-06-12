---
title: Required database schema
description: The shipped schema-flow YAML, consumed mixins from @smplcty/schema-std, and the functions the library calls.
---

The library ships its schema as schema-flow YAML under `@smplcty/auth/schema/`.
It does **not** run migrations — you own that. Generic mixins (`audit`,
`soft_delete`) are **consumed from
[`@smplcty/schema-std`](https://www.npmjs.com/package/@smplcty/schema-std)**,
parameterized to auth's `users` table + `app.actor_id`.

```
@smplcty/auth/schema/
├── tables/
│   ├── users.yaml                    # + audit; seeds the app-init service user (id 1)
│   ├── tenants.yaml                  # + audit; slug (sub-domain), allow_otp (SSO-only switch)
│   ├── roles.yaml                    # + audit; seeds 'user' (default), 'settings', 'security'
│   ├── user_roles.yaml               # + audit; tenant_id NULL = wildcard / all tenants
│   ├── communication_channels.yaml
│   ├── user_communication_methods.yaml
│   ├── auth_domains.yaml             # + audit; tenant's IdP(s), 1:N, resolved by id (display_name = button)
│   ├── sessions.yaml                 # PK = token hash; last_seen_at; geo
│   └── dev_otp_enrollments.yaml
├── functions/
│   ├── resolve_session.yaml          # pure resolver (SECURITY DEFINER)
│   └── current_user_id.yaml          # reads app.actor_id
└── post/
    └── 0001-backfill-audit-by.sql    # attributes seeded rows to app-init before NOT NULL tighten
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
script back-fills them to the seeded **app-init** service user (`users.user_id =
1`) before the NOT NULL tighten phase.

## Soft delete

Every table carries `soft_delete` (`deleted_at`). The library **honors** it —
`resolve_session`, `validateSession`, `findUserByCommunicationMethod`,
`getUserRoleNames`, and the flat-tenant preset all exclude soft-deleted rows.
Unique indexes are partial (`WHERE deleted_at IS NULL`) so a name/code can be
reused after archive. Setting/clearing `deleted_at` is a plain write your app
owns.

## Functions the library calls

| Function                | Role                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `resolve_session(hash)` | SECURITY DEFINER **pure resolver** → `{ user_id, expires_at, roles[], default_role, privileges[] }`; validates nothing (validation/role-selection live in `withSession`) |
| `current_user_id()`     | reads `app.actor_id` — the join key app RLS/scope functions should use |
