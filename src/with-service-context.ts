import type { Pool, PoolClient } from 'pg';
import { InvalidInputError } from './errors.js';
import { SESSION_VAR_NAMES } from './set-helpers.js';

/**
 * Session-scoped `set_config` — persists for the lifetime of the
 * connection, not just the current transaction. Used by background
 * jobs that run multiple statements outside a transaction.
 */
const SET_CONFIG_SESSION = 'SELECT set_config($1, $2, false)';

/**
 * Check out a client from the pool, set service-level GUCs
 * (role=settings, all_tenants=true, session_id=serviceName), run the
 * callback, and release the client.
 *
 * Use this for background Lambdas that need to bypass RLS without a
 * real user session. The GUCs are set session-scoped (not
 * transaction-local) so they persist across all queries on the held
 * client without requiring a wrapping transaction.
 *
 * @example
 * ```ts
 * const pool = await getPool();
 * return withServiceContext(pool, 'handle-hierarchy-refresh', async (client) => {
 *   const { rows } = await client.query('SELECT * FROM hierarchy_change_log');
 *   // ... business logic
 * });
 * ```
 *
 * @throws {InvalidInputError} If `serviceName` is empty.
 */
export async function withServiceContext<T>(
  pool: Pool,
  serviceName: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof serviceName !== 'string' || serviceName.length === 0) {
    throw new InvalidInputError('serviceName must be a non-empty string');
  }

  const client = await pool.connect();
  try {
    await client.query(SET_CONFIG_SESSION, [
      SESSION_VAR_NAMES.sessionId,
      serviceName,
    ]);
    await client.query(SET_CONFIG_SESSION, [
      SESSION_VAR_NAMES.roleName,
      'settings',
    ]);
    await client.query(SET_CONFIG_SESSION, [
      SESSION_VAR_NAMES.allTenants,
      'true',
    ]);
    return await fn(client);
  } finally {
    client.release();
  }
}
