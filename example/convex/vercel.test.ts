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

test('isolation through the tools mirrors the raw API: a foreign better-match never crosses', async () => {
  const t = initConvexTest();
  // A saves a middling match; B saves a STRICTLY better match to A's query.
  await t.action(internal.example.vercelSaveMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    key: 'a1',
    content: 'a one',
    embedding: A_CLOSE
  });
  await t.action(internal.example.vercelSaveMemory, {
    subject: BOB,
    orgCode: ORG_B,
    key: 'b1',
    content: 'b one',
    embedding: B_EXACT
  });

  // A's searchMemory returns ONLY A's row — B's better match is outside A's
  // tenant partition, so the tool never surfaces it.
  const aResults = await t.action(internal.example.vercelSearchMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    embedding: QUERY,
    topK: 8
  });
  expect(aResults.map((r) => r.key)).toEqual(['a1']);

  const bResults = await t.action(internal.example.vercelSearchMemory, {
    subject: BOB,
    orgCode: ORG_B,
    embedding: QUERY,
    topK: 8
  });
  expect(bResults.map((r) => r.key)).toEqual(['b1']);
});

test('the tenant is NOT in the tool surface: no orgCode/subject parameter, and A saves cannot land elsewhere', async () => {
  const t = initConvexTest();
  // Structural: neither tool's input schema exposes the governing identity.
  const surface = await t.action(internal.example.vercelToolSurface, {
    subject: ALICE,
    orgCode: ORG_A
  });
  expect(surface.saveProps).not.toContain('orgCode');
  expect(surface.saveProps).not.toContain('subject');
  expect(surface.searchProps).not.toContain('orgCode');
  expect(surface.searchProps).not.toContain('subject');
  // The model can only supply key/content/embedding (save) and
  // query/embedding/topK (search) — nothing that names a tenant.
  expect(surface.saveProps.sort()).toEqual(['content', 'embedding', 'key']);
  expect(surface.searchProps.sort()).toEqual(['embedding', 'query', 'topK']);

  // Behavioral: a save via A's tools lands in A; B (whatever it does) never sees
  // it, because the tenant is closed over, not an argument that could redirect.
  await t.action(internal.example.vercelSaveMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    key: 'only-a',
    content: 'a secret',
    embedding: A_CLOSE
  });
  const bResults = await t.action(internal.example.vercelSearchMemory, {
    subject: BOB,
    orgCode: ORG_B,
    embedding: QUERY,
    topK: 8
  });
  expect(bResults.some((r) => r.key === 'only-a')).toBe(false);
  const aResults = await t.action(internal.example.vercelSearchMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    embedding: QUERY,
    topK: 8
  });
  expect(aResults.map((r) => r.key)).toEqual(['only-a']);
});

test('saveMemory then searchMemory round-trips through the governed path, and BOTH are audited', async () => {
  const t = initConvexTest();
  const saved = await t.action(internal.example.vercelSaveMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    key: 'r1',
    content: 'roundtrip',
    embedding: A_CLOSE
  });
  expect(saved.id).toBe('r1');
  expect(saved.outcome).toBe('created');

  const results = await t.action(internal.example.vercelSearchMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    embedding: QUERY,
    topK: 8
  });
  expect(results.map((r) => r.key)).toEqual(['r1']);
  expect(results[0].content).toBe('roundtrip'); // content round-trips

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

test('save-by-content and search-by-query use the bound embedder', async () => {
  const t = initConvexTest();
  // No embedding supplied → the tool embeds the content via the bound embedder.
  await t.action(internal.example.vercelSaveMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    key: 'doc1',
    content: 'the sky is blue'
  });
  // No embedding supplied → the tool embeds the query the same way, so it finds
  // the record.
  const results = await t.action(internal.example.vercelSearchMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    query: 'the sky is blue',
    topK: 8
  });
  expect(results.map((r) => r.key)).toEqual(['doc1']);
  expect(results[0].content).toBe('the sky is blue');
});

test('a revoked tenant makes both tools DENY — governance is inherited, not re-implemented', async () => {
  const t = initConvexTest();
  await t.action(internal.example.vercelSaveMemory, {
    subject: ALICE,
    orgCode: ORG_A,
    key: 'a1',
    content: 'a',
    embedding: A_CLOSE
  });

  await t.mutation(internal.example.revokeCaller, {
    subject: ADMIN,
    orgCode: ORG_A,
    target: {kind: 'subject', orgCode: ORG_A, subject: ALICE},
    reason: 'vercel-revocation-test'
  });

  await expectClientError(
    t.action(internal.example.vercelSearchMemory, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: QUERY,
      topK: 8
    }),
    'revoked'
  );
  await expectClientError(
    t.action(internal.example.vercelSaveMemory, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a2',
      content: 'a2',
      embedding: A_CLOSE
    }),
    'revoked'
  );
});
