import { InvalidInputError } from '../errors.js';
import type { Queryable } from '../types.js';
import { OtpNotAllowedError, UnknownMethodError } from './errors.js';
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

const AUTH_DOMAIN_COLUMNS = `
    auth_domain_id     AS "authDomainId",
    tenant_id          AS "tenantId",
    display_name       AS "displayName",
    integration_type   AS "integrationType",
    integration_params AS "integrationParams"
`;

const SELECT_AUTH_DOMAINS_BY_TENANT = `
  SELECT ${AUTH_DOMAIN_COLUMNS}
  FROM auth_domains
  WHERE tenant_id = $1 AND deleted_at IS NULL
  ORDER BY display_name
`;

const SELECT_AUTH_DOMAIN_BY_ID = `
  SELECT ${AUTH_DOMAIN_COLUMNS}
  FROM auth_domains
  WHERE auth_domain_id = $1 AND deleted_at IS NULL
  LIMIT 1
`;

interface TenantRow {
  tenantId: number;
  allowOtp: boolean;
}

/**
 * Build a tenant-centric method router over a set of injected handlers.
 *
 * Sign-in discovery is by **sub-domain → tenant** (the app parses the request
 * Host to a slug). The router lists that tenant's `auth_domains` and dispatches
 * the chosen one (by `auth_domain_id`) to the handler registered for its
 * `integration_type`. The user-bound OTP path is separate and **gated by the
 * tenant's `allow_otp`** — enforced here, not just in the UI.
 *
 * Auth core stays protocol-free: handlers are injected. Install
 * `@smplcty/auth/oidc` / `@smplcty/auth/twilio` (each with its protocol peer)
 * and pass them in.
 *
 * @example
 * ```ts
 * const router = createMethodRouter({
 *   db: pool,
 *   handlers: { oidc: oidcHandler() },
 *   otpHandler: twilioVerifyHandler({ client }),
 * });
 *
 * // sign-in page (app already parsed Host → 'acme'):
 * const opts = await router.signInOptions({ tenantSlug: 'acme' });
 * // opts = { tenantId, authDomains: [...], otpAllowed }
 * //   0 IdPs → OTP form; 1 → redirect to initiate(); N → a button per IdP
 *
 * // OIDC: user clicked the "Microsoft" button (authDomainId 1)
 * const { redirectUrl } = await router.initiate(1);
 * // ...callback: app loaded the auth_domain it stored against `state`
 * const user = await router.complete(1, idToken);
 *
 * // OTP (only when opts.otpAllowed):
 * await router.initiateOtp({ tenantId: opts.tenantId, identifier: phone });
 * const user2 = await router.completeOtp({ tenantId: opts.tenantId, identifier: phone, credential: code });
 * ```
 */
export function createMethodRouter(options: MethodRouterOptions): MethodRouter {
  const { db, handlers, otpHandler } = options;
  const q = db as Queryable;

  async function loadAuthDomain(authDomainId: number): Promise<AuthDomain> {
    if (!Number.isInteger(authDomainId) || authDomainId <= 0) {
      throw new InvalidInputError('authDomainId must be a positive integer');
    }
    const { rows } = await q.query<AuthDomain>(SELECT_AUTH_DOMAIN_BY_ID, [authDomainId]);
    const authDomain = rows[0];
    if (!authDomain) {
      throw new UnknownMethodError(String(authDomainId));
    }
    return authDomain;
  }

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
      return {
        tenantId: tenant.tenantId,
        authDomains,
        otpAllowed: tenant.allowOtp === true && !!otpHandler,
      };
    },

    async initiate(authDomainId) {
      const authDomain = await loadAuthDomain(authDomainId);
      const handler = handlers[authDomain.integrationType];
      if (!handler) {
        throw new UnknownMethodError(String(authDomainId), authDomain.integrationType);
      }
      return handler.initiate({ db, authDomain });
    },

    async complete(authDomainId, credential): Promise<ResolvedUser> {
      if (typeof credential !== 'string' || credential.length === 0) {
        throw new InvalidInputError('credential must be a non-empty string');
      }
      const authDomain = await loadAuthDomain(authDomainId);
      const handler = handlers[authDomain.integrationType];
      if (!handler) {
        throw new UnknownMethodError(String(authDomainId), authDomain.integrationType);
      }
      return handler.complete({ db, authDomain, credential });
    },

    async initiateOtp({ tenantId, identifier }) {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        throw new InvalidInputError('identifier must be a non-empty string');
      }
      await assertOtpAllowed(tenantId);
      return otpHandler!.initiate({ db, authDomain: null, identifier });
    },

    async completeOtp({ tenantId, identifier, credential }): Promise<ResolvedUser> {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        throw new InvalidInputError('identifier must be a non-empty string');
      }
      if (typeof credential !== 'string' || credential.length === 0) {
        throw new InvalidInputError('credential must be a non-empty string');
      }
      await assertOtpAllowed(tenantId);
      return otpHandler!.complete({ db, authDomain: null, identifier, credential });
    },
  };
}
