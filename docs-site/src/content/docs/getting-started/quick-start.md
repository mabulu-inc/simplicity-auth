---
title: Quick start
description: Sign a user in, create a session, and run a request under RLS.
---

:::tip[The fastest path: mount the transport tier]
If you want the whole sign-in surface — OTP, dev-OTP, and OIDC routes, the
session cookie, and per-request auth — without wiring it yourself, mount
[`@smplcty/auth/http`](/simplicity-auth/http/transport/) and supply a config.
The rest of this page shows the **primitives** underneath it, for apps that want
to drive the lifecycle directly.
:::

After you've verified a user's identity (via a [sign-in
method](/simplicity-auth/methods/overview/)), the request lifecycle is:

```ts
import { findUserByCommunicationMethod, createSession, withSession } from '@smplcty/auth';

// 1. Resolve the user (e.g. after an OTP/OIDC verification).
const lookup = await findUserByCommunicationMethod(pool, { channel: 'email', code: 'alice@acme.com' });

// 2. Mint a session — returns the raw opaque token ONCE; only its hash is stored.
const session = await createSession(pool, {
  userCommunicationMethodId: lookup.userCommunicationMethodId,
  ttl: '30 days',
});
setCookie('session', session.token);

// 3. Every authenticated request: resolve + validate + set identity GUCs + run under RLS.
const widgets = await withSession(pool, { token, roleName: 'user' }, async (client, ctx) => {
  // ctx = { userId, activeRole, roles, privileges }
  const { rows } = await client.query('SELECT * FROM widgets'); // RLS-scoped
  return rows;
});
```

That's the whole loop: **resolve → session → `withSession`**. The library sets
the [identity GUCs](/simplicity-auth/reference/identity-gucs/); your RLS policies
read them (via `current_user_id()` and friends). Role and privilege changes take
effect on the next request; sign-off is a [revoke](/simplicity-auth/sessions/lifecycle/).

Next: [`withSession`](/simplicity-auth/sessions/with-session/) in depth.
