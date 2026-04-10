import { InvalidInputError } from './errors.js';
import type { Queryable } from './types.js';

const SELECT_ROLE_NAMES = `
  SELECT DISTINCT r.name
  FROM user_roles ur
  JOIN roles r ON r.role_id = ur.role_id
  WHERE ur.user_id = $1
  ORDER BY r.name
`;

interface RoleNameRow {
  name: string;
}

/**
 * Return every distinct role name assigned to a user, in alphabetical
 * order. Returns an empty array if the user has no roles.
 *
 * Use this after `createSession` when the caller needs to tell the
 * client which roles are available (e.g. to drive UI routing on the
 * frontend). For in-transaction session bootstrapping — where the role
 * is already known — use `withSession` instead.
 *
 * @example
 * ```ts
 * const session = await createSession(db, { ... });
 * const roles = await getUserRoleNames(db, session.userId);
 * return { sessionId: session.sessionId, roles };
 * ```
 *
 * @throws {InvalidInputError} If `userId` is not a positive integer.
 */
export async function getUserRoleNames(
  db: Queryable,
  userId: number,
): Promise<string[]> {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new InvalidInputError('userId must be a positive integer');
  }

  const { rows } = await db.query<RoleNameRow>(SELECT_ROLE_NAMES, [userId]);
  return rows.map((r) => r.name);
}
