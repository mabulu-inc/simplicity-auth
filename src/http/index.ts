/**
 * `@smplcty/auth/http` — the framework-agnostic transport tier.
 *
 * Wires the library's primitives (the method router, the OIDC handler, the
 * session lifecycle) into Web-standard `(Request) => Promise<Response>`
 * handlers, plus cookie / signed-login-state helpers and a per-request session
 * resolver. Built on Web standards only — mount the handlers directly in Hono
 * (`app.all('/auth/*', (c) => handlers.handle(c.req.raw))`) or as Next.js App
 * Router route handlers (`export const GET = handlers.signInOptions`).
 */

export { createAuthHandlers, getSessionToken, withRequestSession } from './handlers.js';
export {
  serializeCookie,
  parseCookies,
  signLoginState,
  verifyLoginState,
  type SerializeCookieOptions,
  type LoginState,
} from './cookies.js';
export type { AuthHttpConfig, AuthCookieConfig, AuthHandlers, RequestSessionMeta } from './types.js';
