/// <reference types="vite/client" />
//
// Shared test helpers for the component suites. This is a plain module, NOT a
// `*.test.ts` file, so importing it runs no tests: the smoke test lives alone
// in `setup.test.ts` and is collected exactly once, rather than re-run in every
// suite that used to import the old `setup.test.ts`.
//
// FILENAME: the double-dot `.shared.ts` is deliberate. Convex's function
// bundler skips any file whose basename has more than one dot (the same rule
// that excludes `*.test.ts`), so this module — which uses `import.meta.glob`, a
// Vite-only feature the bundler cannot evaluate — is not analyzed during
// codegen. vitest still ignores it too (it is not a `*.test.ts`).
//
// STRUCTURAL NOTE: `auditRows` reads the `audit` table via `t.run`, exactly as
// the test files do. This is test scaffolding, not a production access path, so
// `structure.test.ts` excludes this module from its table-access grep alongside
// the `*.test.ts` files.
//
import {convexTest} from 'convex-test';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {expect} from 'vitest';
import schema from './schema.js';
import {EMBEDDING_DIMENSIONS} from './lib/embedding.js';

const modules = import.meta.glob('./**/*.*s');

/**
 * The signing secret every suite stubs in its OWN `beforeEach` (vitest hooks
 * are file-scoped, so importing this constant does not import a hook). Keying
 * the audit digests with it exercises the HMAC path.
 */
export const TEST_SIGNING_SECRET = 'test-signing-secret';

export function initConvexTest() {
  return convexTest(schema, modules);
}

export type ConvexTest = ReturnType<typeof initConvexTest>;

/**
 * Assert that a component call rejects with a machine-readable ConvexError
 * carrying the given `code`. convex-test may re-serialize `ConvexError.data` to
 * a JSON string across the function boundary, so both forms are handled.
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

/** All audit rows, read directly for assertions (test scaffolding). */
export async function auditRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('audit').collect());
}

/** A unit embedding along the e0 axis, for deterministic recall tests. */
export function unitEmbedding(): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  return vector;
}
