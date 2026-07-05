/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {api} from './_generated/api.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './setup.test.js';
import {EMBEDDING_DIMENSIONS} from '@kinde-oss/kinde-convex-agent-memory';

type ConvexTest = ReturnType<typeof initConvexTest>;

// Hardening: stub the declared signing secret before every test.
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const ADMIN = 'user_admin';

/** A sparse test vector: cosine similarity to the e0 QUERY is exactly controlled. */
function vec(entries: Record<number, number>): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const [index, value] of Object.entries(entries)) {
    vector[Number(index)] = value;
  }
  return vector;
}

const QUERY = vec({0: 1}); // the query direction, e0
const A_CLOSE = vec({0: 1, 1: 1}); // cos(·, e0) ≈ 0.707
const A_FAR = vec({0: 1, 1: 3}); // cos(·, e0) ≈ 0.316
const B_EXACT = vec({0: 1}); // cos = 1.0 — strictly a better match than any A row

async function expectClientError(
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

async function orgAudit(t: ConvexTest, orgCode: string, subject: string) {
  const result = await t.query(api.example.auditLog, {
    orgCode,
    subject,
    numItems: 100,
    cursor: null
  });
  return result.rows;
}

test('isolation through the adapter mirrors the raw API: a foreign better-match never crosses', async () => {
  const t = initConvexTest();
  // A stores a middling match; B stores a STRICTLY better match to A's query.
  await t.action(api.example.mastraUpsert, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    vector: A_CLOSE
  });
  await t.action(api.example.mastraUpsert, {
    subject: BOB,
    orgCode: ORG_B,
    id: 'b1',
    vector: B_EXACT
  });

  // A's adapter query returns ONLY A's row — B_EXACT is a better match but is
  // outside A's tenant partition, so the adapter never surfaces it.
  const aResults = await t.action(api.example.mastraQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    topK: 8
  });
  expect(aResults.map((r) => r.id)).toEqual(['a1']);

  // B's adapter, symmetrically, sees only B's row.
  const bResults = await t.action(api.example.mastraQuery, {
    subject: BOB,
    orgCode: ORG_B,
    queryVector: QUERY,
    topK: 8
  });
  expect(bResults.map((r) => r.id)).toEqual(['b1']);
});

test('a Mastra filter NARROWS within the tenant', async () => {
  const t = initConvexTest();
  await t.action(api.example.mastraUpsert, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'note1',
    vector: A_CLOSE,
    metadata: {kind: 'note'}
  });
  await t.action(api.example.mastraUpsert, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'task1',
    vector: A_FAR,
    metadata: {kind: 'task'}
  });

  // No filter: both, best score first.
  const all = await t.action(api.example.mastraQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    topK: 8
  });
  expect(all.map((r) => r.id)).toEqual(['note1', 'task1']);

  // Filter narrows to the notes only.
  const notes = await t.action(api.example.mastraQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    topK: 8,
    filter: {kind: 'note'}
  });
  expect(notes.map((r) => r.id)).toEqual(['note1']);
});

test('a filter cannot WIDEN: an orgCode in the filter is ignored (tenant is construction-bound)', async () => {
  const t = initConvexTest();
  await t.action(api.example.mastraUpsert, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    vector: A_CLOSE
  });
  await t.action(api.example.mastraUpsert, {
    subject: BOB,
    orgCode: ORG_B,
    id: 'b1',
    vector: B_EXACT
  });

  // A's adapter query with a filter TRYING to reach org_beta: orgCode is not a
  // caller filter — it is dropped, the bound tenant wins, B never crosses.
  const results = await t.action(api.example.mastraQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    topK: 8,
    filter: {orgCode: ORG_B}
  });
  expect(results.map((r) => r.id)).toEqual(['a1']);
});

test('upsert then query round-trips through the governed path, and BOTH are audited', async () => {
  const t = initConvexTest();
  await t.action(api.example.mastraUpsert, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'r1',
    vector: A_CLOSE
  });
  const results = await t.action(api.example.mastraQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    topK: 8
  });
  expect(results.map((r) => r.id)).toEqual(['r1']);

  // The write and the recall each landed an audit row — governance came for
  // free from the governed client, observed here via the audit.query surface.
  const rows = await orgAudit(t, ORG_A, ALICE);
  const writes = rows.filter(
    (row) => row.operation === 'write' && row.reasonCode === 'created'
  );
  const recalls = rows.filter(
    (row) => row.operation === 'recall' && row.reasonCode === 'recalled'
  );
  expect(writes.length).toBeGreaterThanOrEqual(1);
  expect(recalls.length).toBeGreaterThanOrEqual(1);
});

test('a revoked tenant context makes the adapter DENY — governance is inherited, not re-implemented', async () => {
  const t = initConvexTest();
  await t.action(api.example.mastraUpsert, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    vector: A_CLOSE
  });

  // Revoke ALICE at subject level (the overlay), then query through the adapter.
  await t.mutation(api.example.revokeCaller, {
    subject: ADMIN,
    orgCode: ORG_A,
    target: {kind: 'subject', orgCode: ORG_A, subject: ALICE},
    reason: 'adapter-revocation-test'
  });

  await expectClientError(
    t.action(api.example.mastraQuery, {
      subject: ALICE,
      orgCode: ORG_A,
      queryVector: QUERY,
      topK: 8
    }),
    'revoked'
  );
});

// The whole point of the phase: the shipped package (src/) must gain NO
// framework dependency. Prove it structurally — no `@mastra` import survives
// anywhere under src/.
const coreSources = import.meta.glob('../../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

test('the core (src/) imports no framework: `@mastra` appears nowhere under src/', () => {
  expect(Object.keys(coreSources).length).toBeGreaterThan(0); // glob really matched
  const offenders = Object.entries(coreSources)
    .filter(([, source]) => /@mastra/.test(source))
    .map(([path]) => path)
    .sort();
  expect(offenders).toEqual([]);
});
