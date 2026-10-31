import * as oauth from 'oauth4webapi';
import { InvalidInputError } from '../../errors.js';
import { findUserByCommunicationMethod } from '../../find-user-by-communication-method.js';
import { emailDomainOf, tenantHasVerifiedDomain } from '../../internal/email-domain.js';
import type { Queryable } from '../../types.js';
import { EmailDomainNotVerifiedError, VerificationFailedError } from '../errors.js';
import type { AuthDomain, ResolvedUser } from '../types.js';
import { loadClientKey, loadClientSecret, type CredentialCipher } from './credentials.js';

export {
  generateClientKey,
  getClientCredentialStatus,
  setClientSecret,
  type ClientCredentialStatus,
  type ClientPublicKey,
  type CredentialCipher,
  type CredentialContext,
} from './credentials.js';

/** How the client authenticates at the token endpoint (OIDC registration's `token_endpoint_auth_method`). */
export type TokenEndpointAuthMethod = 'none' | 'client_secret_basic' | 'client_secret_post' | 'private_key_jwt';

const TOKEN_ENDPOINT_AUTH_METHODS: readonly TokenEndpointAuthMethod[] = [
  'none',
  'client_secret_basic',
  'client_secret_post',
  'private_key_jwt',
];

/**
 * The OIDC provider config read from `auth_domains.integration_params`.
 * Public values only. The client's credential never goes here: it is stored
 * encrypted in `auth_domain_credentials` (see {@link setClientSecret} and
 * {@link generateClientKey}), or supplied by the app's
 * {@link OidcHandlerOptions.clientSecret} resolver.
 */
export interface OidcParams {
  /** Provider issuer URL (discovery is fetched from `${issuer}/.well-known/openid-configuration`). */
  issuer: string;
  /** This app's OIDC client id. */
  clientId: string;
  /** Where the provider sends the user back (must match the app's callback route). */
  redirectUri: string;
  /** OAuth scope. Defaults to `openid email profile`. */
  scope?: string;
  /**
   * How the client authenticates at the token endpoint; only this method is
   * ever sent, and a failure is never retried with another. Leave it out to
   * keep the behavior from before it existed: `client_secret_post` when the
   * {@link OidcHandlerOptions.clientSecret} resolver returns a secret, else none.
   */
  tokenEndpointAuthMethod?: TokenEndpointAuthMethod;
}

/**
 * The transient login state produced by {@link OidcHandler.initiate} that the
 * **app must persist** across the redirect (a short-lived signed cookie keyed
 * by `state`) and hand back to {@link OidcHandler.complete}. The library holds
 * no pre-auth state of its own.
 */
export interface OidcLoginState {
  state: string;
  nonce: string;
  codeVerifier: string;
}

export interface OidcAuthorization {
  /** Where to redirect the browser to begin the OIDC flow. */
  redirectUrl: string;
  /** Persist this (signed cookie) and pass it to `complete` on callback. */
  loginState: OidcLoginState;
}

export interface OidcHandlerOptions {
  /**
   * Resolve a client secret the app holds itself, from its own secret store.
   * When it returns a secret, that secret is used, ahead of one stored with
   * {@link setClientSecret}; return `undefined` to fall back to the stored one.
   */
  clientSecret?: (authDomain: AuthDomain<OidcParams>) => string | undefined | Promise<string | undefined>;
  /**
   * Decrypts credentials stored with {@link setClientSecret} and
   * {@link generateClientKey} (the same cipher that encrypted them). Each is
   * read and decrypted on every sign-in, never cached, so a replaced credential
   * takes effect on the next one.
   */
  cipher?: CredentialCipher;
  /**
   * Provision a user when a verified identity has no existing communication
   * method. The app owns the writes + audit attribution (it knows the tenant
   * from `authDomain.tenantId`). Omit to reject unprovisioned identities.
   */
  provisionUser?: (input: {
    db: Queryable;
    authDomain: AuthDomain<OidcParams>;
    claims: ValidatedClaims;
  }) => Promise<ResolvedUser>;
  /** Override `fetch` (tests inject a mock for discovery + token endpoints). */
  fetch?: typeof globalThis.fetch;
}

type ValidatedClaims = NonNullable<ReturnType<typeof oauth.getValidatedIdTokenClaims>>;

