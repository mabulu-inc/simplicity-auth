// Errors
export {
  AuthError,
  SessionNotFoundError,
  SessionExpiredError,
  RoleNotAssignedError,
  InvalidInputError,
} from './errors.js';

// Types
export type {
  Queryable,
  Session,
  SessionContext,
  SessionAuth,
  CreateSessionInput,
  GeoLocation,
  UserByCommunicationMethod,
  FindUserQuery,
  Logger,
  WithSessionOptions,
} from './types.js';

// Session lifecycle
export { createSession } from './create-session.js';
export { validateSession } from './validate-session.js';
export { revokeSession } from './revoke-session.js';
export { findUserByCommunicationMethod } from './find-user-by-communication-method.js';

export { getUserRoleNames } from './get-user-role-names.js';

// Request bootstrapping
export { withSession } from './with-session.js';
export { withTransaction } from './with-transaction.js';

// Low-level helpers — must be called inside an open transaction.
export {
  setSessionId,
  setRoleName,
  setTenantIds,
  setAllTenants,
  setSessionContext,
  SESSION_VAR_NAMES,
} from './set-helpers.js';

// Background service context — for Lambdas with no user session.
export { withServiceContext } from './with-service-context.js';

// Developer OTP — for devs whose phones can't receive Twilio SMS.
export {
  verifyDevOtp,
  isDevOtpEnrolled,
  generateDevOtpSecret,
  getDevOtpEnrollmentUri,
} from './dev-otp.js';
