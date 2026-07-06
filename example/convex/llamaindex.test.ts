/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {internal} from './_generated/api.js';
import {
  expectClientError,
  initConvexTest,
  TEST_SIGNING_SECRET
} from './testHelpers.shared.js';
import {EMBEDDING_DIMENSIONS} from '@kinde-oss/kinde-convex-agent-memory';

type ConvexTest = ReturnType<typeof initConvexTest>;

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

async function orgAudit(t: ConvexTest, orgCode: string, subject: string) {
  const result = await t.query(internal.example.auditLog, {
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
  await t.action(internal.example.llamaindexAdd, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    embedding: A_CLOSE,
    text: 'a one'
  });
  await t.action(internal.example.llamaindexAdd, {
    subject: BOB,
    orgCode: ORG_B,
    id: 'b1',
    embedding: B_EXACT,
    text: 'b one'
  });

  // A's query returns ONLY A's node — B's better match is outside A's tenant
  // partition, so the adapter never surfaces it.
  const aResults = await t.action(internal.example.llamaindexQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryEmbedding: QUERY,
    similarityTopK: 8
  });
  expect(aResults.map((r) => r.id)).toEqual(['a1']);

  // B's adapter, symmetrically, sees only B's node.
  const bResults = await t.action(internal.example.llamaindexQuery, {
    subject: BOB,
    orgCode: ORG_B,
    queryEmbedding: QUERY,
    similarityTopK: 8
  });
  expect(bResults.map((r) => r.id)).toEqual(['b1']);
});

test('a LlamaIndex filter NARROWS within the tenant', async () => {
  const t = initConvexTest();
  await t.action(internal.example.llamaindexAdd, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'note1',
    embedding: A_CLOSE,
    text: 'a note',
    metadata: {kind: 'note'}
  });
  await t.action(internal.example.llamaindexAdd, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'task1',
    embedding: A_FAR,
    text: 'a task',
    metadata: {kind: 'task'}
  });

  const all = await t.action(internal.example.llamaindexQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryEmbedding: QUERY,
    similarityTopK: 8
  });
  expect(all.map((r) => r.id)).toEqual(['note1', 'task1']);

  const notes = await t.action(internal.example.llamaindexQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryEmbedding: QUERY,
    similarityTopK: 8,
    filter: {kind: 'note'}
  });
  expect(notes.map((r) => r.id)).toEqual(['note1']);
});

test('a filter cannot WIDEN: an orgCode filter is ignored (tenant is construction-bound)', async () => {
  const t = initConvexTest();
  await t.action(internal.example.llamaindexAdd, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    embedding: A_CLOSE,
    text: 'a'
  });
  await t.action(internal.example.llamaindexAdd, {
    subject: BOB,
    orgCode: ORG_B,
    id: 'b1',
    embedding: B_EXACT,
    text: 'b'
  });

  // A filter naming org_beta is dropped; the construction-bound tenant wins.
  const results = await t.action(internal.example.llamaindexQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryEmbedding: QUERY,
    similarityTopK: 8,
    filter: {orgCode: ORG_B}
  });
  expect(results.map((r) => r.id)).toEqual(['a1']);
});

test('add then query round-trips through the governed path, and BOTH are audited', async () => {
  const t = initConvexTest();
  await t.action(internal.example.llamaindexAdd, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'r1',
    embedding: A_CLOSE,
    text: 'roundtrip'
  });
  const results = await t.action(internal.example.llamaindexQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryEmbedding: QUERY,
    similarityTopK: 8
  });
  expect(results.map((r) => r.id)).toEqual(['r1']);
  expect(results[0].text).toBe('roundtrip'); // node text round-trips

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
  await t.action(internal.example.llamaindexAdd, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    embedding: A_CLOSE,
    text: 'a'
  });

  await t.mutation(internal.example.revokeCaller, {
    subject: ADMIN,
    orgCode: ORG_A,
    target: {kind: 'subject', orgCode: ORG_A, subject: ALICE},
    reason: 'llamaindex-revocation-test'
  });

  await expectClientError(
    t.action(internal.example.llamaindexQuery, {
      subject: ALICE,
      orgCode: ORG_A,
      queryEmbedding: QUERY,
      similarityTopK: 8
    }),
    'revoked'
  );
});

test('delete is honestly not supported: it throws rather than bypass the governed path', async () => {
  const t = initConvexTest();
  await t.action(internal.example.llamaindexAdd, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    embedding: A_CLOSE,
    text: 'a'
  });

  // The governed client has no delete; the adapter refuses rather than reaching
  // the table directly. The row is still there afterward.
  await expect(
    t.action(internal.example.llamaindexDelete, {
      subject: ALICE,
      orgCode: ORG_A,
      refDocId: 'a1'
    })
  ).rejects.toThrow();

  const stillThere = await t.action(internal.example.llamaindexQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryEmbedding: QUERY,
    similarityTopK: 8
  });
  expect(stillThere.map((r) => r.id)).toEqual(['a1']);
});
