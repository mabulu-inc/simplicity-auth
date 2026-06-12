import type { PoolClient } from 'pg';
import type { ScopeHook, SessionIdentity } from '../types.js';

/**
 * The flat-tenant scope GUCs. Set by the {@link flatTenantScope} preset;
 * **not** part of the core identity contract. Reference them in RLS
 * policies if you adopt the preset.
 *
 * - `app.tenant_ids`  — comma-separated tenant ids the user belongs to.
 * - `app.all_tenants` — `'true'` when the user has a wildcard
 *   (`tenant_id IS NULL`) membership; such users see every tenant.
 */
export const FLAT_TENANT_GUC = {
  tenantIds: 'app.tenant_ids',
  allTenants: 'app.all_tenants',
} as const;

const SET_CONFIG = 'SELECT set_config($1, $2, true)';

// Resolve the user's tenant membership from user_roles. tenant_id IS NULL
// is a wildcard (all tenants); concrete ids are the explicit memberships.
// Runs as the request user — an RLS policy keyed on current_user_id()
// (already set by withSession) lets the user read their own rows.
const SELECT_TENANTS = `
  SELECT
    COALESCE(
      array_agg(DISTINCT tenant_id) FILTER (WHERE tenant_id IS NOT NULL),
      '{}'::integer[]
    ) AS tenant_ids,
    COALESCE(bool_or(tenant_id IS NULL), false) AS all_tenants
  FROM user_roles
  WHERE user_id = $1
    AND deleted_at IS NULL
`;

interface TenantRow {
  tenant_ids: number[];
  all_tenants: boolean;
}

/**
 * A ready-made scope hook implementing the flat `tenant_ids` /
 * `all_tenants` model (the 0.6.x behavior), now opt-in rather than baked
 * into the core.
 *
 * Adopt it for simple multi-tenant apps that don't need a custom scope:
 *
 * ```ts
 * import { withSession } from '@smplcty/auth';
 * import { flatTenantScope } from '@smplcty/auth/flat-tenant';
 *
 * const scope = flatTenantScope();
 * await withSession(pool, { token }, fn, { scope });
 * ```
 *
 * It sets `app.tenant_ids` and `app.all_tenants` from the user's
 * `user_roles` rows. Your RLS policies read those GUCs to filter by
 * tenant. Apps with a richer intra-tenant model (producer/region/plant,
 * rep hierarchy, …) ship their own scope hook instead.
 */
export function flatTenantScope(): ScopeHook {
  return async (client: PoolClient, identity: SessionIdentity): Promise<void> => {
    const { rows } = await client.query<TenantRow>(SELECT_TENANTS, [identity.userId]);
    const row = rows[0];
    const tenantIds = row?.tenant_ids ?? [];
    const allTenants = row?.all_tenants ?? false;
    await client.query(SET_CONFIG, [FLAT_TENANT_GUC.tenantIds, tenantIds.join(',')]);
    await client.query(SET_CONFIG, [FLAT_TENANT_GUC.allTenants, allTenants ? 'true' : 'false']);
  };
}
