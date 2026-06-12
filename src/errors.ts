/**
 * Base class for all errors thrown by `@smplcty/auth`. Every error has a
 * `code` discriminator so consumers can `switch` on it without `instanceof`.
 */
export class AuthError extends Error {
  override readonly name: string = 'AuthError';
  readonly code: string = 'AUTH_ERROR';
}

/**
 * Thrown when a session ID does not match any row in the `sessions` table.
 */
export class SessionNotFoundError extends AuthError {
  override readonly name = 'SessionNotFoundError';
  override readonly code = 'SESSION_NOT_FOUND' as const;

  constructor(message: string = 'Session not found') {
    super(message);
  }
}

/**
 * Thrown when a session row exists but its `expires_at` has passed.
 */
export class SessionExpiredError extends AuthError {
  override readonly name = 'SessionExpiredError';
  override readonly code = 'SESSION_EXPIRED' as const;
  readonly expiresAt: Date;

  constructor(expiresAt: Date, message?: string) {
    super(message ?? `Session expired at ${expiresAt.toISOString()}`);
    this.expiresAt = expiresAt;
  }
}

/**
 * Thrown when a request asks to activate a role the user does not hold.
 *
 * Role selection and validation happen in `withSession` (TS): the pure
 * `resolve_session` resolver returns the roles the user holds, and
 * `withSession` rejects a requested role that isn't among them.
 */
export class RoleNotHeldError extends AuthError {
  override readonly name = 'RoleNotHeldError';
  override readonly code = 'ROLE_NOT_HELD' as const;
  readonly roleName: string;

  constructor(roleName: string, message?: string) {
    super(message ?? `User does not hold role: ${roleName}`);
    this.roleName = roleName;
  }
}

/**
 * Thrown when `withServiceContext` can't find a `users` row of
 * `kind = 'service'` with the given name. Almost always a missing seed:
 * the service principal must be provisioned before background writes run.
 */
export class ServicePrincipalNotFoundError extends AuthError {
  override readonly name = 'ServicePrincipalNotFoundError';
  override readonly code = 'SERVICE_PRINCIPAL_NOT_FOUND' as const;
  readonly serviceName: string;

  constructor(serviceName: string, message?: string) {
    super(message ?? `No service principal named: ${serviceName}`);
    this.serviceName = serviceName;
  }
}

/**
 * Thrown when a function input fails validation (empty string, wrong type,
 * etc.) before the library will hit the database.
 */
export class InvalidInputError extends AuthError {
  override readonly name = 'InvalidInputError';
  override readonly code = 'INVALID_INPUT' as const;

  constructor(message: string) {
    super(message);
  }
}
