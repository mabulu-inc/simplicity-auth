import type { Pool, PoolClient } from 'pg';

/**
 * A `pg.Pool` or any single checked-out `pg.PoolClient`. Functions that
 * accept this type can be called with either — they perform a single query
 * and don't need to span multiple statements on the same connection.
 */
export type Queryable = Pool | PoolClient;

/**
 * A persisted session row, returned from `createSession` and
 * `validateSession`.
 */
export interface Session {
  /** Server-generated session token. Treat as a bearer credential. */
  readonly sessionId: string;
  /** The user this session was created for. */
  readonly userId: number;
  /** When the session row was created. */
  readonly createdAt: Date;
  /** When the session expires. After this instant, the session is invalid. */
  readonly expiresAt: Date;
}

/**
 * The fully resolved authentication context for a request. Passed to the
 * callback inside `withSession`.
 *
 * @typeParam TRole - String literal union of role names valid in your
 *   application. Defaults to `string`. Narrow this in a thin wrapper —
 *   see the README for the recommended pattern.
 */
export interface SessionContext<TRole extends string = string> {
  /** The user this session belongs to. */
  readonly userId: number;
  /** Tenant IDs the user has access to. Empty if `allTenants` is true and
   *  the user has no tenant-scoped roles. */
  readonly tenantIds: readonly number[];
  /** True if the user has at least one role that is not tenant-scoped
   *  (i.e. a `user_roles` row with `tenant_id IS NULL`). When true, RLS
   *  policies typically bypass tenant filtering. */
  readonly allTenants: boolean;
  /** All roles assigned to the user (across all tenants). */
  readonly roles: readonly TRole[];
}

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
 * The library never logs PII or session IDs. It only emits structural
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
export interface WithSessionOptions {
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
  sessionId: string;
  roleName: TRole;
}
