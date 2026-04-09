import { createHash } from 'node:crypto';

/**
 * Truncated, non-reversible identifier suitable for log correlation.
 * Never log a raw session ID — log `hashId(sessionId)` instead. Twelve hex
 * chars is enough to disambiguate within a single log stream while
 * remaining a one-way hash.
 */
export function hashId(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}
