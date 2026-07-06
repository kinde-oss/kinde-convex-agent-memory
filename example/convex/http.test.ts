/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {internal} from './_generated/api.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './testHelpers.shared.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

// Hardening: stub the declared signing secret before every test (file-scoped
// hook; see setup.test.ts).
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

const TOKEN_A = 'token-alice-orgA'; // → user_alice / org_alpha
const TOKEN_B = 'token-bob-orgB'; // → user_bob / org_beta
const TOKEN_NO_ORG = 'token-no-org'; // → orgCode null (malformed for memory ops)

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

/** POST a JSON payload with an optional bearer token. */
async function call(
  t: ConvexTest,
  path: string,
  token: string | null,
  payload: unknown
): Promise<HttpResult> {
  const headers: Record<string, string> = {'content-type': 'application/json'};
  if (token !== null) {
    headers.authorization = `Bearer ${token}`;
  }
  const res = await t.fetch(path, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload)
  });
  return {
    status: res.status,
    body: (await res.json()) as Record<string, unknown>
  };
}

async function orgAudit(t: ConvexTest, orgCode: string, subject?: string) {
  const result = await t.query(internal.example.auditLog, {
    orgCode,
    ...(subject === undefined ? {} : {subject}),
    numItems: 100,
    cursor: null
  });
  return result.rows;
}

test('write then get over HTTP, bound to the token tenant', async () => {
  const t = initConvexTest();
  const w = await call(t, '/memory/write', TOKEN_A, {
    key: 'notes/1',
    content: 'hello over http'
  });
  expect(w.status).toBe(200);
  expect(w.body.ok).toBe(true);

  const g = await call(t, '/memory/get', TOKEN_A, {key: 'notes/1'});
  expect(g.status).toBe(200);
  expect((g.body.memory as {content: string}).content).toBe('hello over http');
});

test('the body cannot smuggle a foreign tenant: orgCode conflict is rejected AND audited', async () => {
  const t = initConvexTest();
  // Token verifies org_alpha; body claims org_beta → claimedOrgCode conflict.
  const w = await call(t, '/memory/write', TOKEN_A, {
    key: 'k',
    content: 'c',
    orgCode: 'org_beta'
  });
  expect(w.status).toBe(403);
  expect(w.body.code).toBe('tenant_context_conflict');

  // Nothing landed in org_beta: token B (org_beta) sees no such key.
  const g = await call(t, '/memory/get', TOKEN_B, {key: 'k'});
  expect(g.status).toBe(200);
  expect(g.body.memory).toBeNull();

  // The conflict reached the governed op, so it audited once under org_alpha.
  const conflicts = (await orgAudit(t, 'org_alpha')).filter(
    (row) => row.reasonCode === 'tenant_context_conflict'
  );
  expect(conflicts).toHaveLength(1);
});

test('a body orgCode that MATCHES the verified tenant is accepted', async () => {
  const t = initConvexTest();
  const w = await call(t, '/memory/write', TOKEN_A, {
    key: 'k',
    content: 'c',
    orgCode: 'org_alpha'
  });
  expect(w.status).toBe(200);
  expect(w.body.ok).toBe(true);
});

test('cross-tenant isolation over the wire: token B cannot read token Aʼs key', async () => {
  const t = initConvexTest();
  await call(t, '/memory/write', TOKEN_A, {key: 'secret/1', content: 'a-only'});
  const g = await call(t, '/memory/get', TOKEN_B, {key: 'secret/1'});
  expect(g.status).toBe(200);
  expect(g.body.memory).toBeNull(); // not found in org_beta, no oracle
});

test('list over HTTP returns only the token tenantʼs keys', async () => {
  const t = initConvexTest();
  await call(t, '/memory/write', TOKEN_A, {key: 'notes/a', content: 'x'});
  await call(t, '/memory/write', TOKEN_A, {key: 'notes/b', content: 'y'});
  await call(t, '/memory/write', TOKEN_B, {key: 'notes/c', content: 'z'});
  const r = await call(t, '/memory/list', TOKEN_A, {
    numItems: 50,
    cursor: null,
    filter: {keyPrefix: 'notes/'}
  });
  expect(r.status).toBe(200);
  const page = r.body.page as Array<{key: string; orgCode: string}>;
  expect(page.map((row) => row.key).sort()).toEqual(['notes/a', 'notes/b']);
  expect(page.every((row) => row.orgCode === 'org_alpha')).toBe(true);
});

