/// <reference types="vite/client" />
import {describe, expect, test} from 'vitest';
import {api} from './_generated/api.js';
import {getMemoriesByIds} from './access.js';
import {EMBEDDING_DIMENSIONS, MAX_RECALL_TOP_K} from './lib/embedding.js';
import {expectFail, initConvexTest} from './setup.test.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const SECRET = 'TOP-SECRET-CONTENT-a3f8c2';

/**
 * A sparse test vector: zeros everywhere except the given components. Cosine
 * similarity to the query below is then EXACTLY controlled — no embedding
 * model, no approximation.
 */
function vec(entries: Record<number, number>): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const [index, value] of Object.entries(entries)) {
    vector[Number(index)] = value;
  }
  return vector;
}

// The query direction is e0; 0.987654 is a DISTINCTIVE magnitude (cosine is
// scale-invariant, so it changes no score) that the audit-redaction test can
// grep audit rows for.
const QUERY = vec({0: 0.987654});
// cos(A_CLOSE, e0) = 1/√2 ≈ 0.7071
const A_CLOSE = vec({0: 1, 1: 1});
// cos(A_FAR, e0) = 1/√10 ≈ 0.3162
const A_FAR = vec({0: 1, 1: 3});
// cos(B_EXACT, e0) = 1.0 — engineered STRICTLY more similar than any A row.
const B_EXACT = vec({0: 1});

async function memoryRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('memories').collect());
}
async function auditRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('audit').collect());
}

async function writeEmbedded(
  t: ConvexTest,
  orgCode: string,
  subject: string,
  key: string,
  content: string,
  embedding: number[]
) {
  const result = await t.mutation(api.memory.write, {
    subject,
    orgCode,
    key,
    content,
    embedding
  });
  if (!result.ok) throw new Error(`test write denied: ${result.code}`);
  return result;
}

describe('tenant-partitioned recall (the isolation proof)', () => {
  test("HEADLINE: B's strictly better-matching row never appears in A's recall", async () => {
    const t = initConvexTest();
    await writeEmbedded(t, ORG_A, ALICE, 'a/close', 'a close', A_CLOSE);
    await writeEmbedded(t, ORG_A, ALICE, 'a/far', 'a far', A_FAR);
    // B's record scores 1.0 against the query — better than EVERY A record.
    await writeEmbedded(t, ORG_B, BOB, 'b/exact', SECRET, B_EXACT);

    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: QUERY,
      // Large enough to include every record that CAN be returned.
      topK: MAX_RECALL_TOP_K
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');

    // Only A's rows — every single returned row carries A's orgCode.
    expect(result.matches).toHaveLength(2);
    for (const match of result.matches) {
      expect(match.memory.orgCode).toBe(ORG_A);
    }
    expect(result.matches.map((match) => match.memory.key)).toEqual([
      'a/close',
      'a/far'
    ]);

    // The engineering held: B's absent row would have OUTSCORED every match.
    const bestReturnedScore = result.matches[0].score;
    expect(bestReturnedScore).toBeLessThan(1.0);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  test('a tenant with no embedded memories recalls ok with empty matches', async () => {
    const t = initConvexTest();
    // Another tenant HAS a perfect match; the caller's tenant has nothing.
    await writeEmbedded(t, ORG_B, BOB, 'b/exact', 'b', B_EXACT);

    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: QUERY,
      topK: 8
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.matches).toEqual([]);
  });

  /**
   * KNOWN convex-test LIMITATION (v0.0.53), documented as a test so it flags
   * the moment the harness fixes it. In PRODUCTION Convex, a document
   * without the vector field is simply absent from the vector index — a
   * same-tenant record with no embedding can never appear in (or affect)
   * recall. convex-test's fake instead iterates every filter-matching doc
   * and computes cosine against `doc.embedding`, crashing on `undefined`
   * (verified in its source: `vectorSearch` → `cosineSimilarity(vector,
   * doc[vectorField])` with no field-presence check). If this test ever
   * FAILS, convex-test has fixed the gap — replace it with the real
   * assertion: recall returns only 'a/close'.
   */
  test('KNOWN convex-test gap: a same-tenant record without an embedding crashes the FAKE vector search (production ignores it)', async () => {
    const t = initConvexTest();
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/unembedded',
      content: 'no vector'
    });
    await writeEmbedded(t, ORG_A, ALICE, 'a/close', 'a close', A_CLOSE);

    await expect(
      t.action(api.memory.recall, {
        subject: ALICE,
        orgCode: ORG_A,
        embedding: QUERY,
        topK: 8
      })
    ).rejects.toThrow();
  });
});

