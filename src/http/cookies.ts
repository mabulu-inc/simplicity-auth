/**
 * Cookie serialization/parsing and the signed OIDC login-state token.
 *
 * Built on Web standards only (no Node `Buffer`, no framework) so the same
 * code runs on Node and edge runtimes: base64url via `btoa`/`atob`, HMAC via
 * Web Crypto (`globalThis.crypto.subtle`).
 */

/** Attributes for a `Set-Cookie` header value. */
export interface SerializeCookieOptions {
  domain?: string;
  path?: string;
  /** Max-Age in seconds. `0` expires the cookie immediately. */
  maxAge?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'lax' | 'strict' | 'none';
}

/** Build one `Set-Cookie` header value. The name/value are not re-encoded — session tokens and signed state are already URL-safe. */
export function serializeCookie(name: string, value: string, opts: SerializeCookieOptions = {}): string {
  const parts = [`${name}=${value}`];
  parts.push(`Path=${opts.path ?? '/'}`);
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(opts.maxAge)}`);
  if (opts.httpOnly !== false) parts.push('HttpOnly');
  if (opts.secure !== false) parts.push('Secure');
  parts.push(`SameSite=${capitalize(opts.sameSite ?? 'lax')}`);
  return parts.join('; ');
}

/** Parse a request `Cookie` header into a name→value map. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq === -1) continue;
    const name = pair.slice(0, eq).trim();
    if (!name) continue;
    out[name] = pair.slice(eq + 1).trim();
  }
  return out;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The transient OIDC login state, persisted across the IdP redirect in a
 * short-lived **signed** cookie. Carries the `auth_domains` row id (so the
 * callback knows which IdP to complete against) plus the PKCE/state/nonce
 * the library's `OidcHandler` produced, and an optional post-sign-in target.
 */
export interface LoginState {
  authDomainId: number;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo?: string;
}

interface SignedPayload extends LoginState {
  /** Issued-at, epoch seconds — checked against the max-age on verify. */
  iat: number;
}

const ENCODER = new TextEncoder();

/** UTF-8 encode into an explicitly `ArrayBuffer`-backed array (Web Crypto's `BufferSource` excludes `SharedArrayBuffer`). */
function utf8(s: string): Uint8Array<ArrayBuffer> {
  const enc = ENCODER.encode(s);
  const out = new Uint8Array(new ArrayBuffer(enc.length));
  out.set(enc);
  return out;
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return globalThis.crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
    'verify',
  ]);
}

/**
 * Sign a login state into an opaque `<payload>.<sig>` token (HMAC-SHA256 over
 * the payload). `now` is injectable for tests.
 */
export async function signLoginState(state: LoginState, secret: string, now: number = Date.now()): Promise<string> {
  const payload: SignedPayload = { ...state, iat: Math.floor(now / 1000) };
  const body = b64urlEncode(utf8(JSON.stringify(payload)));
  const key = await hmacKey(secret);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, utf8(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

/**
 * Verify and decode a login-state token. Returns the `LoginState` if the
 * signature is valid (constant-time, via `subtle.verify`) and it was issued
 * within `maxAgeSeconds`; otherwise `null`. Never throws on malformed input.
 */
export async function verifyLoginState(
  token: string | undefined | null,
  secret: string,
  maxAgeSeconds: number,
  now: number = Date.now(),
): Promise<LoginState | null> {
  if (!token) return null;
  const dot = token.indexOf('.');
  if (dot === -1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  let valid: boolean;
  try {
    const key = await hmacKey(secret);
    valid = await globalThis.crypto.subtle.verify('HMAC', key, b64urlDecode(sig), utf8(body));
  } catch {
    return null;
  }
  if (!valid) return null;

  let payload: SignedPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(b64urlDecode(body))) as SignedPayload;
  } catch {
    return null;
  }
  if (typeof payload.iat !== 'number' || Math.floor(now / 1000) - payload.iat > maxAgeSeconds) {
    return null;
  }
  const { authDomainId, state, nonce, codeVerifier, returnTo } = payload;
  if (typeof authDomainId !== 'number' || !state || !nonce || !codeVerifier) return null;
  return { authDomainId, state, nonce, codeVerifier, ...(returnTo ? { returnTo } : {}) };
}
