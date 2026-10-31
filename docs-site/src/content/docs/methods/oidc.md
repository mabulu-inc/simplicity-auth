---
title: OIDC
description: The @smplcty/auth/oidc handler — authorization-code + PKCE + token exchange + id_token verification on oauth4webapi.
---

The org-bound OIDC handler (opt-in subpath `@smplcty/auth/oidc`) is built on
[`oauth4webapi`](https://github.com/panva/oauth4webapi). Two phases:

```ts
import { oidcHandler } from '@smplcty/auth/oidc'; // optional peer: oauth4webapi

const oidc = oidcHandler({
  // decrypts each auth domain's stored client credential (see Client credentials):
  cipher,
  // optional: provision a user when a verified identity has no communication method
  provisionUser: async ({ db, authDomain, claims }) => {
    /* create user + email method + default roles for authDomain.tenantId */
  },
});

// Phase 1 — discovery + PKCE/state/nonce → redirect URL + login state:
const { redirectUrl, loginState } = await oidc.initiate(authDomain);
// persist loginState in a short-lived signed cookie keyed by loginState.state, then redirect.

// Phase 2 — on the provider callback (hand back the stored loginState + the callback URL):
const user = await oidc.complete({ db: pool, authDomain, callbackUrl, loginState });
// → { userId, userCommunicationMethodId } — then createSession(...)
```

## What the library does vs what you do

- **`oauth4webapi` (in the handler):** discovery, the authorization URL, PKCE,
  `state`/`nonce`, the code→token exchange, and `id_token` verification
  (signature via JWKS, `iss`/`aud`/`exp`/`nonce`).
- **You (the app):** persist `loginState` (`state` / `nonce` / `codeVerifier`)
  across the redirect in a short-lived signed cookie, and own the callback
  route. The library holds no pre-auth state.

## `auth_domains` config

`integration_params` holds **only public** values:

```json
{
  "issuer": "https://login.microsoftonline.com/<tenant-guid>/v2.0",
  "clientId": "<app-registration-id>",
  "redirectUri": "https://acme.app.example.com/auth/oidc/callback",
  "tokenEndpointAuthMethod": "private_key_jwt"
}
```

Email is read as `email ?? preferred_username` (Entra often uses the latter) —
ensure the user's `user_communication_methods.code` (channel `email`) matches.

## Client credentials

Each auth domain carries its own client credential, set by the tenant's
**security or settings admin** from your app, so a customer's SSO works without
anyone adding a secret to your infrastructure or redeploying.

**How the client authenticates** is the auth domain's
`tokenEndpointAuthMethod`, and only that method is ever sent; a failure is
never retried with another:

| Method | Sends |
| --- | --- |
| `none` | nothing (a PKCE-only public client) |
| `client_secret_basic` | the secret in the `Authorization` header (what RFC 6749 says servers must support, and Okta's default for web apps) |
| `client_secret_post` | the secret in the request body |
| `private_key_jwt` | an assertion signed with a key the library generated (RFC 7523); nothing secret ever travels from the customer to you |

An auth domain that declares no method behaves as before:
`client_secret_post` when your `clientSecret` resolver returns a secret, else none.

**Storage.** Credentials live in `auth_domain_credentials`, encrypted by a
`CredentialCipher` you supply (for example with an AWS KMS data key), so the
database never holds plaintext and the library picks no key-management vendor.
Each call gets `{ authDomainId, purpose }` so you can bind the ciphertext to its
row. Plaintext exists only in memory during the token exchange, and never in a
log, error or response. Credentials are read and decrypted on every sign-in, so
a replaced one takes effect on the next. A soft-deleted auth domain's credential
is never used.

```ts
import { setClientSecret, generateClientKey, getClientCredentialStatus } from '@smplcty/auth/oidc';

// On the admin's session client, e.g. inside withSession: RLS admits only the
// tenant's security or settings admin.
await setClientSecret(client, { authDomainId, secret, cipher });
const { jwks, certificatePem } = await generateClientKey(client, { authDomainId, cipher });
const status = await getClientCredentialStatus(client, authDomainId);
// → { secretSetAt, privateKeySetAt, publicKey: { jwks, certificatePem } | null }
```

No role reachable from a tenant session can read a secret or private key back,
including the admin who set it: `app_rls` can write those columns but only
`SELECT` the status and public ones. The token exchange reads them through the
privileged pool, the same one that already reads `auth_domains` before a session
exists.

**`private_key_jwt`.** `generateClientKey` makes an RSA-2048 key pair and a
self-signed X.509 certificate (valid 730 days by default, `validityDays` to
change it). Give the IdP the JWKS, or the certificate (`.pem`) for Entra, whose
upload takes a certificate rather than a bare key. The assertion carries the
certificate thumbprint in `x5t#S256` (and the older `x5t`) and uses the token
endpoint as its audience, which is what Entra requires. Generating a key needs
two optional peers, loaded only then:

```sh
pnpm add @peculiar/x509 reflect-metadata
```

`reflect-metadata` adds a global `Reflect` polyfill (a requirement of
`@peculiar/x509`); it loads only when you generate a key, never during sign-in.

**Your own secret store still works.** A `clientSecret` resolver that returns a
secret wins over a stored one, so an app that holds secrets itself needn't
change. Return `undefined` to fall back to the stored secret.

**Why credentials moved into the database.** The previous guidance kept every
client secret in the app's secret store. That made each customer's SSO wait on
whoever runs the infrastructure: one secret per tenant per IdP, then a redeploy.
A secrets-manager entry per auth domain would need the app to create and delete
secrets at runtime and keep a second store in sync with the table. Encrypted rows
make self-service possible, and the cipher hook keeps the key outside the
database. One shared multi-tenant app registration was rejected: it works only
for Microsoft and Google (Okta, Ping, OneLogin, Keycloak and ADFS need a
registration per customer anyway), and every customer's sign-on would depend on
one vendor-controlled credential. See issue #25.

`complete` refuses an address at a domain the auth domain's tenant hasn't
verified, with `EmailDomainNotVerifiedError`, before any lookup or
`provisionUser` call. An auth domain with no verified domains signs nobody in.
The HTTP transport's `signInErrorPath` sends that refusal to a page your app
renders.
See [Email domains](/simplicity-auth/methods/email-domains/).

## Why not Auth.js, why not a hand-rolled `@smplcty/oidc`

`oauth4webapi` is the spec-complete protocol engine (the same one Auth.js uses
internally), framework-agnostic, and fits per-tenant config and our sessions +
RLS without a parallel session model. See
[ADR-0001](/simplicity-auth/design/adr-0001/) for the full rationale (and why
`@smplcty/oidc` was deprecated).
