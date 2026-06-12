import { createHash, randomBytes } from 'node:crypto';

/**
 * Generate a fresh opaque session token: 32 random bytes (256 bits of
 * entropy), base64url-encoded so it's URL/cookie-safe. This is the raw
 * bearer credential returned to the client — it is never stored.
 */
export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Derive the at-rest identifier for a token: its full SHA-256 hex digest.
 * This is what's stored as `sessions.session_id`. A database leak exposes
 * only hashes, which can't be replayed as bearer tokens.
 *
 * Distinct from `hashId` (a truncated, log-safe fingerprint): this is the
 * full-width, collision-resistant key used for lookups.
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
