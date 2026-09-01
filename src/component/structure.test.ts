/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';

// Hardening convention: every test file stubs the declared component env vars
// before each test. These are static source-text checks that run no functions,
// so the stub is inert here, but the convention is kept uniform across files.
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', 'test-signing-secret');
});

// Every component source file, as raw text — a grep, run as a test.
const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

/**
 * PRODUCTION source modules only. Excluded from every scan below: generated
 * code; test files (`*.test.ts`), which inspect table state directly via
 * `t.run` by design; and `testHelpers.shared.ts`, the shared test-scaffolding
 * module that does the same (its double-dot name also keeps Convex's bundler
 * from analyzing it — see the note in that file). None is a production access
 * path.
 */
function productionSources(): Array<[string, string]> {
  return Object.entries(sources).filter(
    ([path]) =>
      !path.includes('/_generated/') &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('testHelpers.shared.ts')
  );
}

/** The production modules whose text matches `pattern`, sorted. */
function modulesMatching(pattern: RegExp): string[] {
  return productionSources()
    .filter(([, source]) => pattern.test(source))
    .map(([path]) => path)
    .sort();
}

// A db-level access of the memories table, in every form the Convex API
// offers: query, the explicit-table-name id operations (get included — the
// governed path always uses the table-scoped `db.get('memories', id)`
// overload precisely so this grep sees it), and vector search (P3:
// `ctx.vectorSearch('memories', …)` is a READ of the table and is pinned to
// access.ts like every other access).
const MEMORY_TABLE_ACCESS =
  /\.(?:query|get|insert|patch|replace|delete|vectorSearch)\(\s*['"]memories['"]/;

/**
 * THE GOVERNED-ACCESS-PATH CONTRACT (see access.ts): the `memories` table is
 * queried in exactly ONE production module.
 */
test("the 'memories' table is accessed by exactly one module: access.ts", () => {
  expect(modulesMatching(MEMORY_TABLE_ACCESS)).toEqual(['./access.ts']);
});

test("the 'audit' table is written by exactly one module: lib/audit.ts", () => {
  const AUDIT_TABLE_ACCESS = /\.(?:query|insert)\(\s*['"]audit['"]/;
  expect(modulesMatching(AUDIT_TABLE_ACCESS)).toEqual(['./lib/audit.ts']);
});

/** P4: the grant store is pinned exactly like the memories path. */
test("the 'accessGrants' table is accessed by exactly one module: lib/grantStore.ts", () => {
  const GRANTS_TABLE_ACCESS =
    /\.(?:query|get|insert|patch|replace|delete)\(\s*['"]accessGrants['"]/;
  expect(modulesMatching(GRANTS_TABLE_ACCESS)).toEqual(['./lib/grantStore.ts']);
});

/** P4: the redaction-policy store is pinned exactly like the memories path. */
test("the 'redactionPolicies' table is accessed by exactly one module: lib/redaction.ts", () => {
  const POLICIES_TABLE_ACCESS =
    /\.(?:query|get|insert|patch|replace|delete)\(\s*['"]redactionPolicies['"]/;
  expect(modulesMatching(POLICIES_TABLE_ACCESS)).toEqual([
    './lib/redaction.ts'
  ]);
});

/** P5: the revocation store is pinned exactly like the memories path. */
test("the 'revocations' table is accessed by exactly one module: lib/revocationStore.ts", () => {
  const REVOCATIONS_TABLE_ACCESS =
    /\.(?:query|get|insert|patch|replace|delete)\(\s*['"]revocations['"]/;
  expect(modulesMatching(REVOCATIONS_TABLE_ACCESS)).toEqual([
    './lib/revocationStore.ts'
  ]);
});

/**
 * P4 NON-BYPASSABLE EGRESS — the structural half of a two-layer guarantee.
 * The compile-time half: `EgressedMemoryRecord` is branded with a
 * module-private unique symbol, so the `as EgressedMemoryRecord` assertion
 * inside `egressMemory` is the ONLY expression that can produce the type,
 * and every doc-returning handler is annotated to return Egressed* types —
 * returning a raw doc is a type error. These greps pin both halves so
 * neither the mint nor the annotations can be quietly deleted.
 */
test('the egress brand is minted in exactly one module: lib/redaction.ts', () => {
  const BRAND_MINT = /as\s+EgressedMemoryRecord/;
  expect(modulesMatching(BRAND_MINT)).toEqual(['./lib/redaction.ts']);
});

test('every doc-returning read path declares the egressed return type', () => {
  const memorySource = sources['./memory.ts'];
  expect(memorySource).toMatch(/Promise<EgressedGetResult>/);
  expect(memorySource).toMatch(/Promise<EgressedListResult>/);
  expect(memorySource).toMatch(/Promise<EgressedRecallMatches>/);
});
