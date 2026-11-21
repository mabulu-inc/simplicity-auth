/**
 * Failures of the database or the network that are temporary and worth
 * retrying, as opposed to bugs. Kept to an explicit list: anything not on it
 * is treated as a bug, so it stays loud.
 */

/** SQLSTATEs: connection errors (class 08), resource limits, shutdowns, timeouts, retryable conflicts. */
const TRANSIENT_SQLSTATE = /^(08...|53...|57P0[1-3]|57014|40001|40P01|55P03)$/;

/**
 * Node and undici socket failures, and a temporary DNS failure (EAI_AGAIN).
 * Not ENOTFOUND: "no such name" is usually permanent, a misconfigured host,
 * which should fail loudly rather than read as "try again shortly" forever.
 */
const TRANSIENT_NET = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * pg's own connection failures carry no code, only these messages
 * (pg-pool 3.14 and pg 8.23). Re-check them when pg is upgraded.
 */
const PG_CONNECTION_MESSAGES = [
  'timeout exceeded when trying to connect',
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
];

function isTransientCode(code: unknown): boolean {
  return typeof code === 'string' && (TRANSIENT_SQLSTATE.test(code) || TRANSIENT_NET.has(code));
}

/** Whether `err` (or its `cause`) is a temporary database or network failure. */
export function isTransientFailure(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown; cause?: { code?: unknown } } | null;
  if (isTransientCode(e?.code) || isTransientCode(e?.cause?.code)) return true;
  return err instanceof Error && PG_CONNECTION_MESSAGES.includes(err.message);
}