/**
 * The org-bound OIDC handler (opt-in subpath `@smplcty/auth/oidc`), built on
 * **`oauth4webapi`** (ADR-0001). Two phases:
 *
 * - `initiate(authDomain)` — discovery + PKCE/state/nonce → an authorization
 *   redirect URL and the `loginState` to persist.
 * - `complete({ callbackUrl, loginState })` — validate the callback, exchange
 *   the code, verify the `id_token` (signature, claims, nonce) → resolve (or
 *   provision) the user.
 *
 * `oauth4webapi` is an **optional peer**; install it to use this subpath.
 *
 * **Trust boundary.** `complete()` resolves the user by the verified
 * `id_token` email **globally** — it does not constrain the match to
 * `authDomain.tenantId`. An `auth_domains` IdP is therefore trusted to assert
 * only identities it is authoritative for; partition tenants by verified email
 * domain so one tenant's IdP cannot attest another tenant's user's address. The
 * minted session is still the matched user's own (their roles, their tenants) —
 * this is an authentication-authority boundary, not a scope boundary.
 *
 * ```ts
 * const oidc = oidcHandler({ cipher }); // or clientSecret: (ad) => secrets.get(ad.tenantId)
 * const { redirectUrl, loginState } = await oidc.initiate(authDomain);
 * // ...store loginState in a signed cookie keyed by loginState.state, redirect...
 * const user = await oidc.complete({ db: pool, authDomain, callbackUrl, loginState });
 * const session = await createSession(pool, { userCommunicationMethodId: user.userCommunicationMethodId, ttl: '30 days' });
 * ```
 */
export interface OidcHandler {
  initiate(authDomain: AuthDomain<OidcParams>, opts?: { loginHint?: string }): Promise<OidcAuthorization>;
  complete(input: {
    db: Queryable;
    authDomain: AuthDomain<OidcParams>;
    /** The full callback URL (including the query string from the provider). */
    callbackUrl: string | URL;
    loginState: OidcLoginState;
  }): Promise<ResolvedUser>;
}

function paramsOf(authDomain: AuthDomain<Partial<OidcParams>>): OidcParams {
  if (authDomain.integrationType !== 'oidc') {
    throw new InvalidInputError(`OidcHandler requires integration_type 'oidc', got '${authDomain.integrationType}'`);
  }
  const p = authDomain.integrationParams;
  if (!p.issuer || !p.clientId || !p.redirectUri) {
    throw new InvalidInputError('OIDC integration_params must include issuer, clientId, and redirectUri');
  }
  if (p.tokenEndpointAuthMethod !== undefined && !TOKEN_ENDPOINT_AUTH_METHODS.includes(p.tokenEndpointAuthMethod)) {
    throw new InvalidInputError(
      `OIDC tokenEndpointAuthMethod must be one of ${TOKEN_ENDPOINT_AUTH_METHODS.join(', ')}, got ${JSON.stringify(p.tokenEndpointAuthMethod)}`,
    );
  }
  return p as OidcParams;
}

/**
 * The client authentication for this exchange: the auth domain's declared
 * method and nothing else, with its credential read and decrypted now.
 */
async function clientAuthFor(
  db: Queryable,
  authDomain: AuthDomain<OidcParams>,
  params: OidcParams,
  as: oauth.AuthorizationServer,
  options: OidcHandlerOptions,
): Promise<oauth.ClientAuth> {
  const method = params.tokenEndpointAuthMethod;
  const id = authDomain.authDomainId;
  if (method === undefined) {
    const secret = options.clientSecret ? await options.clientSecret(authDomain) : undefined;
    return secret ? oauth.ClientSecretPost(secret) : oauth.None();
  }
  if (method === 'none') return oauth.None();
  if (method === 'private_key_jwt') {
    const stored = await loadClientKey(db, id, options.cipher);
    if (!stored) throw new InvalidInputError(`auth domain ${id} uses private_key_jwt but has no key; generate one`);
    return oauth.PrivateKeyJwt(
      { key: stored.key, kid: stored.x5tS256 },
      {
        // Entra identifies the certificate by thumbprint, not kid, and wants the
        // token endpoint as the audience; oauth4webapi defaults aud to the issuer.
        [oauth.modifyAssertion]: (header, payload) => {
          Object.assign(header, { 'x5t#S256': stored.x5tS256, x5t: stored.x5t });
          if (as.token_endpoint) payload.aud = as.token_endpoint;
        },
      },
    );
  }
  const secret =
    (options.clientSecret ? await options.clientSecret(authDomain) : undefined) ??
    (await loadClientSecret(db, id, options.cipher));
  if (!secret) throw new InvalidInputError(`auth domain ${id} uses ${method} but has no client secret; set one`);
  return method === 'client_secret_basic' ? oauth.ClientSecretBasic(secret) : oauth.ClientSecretPost(secret);
}