describe('scoring and bounds', () => {
  test('scores descend and topK truncates to the best matches', async () => {
    const t = initConvexTest();
    await writeEmbedded(t, ORG_A, ALICE, 'a/far', 'far', A_FAR);
    await writeEmbedded(t, ORG_A, ALICE, 'a/exact', 'exact', B_EXACT);
    await writeEmbedded(t, ORG_A, ALICE, 'a/close', 'close', A_CLOSE);

    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: QUERY,
      topK: 2
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.matches.map((match) => match.memory.key)).toEqual([
      'a/exact',
      'a/close'
    ]);
    expect(result.matches[0].score).toBeCloseTo(1.0, 5);
    expect(result.matches[1].score).toBeCloseTo(Math.SQRT1_2, 5);
    expect(result.matches[0].score).toBeGreaterThan(result.matches[1].score);
  });
});

describe('recall validation (typed denials, each audited)', () => {
  async function expectRecallDenied(
    t: ConvexTest,
    args: {
      claimedOrgCode?: string;
      embedding: number[];
      topK: number;
    },
    code: string
  ) {
    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      ...args
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe(code);
    return result;
  }

  test('wrong dimensionality is denied invalid_embedding and audited', async () => {
    const t = initConvexTest();
    await expectRecallDenied(
      t,
      {embedding: [1, 2, 3], topK: 8},
      'invalid_embedding'
    );
    const audit = await auditRows(t);
    expect(audit).toHaveLength(1);
    expect(audit[0].operation).toBe('recall');
    expect(audit[0].decision).toBe('denied');
    expect(audit[0].reasonCode).toBe('invalid_embedding');
  });

  test('non-finite components are denied invalid_embedding', async () => {
    const t = initConvexTest();
    await expectRecallDenied(
      t,
      {embedding: vec({0: NaN}), topK: 8},
      'invalid_embedding'
    );
    await expectRecallDenied(
      t,
      {embedding: vec({0: Infinity}), topK: 8},
      'invalid_embedding'
    );
    const audit = await auditRows(t);
    expect(audit).toHaveLength(2);
    for (const row of audit) {
      expect(row.decision).toBe('denied');
      expect(row.reasonCode).toBe('invalid_embedding');
    }
  });

  test('topK out of bounds (0, max+1, non-integer) is denied invalid_topk', async () => {
    const t = initConvexTest();
    for (const topK of [0, MAX_RECALL_TOP_K + 1, 2.5]) {
      await expectRecallDenied(t, {embedding: QUERY, topK}, 'invalid_topk');
    }
    const audit = await auditRows(t);
    expect(audit).toHaveLength(3);
    for (const row of audit) {
      expect(row.reasonCode).toBe('invalid_topk');
    }
  });

  test('claimedOrgCode conflict is denied tenant_context_conflict and audited under the verified org', async () => {
    const t = initConvexTest();
    await writeEmbedded(t, ORG_A, ALICE, 'a/close', SECRET, A_CLOSE);
    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      claimedOrgCode: ORG_B,
      embedding: QUERY,
      topK: 8
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('tenant_context_conflict');

    const recallAudit = (await auditRows(t)).filter(
      (row) => row.operation === 'recall'
    );
    expect(recallAudit).toHaveLength(1);
    expect(recallAudit[0].decision).toBe('denied');
    expect(recallAudit[0].reasonCode).toBe('tenant_context_conflict');
    expect(recallAudit[0].orgCode).toBe(ORG_A);
  });

  test('blank identity fields throw invalid_argument before the governed path', async () => {
    const t = initConvexTest();
    await expectFail(
      t.action(api.memory.recall, {
        subject: '',
        orgCode: ORG_A,
        embedding: QUERY,
        topK: 8
      }),
      'invalid_argument'
    );
    await expectFail(
      t.action(api.memory.recall, {
        subject: ALICE,
        orgCode: '',
        embedding: QUERY,
        topK: 8
      }),
      'invalid_argument'
    );
    // Malformed calls never reach the spine: nothing was audited.
    expect(await auditRows(t)).toHaveLength(0);
  });
});

