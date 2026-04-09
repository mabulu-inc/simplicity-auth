import { generateSecret, generateURI, verifySync } from 'otplib';
import { InvalidInputError } from './errors.js';
import type { Queryable } from './types.js';

// Accept codes within a ±30-second window — i.e. the current code,
// the previous code (just rolled), and the next code (about to roll).
// This handles small clock drift between the dev's authenticator app
// and the database server. Larger windows trade security for
// convenience and are not worth it.
const EPOCH_TOLERANCE_SECONDS = 30;

const SELECT_ENROLLMENT = `
  SELECT
    user_communication_method_id  AS "userCommunicationMethodId",
    totp_secret                   AS "totpSecret",
    label                         AS "label",
    enrolled_at                   AS "enrolledAt",
    last_used_at                  AS "lastUsedAt",
    used_count                    AS "usedCount"
  FROM dev_otp_enrollments
  WHERE user_communication_method_id = $1
`;

const RECORD_USE = `
  UPDATE dev_otp_enrollments
  SET last_used_at = now(),
      used_count   = used_count + 1
  WHERE user_communication_method_id = $1
`;

interface EnrollmentRow {
  userCommunicationMethodId: number;
  totpSecret: string;
  label: string;
  enrolledAt: Date;
  lastUsedAt: Date | null;
  usedCount: number;
}

/**
 * Verify a TOTP code against a developer's enrolled secret.
 *
 * Returns `true` if the user has a row in `dev_otp_enrollments` AND
 * the submitted code matches a valid TOTP for the stored secret within
 * the configured ±30s tolerance window. On a successful verification,
 * the enrollment row's `last_used_at` and `used_count` are updated.
 *
 * Returns `false` if no enrollment exists for the user, or if the code
 * doesn't match. **Does not throw on these cases** — falling through to
 * Twilio verification (or any other verification path) is the caller's
 * responsibility.
 *
 * Use this in a sign-in-verify handler to give devs whose phones can't
 * receive Twilio SMS a way to sign in via an authenticator app:
 *
 * ```ts
 * const ok = await verifyDevOtp(db, ucmId, submittedCode);
 * if (ok) {
 *   // log audit event with phone, IP, timestamp
 *   return createSession(db, { ... });
 * }
 * // fall through to Twilio verification
 * const verified = await verifyVerificationCode(to, submittedCode);
 * ```
 *
 * @throws {InvalidInputError} If `userCommunicationMethodId` is not a
 *   positive integer or `code` is not a non-empty string.
 */
export async function verifyDevOtp(
  db: Queryable,
  userCommunicationMethodId: number,
  code: string,
): Promise<boolean> {
  if (
    !Number.isInteger(userCommunicationMethodId) ||
    userCommunicationMethodId <= 0
  ) {
    throw new InvalidInputError(
      'userCommunicationMethodId must be a positive integer',
    );
  }
  if (typeof code !== 'string' || code.length === 0) {
    throw new InvalidInputError('code must be a non-empty string');
  }

  const { rows } = await db.query<EnrollmentRow>(SELECT_ENROLLMENT, [
    userCommunicationMethodId,
  ]);
  const enrollment = rows[0];
  if (!enrollment) {
    return false;
  }

  let valid = false;
  try {
    const result = verifySync({
      secret: enrollment.totpSecret,
      token: code,
      epochTolerance: EPOCH_TOLERANCE_SECONDS,
    });
    valid = result.valid;
  } catch {
    // otplib throws on malformed secrets or non-numeric tokens — treat
    // as a non-match rather than crashing the request. A malformed
    // secret in the DB is a configuration error worth noticing through
    // the consumer's audit pipeline.
    return false;
  }

  if (!valid) {
    return false;
  }

  await db.query(RECORD_USE, [userCommunicationMethodId]);
  return true;
}

/**
 * Generate a fresh base32-encoded TOTP secret suitable for storing in
 * the `dev_otp_enrollments.totp_secret` column.
 *
 * Use this from a one-off enrollment script:
 *
 * ```ts
 * import { generateDevOtpSecret, getDevOtpEnrollmentUri } from '@smplcty/auth';
 *
 * const secret = generateDevOtpSecret();
 * const uri = getDevOtpEnrollmentUri({
 *   secret,
 *   label: 'sam@salez1.com',
 *   issuer: 'Salez1',
 * });
 *
 * // INSERT secret into dev_otp_enrollments via SQL,
 * // print uri as a QR code with the qrcode package,
 * // and have the dev scan it with their authenticator app.
 * ```
 */
export function generateDevOtpSecret(): string {
  return generateSecret();
}

/**
 * Build an `otpauth://` URI suitable for QR-code encoding. Authenticator
 * apps scan this URI and add the secret to their list of accounts.
 *
 * The label is what the user sees in their authenticator app — typically
 * the user's email address or phone number. The issuer is the application
 * name (e.g., "Salez1"). Both are URI-encoded by the underlying library.
 */
export function getDevOtpEnrollmentUri(input: {
  secret: string;
  label: string;
  issuer: string;
}): string {
  if (typeof input?.secret !== 'string' || input.secret.length === 0) {
    throw new InvalidInputError('secret must be a non-empty string');
  }
  if (typeof input?.label !== 'string' || input.label.length === 0) {
    throw new InvalidInputError('label must be a non-empty string');
  }
  if (typeof input?.issuer !== 'string' || input.issuer.length === 0) {
    throw new InvalidInputError('issuer must be a non-empty string');
  }
  return generateURI({
    issuer: input.issuer,
    label: input.label,
    secret: input.secret,
  });
}
