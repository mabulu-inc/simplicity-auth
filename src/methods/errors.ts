import { AuthError } from '../errors.js';

/**
 * Thrown when OTP (user-bound) sign-in is attempted for a tenant whose
 * `allow_otp` is false — an SSO-only tenant. Enforced in the router so a
 * crafted request can't bypass a hidden UI button.
 */
export class OtpNotAllowedError extends AuthError {
  override readonly name = 'OtpNotAllowedError';
  override readonly code = 'OTP_NOT_ALLOWED' as const;
  readonly tenantId: number;

  constructor(tenantId: number, message?: string) {
    super(message ?? `OTP sign-in is not allowed for tenant ${tenantId}`);
    this.tenantId = tenantId;
  }
}

/**
 * Thrown by a handler's `complete` when the submitted credential fails
 * verification (wrong/expired OTP, invalid id_token, unverifiable claims),
 * or when a verified identity has no user and no provisioning is allowed.
 */
export class VerificationFailedError extends AuthError {
  override readonly name = 'VerificationFailedError';
  override readonly code = 'VERIFICATION_FAILED' as const;

  constructor(message: string = 'Verification failed') {
    super(message);
  }
}
