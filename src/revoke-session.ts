import { InvalidInputError } from './errors.js';
import { hashToken } from './internal/hash-token.js';
import type { Queryable } from './types.js';

// Soft-revoke: set expires_at = now() so the row survives for audit but
// the session is locked out immediately (withSession/validateSession both
// reject expires_at <= now()). Guarded so we don't move an already-past
// expiry around.
const EXPIRE_BY_HASH = `
  UPDATE sessions
  SET expires_at = now()
  WHERE session_id = $1
    AND expires_at > now()
`;

const EXPIRE_BY_USER = `
  UPDATE sessions s
  SET expires_at = now()
  FROM user_communication_methods ucm
  WHERE ucm.user_communication_method_id = s.user_communication_method_id
    AND ucm.user_id = $1
    AND s.expires_at > now()
`;

// Tenant-wide sign-off. Membership IS user_roles.tenant_id (the contract;
// there is no user_tenants table), so the library resolves "users in
// tenant X" itself and fans out. The match is tenant_id = $1, NOT
// tenant_id IS NULL: wildcard members (NULL = all-tenants global admins /
// service principals) are not members of any one tenant and must not be
// signed out by a single tenant's sign-off.
const EXPIRE_BY_TENANT = `
  UPDATE sessions s
  SET expires_at = now()
  FROM user_communication_methods ucm
  WHERE ucm.user_communication_method_id = s.user_communication_method_id
    AND s.expires_at > now()
    AND ucm.user_id IN (
      SELECT DISTINCT ur.user_id
      FROM user_roles ur
      WHERE ur.tenant_id = $1
    )
`;

/**
 * Revoke a single session by its raw token (force sign-off of that one
 * session). Idempotent — revoking an unknown or already-expired session is
 * not an error. The row is preserved for audit.
 *
 * @throws {InvalidInputError} If `token` is not a non-empty string.
 */
export async function revokeSession(db: Queryable, token: string): Promise<void> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidInputError('token must be a non-empty string');
  }
  await db.query(EXPIRE_BY_HASH, [hashToken(token)]);
}

/**
 * Revoke every active session belonging to a user (force sign-off
 * everywhere). Use on password reset, account lockout, or a
 * role/privilege change that should drop existing sessions.
 *
 * @throws {InvalidInputError} If `userId` is not a positive integer.
 */
export async function revokeUserSessions(db: Queryable, userId: number): Promise<void> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new InvalidInputError('userId must be a positive integer');
  }
  await db.query(EXPIRE_BY_USER, [userId]);
}

/**
 * Revoke every active session of every user explicitly in a tenant
 * (tenant-wide sign-off). Membership is resolved from `user_roles.tenant_id`
 * — wildcard members (NULL tenant) are intentionally **not** signed out,
 * since they belong to no single tenant.
 *
 * @throws {InvalidInputError} If `tenantId` is not a positive integer.
 */
export async function revokeTenantSessions(db: Queryable, tenantId: number): Promise<void> {
  if (!Number.isInteger(tenantId) || tenantId <= 0) {
    throw new InvalidInputError('tenantId must be a positive integer');
  }
  await db.query(EXPIRE_BY_TENANT, [tenantId]);
}
