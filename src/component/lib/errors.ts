import {ConvexError} from 'convex/values';

/**
 * Throw a machine-readable error. `code` is a stable identifier callers can
 * branch on via `ConvexError.data.code`; `message` is for humans. Every failure
 * path in this component funnels through here so errors stay typed end to end
 * (no raw `Error`, no leaking a stack across the function boundary).
 *
 * NOTE: a governed DENIAL (e.g. `tenant_context_conflict`) is NOT thrown from
 * inside a component mutation — a throw would roll back the denial's audit
 * row. Denials are returned as a typed `DeniedResult` and converted to a
 * thrown ConvexError by the client class. `fail` is for malformed calls that
 * never reach the governed path (nothing to audit, nothing to roll back) —
 * and for hard INVARIANT VIOLATIONS (`isolation_invariant_violation`), where
 * aborting the whole transaction is exactly the point.
 */
export function fail(code: string, message: string): never {
  throw new ConvexError({code, message});
}

/** Reject blank identity fields — malformed calls never reach the spine. */
export function requireNonEmpty(value: string, name: string): void {
  if (value === '') {
    fail('invalid_argument', `${name} must be a non-empty string.`);
  }
}
