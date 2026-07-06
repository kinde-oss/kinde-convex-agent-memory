/// <reference types="vite/client" />
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {
  describeRecall,
  digestFilter,
  digestGrant,
  digestKey,
  digestRedaction,
  digestRevocationTarget
} from './lib/digest.js';
import {TEST_SIGNING_SECRET} from './testHelpers.shared.js';

// This suite drives the signing-secret env var directly, so each test sets the
// mode it needs. The file-scoped hook keeps the keyed default in place for any
// test that does not override it (matching the hardening convention).
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

function setSecret(value: string | undefined): void {
  vi.stubEnv('MEMORY_SIGNING_SECRET', value as unknown as string);
}

describe('audit digest (SHA-256 / HMAC-SHA256)', () => {
  test('SHA-256 shape: v-prefixed descriptor, 16 lowercase hex chars', async () => {
    setSecret(undefined);
    expect(await digestKey('some/key')).toMatch(/^v1:key:[0-9a-f]{16}$/);
    expect(await digestFilter({bySubject: 'alice'})).toMatch(
      /^v1:filter:[0-9a-f]{16}$/
    );
    expect(await digestGrant('memory.read', 'alice')).toMatch(
      /^v1:grant:memory\.read:[0-9a-f]{16}$/
    );
    expect(await digestRedaction(null, ['content'])).toMatch(
      /^v1:redaction:[0-9a-f]{16}$/
    );
    expect(await digestRevocationTarget('org', 'org_a', null)).toMatch(
      /^v1:revocation:org:[0-9a-f]{16}$/
    );
  });

  test('known SHA-256 vector: unkeyed digestKey matches the truncated hash', async () => {
    setSecret(undefined);
    // SHA-256('v1-input') is deterministic; the digest is its first 16 hex
    // chars, proving the algorithm is real SHA-256 and not the old FNV hash.
    const full = await sha256Hex('hello');
    expect(await unkeyedFingerprintOf('hello')).toBe(full.slice(0, 16));
  });

  test('UNKEYED mode correlates: same input always yields the same digest', async () => {
    setSecret(undefined);
    expect(await digestKey('notes/alice')).toBe(await digestKey('notes/alice'));
    expect(await digestFilter({keyPrefix: 'notes/', bySubject: 'a'})).toBe(
      // key order does not matter — stableStringify sorts
      await digestFilter({bySubject: 'a', keyPrefix: 'notes/'})
    );
    // Distinct inputs stay distinct.
    expect(await digestKey('a')).not.toBe(await digestKey('b'));
  });

  test('KEYED mode correlates: same input + same secret yields the same digest', async () => {
    setSecret('production-secret');
    expect(await digestKey('notes/alice')).toBe(await digestKey('notes/alice'));
    expect(await digestGrant('memory.recall', 'bob')).toBe(
      await digestGrant('memory.recall', 'bob')
    );
  });

  test('KEYED digest DIFFERS from the UNKEYED digest of the same input', async () => {
    setSecret(undefined);
    const unkeyed = await digestKey('notes/alice');
    setSecret('production-secret');
    const keyed = await digestKey('notes/alice');
    expect(keyed).not.toBe(unkeyed);
    // Both keep the descriptor shape; only the fingerprint changes.
    expect(unkeyed).toMatch(/^v1:key:[0-9a-f]{16}$/);
    expect(keyed).toMatch(/^v1:key:[0-9a-f]{16}$/);
  });

  test('the SECRET keys the HMAC: different secrets yield different digests', async () => {
    setSecret('secret-one');
    const one = await digestKey('notes/alice');
    setSecret('secret-two');
    const two = await digestKey('notes/alice');
    expect(one).not.toBe(two);
  });

  test('an EMPTY secret is treated as unkeyed', async () => {
    setSecret(undefined);
    const unkeyed = await digestKey('notes/alice');
    setSecret('');
    expect(await digestKey('notes/alice')).toBe(unkeyed);
  });

  test('describeRecall stays plain (no hashing, content never reaches it)', () => {
    expect(describeRecall(8)).toBe('v1:recall:topK=8');
    expect(describeRecall(8, 1)).toBe('v1:recall:topK=8,results=1');
  });
});

/** Full SHA-256 hex of a string, computed independently of the helper. */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(input)
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** The raw fingerprint (post-`v1:key:`) the helper produced for `input`. */
async function unkeyedFingerprintOf(input: string): Promise<string> {
  return (await digestKey(input)).replace('v1:key:', '');
}
