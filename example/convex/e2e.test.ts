/// <reference types="vite/client" />
//
// THE TWO-TENANT END-TO-END STORY.
//
// This file reads top to bottom as one narrative. Two tenants, org A and org B,
// each run an agent that stores and recalls memory THROUGH this component. The
// point of the story is that the boundary between them holds at every layer:
// recall is tenant-partitioned, reads are redactable, access is grantable and
// revocable, and every governed call leaves an audit trail you can follow back
// to why it happened. Nothing here pokes the database directly; every beat runs
// through the real composed path, either the HTTP handlers (where the tenant is
// resolved from a verified token, never the request body) or the client-driver
// mutations and queries the app exposes.
//
import {beforeEach, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {api} from './_generated/api.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './setup.test.js';
import {fakeEmbed} from './example.js';
import {CONTENT_REDACTED} from '@kinde-oss/kinde-convex-agent-memory';

type ConvexTest = ReturnType<typeof initConvexTest>;

beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

// A real app never sees these org codes on the wire. They live inside the
// verified token; the fake verifyCaller maps a bearer token to a tenant exactly
// where kinde-convex-agent-auth's real verifyCaller would.
const TOKEN_A = 'token-alice-orgA'; // → user_alice @ org_alpha
const TOKEN_B = 'token-bob-orgB'; // → user_bob   @ org_beta
const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const ADMIN = 'user_admin';
const CAROL = 'user_carol';
const DEPUTY = 'user_deputy';

// The query both agents will run. Org B will deliberately hold a row that is a
// perfect match for it — a better answer to A's question than anything A wrote.
const SHARED_QUERY = 'project falcon merger terms';
const REVOCATION_REASON = 'compromised-credentials-incident-4471';

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** POST a JSON payload to an HTTP handler, authenticated by a bearer token. */
async function http(
  t: ConvexTest,
  path: string,
  token: string,
  payload: unknown
): Promise<HttpResult> {
  const res = await t.fetch(path, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify(payload)
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>
  };
}

/** Assert a client-driver call rejects with a typed ConvexError code. */
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
  expect(error, `expected ConvexError "${code}"`).toBeInstanceOf(ConvexError);
  const raw = (error as ConvexError<Value>).data;
  const data = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  expect((data as {code: string}).code).toBe(code);
}

interface RecallMatch {
  memory: {key: string; orgCode: string; content: string};
  score: number;
}

