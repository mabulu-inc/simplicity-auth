import type { PoolClient } from 'pg';
import { InvalidInputError } from './errors.js';

const SET_CONFIG = 'SELECT set_config($1, $2, true)';

/**
 * The identity GUC contract — the only GUCs `@smplcty/auth` sets. All are
 * transaction-local (`set_config(name, value, true)`), so they're
 * discarded automatically on COMMIT/ROLLBACK; cross-request leakage is
 * impossible. Re-exported so consumers can reference them in RLS policies.
 *
 * Scope GUCs (tenant ids, plant/region scope, visible rep ids, …) are
 * **not** here — intra-tenant scope is app-owned (set via the scope hook).
 *
 * - `app.actor_id`    — the acting user (human or service). Powers
 *   `current_user_id()` and audit attribution.
 * - `app.session_id`  — the session hash, for correlation/audit.
 * - `app.active_role` — the chosen mode/persona role for the request.
 * - `app.privileges`  — comma-separated privilege names the user holds.
 */
export const IDENTITY_GUC = {
  actorId: 'app.actor_id',
  sessionId: 'app.session_id',
  activeRole: 'app.active_role',
  privileges: 'app.privileges',
} as const;

/**
 * Set a single transaction-local GUC. Low-level escape hatch; prefer the
 * named setters or `setIdentityContext`.
 *
 * **Contract:** `client` must be inside an open transaction.
 */
export async function setLocal(client: PoolClient, name: string, value: string): Promise<void> {
  if (typeof name !== 'string' || name.length === 0) {
    throw new InvalidInputError('GUC name must be a non-empty string');
  }
  await client.query(SET_CONFIG, [name, value]);
}

/**
 * Set `app.actor_id` — the user (or service principal) performing the
 * request. `current_user_id()` and the audit trigger read it.
 *
 * @throws {InvalidInputError} If `actorId` is not a positive integer.
 */
export async function setActorId(client: PoolClient, actorId: number): Promise<void> {
  if (!Number.isInteger(actorId) || actorId <= 0) {
    throw new InvalidInputError('actorId must be a positive integer');
  }
  await client.query(SET_CONFIG, [IDENTITY_GUC.actorId, String(actorId)]);
}

/**
 * Set `app.session_id` (the session hash) for correlation/audit.
 *
 * @throws {InvalidInputError} If `sessionId` is not a non-empty string.
 */
export async function setSessionId(client: PoolClient, sessionId: string): Promise<void> {
  if (typeof sessionId !== 'string' || sessionId.length === 0) {
    throw new InvalidInputError('sessionId must be a non-empty string');
  }
  await client.query(SET_CONFIG, [IDENTITY_GUC.sessionId, sessionId]);
}

/**
 * Set `app.active_role` — the mode/persona role for this request. Pass
 * null to clear it (privilege-only request).
 *
 * @throws {InvalidInputError} If `roleName` is neither a non-empty string nor null.
 */
export async function setActiveRole(client: PoolClient, roleName: string | null): Promise<void> {
  if (roleName !== null && (typeof roleName !== 'string' || roleName.length === 0)) {
    throw new InvalidInputError('roleName must be a non-empty string or null');
  }
  await client.query(SET_CONFIG, [IDENTITY_GUC.activeRole, roleName ?? '']);
}

/**
 * Set `app.privileges` — a comma-separated list of the privilege names the
 * user holds. RLS policies parse it with `string_to_array(_, ',')`.
 *
 * @throws {InvalidInputError} If `privileges` is not an array of strings,
 *   or any entry contains a comma.
 */
export async function setPrivileges(client: PoolClient, privileges: readonly string[]): Promise<void> {
  if (!Array.isArray(privileges)) {
    throw new InvalidInputError('privileges must be an array of strings');
  }
  for (const p of privileges) {
    if (typeof p !== 'string' || p.length === 0) {
      throw new InvalidInputError('privileges must contain only non-empty strings');
    }
    if (p.includes(',')) {
      throw new InvalidInputError(`privilege names must not contain commas; got "${p}"`);
    }
  }
  await client.query(SET_CONFIG, [IDENTITY_GUC.privileges, privileges.join(',')]);
}

/**
 * Set all four identity GUCs in one call.
 *
 * **Contract:** `client` must be inside an open transaction.
 */
export async function setIdentityContext(
  client: PoolClient,
  context: {
    actorId: number;
    sessionId: string;
    activeRole: string | null;
    privileges: readonly string[];
  },
): Promise<void> {
  await setActorId(client, context.actorId);
  await setSessionId(client, context.sessionId);
  await setActiveRole(client, context.activeRole);
  await setPrivileges(client, context.privileges);
}
