import { InvalidInputError } from './errors.js';
import { hashToken } from './internal/hash-token.js';
import type { Queryable } from './types.js';

// Record activity. Only touches still-valid sessions so a touch can't
// resurrect an expired/revoked one. Returns whether a live session matched.
const TOUCH = `
  UPDATE sessions
  SET last_seen_at = now()
  WHERE session_id = $1
    AND expires_at > now()
`;

/**
 * Record activity on a session: stamp `last_seen_at = now()`. Powers the
 * "track activity" requirement (distinct from `created_at`, the sign-in
 * time). No-ops on an unknown, expired, or revoked session.
 *
 * Returns `true` if a live session was touched, `false` otherwise — handy
 * for piggy-backing a liveness check on the activity update.
 *
 * @throws {InvalidInputError} If `token` is not a non-empty string.
 */
export async function touchSession(db: Queryable, token: string): Promise<boolean> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidInputError('token must be a non-empty string');
  }
  const { rowCount } = await db.query(TOUCH, [hashToken(token)]);
  return (rowCount ?? 0) > 0;
}
