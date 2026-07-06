/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {internal} from './_generated/api.js';
import {
  expectClientError,
  initConvexTest,
  TEST_SIGNING_SECRET
} from './testHelpers.shared.js';
import {EMBEDDING_DIMENSIONS} from '@kinde-oss/kinde-convex-agent-memory';
import {fakeEmbed} from './example.js';

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
  await t.action(internal.example.langchainAddVectors, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    vector: A_CLOSE,
    pageContent: 'a one'
  });
  await t.action(internal.example.langchainAddVectors, {
    subject: BOB,
    orgCode: ORG_B,
    id: 'b1',
    vector: B_EXACT,
    pageContent: 'b one'
  });

  // A's search returns ONLY A's row — B_EXACT is a better match but is outside
  // A's tenant partition, so the adapter never surfaces it.
  const aResults = await t.action(internal.example.langchainQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    k: 8
  });
  expect(aResults.map((r) => r.id)).toEqual(['a1']);

  // B's adapter, symmetrically, sees only B's row.
  const bResults = await t.action(internal.example.langchainQuery, {
    subject: BOB,
    orgCode: ORG_B,
    queryVector: QUERY,
    k: 8
  });
  expect(bResults.map((r) => r.id)).toEqual(['b1']);
});

test('a LangChain filter NARROWS within the tenant', async () => {
  const t = initConvexTest();
  await t.action(internal.example.langchainAddVectors, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'note1',
    vector: A_CLOSE,
    pageContent: 'a note',
    metadata: {kind: 'note'}
  });
  await t.action(internal.example.langchainAddVectors, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'task1',
    vector: A_FAR,
    pageContent: 'a task',
    metadata: {kind: 'task'}
  });

  // No filter: both, best score first.
  const all = await t.action(internal.example.langchainQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    k: 8
  });
  expect(all.map((r) => r.id)).toEqual(['note1', 'task1']);

  // Filter narrows to the notes only.
  const notes = await t.action(internal.example.langchainQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    k: 8,
    filter: {kind: 'note'}
  });
  expect(notes.map((r) => r.id)).toEqual(['note1']);
});

test('a filter cannot WIDEN: an orgCode in the filter is ignored (tenant is construction-bound)', async () => {
  const t = initConvexTest();
  await t.action(internal.example.langchainAddVectors, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    vector: A_CLOSE,
    pageContent: 'a'
  });
  await t.action(internal.example.langchainAddVectors, {
    subject: BOB,
    orgCode: ORG_B,
    id: 'b1',
    vector: B_EXACT,
    pageContent: 'b'
  });

  // A's query with a filter TRYING to reach org_beta: orgCode is not a caller
  // filter — it is dropped, the bound tenant wins, B never crosses.
  const results = await t.action(internal.example.langchainQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    k: 8,
    filter: {orgCode: ORG_B}
  });
  expect(results.map((r) => r.id)).toEqual(['a1']);
});

test('addVectors then query round-trips through the governed path, and BOTH are audited', async () => {
  const t = initConvexTest();
  await t.action(internal.example.langchainAddVectors, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'r1',
    vector: A_CLOSE,
    pageContent: 'roundtrip'
  });
  const results = await t.action(internal.example.langchainQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: QUERY,
    k: 8
  });
  expect(results.map((r) => r.id)).toEqual(['r1']);
  expect(results[0].pageContent).toBe('roundtrip'); // pageContent round-trips

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

test('addDocuments embeds pageContent via the store embeddings and round-trips', async () => {
  const t = initConvexTest();
  await t.action(internal.example.langchainAddDocuments, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'doc1',
    pageContent: 'the sky is blue'
  });
  // The store embedded 'the sky is blue' with the same fake embedder; querying
  // that exact vector finds it.
  const results = await t.action(internal.example.langchainQuery, {
    subject: ALICE,
    orgCode: ORG_A,
    queryVector: fakeEmbed('the sky is blue'),
    k: 8
  });
  expect(results.map((r) => r.id)).toEqual(['doc1']);
  expect(results[0].pageContent).toBe('the sky is blue');
});

test('a revoked tenant context makes the adapter DENY — governance is inherited, not re-implemented', async () => {
  const t = initConvexTest();
  await t.action(internal.example.langchainAddVectors, {
    subject: ALICE,
    orgCode: ORG_A,
    id: 'a1',
    vector: A_CLOSE,
    pageContent: 'a'
  });

  // Revoke ALICE at subject level (the overlay), then search through the adapter.
  await t.mutation(internal.example.revokeCaller, {
    subject: ADMIN,
    orgCode: ORG_A,
    target: {kind: 'subject', orgCode: ORG_A, subject: ALICE},
    reason: 'langchain-revocation-test'
  });

  await expectClientError(
    t.action(internal.example.langchainQuery, {
      subject: ALICE,
      orgCode: ORG_A,
      queryVector: QUERY,
      k: 8
    }),
    'revoked'
  );
});
