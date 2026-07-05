/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {convexTest} from 'convex-test';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import schema from './schema.js';

export const modules = import.meta.glob('./**/*.*s');

/**
 * Hardening: stub ALL declared component env vars before every test. Each test
 * file carries its OWN copy of this `beforeEach` (vitest hooks are file-scoped,
 * so importing `initConvexTest` does NOT import this hook) — keep them in sync.
 * `MEMORY_SIGNING_SECRET` keys the audit digests (see `lib/digest.ts`); stubbing
 * it exercises the keyed HMAC path and keeps in-mutation digests correlating
 * with any digest helpers a test computes directly.
 */
export const TEST_SIGNING_SECRET = 'test-signing-secret';
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

export function initConvexTest() {
  return convexTest(schema, modules);
}

/**
 * Assert that a component call rejects with a machine-readable ConvexError
 * carrying the given `code`. convex-test re-serializes `ConvexError.data` to a
 * JSON string across the function boundary, so both forms are handled.
 */
export async function expectFail(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected ConvexError with code "${code}"`).toBeInstanceOf(
    ConvexError
  );
  const raw = (error as ConvexError<Value>).data;
  const data = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  expect((data as {code: string}).code).toBe(code);
}

test('the component test deployment comes up', () => {
  const t = initConvexTest();
  expect(t).toBeDefined();
});
