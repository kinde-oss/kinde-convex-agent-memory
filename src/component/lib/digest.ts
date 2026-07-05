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
