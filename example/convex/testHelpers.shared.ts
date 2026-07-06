/// <reference types="vite/client" />
//
// Shared test helpers for the example app. This is a plain module, NOT a
// `*.test.ts` file, so importing it runs no tests: the health-check test lives
// alone in `setup.test.ts` and is collected exactly once, rather than re-run in
// every suite that used to import the old `setup.test.ts`.
//
// FILENAME: the double-dot `.shared.ts` is deliberate. It uses `import.meta.glob`
// (a Vite-only feature), and Convex's function bundler skips any file whose
// basename has more than one dot (the same rule that excludes `*.test.ts`), so
// this module is never analyzed during codegen. vitest ignores it too (not a
// `*.test.ts`).
//
import {convexTest} from 'convex-test';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {expect} from 'vitest';
import schema from './schema.js';
import component from '@kinde-oss/kinde-convex-agent-memory/test';

const modules = import.meta.glob('./**/*.*s');

/**
 * The signing secret every suite stubs in its OWN `beforeEach` (vitest hooks
 * are file-scoped, so importing this constant does not import a hook). Keying
 * the audit digests with it exercises the HMAC path.
 */
export const TEST_SIGNING_SECRET = 'test-signing-secret';

/** Build a convex-test instance with the memory component registered. */
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  return t;
}

/**
 * Assert a client-driver call rejects with a machine-readable ConvexError
 * carrying the given `code`. convex-test may re-serialize `ConvexError.data` to
 * a JSON string across the function boundary, so both forms are handled.
 */
export async function expectClientError(
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
