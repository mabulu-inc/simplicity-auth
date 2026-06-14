import { InvalidInputError } from '../errors.js';
import type { Queryable } from '../types.js';
import { OtpNotAllowedError } from './errors.js';
import type { AuthDomain, MethodRouter, MethodRouterOptions, ResolvedUser, SignInOptions } from './types.js';

const SELECT_TENANT_BY_SLUG = `
  SELECT tenant_id AS "tenantId", allow_otp AS "allowOtp"
  FROM tenants
  WHERE slug = $1 AND deleted_at IS NULL
  LIMIT 1
`;

const SELECT_ALLOW_OTP = `
  SELECT allow_otp AS "allowOtp"
  FROM tenants
  WHERE tenant_id = $1 AND deleted_at IS NULL
  LIMIT 1
`;

const SELECT_AUTH_DOMAINS_BY_TENANT = `
  SELECT
    auth_domain_id     AS "authDomainId",
    tenant_id          AS "tenantId",
    display_name       AS "displayName",
    integration_type   AS "integrationType",
    integration_params AS "integrationParams"
  FROM auth_domains
  WHERE tenant_id = $1 AND deleted_at IS NULL
  ORDER BY display_name
`;

interface TenantRow {
  tenantId: number;
  allowOtp: boolean;
}

/**
 * Build the tenant-centric sign-in router: **discovery** (`signInOptions`) and
 * the **user-bound OTP path** (`initiateOtp`/`completeOtp`, gated by the
 * tenant's `allow_otp`, enforced here — not just in the UI).
 *
 * OIDC is intentionally not routed here: it has a richer `authorize`/`callback`
 * shape (PKCE + login-state) handled by `@smplcty/auth/oidc`. Resolve the
 * tenant's OIDC `auth_domains` via `signInOptions`, then drive that handler.
 *
 * ```ts
 * const router = createMethodRouter({ db: pool, otpHandler: twilioVerifyHandler({ client }) });
 * const opts = await router.signInOptions({ tenantSlug: 'acme' });
 * // opts = { tenantId, authDomains: [...OIDC IdPs...], otpAllowed }
 * //   render: a button per authDomain (→ @smplcty/auth/oidc) + an OTP form iff otpAllowed
 * ```
 */
export function createMethodRouter(options: MethodRouterOptions): MethodRouter {
  const { otpHandler } = options;
  const q = options.db as Queryable;

  async function assertOtpAllowed(tenantId: number): Promise<void> {
    if (!Number.isInteger(tenantId) || tenantId <= 0) {
      throw new InvalidInputError('tenantId must be a positive integer');
    }
    if (!otpHandler) {
      throw new OtpNotAllowedError(tenantId, 'No OTP handler is configured');
    }
    const { rows } = await q.query<{ allowOtp: boolean }>(SELECT_ALLOW_OTP, [tenantId]);
    const row = rows[0];
    // Unknown tenant or allow_otp=false both deny — fail closed.
    if (!row || row.allowOtp !== true) {
      throw new OtpNotAllowedError(tenantId);
    }
  }

  return {
    async signInOptions({ tenantSlug }): Promise<SignInOptions | null> {
      if (typeof tenantSlug !== 'string' || tenantSlug.length === 0) {
        throw new InvalidInputError('tenantSlug must be a non-empty string');
      }
      const { rows } = await q.query<TenantRow>(SELECT_TENANT_BY_SLUG, [tenantSlug]);
      const tenant = rows[0];
      if (!tenant) {
        return null;
      }
      const { rows: authDomains } = await q.query<AuthDomain>(SELECT_AUTH_DOMAINS_BY_TENANT, [tenant.tenantId]);
      // bigint ids arrive from pg as strings; the public shapes are `number`.
      return {
        tenantId: Number(tenant.tenantId),
        authDomains: authDomains.map((d) => ({
          ...d,
          authDomainId: Number(d.authDomainId),
          tenantId: Number(d.tenantId),
        })),
        otpAllowed: tenant.allowOtp === true && !!otpHandler,
      };
    },

    async initiateOtp({ tenantId, identifier }) {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        throw new InvalidInputError('identifier must be a non-empty string');
      }
      await assertOtpAllowed(tenantId);
      return otpHandler!.initiate({ db: options.db, identifier });
    },

    async completeOtp({ tenantId, identifier, credential }): Promise<ResolvedUser> {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        throw new InvalidInputError('identifier must be a non-empty string');
      }
      if (typeof credential !== 'string' || credential.length === 0) {
        throw new InvalidInputError('credential must be a non-empty string');
      }
      await assertOtpAllowed(tenantId);
      return otpHandler!.complete({ db: options.db, identifier, credential });
    },
  };
}
