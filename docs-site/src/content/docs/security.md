---
title: Security model
description: The guarantees @smplcty/auth makes.
---

- **Every query is parameterized** — no string interpolation in the library.
- **Session tokens are hashed at rest** (SHA-256). The raw 256-bit token is
  returned once and never stored; a database leak exposes only hashes.
- **Identity GUCs are set via `set_config($1, $2, true)`** — transaction-scoped,
  so injection and cross-request leakage are impossible.
- **`withSession` fails closed** — it validates existence, expiry/revocation,
  and role membership before your callback runs.
- **Force sign-off is a row update** — per-session, per-user, or per-tenant
  (`revokeTenantSessions` spares NULL-wildcard members). Role/privilege changes
  apply on the next request because they're resolved per request, not baked into
  the token.
- **OIDC verification is delegated to `oauth4webapi`** (the spec-complete engine,
  using JWKS); auth core has no `oauth4webapi`/Twilio dependency — method
  handlers are opt-in subpaths with optional peers.
- **Soft-deleted rows stop taking effect immediately** — session resolution and
  user/role lookups exclude `deleted_at IS NOT NULL`.
- **Audit attribution is enforced** — auditable tables' `created_by`/`updated_by`
  are NOT NULL, stamped from `app.actor_id`; background writes run as an audited
  service principal.
