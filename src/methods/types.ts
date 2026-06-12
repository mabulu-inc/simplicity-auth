import type { Queryable } from '../types.js';

/**
 * An `auth_domains` row — one of a tenant's org-bound sign-in IdPs. A tenant
 * has 0..N of these; the router lists them for a tenant and dispatches by
 * `integrationType`. Rows are configured at runtime and resolved by
 * `authDomainId` (there is no stable text key); `displayName` is the button
 * label when a tenant has more than one.
 *
 * @typeParam TParams - Shape of `integration_params`. Defaults to an open
 *   record; narrow it in a handler.
 */
export interface AuthDomain<TParams = Record<string, unknown>> {
  readonly authDomainId: number;
  readonly tenantId: number;
  /** Button label when the tenant has several IdPs (e.g. "Microsoft"). */
  readonly displayName: string;
  /** Selects the handler — e.g. 'oidc'. */
  readonly integrationType: string;
  /** Provider config + provisioning policy. Handler-specific. */
  readonly integrationParams: TParams;
}

/**
 * A user verified by a method handler, ready for `createSession`.
 */
export interface ResolvedUser {
  readonly userId: number;
  readonly userCommunicationMethodId: number;
}

/**
 * Result of a handler's `initiate` phase: either an OTP was sent
 * (user-bound methods) or the caller should redirect (org-bound methods).
 */
export type MethodInitiateResult = { readonly otpSent: true } | { readonly redirectUrl: string };

/**
 * Context handed to a handler's `initiate`.
 */
export interface MethodInitiateContext {
  /** A connection or pool the handler may query (e.g. to find the user). */
  readonly db: Queryable;
  /** The matched `auth_domains` row for an org-bound method, or null for the
   *  user-bound (OTP) handler. */
  readonly authDomain: AuthDomain | null;
  /** The identifier the user entered (email/phone). Required by user-bound
   *  handlers; org-bound handlers may use it as a `login_hint`. */
  readonly identifier?: string;
}

/**
 * Context handed to a handler's `complete`. Adds the credential the user
 * submitted back: an OTP code (user-bound) or an OIDC id_token (org-bound).
 */
export interface MethodCompleteContext extends MethodInitiateContext {
  readonly credential: string;
}

/**
 * A pluggable two-phase authentication method. Models OTP (send → check)
 * and OIDC (redirect → callback) under one interface. Handlers are
 * **injected** into the router, so auth core depends on no protocol library.
 */
export interface MethodHandler {
  /** Phase 1: send an OTP, or produce a redirect URL. */
  initiate(ctx: MethodInitiateContext): Promise<MethodInitiateResult>;
  /** Phase 2: verify the submitted credential and resolve (provisioning
   *  if the handler's policy allows) the user. */
  complete(ctx: MethodCompleteContext): Promise<ResolvedUser>;
}

/**
 * Options for {@link createMethodRouter}.
 */
export interface MethodRouterOptions {
  /** Used to look up tenants and their `auth_domains`. */
  db: Queryable;
  /** Org-bound handlers keyed by `auth_domains.integration_type` (e.g. `{ oidc }`). */
  handlers: Record<string, MethodHandler>;
  /** The user-bound OTP handler (e.g. a `TwilioVerifyHandler`). Offered only
   *  when the tenant's `allow_otp` is true; omit it for an SSO-only product. */
  otpHandler?: MethodHandler;
}

/**
 * The sign-in methods available for a tenant — what the app renders on the
 * sign-in surface.
 */
export interface SignInOptions {
  readonly tenantId: number;
  /** The tenant's org-bound IdPs. Zero ⇒ OTP only; one ⇒ straight redirect;
   *  several ⇒ a chooser (button label `displayName`, value `authDomainId`). */
  readonly authDomains: readonly AuthDomain[];
  /** Whether to offer OTP: the tenant's `allow_otp` AND an `otpHandler` is set. */
  readonly otpAllowed: boolean;
}

/**
 * Tenant-centric sign-in dispatch. Discovery is by sub-domain → tenant (the
 * app parses the Host to a slug); the router lists the tenant's IdPs and
 * dispatches the chosen one by `auth_domains.integration_type`. The user-bound
 * OTP path is gated by the tenant's `allow_otp` (enforced here, not just in UI).
 */
export interface MethodRouter {
  /** The sign-in methods for the tenant owning `tenantSlug`, or null if no
   *  such (live) tenant. */
  signInOptions(input: { tenantSlug: string }): Promise<SignInOptions | null>;
  /** Org-bound phase 1 for a chosen `auth_domains` row (e.g. OIDC redirect). */
  initiate(authDomainId: number): Promise<MethodInitiateResult>;
  /** Org-bound phase 2 for a chosen `auth_domains` row (verify id_token, etc.). */
  complete(authDomainId: number, credential: string): Promise<ResolvedUser>;
  /** User-bound (OTP) phase 1. Throws {@link OtpNotAllowedError} when the
   *  tenant disallows OTP. */
  initiateOtp(input: { tenantId: number; identifier: string }): Promise<MethodInitiateResult>;
  /** User-bound (OTP) phase 2. Throws {@link OtpNotAllowedError} when the
   *  tenant disallows OTP. */
  completeOtp(input: { tenantId: number; identifier: string; credential: string }): Promise<ResolvedUser>;
}
