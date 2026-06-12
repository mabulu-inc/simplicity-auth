# ADR-0001: OIDC via `oauth4webapi` in the `OidcHandler` (not Auth.js, not `@smplcty/oidc`)

- **Status:** Accepted — 2026-06-12
- **Supersedes:** the "full OIDC flow in `@smplcty/oidc`" follow-up noted in `docs/v1-design.md`
- **Relates to:** `@smplcty/auth/oidc` (the `OidcHandler`), `@smplcty/oidc` (deprecated by this ADR)

## Context

v1 (`docs/v1-design.md`) puts **sign-in federation in `@smplcty/auth`**: `auth_domains` config, the method router, and an opt-in `@smplcty/auth/oidc` `OidcHandler`. The open question was **how** to implement the OIDC protocol (authorization-URL building, PKCE, `state`/`nonce`, code→token exchange, `id_token`/JWKS verification) — a security-critical domain not worth hand-rolling.

We investigated the **legacy `production-now` OIDC** for prior art and found:

- The browser ran the OIDC dance via **NextAuth/Auth.js**; a Next route forwarded the resulting `id_token` to an **AWS Lambda** (`sign-in-oidc`) that verified it via `@smplcty/oidc`'s `verifyIdToken` and created a session via `@smplcty/auth`.
- **Config discovery is live in prod** (`POST /sign-in` with `{ code }` → returns the `auth_domains` OIDC config), but the **verification half was never wired or invoked**: the `sign-in-oidc` Lambda has **0 invocations and no log group**, there is no `/sign-in/oidc` route on the prod API Gateway, and the prod `BACKEND_URL` points at that routeless gateway — so completion `404`s. There is **no production-proven server-side OIDC completion to port.**
- The one real tenant, **Clyde (`auth_domains.code = 'clyde-inc'`, tenant 9), uses Microsoft Entra ID** — a confidential client; `issuer` (`https://login.microsoftonline.com/<tenant-guid>/v2.0`) + `client_id` are stored in `auth_domains`, with a `client_secret` (the legacy stored it in the DB).

Relevant constraints of our stack:

- `@smplcty/auth` already owns **identity, sessions, tenancy, and authorization** — opaque hashed sessions + **Postgres RLS via identity GUCs** (`withSession`). We do **not** use a framework session.
- The API is **Hono**; multitenancy is **by sub-domain** (`tenants.slug`), so each tenant needs **per-request OIDC config** (a different Entra app).

### Options considered

1. **Hand-roll the flow in `@smplcty/oidc`** (the original `#4`). Rejected — reimplementing a security-critical protocol by hand.
2. **Auth.js (`@auth/core` / `next-auth`).** A framework: it does the dance **and** brings its own identity/session model (`accounts`/`sessions` tables, its cookie, middleware-based authz) and provider catalog. It uses `oauth4webapi` + `jose` internally. Rejected as the auth system — see below.
3. **`oauth4webapi` (panva; zero-dep, spec-complete, framework-agnostic).** A toolkit for exactly the protocol primitives; you own session/cookie/state. **Chosen.**

## Decision

- **Implement the OIDC protocol with `oauth4webapi`, wrapped by `@smplcty/auth/oidc`'s `OidcHandler`** — `initiate` = discovery + authorization URL + PKCE/`state`/`nonce`; `complete` = code→token exchange + `id_token` verification. This realizes the v1 design's `#4` with a **vetted library instead of hand-rolled code**.
- **Do not adopt Auth.js as the auth system.** It would layer a **parallel** identity/session/authz model over the `@smplcty/auth` + RLS one we deliberately built; we'd use only ~30% of it (the protocol slice — which _is_ `oauth4webapi`) while paying for a framework and its sessions/adapters/middleware we'd ignore. Auth.js remains the right choice only for a _greenfield, web-centric_ consumer that adopts its sessions — not us.
- **Deprecate `@smplcty/oidc`.** It is a thin `jose` wrapper (`verifyIdToken` + `getOidcConfig`); `oauth4webapi` subsumes both and adds the full flow. The `OidcHandler` will depend on `oauth4webapi` (with `jose` transitive) instead.
- **OTP / dev-OTP stay in the `@smplcty/auth` method router** (`initiateOtp`/`completeOtp`, `verifyDevOtp`, the `tenants.allow_otp` gate). `oauth4webapi` is OIDC-only; OTP is **not** routed through Auth.js Credentials (it has no hard protocol part to delegate, and the Credentials provider is the framework's most constrained path).
- **The consumer owns the transient login-state store** — `code_verifier` / `state` / `nonce` in a short-lived signed cookie — and the callback route (per v1's "caller persists verifier/state").
- **`auth_domains.integration_params` holds only public config** (`issuer`, `client_id`). The **`client_secret` lives in the consumer's secret store** (e.g. Vercel/SSM), not the database. (The legacy stored it in the DB — do not replicate.)

## Consequences

- **+** Audited, spec-complete protocol handling; server-side; framework-agnostic (fits the Hono API and per-tenant Entra config); composes with `@smplcty/auth` sessions + RLS.
- **+** One fewer package to maintain (`@smplcty/oidc` retired); no Auth.js dependency or parallel session model.
- **−** The `OidcHandler` must be (re)implemented on `oauth4webapi` (follow-up), and the consumer writes the small state-cookie + callback glue (~30–50 lines) Auth.js would otherwise provide.
- **−** Until that swap lands, `@smplcty/auth/oidc` still imports the now-deprecated `@smplcty/oidc` for `verifyIdToken`; migrate promptly.

### Resulting consumer flow (e.g. productionnow / Clyde / Entra)

1. Sub-domain → `tenants.slug` → tenant → its `auth_domains` (via `signInOptions({ tenantSlug })`).
2. `OidcHandler.initiate(authDomainId)` (`oauth4webapi`) → authorization URL + PKCE/`state`/`nonce`; app stores those in a short-lived cookie and redirects to Entra.
3. Entra callback → `OidcHandler.complete(authDomainId, { code, … })` (`oauth4webapi`) → token exchange + `id_token` verify → claims (`email ?? preferred_username`).
4. `findUserByCommunicationMethod` (+ optional `provision`) → `createSession` → opaque session token.
5. Subsequent requests → `withSession` → identity GUCs → RLS. OTP tenants use the router's `initiateOtp`/`completeOtp` instead of steps 2–3.

## References

- `docs/v1-design.md`
- Legacy findings: `sign-in-oidc` Lambda — 0 CloudWatch invocations, no log group; prod `BACKEND_URL` = routeless API Gateway (`/sign-in/oidc` → 404).
- Clyde's `auth_domains` row: Microsoft Entra ID, confidential client.
