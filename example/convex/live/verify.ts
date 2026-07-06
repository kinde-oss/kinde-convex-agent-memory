/**
 * LIVE VERIFICATION HARNESS (phase 1) — real embedder, real Convex vector index.
 *
 * Runs against the REAL deployment through the REAL governed client path (write
 * and recall on the deployed component), NOT convex-test, NOT a raw table poke.
 * It proves what the hash fake + in-memory vector fake could not: that a REAL
 * embedding model over the REAL `by_embedding` index (filterFields ['orgCode'])
 * holds tenant isolation under real cosine distances, even when tenant B
 * genuinely wins on similarity to A's query.
 *
 * Invoke: `npx convex run 'live/verify:runIsolation'` (no CONVEX_AGENT_MODE).
 * It writes test memories (upsert by (orgCode,key), namespaced by a per-run
 * marker) and reads them back; it never touches component source.
 */
import {internalAction} from '../_generated/server.js';
import {components} from '../_generated/api.js';
import {AgentMemory} from '@kinde-oss/kinde-convex-agent-memory';
import {v} from 'convex/values';
import {embedText, embedTexts} from './openaiEmbedder.js';

// The live client, wired with the REAL OpenAI embedder (recall-by-query-text
// embeds through this). No admin key: every call is a governed, per-call,
// tenant-bound operation.
const liveAgentMemory = new AgentMemory(components.memory, {
  embedder: embedText
});

const ORG_A = 'live_org_a';
const ORG_B = 'live_org_b';
const ALICE = 'live_alice';
const BOB = 'live_bob';
const QUERY = "How do I reset a user's password?";

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// A minimal, local re-implementation of the component's key digest, used ONLY to
// confirm (from outside) whether stored audit digests are HMAC-keyed. `v1:key:`
// + first 16 hex of HMAC-SHA256(secret, key) when a secret is applied, else of
// plain SHA-256(key).
async function keyFingerprint(
  key: string,
  secret: string | undefined
): Promise<string> {
  const enc = new TextEncoder();
  const data = enc.encode(key);
  let buffer: ArrayBuffer;
  if (secret !== undefined && secret !== '') {
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      enc.encode(secret),
      {name: 'HMAC', hash: 'SHA-256'},
      false,
      ['sign']
    );
    buffer = await crypto.subtle.sign('HMAC', cryptoKey, data);
  } else {
    buffer = await crypto.subtle.digest('SHA-256', data);
  }
  let hex = '';
  for (const byte of new Uint8Array(buffer)) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `v1:key:${hex.slice(0, 16)}`;
}

const rankingRow = v.object({
  tenant: v.string(),
  key: v.string(),
  cosineToQuery: v.number()
});
const recallRow = v.object({
  key: v.string(),
  orgCode: v.string(),
  score: v.number()
});

