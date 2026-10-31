import { InvalidInputError } from '../errors.js';
import { emailDomainOf, ssoRequiredDomain, ssoRequiredDomainForUser } from '../internal/email-domain.js';
import type { Queryable } from '../types.js';
import { OtpNotAllowedError, SsoRequiredError } from './errors.js';
import type {
  AuthDomain,
  IdentifierKind,
  MethodHandler,
  MethodRouter,
  MethodRouterOptions,
  ResolvedUser,
  SignInOptions,
} from './types.js';

/** An identifier containing `@` is an email; anything else is a phone. */
export function identifierKind(identifier: string): IdentifierKind {
  return identifier.includes('@') ? 'email' : 'phone';
}

const SELECT_TENANT_BY_SLUG = `
  SELECT tenant_id AS "tenantId"
  FROM tenants
  WHERE slug = $1 AND deleted_at IS NULL
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
}

/**
 * Build the tenant-centric sign-in router: **discovery** (`signInOptions`) and
 * the **user-bound OTP path** (`initiateOtp`/`completeOtp`). Code sign-in is
 * open to everyone except addresses at a verified email domain that requires
 * SSO (`tenant_email_domains.sso_required`) — refused here, on every
 * sub-domain, not just hidden in the UI.
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
  const otpAllowed = !!otpHandler && ('initiate' in otpHandler || !!(otpHandler.email || otpHandler.phone));

  /** The handler for this identifier: the single one, or the one for its kind. */
  function handlerFor(identifier: string): MethodHandler {
    if (!otpHandler) throw new OtpNotAllowedError('No OTP handler is configured');
    if ('initiate' in otpHandler) return otpHandler;
    const kind = identifierKind(identifier);
    const handler = otpHandler[kind];
    if (!handler) throw new OtpNotAllowedError(`Code sign-in by ${kind} is not offered`);
    return handler;
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
        otpAllowed,
      };
    },

    async initiateOtp({ identifier }) {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        throw new InvalidInputError('identifier must be a non-empty string');
      }
      const handler = handlerFor(identifier);
      // Don't send a code to an address that could never use it.
      const domain = emailDomainOf(identifier);
      const required = domain ? await ssoRequiredDomain(q, [domain]) : null;
      if (required) throw new SsoRequiredError(required);
      // The same verdict completeOtp reaches on the resolved user, with the same
      // response an unknown identifier gets, so it doesn't reveal whose a phone is.
      const user = await handler.resolveUser?.({ db: options.db, identifier });
      if (user && (await ssoRequiredDomainForUser(q, user.userId))) return { otpSent: true };
      return handler.initiate({ db: options.db, identifier });
    },

    async completeOtp({ identifier, credential }): Promise<ResolvedUser> {
      if (typeof identifier !== 'string' || identifier.length === 0) {
        throw new InvalidInputError('identifier must be a non-empty string');
      }
      if (typeof credential !== 'string' || credential.length === 0) {
        throw new InvalidInputError('credential must be a non-empty string');
      }
      const user = await handlerFor(identifier).complete({ db: options.db, identifier, credential });
      // Checked on the resolved user, not just the identifier: someone whose
      // email is at an SSO-required domain can't sign in by phone either.
      const required = await ssoRequiredDomainForUser(q, user.userId);
      if (required) throw new SsoRequiredError(required);
      return user;
    },
  };
}