test('missing Authorization → 401, nothing written, NOTHING audited (seam-level)', async () => {
  const t = initConvexTest();
  const res = await t.fetch('/memory/write', {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify({key: 'k', content: 'c'})
  });
  expect(res.status).toBe(401);
  expect(((await res.json()) as {code: string}).code).toBe(
    'missing_authorization'
  );
  // Seam-level rejection is BEFORE any governed op → no audit row.
  expect(await orgAudit(t, 'org_alpha')).toHaveLength(0);
});

test('malformed Authorization → 401 malformed_authorization', async () => {
  const t = initConvexTest();
  const res = await t.fetch('/memory/write', {
    method: 'POST',
    headers: {authorization: 'Basic xyz', 'content-type': 'application/json'},
    body: JSON.stringify({key: 'k', content: 'c'})
  });
  expect(res.status).toBe(401);
  expect(((await res.json()) as {code: string}).code).toBe(
    'malformed_authorization'
  );
});

test('an unknown/bad token (verifyCaller throws) → 401 unauthorized', async () => {
  const t = initConvexTest();
  const r = await call(t, '/memory/write', 'token-unknown', {
    key: 'k',
    content: 'c'
  });
  expect(r.status).toBe(401);
  expect(r.body.code).toBe('unauthorized');
});

test('verifyCaller returns a tenant-less caller → 500 verify_caller_response_malformed', async () => {
  const t = initConvexTest();
  const r = await call(t, '/memory/write', TOKEN_NO_ORG, {
    key: 'k',
    content: 'c'
  });
  expect(r.status).toBe(500);
  expect(r.body.code).toBe('verify_caller_response_malformed');
  expect(await orgAudit(t, 'org_alpha')).toHaveLength(0);
});

test('malformed JSON body → 400 request_body_malformed, NOTHING audited', async () => {
  const t = initConvexTest();
  const res = await t.fetch('/memory/write', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN_A}`,
      'content-type': 'application/json'
    },
    body: '{ this is not json'
  });
  expect(res.status).toBe(400);
  expect(((await res.json()) as {code: string}).code).toBe(
    'request_body_malformed'
  );
  expect(await orgAudit(t, 'org_alpha')).toHaveLength(0);
});

test('a governed denial (revoked) over HTTP → 403 with code + correlationId, audited ONCE by the component', async () => {
  const t = initConvexTest();
  const REASON = 'http-revoke-reason-secret';
  await t.mutation(internal.example.revokeCaller, {
    subject: 'user_admin',
    orgCode: 'org_alpha',
    target: {kind: 'subject', orgCode: 'org_alpha', subject: 'user_alice'},
    reason: REASON
  });

  const r = await call(t, '/memory/write', TOKEN_A, {key: 'k', content: 'c'});
  expect(r.status).toBe(403);
  expect(r.body.code).toBe('revoked');
  expect(typeof r.body.correlationId).toBe('string');
  // The reason never rides out over the wire.
  expect(JSON.stringify(r.body)).not.toContain(REASON);

  // The denial audited exactly once — from the component, not the seam.
  const revokedRows = (await orgAudit(t, 'org_alpha', 'user_alice')).filter(
    (row) => row.decision === 'denied' && row.reasonCode === 'revoked'
  );
  expect(revokedRows).toHaveLength(1);
});

test('recall over HTTP via the fake embedder works and stays tenant-partitioned', async () => {
  const t = initConvexTest();
  // Seed an embedded memory in org_alpha (the driver embeds the content).
  await t.mutation(internal.example.writeMemoryEmbedded, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    key: 'facts/sky',
    content: 'the sky is blue'
  });

  const rA = await call(t, '/memory/recall', TOKEN_A, {
    query: 'the sky is blue',
    topK: 8
  });
  expect(rA.status).toBe(200);
  const matchesA = rA.body.matches as Array<{memory: {key: string}}>;
  expect(matchesA.length).toBeGreaterThanOrEqual(1);
  expect(matchesA[0].memory.key).toBe('facts/sky');

  // Token B (org_beta) recalling the same query is outside the partition.
  const rB = await call(t, '/memory/recall', TOKEN_B, {
    query: 'the sky is blue',
    topK: 8
  });
  expect(rB.status).toBe(200);
  expect((rB.body.matches as unknown[]).length).toBe(0);
});
