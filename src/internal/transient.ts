/**
 * Failures of the database or the network that are temporary and worth
 * retrying, as opposed to bugs. Kept to an explicit list: anything not on it
 * is treated as a bug, so it stays loud.
 */

/** SQLSTATEs: connection errors (class 08), resource limits, shutdowns, timeouts, retryable conflicts. */
const TRANSIENT_SQLSTATE = /^(08...|53...|57P0[1-3]|57014|40001|40P01|55P03)$/;

/**
 * Node and undici socket and DNS failures. ENOTFOUND is included: musl
 * (Alpine) can report a resolver timeout as ENOTFOUND, and @smplcty/twilio
 * 0.2.0 already treats every failed fetch as an outage. A truly misconfigured
 * host still fails loudly, as error-level logs and 5xx answers.
 */
const TRANSIENT_NET = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENOTFOUND',
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