export const runIsolation = internalAction({
  args: {},
  returns: v.object({
    ranAgainstRealDeployment: v.boolean(),
    query: v.string(),
    ranking: v.array(rankingRow),
    aRecall: v.array(recallRow),
    bRecall: v.array(recallRow),
    isolation: v.object({
      aAllRowsAreOrgA: v.boolean(),
      bAllRowsAreOrgB: v.boolean(),
      bWinnerKey: v.string(),
      bWinnerCosineToQuery: v.number(),
      aBestCosineToQuery: v.number(),
      bWinnerBeatsAllOfA: v.boolean(),
      bWinnerAbsentFromARecall: v.boolean(),
      held: v.boolean()
    }),
    missingEmbedding: v.object({
      key: v.string(),
      recallSucceeded: v.boolean(),
      absentFromRecall: v.boolean(),
      crashed: v.boolean()
    }),
    keyedDigest: v.object({
      secretReadableInHarness: v.boolean(),
      writtenKeyCount: v.number(),
      writeDigestsMatchingKeyed: v.number(),
      writeDigestsMatchingUnkeyed: v.number(),
      writeDigestsMatchingNeither: v.number(),
      allWriteDigestsKeyed: v.boolean(),
      anyWriteDigestUnkeyed: v.boolean(),
      sampleKey: v.string(),
      sampleKeyedDigest: v.string(),
      sampleUnkeyedDigest: v.string(),
      sampleStoredDigest: v.string(),
      allDigestsWellFormed: v.boolean(),
      markerAbsentFromAudit: v.boolean(),
      queryWordsAbsentFromAudit: v.boolean()
    })
  }),
  handler: async (ctx) => {
    const marker = `LIVEMARK-${crypto.randomUUID().slice(0, 8)}`;

    // A's memories: on-topic-ish but NOT the direct answer. B's first memory IS
    // the direct answer to A's query, so B genuinely wins on cosine.
    const aTexts = [
      {
        key: `${marker}-a-invoice`,
        text: `${marker} :: The invoice for March is due on the fifteenth.`
      },
      {
        key: `${marker}-a-deploy`,
        text: `${marker} :: Deploy the service by running the release pipeline.`
      },
      {
        key: `${marker}-a-onboard`,
        text: `${marker} :: New team members finish onboarding in their first week.`
      },
      {
        key: `${marker}-a-pwreq`,
        text: `${marker} :: Password requirements: at least twelve characters with a number.`
      }
    ];
    const bTexts = [
      {
        key: `${marker}-b-answer`,
        text: `${marker} :: To reset a user password, open Settings, choose Security, then click Reset Password.`
      },
      {
        key: `${marker}-b-board`,
        text: `${marker} :: The quarterly board meeting is scheduled for Friday afternoon.`
      },
      {
        key: `${marker}-b-holiday`,
        text: `${marker} :: Our office is closed on national public holidays.`
      }
    ];
    const bWinnerKey = `${marker}-b-answer`;

    // Embed everything (batch) with the REAL model, plus the query.
    const allTexts = [...aTexts, ...bTexts];
    const allVectors = await embedTexts(allTexts.map((m) => m.text));
    const queryVector = await embedText(QUERY);

    const withVectors = allTexts.map((m, i) => ({
      ...m,
      tenant: i < aTexts.length ? 'A' : 'B',
      orgCode: i < aTexts.length ? ORG_A : ORG_B,
      subject: i < aTexts.length ? ALICE : BOB,
      embedding: allVectors[i]
    }));

    // WRITE each memory through the governed client with its REAL embedding.
    for (const m of withVectors) {
      await liveAgentMemory.write(ctx, {
        subject: m.subject,
        orgCode: m.orgCode,
        key: m.key,
        content: m.text,
        embedding: m.embedding
      });
    }

    // MISSING-EMBEDDING: one memory in A with NO embedding. On the real index it
    // must simply be absent from recall (the fake crashed here).
    const noEmbedKey = `${marker}-a-noembed`;
    await liveAgentMemory.write(ctx, {
      subject: ALICE,
      orgCode: ORG_A,
      key: noEmbedKey,
      content: `${marker} :: This memory has no embedding at all.`
    });

    // Local cosine ranking across BOTH tenants, for legibility.
    const ranking = withVectors
      .map((m) => ({
        tenant: m.tenant,
        key: m.key,
        cosineToQuery: cosine(queryVector, m.embedding)
      }))
      .sort((x, y) => y.cosineToQuery - x.cosineToQuery);

    console.log(
      `\n=== LIVE cosine ranking vs query "${QUERY}" (both tenants) ===`
    );
    for (const r of ranking) {
      console.log(`  ${r.cosineToQuery.toFixed(4)}  [${r.tenant}]  ${r.key}`);
    }

    const bWinnerCosine =
      ranking.find((r) => r.key === bWinnerKey)?.cosineToQuery ?? Number.NaN;
    const aBestCosine = Math.max(
      ...ranking.filter((r) => r.tenant === 'A').map((r) => r.cosineToQuery)
    );

    // RECALL as tenant A, by query TEXT, embedded live via the client. topK large
    // enough to include every row across both tenants if the partition were gone.
    let aRecallCrashed = false;
    let aMatches: {key: string; orgCode: string; score: number}[] = [];
    try {
      const aResult = await liveAgentMemory.recall(ctx, {
        subject: ALICE,
        orgCode: ORG_A,
        query: QUERY,
        topK: 20
      });
      aMatches = aResult.matches.map((m) => ({
        key: m.memory.key,
        orgCode: m.memory.orgCode,
        score: m.score
      }));
    } catch (caught) {
      aRecallCrashed = true;
      console.log(
        `  A recall THREW: ${caught instanceof Error ? caught.message : String(caught)}`
      );
    }

    const bResult = await liveAgentMemory.recall(ctx, {
      subject: BOB,
      orgCode: ORG_B,
      query: QUERY,
      topK: 20
    });
    const bMatches = bResult.matches.map((m) => ({
      key: m.memory.key,
      orgCode: m.memory.orgCode,
      score: m.score
    }));

    console.log(
      `\n=== A recall (org ${ORG_A}) returned ${aMatches.length} rows ===`
    );
    for (const m of aMatches) {
      console.log(`  score=${m.score.toFixed(4)}  org=${m.orgCode}  ${m.key}`);
    }
    console.log(
      `\n=== B recall (org ${ORG_B}) returned ${bMatches.length} rows ===`
    );
    for (const m of bMatches) {
      console.log(`  score=${m.score.toFixed(4)}  org=${m.orgCode}  ${m.key}`);
    }

    const aAllRowsAreOrgA =
      aMatches.length > 0 && aMatches.every((m) => m.orgCode === ORG_A);
    const bAllRowsAreOrgB =
      bMatches.length > 0 && bMatches.every((m) => m.orgCode === ORG_B);
    const bWinnerAbsentFromARecall = !aMatches.some(
      (m) => m.key === bWinnerKey
    );
    const bWinnerBeatsAllOfA = bWinnerCosine > aBestCosine;
    const isolationHeld =
      aAllRowsAreOrgA &&
      bAllRowsAreOrgB &&
      bWinnerAbsentFromARecall &&
      bWinnerBeatsAllOfA &&
      !aRecallCrashed;

    // MISSING-EMBEDDING result: A's recall must have succeeded and the
    // no-embedding memory must be absent from it.
    const noEmbedAbsent = !aMatches.some((m) => m.key === noEmbedKey);

    // AUDIT: fetch this tenant's audit rows and inspect the digests + leakage.
    const auditA = await liveAgentMemory.auditQuery(ctx, {
      orgCode: ORG_A,
      paginationOpts: {numItems: 500, cursor: null}
    });
    const auditB = await liveAgentMemory.auditQuery(ctx, {
      orgCode: ORG_B,
      paginationOpts: {numItems: 500, cursor: null}
    });
    const allAuditRows = [...auditA.page, ...auditB.page];
    // Only rows from THIS run (namespaced by marker via correlation is not
    // available, so filter by digests we can recompute is not possible; instead
    // reason over the whole tenant audit but check digest shape + no raw leakage
    // across every row, which must hold regardless of run).
    const auditJson = JSON.stringify(allAuditRows);
    const digestSet = new Set(allAuditRows.map((r) => r.keyOrQueryDigest));

    const secret = process.env.MEMORY_SIGNING_SECRET;
    const secretReadableInHarness = secret !== undefined && secret !== '';

    // For EVERY key we wrote this run, is the stored audit digest the HMAC-keyed
    // one (secret applied by the component) or the plain SHA-256 one (unkeyed)?
    const writtenKeys = [...withVectors.map((m) => m.key), noEmbedKey];
    let writeDigestsMatchingKeyed = 0;
    let writeDigestsMatchingUnkeyed = 0;
    let writeDigestsMatchingNeither = 0;
    const perKeyLog: string[] = [];
    for (const k of writtenKeys) {
      const keyed = await keyFingerprint(k, secret);
      const unkeyed = await keyFingerprint(k, undefined);
      if (digestSet.has(keyed)) {
        writeDigestsMatchingKeyed++;
        perKeyLog.push(`  keyed    ${k}`);
      } else if (digestSet.has(unkeyed)) {
        writeDigestsMatchingUnkeyed++;
        perKeyLog.push(`  UNKEYED  ${k}`);
      } else {
        writeDigestsMatchingNeither++;
        perKeyLog.push(`  neither  ${k}`);
      }
    }
    const allWriteDigestsKeyed =
      writeDigestsMatchingKeyed === writtenKeys.length;
    const anyWriteDigestUnkeyed = writeDigestsMatchingUnkeyed > 0;

    const sampleKey = writtenKeys[0] ?? `${marker}-a-invoice`;
    const sampleKeyedDigest = await keyFingerprint(sampleKey, secret);
    const sampleUnkeyedDigest = await keyFingerprint(sampleKey, undefined);
    const sampleStoredDigest = digestSet.has(sampleKeyedDigest)
      ? sampleKeyedDigest
      : digestSet.has(sampleUnkeyedDigest)
        ? sampleUnkeyedDigest
        : '(not found in audit)';

    // A digest is well-formed if it is a hashed descriptor (v1:<kind>:<16 hex>)
    // or the non-hashed recall descriptor (v1:recall:topK=N[,results=M]).
    const hashedShape = /^v1:[a-z_]+:[0-9a-f]{16}$/;
    const recallShape = /^v1:recall:topK=\d+(,results=\d+)?$/;
    const allDigestsWellFormed = [...digestSet].every(
      (d) => hashedShape.test(d) || recallShape.test(d)
    );
    const markerAbsentFromAudit = !auditJson.includes(marker);
    const queryWordsAbsentFromAudit =
      !auditJson.includes('password') && !auditJson.includes('reset');

    console.log(`\n=== keyed-digest check ===`);
    console.log(
      `  secret readable in harness (app env): ${secretReadableInHarness}`
    );
    console.log(`  written keys: ${writtenKeys.length}`);
    for (const line of perKeyLog) {
      console.log(line);
    }
    console.log(
      `  keyed=${writeDigestsMatchingKeyed} unkeyed=${writeDigestsMatchingUnkeyed} neither=${writeDigestsMatchingNeither}`
    );
    console.log(`  sample key: ${sampleKey}`);
    console.log(
      `  sample keyed digest (secret applied):  ${sampleKeyedDigest}`
    );
    console.log(
      `  sample unkeyed digest (plain SHA-256): ${sampleUnkeyedDigest}`
    );
    console.log(
      `  sample STORED digest in audit:         ${sampleStoredDigest}`
    );
    console.log(`  all digests well-formed: ${allDigestsWellFormed}`);
    console.log(
      `  marker (content/key) absent from audit: ${markerAbsentFromAudit}`
    );
    console.log(
      `  query words absent from audit: ${queryWordsAbsentFromAudit}`
    );
    console.log(
      `\n=== ISOLATION HELD: ${isolationHeld} (bWinnerCosine=${bWinnerCosine.toFixed(4)} > aBest=${aBestCosine.toFixed(4)}; bWinner absent from A: ${bWinnerAbsentFromARecall}) ===\n`
    );

    return {
      ranAgainstRealDeployment: true,
      query: QUERY,
      ranking,
      aRecall: aMatches,
      bRecall: bMatches,
      isolation: {
        aAllRowsAreOrgA,
        bAllRowsAreOrgB,
        bWinnerKey,
        bWinnerCosineToQuery: bWinnerCosine,
        aBestCosineToQuery: aBestCosine,
        bWinnerBeatsAllOfA,
        bWinnerAbsentFromARecall,
        held: isolationHeld
      },
      missingEmbedding: {
        key: noEmbedKey,
        recallSucceeded: !aRecallCrashed,
        absentFromRecall: noEmbedAbsent,
        crashed: aRecallCrashed
      },
      keyedDigest: {
        secretReadableInHarness,
        writtenKeyCount: writtenKeys.length,
        writeDigestsMatchingKeyed,
        writeDigestsMatchingUnkeyed,
        writeDigestsMatchingNeither,
        allWriteDigestsKeyed,
        anyWriteDigestUnkeyed,
        sampleKey,
        sampleKeyedDigest,
        sampleUnkeyedDigest,
        sampleStoredDigest,
        allDigestsWellFormed,
        markerAbsentFromAudit,
        queryWordsAbsentFromAudit
      }
    };
  }
});
