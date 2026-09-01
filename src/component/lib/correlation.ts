import {fail} from './errors.js';

/**
 * Resolve the correlation id for one governed operation: use the
 * caller-supplied id when present (it round-trips through the result and every
 * audit row written for the operation), otherwise mint one. A supplied EMPTY
 * string is contradictory — provided but unusable for correlation — and is
 * rejected with a typed code, never silently replaced with a minted one.
 */
export function resolveCorrelationId(supplied?: string): string {
  if (supplied === undefined) {
    return crypto.randomUUID();
  }
  if (supplied === '') {
    fail(
      'invalid_argument',
      'correlationId must be a non-empty string when supplied.'
    );
  }
  return supplied;
}
