---
title: Developer OTP
description: Per-developer TOTP enrollment for devs whose phones can't receive Twilio SMS.
---

Twilio Verify doesn't deliver SMS reliably to every carrier (overseas, some
pre-paid, some VoIP). `@smplcty/auth` ships per-developer **TOTP** enrollment for
this case: each enrolled dev has their own secret in `dev_otp_enrollments`,
scanned into a standard authenticator app. The verify side tries the dev OTP
first, then falls through to Twilio — the [`twilioVerifyHandler`](/simplicity-auth/methods/overview/)
does this for you; the primitives below are for hand-rolled flows.

A 6-digit TOTP is indistinguishable from a 6-digit SMS code — the backend just
tries dev-OTP first. The `dev_otp_enrollments.last_used_at` / `used_count` give
you the audit signal for which path succeeded.

## Verify side

```ts
import { verifyDevOtp } from '@smplcty/auth';

const ok = await verifyDevOtp(db, userCommunicationMethodId, submittedCode);
// true if enrolled AND the code matches within ±30s; updates last_used_at + used_count.
// false (never throws) if unenrolled, mismatch, or malformed secret.
```

## Send side

Skip the SMS for dev-enrolled users (they generate the code locally):

```ts
import { isDevOtpEnrolled } from '@smplcty/auth';

if (!(await isDevOtpEnrolled(db, userCommunicationMethodId))) {
  await twilio.sendVerificationCode({ channel: 'sms', to: phone });
}
```

Both `verifyDevOtp` and `isDevOtpEnrolled` return `false` regardless of
enrollment status (just under different conditions), so neither leaks enrollment
to the caller.

## Enrolling a dev

```ts
import { generateDevOtpSecret, getDevOtpEnrollmentUri } from '@smplcty/auth';

const secret = generateDevOtpSecret();
const uri = getDevOtpEnrollmentUri({ secret, label: 'sam@acme.com', issuer: 'Acme' });
// render `uri` as a QR code; INSERT the secret into dev_otp_enrollments.
```

Per-dev TOTP (vs a shared bypass code) gives one-account blast radius,
delete-one-row revocation, a per-enrollment audit trail, 30-second rotation, and
a possession factor — with no bypass recipe baked into source.
