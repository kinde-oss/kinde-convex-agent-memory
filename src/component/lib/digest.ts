/**
 * THE AUDIT DIGEST HELPER. Every value that could be content-bearing — memory
 * keys, subject ids, filter values, metadata field names — is fingerprinted
 * HERE before it can reach an audit row, so raw values never appear in the
 * trail while equal inputs still correlate across rows.
 *
 * ALGORITHM (hardening upgrade): SHA-256 via the Web Crypto API
 * (`crypto.subtle`), truncated to the first {@link DIGEST_HEX_LENGTH} hex
 * chars. This replaces the former FNV-1a 32-bit hash, which was neither
 * collision-resistant nor preimage-resistant: low-entropy inputs (short keys,
 * subject ids) were brute-forceable from an audit row by anyone who could read
 * it. `crypto.subtle.digest('SHA-256', …)` is available in both the Convex
 * default runtime (where these digests are computed, inside mutations) and the
 * vitest edge-runtime used by the test suite — verified before shipping; there
 * is deliberately NO silent fallback.
 *
 * KEYED MODE: when the signing secret {@link SIGNING_SECRET_ENV_VAR} is set,
 * the fingerprint is an HMAC-SHA256 keyed by it instead of a plain digest.
 * HONEST TRADEOFF: an UNKEYED digest of a low-entropy value is still
 * ENUMERABLE — an attacker who can read audit rows can hash a dictionary of
 * candidate keys/subjects and match them by digest. Only the secret defeats
 * that (the attacker cannot compute the HMAC without it). Configure
 * `MEMORY_SIGNING_SECRET` for keyed digests in production; unkeyed is the
 * documented, weaker default for standalone/dev use.
 *
 * Digests stay DETERMINISTIC for correlation: the same input (and, in keyed
 * mode, the same secret) always yields the same digest, so audit rows still
 * join. A keyed digest necessarily differs from the unkeyed digest of the same
 * input — switching the secret on or off re-partitions correlation, by design.
 */

/**
 * Name of the environment variable holding the HMAC signing secret. Declared
 * on the component in `convex.config.ts` (as `env.MEMORY_SIGNING_SECRET`,
 * optional) and read here via `process.env` — the Convex-generated `env`
 * export is itself just `process.env`, so the two are equivalent, and reading
 * `process.env` keeps this pure lib file decoupled from generated code and
 * works identically under the vitest edge-runtime. Set out-of-band with
 * `npx convex env set MEMORY_SIGNING_SECRET …`, never hardcoded.
 */
export const SIGNING_SECRET_ENV_VAR = 'MEMORY_SIGNING_SECRET';

/**
 * Hex length the SHA-256/HMAC output is truncated to. 16 hex chars = 64 bits:
 * ample against accidental audit-row collisions while keeping digests compact.
 * Truncation does not weaken preimage resistance below the point that matters
 * here — the secret, not the digest length, is what stops enumeration.
 */
const DIGEST_HEX_LENGTH = 16;

const textEncoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  let hex = '';
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return hex;
}

/**
 * The one fingerprint primitive: HMAC-SHA256 keyed by the signing secret when
 * present, plain SHA-256 otherwise, truncated to {@link DIGEST_HEX_LENGTH}.
 * Async because `crypto.subtle` is async. The raw input is NEVER returned —
 * only its fingerprint — and it never leaves this function.
 */
async function fingerprint(input: string): Promise<string> {
  const data = textEncoder.encode(input);
  const secret = process.env[SIGNING_SECRET_ENV_VAR];
  let buffer: ArrayBuffer;
  if (secret !== undefined && secret !== '') {
    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['sign']
    );
    buffer = await crypto.subtle.sign('HMAC', key, data);
  } else {
    buffer = await crypto.subtle.digest('SHA-256', data);
  }
  return toHex(buffer).slice(0, DIGEST_HEX_LENGTH);
}

/**
 * Stable, redacted digest of a memory KEY for the audit trail. Deterministic
 * (the same key always yields the same digest, so audit rows correlate), but
 * the raw key is FINGERPRINTED and never appears raw in an audit row — so a
 * key that itself encodes sensitive data stays out of the trail, and memory
 * CONTENT never comes near this function at all.
 */
export async function digestKey(key: string): Promise<string> {
  return `v1:key:${await fingerprint(key)}`;
}

/**
 * Deterministic serialization: object keys sorted at every depth, `undefined`
 * members dropped, so semantically equal filters always serialize — and hash —
 * identically.
 */
function stableStringify(value: unknown): string {
  if (value === undefined) {
    return 'undefined';
  }
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, member]) => member !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, member]) => `${JSON.stringify(k)}:${stableStringify(member)}`);
  return `{${entries.join(',')}}`;
}

/**
 * Stable, redacted digest of a WHOLE list filter for the audit trail. The
 * filter is fingerprinted as one object — its raw values (a key prefix, a
 * subject, a metadata value: all potentially content-bearing) are
 * fingerprinted, never appear raw in an audit row. Deterministic: the same
 * filter always yields the same digest, so audit rows correlate.
 */
export async function digestFilter(filter: unknown): Promise<string> {
  return `v1:filter:${await fingerprint(stableStringify(filter ?? {}))}`;
}

/**
 * Audit descriptor for a GRANT / REVOKE. The scope is a closed enum (never
 * content-bearing) and rides in plain text; the target subject is an
 * identity string and is fingerprinted like keys are — the raw subject is
 * fingerprinted, never appears raw, but the same target always correlates.
 */
export async function digestGrant(
  scope: string,
  targetSubject: string
): Promise<string> {
  return `v1:grant:${scope}:${await fingerprint(targetSubject)}`;
}

/**
 * Audit descriptor for a SET-REDACTION. The whole targeting + fields shape
 * is fingerprinted as one object — metadata FIELD NAMES are app schema and
 * potentially sensitive, so raw names are fingerprinted, never appear raw in
 * an audit row, while the same policy shape always correlates.
 */
export async function digestRedaction(
  targetSubject: string | null,
  fields: string[]
): Promise<string> {
  return `v1:redaction:${await fingerprint(stableStringify({targetSubject, fields}))}`;
}

/**
 * Audit descriptor for a REVOKE / LIFT. The kind is a closed enum and rides
 * plain; the org/subject identities are fingerprinted, never appear raw. The
 * stored REASON is deliberately not an input here — it never reaches an audit
 * row in any form; auditors join to the revocation row through the store.
 */
export async function digestRevocationTarget(
  kind: string,
  orgCode: string | null,
  subject: string | null
): Promise<string> {
  return `v1:revocation:${kind}:${await fingerprint(stableStringify({orgCode, subject}))}`;
}

/**
 * Audit descriptor for a RECALL. The query VECTOR is the content-bearing part
 * of a recall and it never reaches this function — the descriptor records only
 * the requested `topK` and (once known) the result count, neither of which
 * carries content, so no hashing is needed (this stays synchronous). Denials
 * audit before any search runs, so their descriptor has no result count.
 */
export function describeRecall(topK: number, resultCount?: number): string {
  return resultCount === undefined
    ? `v1:recall:topK=${topK}`
    : `v1:recall:topK=${topK},results=${resultCount}`;
}
