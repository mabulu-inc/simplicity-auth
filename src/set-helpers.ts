import type { PoolClient } from 'pg';
import { InvalidInputError } from './errors.js';

const SET_CONFIG = 'SELECT set_config($1, $2, true)';

/**
 * The four GUC variable names this library uses. Re-exported here in
 * case consumers need them in custom RLS policies.
 */
export const SESSION_VAR_NAMES = {
  sessionId: 'app.session_id',
  roleName: 'app.role_name',
  tenantIds: 'app.tenant_ids',
  allTenants: 'app.all_tenants',
} as const;

/**
 * Set `app.session_id` for the current transaction.
 *
 * **Contract:** `client` must be inside an open transaction. Either wrap
 * with `withTransaction(pool, fn)` or call `await client.query('BEGIN')`
 * yourself first.
 *
 * The variable is set with transaction scope (`set_config(name, value, true)`)
 * and is automatically discarded on COMMIT or ROLLBACK. There is no risk
 * of cross-request leakage.
 *
 * **Warning:** This helper does not validate that the session exists or
 * is unexpired. Use `validateSession` or `withSession` if you want
 * automatic verification.
 *
 * @throws {InvalidInputError} If `sessionId` is not a non-empty string.
 */
export async function setSessionId(
  client: PoolClient,
  sessionId: string,
): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new InvalidInputError('sessionId must be a non-empty string');
  }
  await client.query(SET_CONFIG, [SESSION_VAR_NAMES.sessionId, sessionId]);
}

/**
 * Set `app.role_name` for the current transaction.
 *
 * **Contract:** `client` must be inside an open transaction.
 *
 * **Warning:** This helper does not verify that the requested role is
 * one the current session is allowed to use. The caller is responsible
 * for not passing user-supplied input directly. Use `withSession` to get
 * automatic role validation against the database.
 *
 * @typeParam TRole - String literal union of roles in your application.
 *   Defaults to `string`. Narrow this in a thin wrapper.
 * @throws {InvalidInputError} If `roleName` is not a non-empty string.
 */
export async function setRoleName<TRole extends string = string>(
  client: PoolClient,
  roleName: TRole,
): Promise<void> {
  if (typeof roleName !== 'string' || roleName.length === 0) {
    throw new InvalidInputError('roleName must be a non-empty string');
  }
  await client.query(SET_CONFIG, [SESSION_VAR_NAMES.roleName, roleName]);
}

/**
 * Set `app.tenant_ids` for the current transaction. The value is encoded
 * as a comma-separated string of integers (so RLS policies can parse it
 * with `string_to_array`). Empty arrays produce an empty string.
 *
 * **Contract:** `client` must be inside an open transaction.
 *
 * @throws {InvalidInputError} If any element of `tenantIds` is not a finite integer.
 */
export async function setTenantIds(
  client: PoolClient,
  tenantIds: readonly number[],
): Promise<void> {
  if (!Array.isArray(tenantIds)) {
    throw new InvalidInputError('tenantIds must be an array of integers');
  }
  for (const id of tenantIds) {
    if (!Number.isInteger(id)) {
      throw new InvalidInputError(
        `tenantIds must contain only integers; got ${String(id)}`,
      );
    }
  }
  await client.query(SET_CONFIG, [
    SESSION_VAR_NAMES.tenantIds,
    tenantIds.join(','),
  ]);
}

/**
 * Set `app.all_tenants` for the current transaction. When `true`, RLS
 * policies typically bypass tenant filtering and allow access to every
 * tenant's rows.
 *
 * **Contract:** `client` must be inside an open transaction.
 *
 * @throws {InvalidInputError} If `allTenants` is not a boolean.
 */
export async function setAllTenants(
  client: PoolClient,
  allTenants: boolean,
): Promise<void> {
  if (typeof allTenants !== 'boolean') {
    throw new InvalidInputError('allTenants must be a boolean');
  }
  await client.query(SET_CONFIG, [
    SESSION_VAR_NAMES.allTenants,
    allTenants ? 'true' : 'false',
  ]);
}

/**
 * Set all four session variables in one call. Equivalent to calling
 * `setSessionId`, `setRoleName`, `setTenantIds`, and `setAllTenants`
 * sequentially, but more concise.
 *
 * **Contract:** `client` must be inside an open transaction.
 */
export async function setSessionContext<TRole extends string = string>(
  client: PoolClient,
  context: {
    sessionId: string;
    roleName: TRole;
    tenantIds: readonly number[];
    allTenants: boolean;
  },
): Promise<void> {
  await setSessionId(client, context.sessionId);
  await setRoleName(client, context.roleName);
  await setTenantIds(client, context.tenantIds);
  await setAllTenants(client, context.allTenants);
}
