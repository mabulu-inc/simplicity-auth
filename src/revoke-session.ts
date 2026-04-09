import { InvalidInputError } from './errors.js';
import type { Queryable } from './types.js';

const DELETE_SESSION = 'DELETE FROM sessions WHERE session_id = $1';

/**
 * Revoke a session by hard-deleting its row from the `sessions` table.
 *
 * Idempotent: revoking a non-existent session is not an error. Returns
 * normally regardless of whether a row was deleted.
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
  await db.query(DELETE_SESSION, [sessionId]);
}
