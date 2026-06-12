---
title: Introduction
description: What @smplcty/auth is, the one seam between library and app, and why stateful sessions.
---

`@smplcty/auth` is the shared authentication core for PostgreSQL apps that use
Row-Level Security. It owns **identity, sessions, roles/privileges, tenants,
sign-in federation, and per-request context.** Each app owns only its
**intra-tenant authorization scope** — its own RLS model.

## The one seam

- **Library:** users, sessions, roles + privileges, tenants, `auth_domains`,
  the sign-in method router, session lifecycle, and the identity GUC contract.
- **App:** the intra-tenant scope (producer/region/plant wildcards, a rep
  hierarchy, or a flat tenant list) and its RLS policies. The library never
  dictates a scope model.

## Why stateful sessions (not JWT)

The requirements decide it: **track sign-ins/activity**, **force immediate
sign-off for a whole tenant**, and make **role/privilege changes take effect
immediately**. All three need per-request server authority — exactly what a JWT
trades away. Both apps already open an RLS transaction per request, so a session
lookup is one indexed query folded into work already happening. Revocation is a
row update; role/privilege changes are immediate because they're resolved per
request — nothing is baked into the token.

## The identity GUC contract

Every request sets exactly four transaction-local GUCs (discarded on
COMMIT/ROLLBACK, so cross-request leakage is impossible):

| GUC               | Meaning                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `app.actor_id`    | the acting user (human **or** service); `current_user_id()` reads it |
| `app.session_id`  | the session hash, for correlation/audit                              |
| `app.active_role` | the chosen mode/persona role for the request                         |
| `app.privileges`  | comma-separated capability flags the user holds                      |

Intra-tenant **scope** GUCs are deliberately **not** in this contract — they're
app-owned (see [Authorization scope](/simplicity-auth/sessions/scope/)).

Continue to [Installation](/simplicity-auth/getting-started/installation/).