// Discovery is cached per issuer for the process lifetime (warm-start friendly).
// Failures are not cached.
const discoveryCache = new Map<string, Promise<oauth.AuthorizationServer>>();

function authorizationServer(issuer: string, fetchImpl?: typeof globalThis.fetch): Promise<oauth.AuthorizationServer> {
  let cached = discoveryCache.get(issuer);
  if (!cached) {
    const issuerUrl = new URL(issuer);
    const options = fetchImpl ? { [oauth.customFetch]: fetchImpl } : undefined;
    cached = oauth
      .discoveryRequest(issuerUrl, options)
      .then((response) => oauth.processDiscoveryResponse(issuerUrl, response));
    cached.catch(() => discoveryCache.delete(issuer));
    discoveryCache.set(issuer, cached);
  }
  return cached;
}

export function oidcHandler(options: OidcHandlerOptions = {}): OidcHandler {
  return {
    async initiate(authDomain, opts = {}): Promise<OidcAuthorization> {
      const params = paramsOf(authDomain);
      const as = await authorizationServer(params.issuer, options.fetch);
      if (!as.authorization_endpoint) {
        throw new InvalidInputError(`OIDC issuer ${params.issuer} exposes no authorization_endpoint`);
      }

      const codeVerifier = oauth.generateRandomCodeVerifier();
      const codeChallenge = await oauth.calculatePKCECodeChallenge(codeVerifier);
      const state = oauth.generateRandomState();
      const nonce = oauth.generateRandomNonce();

      const url = new URL(as.authorization_endpoint);
      url.searchParams.set('client_id', params.clientId);
      url.searchParams.set('redirect_uri', params.redirectUri);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('scope', params.scope ?? 'openid email profile');
      url.searchParams.set('code_challenge', codeChallenge);
      url.searchParams.set('code_challenge_method', 'S256');
      url.searchParams.set('state', state);
      url.searchParams.set('nonce', nonce);
      if (opts.loginHint) {
        url.searchParams.set('login_hint', opts.loginHint);
      }

      return { redirectUrl: url.toString(), loginState: { state, nonce, codeVerifier } };
    },

    async complete({ db, authDomain, callbackUrl, loginState }): Promise<ResolvedUser> {
      const params = paramsOf(authDomain);
      const as = await authorizationServer(params.issuer, options.fetch);
      const client: oauth.Client = { client_id: params.clientId };
      const clientAuth = await clientAuthFor(db, authDomain, params, as, options);
      const currentUrl = typeof callbackUrl === 'string' ? new URL(callbackUrl) : callbackUrl;
      const fetchOption = options.fetch ? { [oauth.customFetch]: options.fetch } : undefined;

      let claims: ValidatedClaims;
      try {
        const callbackParams = oauth.validateAuthResponse(as, client, currentUrl, loginState.state);
        const response = await oauth.authorizationCodeGrantRequest(
          as,
          client,
          clientAuth,
          callbackParams,
          params.redirectUri,
          loginState.codeVerifier,
          fetchOption,
        );
        const tokenResponse = await oauth.processAuthorizationCodeResponse(as, client, response, {
          expectedNonce: loginState.nonce,
          requireIdToken: true,
        });
        const validated = oauth.getValidatedIdTokenClaims(tokenResponse);
        if (!validated) {
          throw new VerificationFailedError('OIDC token response carried no id_token');
        }
        claims = validated;
      } catch (err) {
        if (err instanceof VerificationFailedError) throw err;
        throw new VerificationFailedError('OIDC authorization failed');
      }

      // Entra often carries the address in preferred_username rather than email.
      const email =
        typeof claims.email === 'string'
          ? claims.email
          : typeof claims.preferred_username === 'string'
            ? claims.preferred_username
            : undefined;
      if (!email) {
        throw new VerificationFailedError('OIDC id_token has no email or preferred_username');
      }

      // An IdP is trusted only for the email domains its tenant has verified —
      // checked before any lookup or provisioning, so a tenant admin's IdP can't
      // sign in (or create) a user at someone else's domain.
      const domain = emailDomainOf(email);
      if (!domain) {
        throw new VerificationFailedError('OIDC email claim is not an email address');
      }
      if (!(await tenantHasVerifiedDomain(db, authDomain.tenantId, domain))) {
        throw new EmailDomainNotVerifiedError(authDomain.tenantId, domain);
      }

      const existing = await findUserByCommunicationMethod(db, { channel: 'email', code: email });
      if (existing) {
        return existing;
      }
      if (options.provisionUser) {
        return options.provisionUser({ db, authDomain, claims });
      }
      throw new VerificationFailedError('No user for verified identity and provisioning is disabled');
    },
  };
}
