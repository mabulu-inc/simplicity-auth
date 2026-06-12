import type { Pool, PoolClient } from 'pg';
import { withTransaction } from '@smplcty/db';
import { InvalidInputError, ServicePrincipalNotFoundError } from './errors.js';
import { setActorId, setSessionId } from './set-helpers.js';

const SELECT_SERVICE_USER = `
  SELECT user_id AS "userId"
  FROM users
  WHERE name = $1 AND kind = 'service'
  LIMIT 1
`;

interface ServiceUserRow {
  userId: number;
}

/**
 * Run background work as a named service principal, inside a `@smplcty/db`
 * transaction with `app.actor_id` set to that principal's `user_id`.
 *
 * Background writers (ingestion, transform workers, app-init) have no human
 * session, but audit attribution (`created_by`/`updated_by`, stamped from
 * `app.actor_id`) is NOT NULL — so service writes need an actor too.
 * Provision a `users` row with `kind = 'service'` for each service and pass
 * its name here.
 *
 * Sets `app.actor_id` (the service's user_id) and `app.session_id` (the
 * service name, for correlation). No active role / privileges — service
 * principals act through `current_user_id()` and RLS, not roles.
 *
 * @example
 * ```ts
 * await withServiceContext(pool, 'transform-worker', async (client) => {
 *   await client.query('INSERT INTO metrics (...) VALUES (...)'); // audited to the service
 * });
 * ```
 *
 * @throws {InvalidInputError}              If `serviceName` is empty.
 * @throws {ServicePrincipalNotFoundError}  If no `kind='service'` user has that name.
 */
export async function withServiceContext<T>(
  pool: Pool,
  serviceName: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  if (typeof serviceName !== 'string' || serviceName.length === 0) {
    throw new InvalidInputError('serviceName must be a non-empty string');
  }

  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<ServiceUserRow>(SELECT_SERVICE_USER, [serviceName]);
    const row = rows[0];
    if (!row) {
      throw new ServicePrincipalNotFoundError(serviceName);
    }

    await setActorId(client, row.userId);
    await setSessionId(client, serviceName);

    return fn(client);
  });
}
