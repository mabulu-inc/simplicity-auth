import type { Pool, PoolClient } from 'pg';

/**
 * A `pg.Pool` or any single checked-out `pg.PoolClient`. Functions that
 * accept this type can be called with either — they perform a single query
 * and don't need to span multiple statements on the same connection.
 */
export type Queryable = Pool | PoolClient;

/**
 * A freshly created session, returned from `createSession`.
 *
 * `token` is the **raw opaque bearer credential** — it is returned to the
 * client exactly once and is never stored server-side. Only its hash is
 * persisted (as the `sessions` primary key). Treat `token` like a password:
 * hand it to the client and forget it.
 */
export interface Session {
  /** Raw opaque bearer token. Returned once; only its hash is stored. */
  readonly token: string;
  /** The user this session was created for. */
  readonly userId: number;
  /** When the session row was created. */
  readonly createdAt: Date;
  /** When the session expires. After this instant, the session is invalid. */
  readonly expiresAt: Date;
}

/**
 * A validated session, returned from `validateSession`. Carries no raw
 * token — the token is never recoverable from a stored session.
 */
export interface SessionInfo {
  /** The user this session belongs to. */
  readonly userId: number;
  /** When the session row was created (sign-in time). */
  readonly createdAt: Date;
  /** When the session expires. */
  readonly expiresAt: Date;
  /** Last recorded activity (`touchSession`), or null if never touched. */
  readonly lastSeenAt: Date | null;
}

/**
 * The resolved identity for a request. Passed to the callback inside
 * `withSession` and to the app-supplied scope hook.
 *
 * Note this carries **no tenant/scope data** — intra-tenant scope is
 * app-owned (see the scope hook). The library resolves identity only:
 * the user, the active role, the roles the user holds, and the privileges.
 *
 * @typeParam TRole - String literal union of role names valid in your
 *   application. Defaults to `string`. Narrow this in a thin wrapper —
 *   see the README for the recommended pattern.
 */
export interface SessionContext<TRole extends string = string> {
  /** The user this session belongs to. */
  readonly userId: number;
  /** The active mode/persona role for this request (becomes
   *  `app.active_role`), or null when the user holds only privileges and
   *  requested no role. */
  readonly activeRole: TRole | null;
  /** All selectable (non-privilege) roles the user holds. */
  readonly roles: readonly TRole[];
  /** All privileges (always-on capability flags) the user holds.
   *  Exported as `app.privileges`. */
  readonly privileges: readonly string[];
}

/**
 * The identity handed to an app's scope hook. Same shape as
 * {@link SessionContext}.
 */
export type SessionIdentity<TRole extends string = string> = SessionContext<TRole>;

/**
 * An app-supplied hook that sets whatever scope GUCs the app's RLS needs
 * (or is a no-op when scope is enforced function-carried). Called by
 * `withSession` after the identity GUCs are set, inside the request
 * transaction. The library ships no scope model of its own — see the
 * `@smplcty/auth/flat-tenant` preset for the common tenant case.
 */
export type ScopeHook<TRole extends string = string> = (
  client: PoolClient,
  identity: SessionIdentity<TRole>,
) => Promise<void>;

/**
 * Geolocation metadata captured at session creation time. All fields
 * optional — only what your app supplies will be stored.
 */
export interface GeoLocation {
  city?: string;
  region?: string;
  country?: string;
  latitude?: string;
  longitude?: string;
}

/**
 * Input to `createSession`.
 */
export interface CreateSessionInput {
  /** The communication method (email row, phone row, etc.) the user
   *  authenticated with. Get this from `findUserByCommunicationMethod`. */
  userCommunicationMethodId: number;
  /** Postgres interval string — e.g. `'30 days'`, `'12 hours'`, `'1 week'`.
   *  Evaluated server-side via `now() + interval $ttl`. There is no
   *  default; sessions never live forever. */
  ttl: string;
  /** IP address of the requester. Optional. */
  ip?: string;
  /** Geolocation derived from the requester's IP. Optional. */
  geo?: GeoLocation;
}

/**
 * Result of `findUserByCommunicationMethod`.
 */
export interface UserByCommunicationMethod {
  readonly userId: number;
  readonly userCommunicationMethodId: number;
}

/**
 * Query for `findUserByCommunicationMethod`.
 */
export interface FindUserQuery {
  /** The name of the communication channel — typically `'email'` or
   *  `'phone'`. Matched against `communication_channels.name`. */
  channel: string;
  /** The address or number — matched against `user_communication_methods.code`. */
  code: string;
}

/**
 * A pluggable structured logger. The argument order matches `pino`'s
 * idiomatic shape so a pino logger can be passed directly without
 * adaptation.
 *
 * The library never logs PII or raw tokens. It only emits structural
 * events with safe identifiers (userId, role, hash prefixes).
 */
export interface Logger {
  debug(data: Record<string, unknown>, msg: string): void;
  info(data: Record<string, unknown>, msg: string): void;
  warn(data: Record<string, unknown>, msg: string): void;
  error(data: Record<string, unknown>, msg: string): void;
}

/**
 * Options accepted by `withSession`.
 */
export interface WithSessionOptions<TRole extends string = string> {
  /** App-supplied scope hook — sets intra-tenant scope GUCs (or no-op).
   *  The library sets no scope GUC itself. */
  scope?: ScopeHook<TRole>;
  /** Optional logger. Defaults to a no-op. */
  logger?: Logger;
}

/**
 * Authentication parameters passed to `withSession`.
 *
 * @typeParam TRole - String literal union of role names valid in your
 *   application. Defaults to `string`.
 */
export interface SessionAuth<TRole extends string = string> {
  /** The raw opaque bearer token from the client (e.g. a cookie/header). */
  token: string;
  /** The mode/persona role to activate for this request. Omit to use the
   *  user's default role (or none, if the user holds only privileges). */
  roleName?: TRole;
}
