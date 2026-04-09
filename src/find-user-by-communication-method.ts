import { InvalidInputError } from './errors.js';
import type {
  FindUserQuery,
  Queryable,
  UserByCommunicationMethod,
} from './types.js';

const SELECT_BY_COMMUNICATION_METHOD = `
  SELECT
    ucm.user_id                       AS "userId",
    ucm.user_communication_method_id  AS "userCommunicationMethodId"
  FROM user_communication_methods ucm
  JOIN communication_channels cc
    ON cc.communication_channel_id = ucm.communication_channel_id
  WHERE cc.name = $1
    AND ucm.code = $2
  LIMIT 1
`;

/**
 * Look up the user attached to a communication method (an email address,
 * phone number, etc). Returns `null` if no matching record exists.
 *
 * Returning `null` instead of throwing is deliberate: the caller (a
 * sign-in endpoint, typically) decides whether to expose user-existence
 * information to the client. To avoid the user-enumeration oracle, most
 * sign-in endpoints should return the same response regardless of
 * whether this returns a value or `null`.
 *
 * @example
 * ```ts
 * const lookup = await findUserByCommunicationMethod(db, {
 *   channel: 'email',
 *   code: 'alice@example.com',
 * });
 * if (!lookup) {
 *   // user not registered — but return success anyway to avoid enumeration
 *   return { ok: true };
 * }
 * ```
 *
 * @throws {InvalidInputError} If `channel` or `code` is empty.
 */
export async function findUserByCommunicationMethod(
  db: Queryable,
  query: FindUserQuery,
): Promise<UserByCommunicationMethod | null> {
  if (typeof query?.channel !== 'string' || query.channel.length === 0) {
    throw new InvalidInputError('query.channel must be a non-empty string');
  }
  if (typeof query?.code !== 'string' || query.code.length === 0) {
    throw new InvalidInputError('query.code must be a non-empty string');
  }

  const { rows } = await db.query<UserByCommunicationMethod>(
    SELECT_BY_COMMUNICATION_METHOD,
    [query.channel, query.code],
  );
  return rows[0] ?? null;
}
