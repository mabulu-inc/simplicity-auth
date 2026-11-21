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

/** How far down a `cause` chain to look: SDKs wrap fetch, which wraps the socket error. */
const MAX_CAUSE_DEPTH = 3;

/**
 * Whether `err`, or an error up to {@link MAX_CAUSE_DEPTH} causes below it, is a
 * temporary database or network failure: a code on the list above, a pg
 * connection message, or a `TimeoutError` by name (`AbortSignal.timeout()`,
 * the AWS SDK), which carries no errno.
 *
 * Best effort for errors the library didn't create: an app that knows its
 * provider is down should throw `DeliveryUnavailableError` itself.
 */
export function isTransientFailure(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth <= MAX_CAUSE_DEPTH && current != null; depth++) {
    const e = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown };
    if (isTransientCode(e.code) || e.name === 'TimeoutError') return true;
    if (current instanceof Error && PG_CONNECTION_MESSAGES.includes(current.message)) return true;
    current = e.cause;
  }
  return false;
}
