import { InvalidInputError, SessionExpiredError, SessionNotFoundError } from './errors.js';
import type { Queryable, Session } from './types.js';

const TS_SUFFIX = process.env['USE_AT_FOR_TIMESTAMPS'] !== 'false' ? '_at' : '';
const CREATED_COL = `created${TS_SUFFIX}`;

const SELECT_SESSION = `
  SELECT
    s.session_id  AS "sessionId",
    ucm.user_id   AS "userId",
    s.${CREATED_COL}  AS "createdAt",
    s.expires_at  AS "expiresAt"
  FROM sessions s
  JOIN user_communication_methods ucm
    ON ucm.user_communication_method_id = s.user_communication_method_id
  WHERE s.session_id = $1
`;

/**
 * Look up a session by ID and verify it is still valid.
 *
 * Returns the {@link Session} on success. Throws if the session does
 * not exist, has expired, or the input is malformed. Does not set any
 * Postgres session variables — this is purely a check.
 *
 * Use this function in API Gateway authorizers, refresh-token flows,
 * and any other place where you need to verify a token without entering
 * a request transaction. For an authenticated request that will run
 * queries, use {@link withSession} instead — it does this validation
 * AND sets up the database context in one call.
 *
 * @throws {InvalidInputError}     If `sessionId` is not a non-empty string.
 * @throws {SessionNotFoundError}  If no row matches `sessionId`.
 * @throws {SessionExpiredError}   If the session row exists but `expires_at` has passed.
 */
export async function validateSession(
  db: Queryable,
  sessionId: string,
): Promise<Session> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new InvalidInputError('sessionId must be a non-empty string');
  }

  const { rows } = await db.query<Session>(SELECT_SESSION, [sessionId]);
  const row = rows[0];
  if (!row) {
    throw new SessionNotFoundError();
  }

  // Compare against the database's now() rather than the local clock
  // would be ideal, but we already trust the row that the DB returned
  // and `expiresAt` is a timestamptz that pg parses to a JS Date.
  // Local-clock comparison is fine here because expiry is server-set
  // by createSession; we're only checking "have we passed it yet."
  if (row.expiresAt.getTime() <= Date.now()) {
    throw new SessionExpiredError(row.expiresAt);
  }

  return row;
}
