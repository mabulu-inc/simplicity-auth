import { InvalidInputError } from './errors.js';
import { generateToken, hashToken } from './internal/hash-token.js';
import type { CreateSessionInput, Queryable, Session } from './types.js';

const INSERT_SESSION = `
  INSERT INTO sessions (
    session_id,
    user_communication_method_id,
    expires_at,
    ip,
    city,
    region,
    country,
    latitude,
    longitude
  )
  VALUES (
    $1,
    $2,
    now() + ($3)::interval,
    $4,
    $5,
    $6,
    $7,
    $8,
    $9
  )
  RETURNING
    created_at AS "createdAt",
    expires_at AS "expiresAt"
`;

const SELECT_USER_ID = `
  SELECT user_id AS "userId"
  FROM user_communication_methods
  WHERE user_communication_method_id = $1
`;

interface InsertedSessionRow {
  createdAt: Date;
  expiresAt: Date;
}

interface UserIdRow {
  userId: number;
}

/**
 * Create a new session for an already-authenticated user.
 *
 * The caller is responsible for verifying the user's identity (via a
 * `MethodHandler`, Twilio Verify, OIDC callback, password check, …)
 * BEFORE calling this. `createSession` performs no authentication — it
 * persists a session row and returns the new token.
 *
 * A fresh opaque token (256 bits of entropy) is generated server-side;
 * only its **SHA-256 hash** is stored, as the `sessions` primary key. The
 * raw token is returned **once** in {@link Session.token} — hand it to the
 * client and don't persist it. Expiration is computed server-side as
 * `now() + interval $ttl` so there's no app/database clock skew.
 *
 * @example
 * ```ts
 * const session = await createSession(db, {
 *   userCommunicationMethodId: 42,
 *   ttl: '30 days',
 *   ip: req.ip,
 *   geo: { country: 'US', region: 'CA' },
 * });
 * setCookie('session', session.token); // raw token to the client, once
 * ```
 *
 * @throws {InvalidInputError} If `ttl` is empty or `userCommunicationMethodId` is not a positive integer.
 */
export async function createSession(db: Queryable, input: CreateSessionInput): Promise<Session> {
  if (!Number.isInteger(input.userCommunicationMethodId) || input.userCommunicationMethodId <= 0) {
    throw new InvalidInputError('userCommunicationMethodId must be a positive integer');
  }
  if (typeof input.ttl !== 'string' || input.ttl.length === 0) {
    throw new InvalidInputError('ttl must be a non-empty Postgres interval string (e.g. "30 days")');
  }

  const token = generateToken();
  const sessionId = hashToken(token);
  const geo = input.geo ?? {};

  const { rows } = await db.query<InsertedSessionRow>(INSERT_SESSION, [
    sessionId,
    input.userCommunicationMethodId,
    input.ttl,
    input.ip ?? null,
    geo.city ?? null,
    geo.region ?? null,
    geo.country ?? null,
    geo.latitude ?? null,
    geo.longitude ?? null,
  ]);

  const row = rows[0];
  if (!row) {
    // Should be impossible — INSERT ... RETURNING always produces a row
    // when the INSERT succeeds. If we get here, the FK constraint must
    // have failed silently, which would mean a pg client misconfiguration.
    throw new Error('createSession: INSERT did not return a row');
  }

  const userResult = await db.query<UserIdRow>(SELECT_USER_ID, [input.userCommunicationMethodId]);
  const userRow = userResult.rows[0];
  if (!userRow) {
    // The FK on sessions.user_communication_method_id should have
    // prevented the INSERT above from succeeding if this row didn't
    // exist. Defensive throw.
    throw new Error('createSession: user_communication_method_id has no matching user');
  }

  return {
    // bigint ids arrive from pg as strings; the public API is `number`.
    token,
    userId: Number(userRow.userId),
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  };
}
