import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '@smplcty/db';
import { RoleNotHeldError, SessionExpiredError, SessionNotFoundError } from './errors.js';
import { hashId } from './internal/hash-id.js';
import { hashToken } from './internal/hash-token.js';
import { noopLogger } from './internal/noop-logger.js';
import { setIdentityContext } from './set-helpers.js';
import type { SessionAuth, SessionContext, WithSessionOptions } from './types.js';

/**
 * Calls the pure `resolve_session` SECURITY DEFINER resolver so the read
 * bypasses RLS on the auth tables (sessions, user_communication_methods,
 * user_roles). The resolver validates nothing — it returns the user, the
 * expiry, the roles the user holds, the default role, and the privileges.
 * Validation and role selection happen here in TS.
 */
const RESOLVE_SESSION = `
  SELECT
    user_id      AS "userId",
    expires_at   AS "expiresAt",
    roles        AS "roles",
    default_role AS "defaultRole",
    privileges   AS "privileges"
  FROM resolve_session($1)
`;

interface ResolvedRow {
  userId: number;
  expiresAt: Date;
  roles: string[];
  defaultRole: string | null;
  privileges: string[];
}

/**
 * The high-level "just make it work" request entry point. Opens a
 * `@smplcty/db` transaction, resolves the session from its token, validates
 * it, picks and validates the active role, sets the identity GUCs, runs the
 * app scope hook, then runs the callback — committing on success or rolling
 * back on throw.
 *
 * Active-role selection (in TS, not the resolver):
 *   1. `roleName` if given — must be one the user holds, else {@link RoleNotHeldError}.
 *   2. otherwise the user's sole role, if they hold exactly one.
 *   3. otherwise the user's default role, if any.
 *   4. otherwise none — a privilege-only request, which is **not** an error.
 *
 * Identity GUCs are transaction-local, so they vanish on COMMIT/ROLLBACK —
 * no cross-request leakage. Scope GUCs are not set here: pass a `scope`
 * hook (e.g. `flatTenantScope()`) for that, or rely on function-carried RLS.
 *
 * @example
 * ```ts
 * const widgets = await withSession(
 *   pool,
 *   { token, roleName: 'user' },
 *   async (client, ctx) => {
 *     // ctx = { userId, activeRole, roles, privileges }
 *     const { rows } = await client.query('SELECT * FROM widgets');
 *     return rows;
 *   },
 *   { scope: flatTenantScope() },
 * );
 * ```
 *
 * @throws {SessionNotFoundError}  If no session matches the token.
 * @throws {SessionExpiredError}   If the session has expired (or was revoked).
 * @throws {RoleNotHeldError}      If `roleName` is given but not held.
 * @throws {InvalidInputError}     If `token` is empty.
 */
export async function withSession<TRole extends string = string, T = unknown>(
  pool: Pool,
  auth: SessionAuth<TRole>,
  fn: (client: PoolClient, ctx: SessionContext<TRole>) => Promise<T>,
  options: WithSessionOptions<TRole> = {},
): Promise<T> {
  const log = options.logger ?? noopLogger;
  const tokenHash = hashToken(auth.token);
  const fingerprint = hashId(auth.token);

  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ResolvedRow>(RESOLVE_SESSION, [tokenHash]);
    const row = rows[0];

    if (!row) {
      log.warn({ session: fingerprint }, 'session not found');
      throw new SessionNotFoundError();
    }

    // Revocation is just expiry: revoke sets expires_at = now(). So an
    // expired-or-revoked session fails the same check.
    if (row.expiresAt.getTime() <= Date.now()) {
      log.warn({ session: fingerprint, expiresAt: row.expiresAt.toISOString() }, 'session expired');
      throw new SessionExpiredError(row.expiresAt);
    }

    // Active-role selection happens here, not in the resolver.
    let activeRole: TRole | null;
    if (auth.roleName !== undefined) {
      if (!row.roles.includes(auth.roleName)) {
        log.warn({ session: fingerprint, userId: row.userId, requestedRole: auth.roleName }, 'role not held');
        throw new RoleNotHeldError(auth.roleName);
      }
      activeRole = auth.roleName;
    } else if (row.roles.length === 1) {
      // A single role is unambiguous — it's the active role whether or not it
      // is flagged default. `roles` is distinct by name (resolve_session), so
      // the same role held across several tenants still counts as one: an admin
      // who only holds `security`, in any number of tenants, gets it
      // auto-selected without having to request it.
      activeRole = row.roles[0] as TRole;
    } else {
      // Two or more distinct roles (e.g. different roles in different tenants):
      // genuinely ambiguous, so fall back to the default role, else none.
      activeRole = (row.defaultRole as TRole | null) ?? null;
    }

    const ctx: SessionContext<TRole> = {
      // bigint user_id arrives from pg as a string; the contract is `number`.
      userId: Number(row.userId),
      activeRole,
      roles: row.roles as TRole[],
      privileges: row.privileges,
    };

    await setIdentityContext(client, {
      actorId: ctx.userId,
      sessionId: tokenHash,
      activeRole: ctx.activeRole,
      privileges: ctx.privileges,
    });

    // App-owned intra-tenant scope. No-op when omitted.
    await options.scope?.(client, ctx);

    log.debug(
      {
        session: fingerprint,
        userId: ctx.userId,
        activeRole: ctx.activeRole,
        roleCount: ctx.roles.length,
        privilegeCount: ctx.privileges.length,
      },
      'session context set',
    );

    return fn(client, ctx);
  });
}
