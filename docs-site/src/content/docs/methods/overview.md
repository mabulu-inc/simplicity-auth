---
title: Sign-in methods overview
description: Tenant-centric discovery, the OTP path via the router, and OIDC via a dedicated handler.
---

Sign-in is **tenant-centric**: the app resolves the tenant from the request
sub-domain (`tenants.slug`), and the router lists that tenant's IdPs. A tenant
has **0..N** OIDC IdPs (mergers, mixed workforces, multi-domain orgs):

- **0 IdPs** → OTP only.
- **1 IdP** → straight redirect, no chooser.
- **N IdPs** → a chooser (one button per IdP, labeled `displayName`, valued by `auth_domain_id`).

```ts
import { createMethodRouter } from '@smplcty/auth';
import { oidcHandler } from '@smplcty/auth/oidc';
import { twilioVerifyHandler } from '@smplcty/auth/twilio';
import { createTwilioVerifyClient } from '@smplcty/twilio';

const router = createMethodRouter({
  db: pool,
  otpHandler: twilioVerifyHandler({ client: createTwilioVerifyClient(cfg) }),
});
const oidc = oidcHandler({ clientSecret: (ad) => secrets.get(ad.tenantId) });

// Sign-in page — app parsed Host → 'acme':
const opts = await router.signInOptions({ tenantSlug: 'acme' });
// opts = { tenantId, authDomains: AuthDomain[], otpAllowed: boolean, ssoRequired: boolean }
```

## Two paths

- **OTP / dev-OTP** (user-bound) goes through the **router**: `initiateOtp` /
  `completeOtp`, open on every tenant except for addresses at a verified email
  domain that requires SSO, which the router refuses on every sub-domain (see
  [Email domains](/simplicity-auth/methods/email-domains/)). A handler that
  implements the optional `resolveUser` also lets the router skip sending a
  code to such a user's phone or other email.
- **OIDC** (org-bound) is driven by a **dedicated handler** —
  [`@smplcty/auth/oidc`](/simplicity-auth/methods/oidc/) on `oauth4webapi` — whose
  `initiate`/`complete` shape (PKCE + login-state) is richer than the OTP
  two-phase, so it's not routed through the generic interface.

```ts
// OTP (only when opts.otpAllowed):
await router.initiateOtp({ identifier: phone });
const user = await router.completeOtp({ identifier: phone, credential: code });

// OIDC — user picked an IdP from opts.authDomains:
const { redirectUrl, loginState } = await oidc.initiate(authDomain);
// ...persist loginState, redirect, then on callback:
const user2 = await oidc.complete({ db: pool, authDomain, callbackUrl, loginState });
```

## When a code can't be sent

By default the OTP path doesn't reveal who has an account. An unknown email or
phone gets `{ otpSent: true }` with nothing sent, so the page should say
*"If there's an account for this address, we've sent a code"*, with a resend
countdown and a "Try another way" link. `otpSent` means accepted, not delivered.

Every failure on the code path gets one of three answers:

- **A temporary failure, which retrying will fix.** That covers a provider
  outage (it's down, its credentials are wrong, an account-wide rate limit), and
  a failure of our own database or Twilio calls on a short list: a dropped
  connection, a pool timeout, a statement timeout, a deadlock, a socket reset, a
  temporary DNS failure. The Twilio handler
  reports an outage on its own with `@smplcty/twilio` 0.2.0 or later, and an
  email `sendCode` does so by throwing `DeliveryUnavailableError`. For the next
  `OTP_OUTAGE_WINDOW_SECONDS` (60), every identifier of that kind, account or
  not, gets `DeliveryUnavailableError` (HTTP `503 DELIVERY_UNAVAILABLE` with
  `Retry-After`), so the page can say "try again shortly". Sends and checks
  have separate windows, so an email outage doesn't stop people using codes they
  already have.
- **The provider refused this one recipient** (an invalid or blocked number, a
  rejected address). It is answered as for an unknown identifier and logged as a
  warning. Any error `sendCode` throws, other than `DeliveryUnavailableError`,
  counts as this, even a network error: `sendCode` may talk to the recipient's
  own mail server, so only the app can say a failure is an outage.
- **Anything else is a bug.** It is logged and rethrown, so the HTTP tier
  answers `500`. It is never answered as "code sent" or as an outage, because
  hiding a bug keeps it alive. A custom handler should therefore throw
  `RecipientRefusedError` or `DeliveryUnavailableError` for a provider's answer.

Three compromises, all accepted on purpose:

- The request that opens an outage window always belongs to an account holder,
  so during an outage an attacker can learn about roughly one identifier per
  window, per server process.
- One request can open the window for everyone. A temporary failure that a
  single request can cause (a deadlock, say) shuts code sign-in of that kind for
  the window. Rate-limiting code sign-in per client limits how often.
- A bug that fires only for account holders reveals who has an account, until
  it is fixed. A sign-in bug should be loud and short-lived.

Failures are logged with the identifier's kind and a short error name and code,
never the identifier or the provider's message. Without a `logger`, they go to
the console, so a failure is never silent.

### Revealing unknown identifiers

For an invite-only app, the most helpful answer is often "There's no account for
this email. Ask your admin." Pass `revealUnknownIdentifiers: true` to
`createMethodRouter` (or `createAuthHandlers`). An unknown identifier then gets
`UnknownIdentifierError` (HTTP `404 UNKNOWN_IDENTIFIER`), a refused address
gets `RecipientRefusedError` (HTTP `422 RECIPIENT_REFUSED`), and an outage gets
`DeliveryUnavailableError` with no outage window, since there is nothing left to
hide.

Rate-limit `otp/initiate` per client (in the app, or at its edge or firewall)
before turning this on: the library has no notion of the client, and without a
limit the answer can be scraped for every address you try. It needs a handler
with `resolveUser`, which both shipped handlers have.

Either path yields a `{ userId, userCommunicationMethodId }`; hand it to
[`createSession`](/simplicity-auth/sessions/lifecycle/).

Auth **core** depends on neither `oauth4webapi` nor Twilio — the handler subpaths
do, as optional peers. A password-only app installs neither.

:::tip[Don't want to wire the routes yourself?]
The [HTTP transport tier](/simplicity-auth/http/transport/)
(`@smplcty/auth/http`) does all of the above — discovery, the OTP two-phase, the
OIDC `start`/`callback`, the session cookie, and the signed login-state cookie —
as framework-agnostic handlers you mount in one line. Drop it in and you only
build the sign-in screen.
:::
