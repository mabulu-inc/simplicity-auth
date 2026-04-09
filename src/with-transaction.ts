import type { Pool, PoolClient } from 'pg';

/**
 * Check out a connection from the pool, open a transaction, run `fn`,
 * and either COMMIT (on success) or ROLLBACK (on throw). The connection
 * is always released back to the pool.
 *
 * The session variables set inside `fn` via the `set*` helpers from this
 * package use transaction scope, so they are discarded automatically when
 * this function commits or rolls back. There is no risk of cross-request
 * leakage.
 *
 * This is the lower-level companion to `withSession`. Use it when you
 * need to set session variables manually (e.g. when migrating existing
 * code that has its own session-extraction logic) and don't want the
 * full session-and-role validation that `withSession` performs.
 *
 * @param pool - The pg connection pool.
 * @param fn   - Callback that receives the transaction-bound client.
 * @returns The value returned by `fn`.
 *
 * @example
 * ```ts
 * const result = await withTransaction(pool, async (client) => {
 *   await setSessionId(client, sessionId);
 *   await setRoleName(client, 'user');
 *   return client.query('SELECT * FROM widgets');
 * });
 * ```
 */
export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {
        // Swallow rollback errors so the original error surfaces.
      });
      throw err;
    }
  } finally {
    client.release();
  }
}
