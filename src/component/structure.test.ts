/// <reference types="vite/client" />
import {expect, test} from 'vitest';

// Every component source file, as raw text — a grep, run as a test.
const sources = import.meta.glob('./**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

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
 * queried in exactly ONE production module. Excluded from the scan: generated
 * code, and test files — tests inspect table state directly via `t.run` by
 * design, which is test scaffolding, not an access path.
 */
test("the 'memories' table is accessed by exactly one module: access.ts", () => {
  const accessors = Object.entries(sources)
    .filter(([path]) => !path.includes('/_generated/'))
    .filter(([path]) => !path.endsWith('.test.ts'))
    .filter(([, source]) => MEMORY_TABLE_ACCESS.test(source))
    .map(([path]) => path)
    .sort();
  expect(accessors).toEqual(['./access.ts']);
});

test("the 'audit' table is written by exactly one module: lib/audit.ts", () => {
  const AUDIT_TABLE_ACCESS = /\.(?:query|insert)\(\s*['"]audit['"]/;
  const accessors = Object.entries(sources)
    .filter(([path]) => !path.includes('/_generated/'))
    .filter(([path]) => !path.endsWith('.test.ts'))
    .filter(([, source]) => AUDIT_TABLE_ACCESS.test(source))
    .map(([path]) => path)
    .sort();
  expect(accessors).toEqual(['./lib/audit.ts']);
});

/** P4: the grant store is pinned exactly like the memories path. */
test("the 'accessGrants' table is accessed by exactly one module: lib/grantStore.ts", () => {
  const GRANTS_TABLE_ACCESS =
    /\.(?:query|get|insert|patch|replace|delete)\(\s*['"]accessGrants['"]/;
  const accessors = Object.entries(sources)
    .filter(([path]) => !path.includes('/_generated/'))
    .filter(([path]) => !path.endsWith('.test.ts'))
    .filter(([, source]) => GRANTS_TABLE_ACCESS.test(source))
    .map(([path]) => path)
    .sort();
  expect(accessors).toEqual(['./lib/grantStore.ts']);
});

/** P4: the redaction-policy store is pinned exactly like the memories path. */
test("the 'redactionPolicies' table is accessed by exactly one module: lib/redaction.ts", () => {
  const POLICIES_TABLE_ACCESS =
    /\.(?:query|get|insert|patch|replace|delete)\(\s*['"]redactionPolicies['"]/;
  const accessors = Object.entries(sources)
    .filter(([path]) => !path.includes('/_generated/'))
    .filter(([path]) => !path.endsWith('.test.ts'))
    .filter(([, source]) => POLICIES_TABLE_ACCESS.test(source))
    .map(([path]) => path)
    .sort();
  expect(accessors).toEqual(['./lib/redaction.ts']);
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
  const minters = Object.entries(sources)
    .filter(([path]) => !path.includes('/_generated/'))
    .filter(([path]) => !path.endsWith('.test.ts'))
    .filter(([, source]) => BRAND_MINT.test(source))
    .map(([path]) => path)
    .sort();
  expect(minters).toEqual(['./lib/redaction.ts']);
});

test('every doc-returning read path declares the egressed return type', () => {
  const memorySource = sources['./memory.ts'];
  expect(memorySource).toMatch(/Promise<EgressedGetResult>/);
  expect(memorySource).toMatch(/Promise<EgressedListResult>/);
  expect(memorySource).toMatch(/Promise<EgressedRecallMatches>/);
});
