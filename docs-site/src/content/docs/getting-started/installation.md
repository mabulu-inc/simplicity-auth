---
title: Installation
description: Install @smplcty/auth, its peers, and the optional sign-in handler subpaths.
---

```sh
pnpm add @smplcty/auth @smplcty/db pg
```

- **`pg`** is a peer dependency.
- **`@smplcty/db`** provides the transaction primitive (`withTransaction` is
  re-exported from it).

## Optional sign-in handlers

Sign-in handlers are **opt-in subpaths** with their own optional peers — auth
core depends on neither `oauth4webapi` nor Twilio, so a password-only app pulls
neither.

```sh
# OIDC (org-bound):
pnpm add oauth4webapi          # → import { oidcHandler } from '@smplcty/auth/oidc'

# Twilio Verify OTP (user-bound):
pnpm add @smplcty/twilio       # → import { twilioVerifyHandler } from '@smplcty/auth/twilio'
```

## Subpath exports

| Import | Purpose |
| --- | --- |
| `@smplcty/auth` | core: `withSession`, session lifecycle, identity setters, `createMethodRouter`, errors, types |
| `@smplcty/auth/oidc` | the `oidcHandler` (needs `oauth4webapi`) |
| `@smplcty/auth/twilio` | the `twilioVerifyHandler` (needs `@smplcty/twilio`) |
| `@smplcty/auth/flat-tenant` | the `flatTenantScope` preset |

## Schema

The library ships its schema as schema-flow YAML under `@smplcty/auth/schema/`
and consumes generic mixins from `@smplcty/schema-std`. See
[Required database schema](/simplicity-auth/schema/overview/).

Continue to [Quick start](/simplicity-auth/getting-started/quick-start/).