describe('the recall audit row', () => {
  test('exactly ONE audit row per successful recall; correlationId round-trips; no vector, no content', async () => {
    const t = initConvexTest();
    await writeEmbedded(t, ORG_A, ALICE, 'a/close', SECRET, A_CLOSE);
    const auditRowsBefore = (await auditRows(t)).length;

    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: QUERY,
      topK: 8,
      correlationId: 'corr-recall-1'
    });
    if (!result.ok) throw new Error('unreachable');
    expect(result.correlationId).toBe('corr-recall-1');

    const recallAudit = (await auditRows(t)).slice(auditRowsBefore);
    expect(recallAudit).toHaveLength(1);
    const row = recallAudit[0];
    expect(row.operation).toBe('recall');
    expect(row.decision).toBe('ok');
    expect(row.reasonCode).toBe('recalled');
    expect(row.correlationId).toBe('corr-recall-1');
    // The descriptor records topK and result count — nothing content-bearing.
    expect(row.keyOrQueryDigest).toBe('v1:recall:topK=8,results=1');

    // Neither the query vector's distinctive component nor any memory
    // content appears anywhere in ANY audit row.
    const serialized = JSON.stringify(await auditRows(t));
    expect(serialized).not.toContain('987654');
    expect(serialized).not.toContain(SECRET);
  });

  test('a denied recall also writes exactly one audit row', async () => {
    const t = initConvexTest();
    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: [1],
      topK: 8,
      correlationId: 'corr-denied-1'
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.correlationId).toBe('corr-denied-1');
    const audit = await auditRows(t);
    expect(audit).toHaveLength(1);
    expect(audit[0].correlationId).toBe('corr-denied-1');
    expect(audit[0].keyOrQueryDigest).toBe('v1:recall:topK=8');
  });
});

describe('embedding intake on write', () => {
  test('write with a malformed embedding is denied invalid_embedding before touching the table', async () => {
    const t = initConvexTest();
    const result = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/bad',
      content: 'c',
      embedding: [1, 2, 3]
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_embedding');
    expect(await memoryRows(t)).toHaveLength(0);
    const audit = await auditRows(t);
    expect(audit).toHaveLength(1);
    expect(audit[0].operation).toBe('write');
    expect(audit[0].reasonCode).toBe('invalid_embedding');
  });

  test('DOCUMENTED CHOICE: updating content WITHOUT an embedding keeps the stored one; supplying one replaces it', async () => {
    const t = initConvexTest();
    await writeEmbedded(t, ORG_A, ALICE, 'a/key', 'v1', A_CLOSE);

    // Content-only update: the stored embedding survives (with the documented
    // staleness caveat — it still describes 'v1').
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/key',
      content: 'v2'
    });
    let rows = await memoryRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('v2');
    expect(rows[0].embedding).toEqual(A_CLOSE);

    // Update WITH a new embedding: replaced.
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/key',
      content: 'v3',
      embedding: A_FAR
    });
    rows = await memoryRows(t);
    expect(rows[0].content).toBe('v3');
    expect(rows[0].embedding).toEqual(A_FAR);
  });
});

describe('the belt-and-braces re-check (unit)', () => {
  test('a cross-tenant doc surfacing in the id fetch fails loudly with isolation_invariant_violation', async () => {
    const t = initConvexTest();
    await writeEmbedded(t, ORG_B, BOB, 'b/exact', 'b', B_EXACT);
    const [bRow] = await memoryRows(t);

    await t.run(async (ctx) => {
      let error: unknown;
      try {
        await getMemoriesByIds(ctx.db, ORG_A, [bRow._id]);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeDefined();
      expect(JSON.stringify(error)).toContain('isolation_invariant_violation');
    });
  });

  test('an id whose doc was deleted is dropped, not an error', async () => {
    const t = initConvexTest();
    await writeEmbedded(t, ORG_A, ALICE, 'a/kept', 'kept', A_CLOSE);
    await writeEmbedded(t, ORG_A, ALICE, 'a/gone', 'gone', A_FAR);
    const rows = await memoryRows(t);
    const gone = rows.find((row) => row.key === 'a/gone');
    const kept = rows.find((row) => row.key === 'a/kept');
    if (gone === undefined || kept === undefined) throw new Error('setup');

    await t.run(async (ctx) => {
      await ctx.db.delete('memories', gone._id);
      const docs = await getMemoriesByIds(ctx.db, ORG_A, [gone._id, kept._id]);
      expect([...docs.keys()]).toEqual([kept._id]);
    });
  });
});
