import type { Logger } from '../types.js';

/**
 * A logger that discards every message. Used as the default when the
 * caller does not provide a logger.
 */
export const noopLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};
