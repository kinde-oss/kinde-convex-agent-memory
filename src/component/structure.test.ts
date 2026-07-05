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
