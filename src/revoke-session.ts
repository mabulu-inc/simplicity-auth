import { InvalidInputError } from './errors.js';
import type { Queryable } from './types.js';

const EXPIRE_SESSION = `
  UPDATE sessions
  SET expires_at = now()
  WHERE session_id = $1
    AND (expires_at IS NULL OR expires_at > now())
`;

/**
 * Revoke a session by setting its `expires_at` to now.
 *
 * The session row is preserved for audit — you can distinguish
 * "explicitly revoked" (expires_at close to created_at) from
 * "expired naturally" (expires_at = created_at + ttl). The
 * `session_authorization()` RLS function already checks
 * `expires_at > now()`, so the session is locked out immediately.
 *
 * Idempotent: revoking a non-existent or already-expired session
 * is not an error.
 *
 * @example
 * ```ts
 * await revokeSession(db, sessionId);
 * ```
 *
 * @throws {InvalidInputError} If `sessionId` is not a non-empty string.
 */
export async function revokeSession(
  db: Queryable,
  sessionId: string,
): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new InvalidInputError('sessionId must be a non-empty string');
  }
  await db.query(EXPIRE_SESSION, [sessionId]);
}
