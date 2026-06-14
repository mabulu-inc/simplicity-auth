import { InvalidInputError, SessionExpiredError, SessionNotFoundError } from './errors.js';
import { hashToken } from './internal/hash-token.js';
import type { Queryable, SessionInfo } from './types.js';

const SELECT_SESSION = `
  SELECT
    ucm.user_id    AS "userId",
    s.created_at   AS "createdAt",
    s.expires_at   AS "expiresAt",
    s.last_seen_at AS "lastSeenAt"
  FROM sessions s
  JOIN user_communication_methods ucm
    ON ucm.user_communication_method_id = s.user_communication_method_id
  JOIN users u ON u.user_id = ucm.user_id
  WHERE s.session_id = $1
    AND s.deleted_at IS NULL
    AND ucm.deleted_at IS NULL
    AND u.deleted_at IS NULL
`;

/**
 * Look up a session by its raw token and verify it is still valid.
 *
 * Hashes the token, finds the matching `sessions` row, and returns its
 * {@link SessionInfo} on success. Throws if the token matches no session,
 * the session has expired (or was revoked — revocation sets `expires_at`
 * to now), or the input is malformed. Sets no GUCs — this is purely a
 * check.
 *
 * Use this in API Gateway authorizers, refresh flows, and anywhere you
 * need to verify a token without entering a request transaction. For an
 * authenticated request that will run queries, use {@link withSession} —
 * it validates AND sets up the database context in one call.
 *
 * @throws {InvalidInputError}     If `token` is not a non-empty string.
 * @throws {SessionNotFoundError}  If no session matches the token.
 * @throws {SessionExpiredError}   If the session has expired or was revoked.
 */
export async function validateSession(db: Queryable, token: string): Promise<SessionInfo> {
  if (typeof token !== 'string' || token.length === 0) {
    throw new InvalidInputError('token must be a non-empty string');
  }

  const { rows } = await db.query<SessionInfo>(SELECT_SESSION, [hashToken(token)]);
  const row = rows[0];
  if (!row) {
    throw new SessionNotFoundError();
  }

  // Expiry is server-set by createSession (and by revoke, which sets it to
  // now()). Local-clock comparison only checks "have we passed it yet."
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new SessionExpiredError(row.expiresAt);
  }

  // bigint user_id arrives from pg as a string; the contract is `number`.
  return { ...row, userId: Number(row.userId) };
}
