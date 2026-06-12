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
// opts = { tenantId, authDomains: AuthDomain[], otpAllowed: boolean }
```

## Two paths

- **OTP / dev-OTP** (user-bound) goes through the **router**: `initiateOtp` /
  `completeOtp`, **gated by the tenant's `allow_otp`** flag, enforced in the
  router (not just hidden in the UI) so an SSO-only tenant can't be bypassed.
- **OIDC** (org-bound) is driven by a **dedicated handler** —
  [`@smplcty/auth/oidc`](/simplicity-auth/methods/oidc/) on `oauth4webapi` — whose
  `initiate`/`complete` shape (PKCE + login-state) is richer than the OTP
  two-phase, so it's not routed through the generic interface.

```ts
// OTP (only when opts.otpAllowed):
await router.initiateOtp({ tenantId: opts.tenantId, identifier: phone });
const user = await router.completeOtp({ tenantId: opts.tenantId, identifier: phone, credential: code });

// OIDC — user picked an IdP from opts.authDomains:
const { redirectUrl, loginState } = await oidc.initiate(authDomain);
// ...persist loginState, redirect, then on callback:
const user2 = await oidc.complete({ db: pool, authDomain, callbackUrl, loginState });
```

Either path yields a `{ userId, userCommunicationMethodId }`; hand it to
[`createSession`](/simplicity-auth/sessions/lifecycle/).

Auth **core** depends on neither `oauth4webapi` nor Twilio — the handler subpaths
do, as optional peers. A password-only app installs neither.