test('two tenants, one component: the boundary holds end to end', async () => {
  const t = initConvexTest();

  // ---------------------------------------------------------------------------
  // BEAT 1 — Tenancy comes from the token, not the body.
  // Each write below carries no org code in its payload. The HTTP handler runs
  // the bearer token through verifyCaller, and the resolved tenant is what the
  // governed write binds to. A body that tried to name another tenant would be
  // rejected (proven exhaustively in http.test.ts); here we just rely on it.
  // ---------------------------------------------------------------------------

  // BEAT 2 — Both agents write. A records its own notes (embedded so they are
  // recallable). The component never embeds on write, so the caller supplies
  // the vector; recall, in contrast, embeds the query server-side.
  const aRoadmap = await http(t, '/memory/write', TOKEN_A, {
    key: 'a/roadmap',
    content: 'org A internal product roadmap',
    embedding: fakeEmbed('org A internal product roadmap')
  });
  expect(aRoadmap.status).toBe(200);
  expect(aRoadmap.body.ok).toBe(true);

  await http(t, '/memory/write', TOKEN_A, {
    key: 'a/budget',
    content: 'org A confidential budget figures',
    embedding: fakeEmbed('org A confidential budget figures')
  });

  // B writes its own notes AND, crucially, a row whose embedding is an EXACT
  // match for A's future query — a strictly better answer to A's question than
  // anything A holds. If the boundary leaked, this is the row that would leak.
  await http(t, '/memory/write', TOKEN_B, {
    key: 'b/notes',
    content: 'org B weekly sync notes',
    embedding: fakeEmbed('org B weekly sync notes')
  });
  await http(t, '/memory/write', TOKEN_B, {
    key: 'b/leak',
    content: SHARED_QUERY,
    embedding: fakeEmbed(SHARED_QUERY)
  });

  // ---------------------------------------------------------------------------
  // BEAT 3 — THE HEADLINE. A recalls its question. B holds the perfect answer,
  // but A only ever sees A's own rows. Then B runs the identical query and sees
  // only B's. The partition is enforced by the vector index itself (filtered on
  // orgCode), not by anything the caller can influence.
  // ---------------------------------------------------------------------------
  const aRecall = await http(t, '/memory/recall', TOKEN_A, {
    query: SHARED_QUERY,
    topK: 10
  });
  expect(aRecall.status).toBe(200);
  const aMatches = aRecall.body.matches as RecallMatch[];
  expect(aMatches.length).toBeGreaterThan(0);
  // Every row A sees is A's. B's better-matching row never appears.
  expect(aMatches.every((m) => m.memory.orgCode === ORG_A)).toBe(true);
  expect(aMatches.some((m) => m.memory.key === 'b/leak')).toBe(false);

  const bRecall = await http(t, '/memory/recall', TOKEN_B, {
    query: SHARED_QUERY,
    topK: 10
  });
  const bMatches = bRecall.body.matches as RecallMatch[];
  expect(bMatches.every((m) => m.memory.orgCode === ORG_B)).toBe(true);
  // B's perfect match is present for B, and no org A row crossed over.
  expect(bMatches.some((m) => m.memory.key === 'b/leak')).toBe(true);
  expect(bMatches.some((m) => m.memory.key.startsWith('a/'))).toBe(false);

  // ---------------------------------------------------------------------------
  // BEAT 4 — Redaction shapes what leaves, not what is stored. A writes a record
  // with a PII field, then sets a policy that hides the email and the body from
  // reads by its own agent. The read comes back redacted; clearing the policy
  // brings the full record back, proving the stored row was never touched. B,
  // with no policy of its own, is unaffected.
  // ---------------------------------------------------------------------------
  // Every org A row carries an embedding. (The convex-test vector fake iterates
  // every same-tenant row and cannot skip one lacking a vector; production, by
  // contrast, simply leaves un-embedded rows out of the index. Embedding all of
  // A's rows keeps the in-memory test faithful to production recall.)
  await http(t, '/memory/write', TOKEN_A, {
    key: 'a/customer',
    content: 'full customer dossier',
    embedding: fakeEmbed('full customer dossier'),
    metadata: {email: 'vip@example.com', tier: 'gold'}
  });
  const setPolicy = await t.mutation(api.example.setRedactionPolicy, {
    subject: ADMIN,
    orgCode: ORG_A,
    targetSubject: ALICE,
    fields: ['content', 'email']
  });
  expect(setPolicy.outcome).toBe('set');

  const redacted = await http(t, '/memory/get', TOKEN_A, {key: 'a/customer'});
  const redactedMemory = redacted.body.memory as {
    content: string;
    metadata?: Record<string, unknown>;
  };
  expect(redactedMemory.content).toBe(CONTENT_REDACTED); // body hidden
  expect(redactedMemory.metadata?.email).toBeUndefined(); // PII field omitted
  expect(redactedMemory.metadata?.tier).toBe('gold'); // non-PII field kept

  // B reads one of its own rows: no policy applies to B, nothing is redacted.
  const bReads = await http(t, '/memory/get', TOKEN_B, {key: 'b/notes'});
  expect((bReads.body.memory as {content: string}).content).toBe(
    'org B weekly sync notes'
  );

  // Clear A's policy and read again: the full record returns untouched.
  await t.mutation(api.example.setRedactionPolicy, {
    subject: ADMIN,
    orgCode: ORG_A,
    targetSubject: ALICE,
    fields: []
  });
  const unredacted = await http(t, '/memory/get', TOKEN_A, {key: 'a/customer'});
  const fullMemory = unredacted.body.memory as {
    content: string;
    metadata?: Record<string, unknown>;
  };
  expect(fullMemory.content).toBe('full customer dossier');
  expect(fullMemory.metadata?.email).toBe('vip@example.com');

  // ---------------------------------------------------------------------------
  // BEAT 5 — Grants: a subject is permissive until its first grant, then it is
  // enforced and holds exactly the scopes it was given. Carol writes freely at
  // first; her first grant (read) flips her; a write then denies; granting write
  // restores it. (Alice is untouched: enforcement is per subject.)
  // ---------------------------------------------------------------------------
  const carolFree = await t.mutation(api.example.writeMemoryEmbedded, {
    subject: CAROL,
    orgCode: ORG_A,
    key: 'carol/first',
    content: 'written while permissive'
  });
  expect(carolFree.outcome).toBe('created');

  await t.mutation(api.example.grantAccess, {
    subject: ADMIN,
    orgCode: ORG_A,
    targetSubject: CAROL,
    scope: 'memory.read'
  }); // first grant flips Carol to enforced

  // Carol now holds read but not write: a write denies with a typed code.
  await expectClientError(
    t.mutation(api.example.writeMemoryEmbedded, {
      subject: CAROL,
      orgCode: ORG_A,
      key: 'carol/second',
      content: 'should be denied'
    }),
    'scope_not_granted'
  );

  await t.mutation(api.example.grantAccess, {
    subject: ADMIN,
    orgCode: ORG_A,
    targetSubject: CAROL,
    scope: 'memory.write'
  });
  const carolAllowed = await t.mutation(api.example.writeMemoryEmbedded, {
    subject: CAROL,
    orgCode: ORG_A,
    key: 'carol/second',
    content: 'now allowed'
  });
  expect(carolAllowed.outcome).toBe('created');

  // ---------------------------------------------------------------------------
  // BEAT 6 — A record for provenance: created by Alice, later updated by a
  // different actor. The creation stamp is immutable; the write stamp moves.
  // Recorded here, inspected in BEAT 9.
  // ---------------------------------------------------------------------------
  const provRecord = await t.mutation(api.example.writeMemoryEmbedded, {
    subject: ALICE,
    orgCode: ORG_A,
    key: 'a/policy-doc',
    content: 'v1 by alice'
  });
  await t.mutation(api.example.writeMemoryEmbedded, {
    subject: DEPUTY, // a different actor updates the same record
    orgCode: ORG_A,
    key: 'a/policy-doc',
    content: 'v2 by deputy'
  });

  // ---------------------------------------------------------------------------
  // BEAT 7 — Correlation. A request id threaded through related calls stitches
  // them together in the audit trail. Here one write and one read share an id.
  // ---------------------------------------------------------------------------
  const CORR = 'story-correlation-9f2a';
  await http(t, '/memory/write', TOKEN_A, {
    key: 'a/corr-doc',
    content: 'threaded through a correlation id',
    embedding: fakeEmbed('threaded through a correlation id'),
    correlationId: CORR
  });
  await http(t, '/memory/get', TOKEN_A, {
    key: 'a/corr-doc',
    correlationId: CORR
  });
  const correlated = await t.query(api.example.auditLog, {
    orgCode: ORG_A,
    correlationId: CORR,
    numItems: 50,
    cursor: null
  });
  expect(correlated.rows).toHaveLength(2); // the write and the read
  expect(correlated.rows.every((row) => row.correlationId === CORR)).toBe(true);
  expect(correlated.rows.map((row) => row.operation).sort()).toEqual([
    'get',
    'write'
  ]);

  // ---------------------------------------------------------------------------
  // BEAT 8 — Revocation and the mid-run authority death. Alice recalls fine one
  // moment; her agent is revoked; the very next recall is denied 'revoked' even
  // though the credentials are unchanged; lifting the revocation restores her.
  // ---------------------------------------------------------------------------
  const beforeRevoke = await http(t, '/memory/recall', TOKEN_A, {
    query: SHARED_QUERY,
    topK: 10
  });
  expect(beforeRevoke.status).toBe(200); // works right now

  await t.mutation(api.example.revokeCaller, {
    subject: ADMIN,
    orgCode: ORG_A,
    target: {kind: 'subject', orgCode: ORG_A, subject: ALICE},
    reason: REVOCATION_REASON
  });

  const afterRevoke = await http(t, '/memory/recall', TOKEN_A, {
    query: SHARED_QUERY,
    topK: 10
  });
  expect(afterRevoke.status).toBe(403); // same call, now denied
  expect(afterRevoke.body.code).toBe('revoked');
  // The revocation reason never rides out over the wire.
  expect(JSON.stringify(afterRevoke.body)).not.toContain(REVOCATION_REASON);

  // B is a different tenant: the revocation of A's agent does not touch it.
  const bStillWorks = await http(t, '/memory/recall', TOKEN_B, {
    query: SHARED_QUERY,
    topK: 10
  });
  expect(bStillWorks.status).toBe(200);

  // Lift it: Alice is back.
  await t.mutation(api.example.liftCaller, {
    subject: ADMIN,
    orgCode: ORG_A,
    target: {kind: 'subject', orgCode: ORG_A, subject: ALICE}
  });
  const afterLift = await http(t, '/memory/recall', TOKEN_A, {
    query: SHARED_QUERY,
    topK: 10
  });
  expect(afterLift.status).toBe(200); // restored

  // ---------------------------------------------------------------------------
  // BEAT 9 — Provenance and the audit trail. The provenance surface separates
  // the immutable creation event from the latest write. The audit log for A
  // reads newest-first and is coherent. And the 'revoked' denial from BEAT 8
  // joins to its reason WITHOUT the reason ever entering the audit row.
  // ---------------------------------------------------------------------------
  const provenance = await t.query(api.example.memoryProvenance, {
    orgCode: ORG_A,
    memoryId: provRecord.memoryId
  });
  expect(provenance).not.toBeNull();
  if (provenance === null) throw new Error('unreachable');
  expect(provenance.createdBy).toBe(ALICE); // creation is immutable
  expect(provenance.writtenBy).toBe(DEPUTY); // latest write moved
  expect(provenance.writtenAt).toBeGreaterThanOrEqual(provenance.createdAt);

  const trail = await t.query(api.example.auditLog, {
    orgCode: ORG_A,
    numItems: 200,
    cursor: null
  });
  expect(trail.rows.length).toBeGreaterThan(0);
  // Newest-first: timestamps are non-increasing down the page.
  for (let i = 1; i < trail.rows.length; i++) {
    expect(trail.rows[i - 1].ts).toBeGreaterThanOrEqual(trail.rows[i].ts);
  }
  // The trail is coherent: it holds the writes, the recalls, and the revocation.
  const operations = new Set(trail.rows.map((row) => row.operation));
  expect(operations.has('write')).toBe(true);
  expect(operations.has('recall')).toBe(true);
  expect(operations.has('revoke')).toBe(true);

  // The reason join. The 'revoked' denial row carries the revocation TARGET
  // digest, never the reason. inspectRevocation returns that same digest plus
  // the reason — so an auditor can answer "why was this denied" by following the
  // digest, while the reason itself never sat in the append-only log.
  const revokedRow = trail.rows.find(
    (row) => row.decision === 'denied' && row.reasonCode === 'revoked'
  );
  expect(revokedRow).toBeDefined();
  if (revokedRow === undefined) throw new Error('unreachable');
  const inspection = await t.query(api.example.inspectRevocation, {
    orgCode: ORG_A,
    target: {kind: 'subject', orgCode: ORG_A, subject: ALICE}
  });
  expect(revokedRow.keyOrQueryDigest).toBe(inspection.targetDigest); // the join
  expect(inspection.revocations[0].reason).toBe(REVOCATION_REASON); // reason here
  // ...and nowhere in the audit trail.
  expect(JSON.stringify(trail.rows)).not.toContain(REVOCATION_REASON);
});
