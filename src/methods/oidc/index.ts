import { verifyIdToken, type OidcTokenPayload } from '@smplcty/oidc';
import { InvalidInputError } from '../../errors.js';
import { findUserByCommunicationMethod } from '../../find-user-by-communication-method.js';
import type { Queryable } from '../../types.js';
import { VerificationFailedError } from '../errors.js';
import type {
  AuthDomain,
  MethodCompleteContext,
  MethodHandler,
  MethodInitiateContext,
  MethodInitiateResult,
  ResolvedUser,
} from '../types.js';

/**
 * The OIDC provider config the handler reads from
 * `auth_domains.integration_params`.
 */
export interface OidcParams {
  /** Provider issuer URL. Used to verify the id_token. */
  issuer: string;
  /** This app's OIDC client id. */
  clientId: string;
  /** The provider's authorization endpoint, used to build the redirect.
   *  Required for `initiate` unless a custom `buildRedirectUrl` is given. */
  authorizationEndpoint?: string;
  /** Where the provider sends the user back. */
  redirectUri?: string;
  /** OAuth scope. Defaults to `openid email`. */
  scope?: string;
}

export interface OidcHandlerOptions {
  /**
   * Build the authorization redirect URL for `initiate`. Defaults to
   * reading `authorizationEndpoint` from the matched config and appending
   * the standard query params.
   *
   * Note: v1 does not manage `state` / `nonce` / PKCE here — those need
   * per-request storage the library doesn't own. Supply this hook to add
   * them, or wait for the full auth-code flow in `@smplcty/oidc`.
   */
  buildRedirectUrl?: (input: { authDomain: AuthDomain<OidcParams>; identifier?: string }) => string;
  /**
   * Provision a user when a verified identity has no existing
   * communication method. The app owns the writes and their audit
   * attribution (it knows the tenant from `authDomain.tenantId` and the
   * default roles from `authDomain.integrationParams`). Omit to reject
   * unprovisioned identities.
   */
  provisionUser?: (input: {
    db: Queryable;
    authDomain: AuthDomain<OidcParams>;
    claims: OidcTokenPayload;
  }) => Promise<ResolvedUser>;
}

function paramsOf(authDomain: AuthDomain | null): AuthDomain<OidcParams> {
  if (!authDomain) {
    throw new InvalidInputError('OIDC handler requires a matched auth_domains row (org-bound)');
  }
  return authDomain as unknown as AuthDomain<OidcParams>;
}

function defaultRedirect(authDomain: AuthDomain<OidcParams>): string {
  const p = authDomain.integrationParams;
  if (!p?.authorizationEndpoint) {
    throw new InvalidInputError(
      'auth_domains.integration_params.authorizationEndpoint is required for OIDC initiate (or pass buildRedirectUrl)',
    );
  }
  const url = new URL(p.authorizationEndpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', p.clientId);
  if (p.redirectUri) {
    url.searchParams.set('redirect_uri', p.redirectUri);
  }
  url.searchParams.set('scope', p.scope ?? 'openid email');
  return url.toString();
}

/**
 * The org-bound OIDC method handler (opt-in subpath `@smplcty/auth/oidc`).
 * Phase 1 produces a redirect to the org's IdP; phase 2 verifies the
 * returned id_token (the `credential`) and matches — or provisions, if a
 * `provisionUser` hook is supplied — the user.
 *
 * Org-bound: it requires a matched `auth_domains` row (the per-tenant
 * provider config). Drives `@smplcty/oidc` (an **optional peer**) for the
 * protocol; the `auth_domains` registry lives in auth (own-domain rule),
 * so this handler reads the config and calls `verifyIdToken` itself.
 *
 * ```ts
 * import { oidcHandler } from '@smplcty/auth/oidc';
 * const router = createMethodRouter({ db: pool, handlers: { oidc: oidcHandler() } });
 * ```
 */
export function oidcHandler(options: OidcHandlerOptions = {}): MethodHandler {
  return {
    async initiate(ctx: MethodInitiateContext): Promise<MethodInitiateResult> {
      const authDomain = paramsOf(ctx.authDomain);
      const redirectUrl = options.buildRedirectUrl
        ? options.buildRedirectUrl({ authDomain, identifier: ctx.identifier })
        : defaultRedirect(authDomain);
      return { redirectUrl };
    },

    async complete(ctx: MethodCompleteContext): Promise<ResolvedUser> {
      const authDomain = paramsOf(ctx.authDomain);
      const { issuer, clientId } = authDomain.integrationParams;

      let claims: OidcTokenPayload;
      try {
        // credential is the id_token returned from the provider.
        claims = await verifyIdToken(ctx.credential, { issuer, clientId });
      } catch {
        throw new VerificationFailedError('OIDC id_token verification failed');
      }

      const email = claims.email ?? claims.preferredUsername;
      if (!email) {
        throw new VerificationFailedError('OIDC id_token has no email or preferred_username');
      }

      const existing = await findUserByCommunicationMethod(ctx.db, { channel: 'email', code: email });
      if (existing) {
        return existing;
      }

      if (options.provisionUser) {
        return options.provisionUser({ db: ctx.db, authDomain, claims });
      }

      throw new VerificationFailedError('No user for verified identity and provisioning is disabled');
    },
  };
}
