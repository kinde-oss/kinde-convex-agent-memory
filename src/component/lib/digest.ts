/**
 * FNV-1a (32-bit), returned as 8 hex chars. NOT cryptographic — it exists only
 * to make the redacted digest stable and collision-resistant enough for audit
 * correlation. It never protects the value: the caller has already dropped the
 * raw value, so only a fingerprint of it survives.
 */
function hash8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Stable, redacted digest of a memory KEY for the audit trail. Pure and
 * deterministic (the same key always yields the same digest, so audit rows
 * correlate), but the raw key is DROPPED — only its fingerprint survives — so
 * a key that itself encodes sensitive data never appears in an audit row, and
 * memory CONTENT never comes near this function at all.
 */
export function digestKey(key: string): string {
  return `v1:key:${hash8(key)}`;
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
 * subject, a metadata value: all potentially content-bearing) are DROPPED and
 * never appear in an audit row. Deterministic: the same filter always yields
 * the same digest, so audit rows correlate.
 */
export function digestFilter(filter: unknown): string {
  return `v1:filter:${hash8(stableStringify(filter ?? {}))}`;
}

/**
 * Audit descriptor for a RECALL. The query VECTOR is the content-bearing part
 * of a recall and it never reaches this function — the descriptor records only
 * the requested `topK` and (once known) the result count, neither of which
 * carries content, so no hashing is needed. Denials audit before any search
 * runs, so their descriptor has no result count.
 */
/**
 * Audit descriptor for a GRANT / REVOKE. The scope is a closed enum (never
 * content-bearing) and rides in plain text; the target subject is an
 * identity string and is fingerprinted like keys are — only its hash
 * survives, but the same target always correlates.
 */
export function digestGrant(scope: string, targetSubject: string): string {
  return `v1:grant:${scope}:${hash8(targetSubject)}`;
}

/**
 * Audit descriptor for a SET-REDACTION. The whole targeting + fields shape
 * is fingerprinted as one object — metadata FIELD NAMES are app schema and
 * potentially sensitive, so raw names never reach an audit row, while the
 * same policy shape always correlates.
 */
export function digestRedaction(
  targetSubject: string | null,
  fields: string[]
): string {
  return `v1:redaction:${hash8(stableStringify({targetSubject, fields}))}`;
}

export function describeRecall(topK: number, resultCount?: number): string {
  return resultCount === undefined
    ? `v1:recall:topK=${topK}`
    : `v1:recall:topK=${topK},results=${resultCount}`;
}
