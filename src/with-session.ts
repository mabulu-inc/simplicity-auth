import type { Pool, PoolClient } from 'pg';
import {
  RoleNotAssignedError,
  SessionExpiredError,
  SessionNotFoundError,
} from './errors.js';
import { hashId } from './internal/hash-id.js';
import { noopLogger } from './internal/noop-logger.js';
import { setSessionContext } from './set-helpers.js';
import type {
  SessionAuth,
  SessionContext,
  WithSessionOptions,
} from './types.js';
import { withTransaction } from './with-transaction.js';

/**
 * Resolves the session and the user's roles in one query. Returns null
 * if the session row doesn't exist or doesn't belong to a user with the
 * requested role.
 *
 * The query joins through `sessions → user_communication_methods → users
 * → user_roles → roles`, filtering by the requested role name. It also
 * computes:
 *
 * - `tenantIds`: distinct non-null tenant_ids on user_roles rows
 * - `allTenants`: true if any user_roles row has tenant_id IS NULL
 * - `roles`: array of all distinct role names assigned to the user
 *
 * The roles array is sourced from a separate inner join so we get every
 * role the user has, not just the one being requested. The `_hasRole`
 * column tells us whether the requested role specifically was found.
 */
/**
 * Uses the resolve_session() SECURITY DEFINER function so the query
 * bypasses RLS on auth tables (user_communication_methods, user_roles).
 * This lets app_user resolve sessions without needing GUCs set first.
 */
const RESOLVE_SESSION = `
  SELECT
    user_id    AS "userId",
    expires_at AS "expiresAt",
    tenant_ids AS "tenantIds",
    all_tenants AS "allTenants",
    roles      AS "roles",
    has_requested_role AS "hasRequestedRole"
  FROM resolve_session($1, $2)
`;

interface ResolvedRow {
  userId: number;
  expiresAt: Date;
  tenantIds: number[];
  allTenants: boolean;
  roles: string[];
  hasRequestedRole: boolean | null;
}

/**
 * The high-level "just make it work" entry point. Checks out a
 * connection, opens a transaction, validates the session, validates the
 * role, sets the four `app.*` GUC variables via parameterized
 * `set_config(_, _, true)`, runs the callback, and commits (or rolls
 * back on throw).
 *
 * The session variables use **transaction scope**, so they're discarded
 * automatically when this function returns. Cross-request leakage is
 * impossible.
 *
 * @example
 * ```ts
 * const widgets = await withSession(
 *   pool,
 *   { sessionId, roleName: 'user' },
 *   async (client, ctx) => {
 *     // ctx = { userId, tenantIds, allTenants, roles }
 *     const { rows } = await client.query('SELECT * FROM widgets');
 *     return rows;
 *   }
 * );
 * ```
 *
 * @throws {SessionNotFoundError}  If no session row matches `auth.sessionId`.
 * @throws {SessionExpiredError}   If the session has passed its `expires_at`.
 * @throws {RoleNotAssignedError}  If the user does not have `auth.roleName`.
 * @throws {InvalidInputError}     If `auth.sessionId` or `auth.roleName` is empty.
 */
export async function withSession<TRole extends string = string, T = unknown>(
  pool: Pool,
  auth: SessionAuth<TRole>,
  fn: (client: PoolClient, ctx: SessionContext<TRole>) => Promise<T>,
  options: WithSessionOptions = {},
): Promise<T> {
  const log = options.logger ?? noopLogger;
  const sessionHash = hashId(auth.sessionId);

  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ResolvedRow>(RESOLVE_SESSION, [
      auth.sessionId,
      auth.roleName,
    ]);
    const row = rows[0];

    if (!row) {
      log.warn({ sessionHash }, 'session not found');
      throw new SessionNotFoundError();
    }

    if (row.expiresAt.getTime() <= Date.now()) {
      log.warn(
        { sessionHash, expiresAt: row.expiresAt.toISOString() },
        'session expired',
      );
      throw new SessionExpiredError(row.expiresAt);
    }

    if (row.hasRequestedRole !== true) {
      log.warn(
        { sessionHash, userId: row.userId, requestedRole: auth.roleName },
        'role not assigned',
      );
      throw new RoleNotAssignedError(auth.roleName);
    }

    const ctx: SessionContext<TRole> = {
      userId: row.userId,
      tenantIds: row.tenantIds,
      allTenants: row.allTenants,
      roles: row.roles as TRole[],
    };

    await setSessionContext(client, {
      sessionId: auth.sessionId,
      roleName: auth.roleName,
      tenantIds: ctx.tenantIds,
      allTenants: ctx.allTenants,
    });

    log.debug(
      {
        sessionHash,
        userId: ctx.userId,
        roleName: auth.roleName,
        tenantCount: ctx.tenantIds.length,
        allTenants: ctx.allTenants,
      },
      'session context set',
    );

    return fn(client, ctx);
  });
}
