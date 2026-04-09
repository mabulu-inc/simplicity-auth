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
const RESOLVE_SESSION = `
  WITH found_session AS (
    SELECT
      s.session_id,
      s.expires_at,
      ucm.user_id
    FROM sessions s
    JOIN user_communication_methods ucm
      ON ucm.user_communication_method_id = s.user_communication_method_id
    WHERE s.session_id = $1
  ),
  user_role_data AS (
    SELECT
      ur.user_id,
      ur.tenant_id,
      r.name AS role_name
    FROM found_session fs
    JOIN user_roles ur ON ur.user_id = fs.user_id
    JOIN roles r ON r.role_id = ur.role_id
  )
  SELECT
    fs.user_id    AS "userId",
    fs.expires_at AS "expiresAt",
    COALESCE(
      array_agg(DISTINCT urd.tenant_id)
        FILTER (WHERE urd.tenant_id IS NOT NULL),
      '{}'
    ) AS "tenantIds",
    COALESCE(bool_or(urd.tenant_id IS NULL), false) AS "allTenants",
    COALESCE(
      array_agg(DISTINCT urd.role_name)
        FILTER (WHERE urd.role_name IS NOT NULL),
      '{}'
    ) AS "roles",
    bool_or(urd.role_name = $2) AS "hasRequestedRole"
  FROM found_session fs
  LEFT JOIN user_role_data urd ON urd.user_id = fs.user_id
  GROUP BY fs.user_id, fs.expires_at
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
