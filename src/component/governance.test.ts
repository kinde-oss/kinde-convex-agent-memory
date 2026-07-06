/// <reference types="vite/client" />
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {CONTENT_REDACTED} from './lib/redaction.js';
import {
  auditRows,
  initConvexTest,
  TEST_SIGNING_SECRET,
  unitEmbedding
} from './testHelpers.shared.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

// Hardening: stub the declared signing secret before every test (file-scoped
// hook; see setup.test.ts). Keys the grant/redaction audit digests asserted.
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const ADMIN = 'user_admin';
const SECRET = 'TOP-SECRET-CONTENT-a3f8c2';
const HUSH = 'SENSITIVE-METADATA-9e1b44';

async function memoryRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('memories').collect());
}

async function writeAs(t: ConvexTest, subject: string, key: string) {
  return await t.mutation(api.memory.write, {
    subject,
    orgCode: ORG_A,
    key,
    content: SECRET,
    metadata: {secret: HUSH, keep: 'visible'},
    embedding: unitEmbedding()
  });
}

async function grantScope(
  t: ConvexTest,
  targetSubject: string,
  scope: 'memory.read' | 'memory.write' | 'memory.recall'
) {
  const result = await t.mutation(api.grants.grant, {
    subject: ADMIN,
    orgCode: ORG_A,
    targetSubject,
    scope
  });
  if (!result.ok) throw new Error(`test grant denied: ${result.code}`);
  return result;
}

describe('the mode boundary (per-subject enforcement)', () => {
  test('zero grants → fully permissive; the FIRST grant row flips only that subject to enforced', async () => {
    const t = initConvexTest();
    // Baseline: no grants anywhere — every operation permissive (P1–P3).
    const before = await writeAs(t, ALICE, 'pre/grant');
    expect(before.ok).toBe(true);

    // ALICE gets one grant — read only. She is now ENFORCED.
    await grantScope(t, ALICE, 'memory.read');

    // Ungranted scope for ALICE: denied, audited.
    const denied = await writeAs(t, ALICE, 'post/grant');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.code).toBe('scope_not_granted');

    // Granted scope for ALICE still works.
    const read = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'pre/grant'
    });
    expect(read.ok).toBe(true);

    // BOB, same tenant, zero grant rows: STILL permissive.
    const bobWrite = await writeAs(t, BOB, 'bob/free');
    expect(bobWrite.ok).toBe(true);

    // The denial audited exactly once, under the verified org.
    const denials = (await auditRows(t)).filter(
      (row) => row.decision === 'denied'
    );
    expect(denials).toHaveLength(1);
    expect(denials[0].reasonCode).toBe('scope_not_granted');
    expect(denials[0].operation).toBe('write');
    expect(denials[0].subject).toBe(ALICE);
  });

  test('grants are tenant-scoped: a grant in org A does not enforce the same subject in org B', async () => {
    const t = initConvexTest();
    await grantScope(t, ALICE, 'memory.read');
    // Same subject name in ANOTHER tenant: no grant rows there → permissive.
    const write = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_B,
      key: 'free/write',
      content: 'c'
    });
    expect(write.ok).toBe(true);
  });

  test('a fully revoked subject stays ENFORCED (locked out), never permissive again', async () => {
    const t = initConvexTest();
    await grantScope(t, ALICE, 'memory.write');
    await t.mutation(api.grants.revokeGrant, {
      subject: ADMIN,
      orgCode: ORG_A,
      targetSubject: ALICE,
      scope: 'memory.write'
    });
    // ALICE's only grant is revoked — she must NOT fall back to permissive.
    const write = await writeAs(t, ALICE, 'locked/out');
    expect(write.ok).toBe(false);
    if (write.ok) throw new Error('unreachable');
    expect(write.code).toBe('scope_not_granted');
  });

  test('every operation is gated by its own scope (get/list share memory.read; recall needs memory.recall)', async () => {
    const t = initConvexTest();
    await writeAs(t, ALICE, 'a/data');
    await grantScope(t, ALICE, 'memory.write'); // enforced, write only

    const get = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/data'
    });
    expect(get.ok).toBe(false);
    if (get.ok) throw new Error('unreachable');
    expect(get.code).toBe('scope_not_granted');

    const list = await t.mutation(api.memory.list, {
      subject: ALICE,
      orgCode: ORG_A,
      paginationOpts: {numItems: 10, cursor: null}
    });
    expect(list.ok).toBe(false);
    if (list.ok) throw new Error('unreachable');
    expect(list.code).toBe('scope_not_granted');

    const recall = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: unitEmbedding(),
      topK: 8
    });
    expect(recall.ok).toBe(false);
    if (recall.ok) throw new Error('unreachable');
    expect(recall.code).toBe('scope_not_granted');

    // Each denial audited exactly once: get, list, recall.
    const denials = (await auditRows(t)).filter(
      (row) => row.reasonCode === 'scope_not_granted'
    );
    expect(denials.map((row) => row.operation).sort()).toEqual([
      'get',
      'list',
      'recall'
    ]);
  });
});

describe('grant lifecycle', () => {
  test('grant → allowed; revoke → denied; re-grant → allowed again', async () => {
    const t = initConvexTest();
    await grantScope(t, ALICE, 'memory.write');
    expect((await writeAs(t, ALICE, 'k1')).ok).toBe(true);

    await t.mutation(api.grants.revokeGrant, {
      subject: ADMIN,
      orgCode: ORG_A,
      targetSubject: ALICE,
      scope: 'memory.write'
    });
    const denied = await writeAs(t, ALICE, 'k2');
    expect(denied.ok).toBe(false);

    // Re-granting after revocation inserts a fresh row and re-permits.
    const regrant = await grantScope(t, ALICE, 'memory.write');
    expect(regrant.outcome).toBe('granted');
    expect((await writeAs(t, ALICE, 'k3')).ok).toBe(true);
  });

  test('granting an already-active scope is idempotent (already_granted, no new row)', async () => {
    const t = initConvexTest();
    const first = await grantScope(t, ALICE, 'memory.read');
    const second = await grantScope(t, ALICE, 'memory.read');
    expect(first.outcome).toBe('granted');
    expect(second.outcome).toBe('already_granted');
    expect(second.grantId).toBe(first.grantId);
    const rows = await t.run(async (ctx) =>
      ctx.db.query('accessGrants').collect()
    );
    expect(rows).toHaveLength(1);
  });

  test('revoking a nonexistent (or already revoked) grant is a typed denial, never a silent no-op', async () => {
    const t = initConvexTest();
    const never = await t.mutation(api.grants.revokeGrant, {
      subject: ADMIN,
      orgCode: ORG_A,
      targetSubject: ALICE,
      scope: 'memory.read'
    });
    expect(never.ok).toBe(false);
    if (never.ok) throw new Error('unreachable');
    expect(never.code).toBe('grant_not_found');

    await grantScope(t, ALICE, 'memory.read');
    await t.mutation(api.grants.revokeGrant, {
      subject: ADMIN,
      orgCode: ORG_A,
      targetSubject: ALICE,
      scope: 'memory.read'
    });
    const again = await t.mutation(api.grants.revokeGrant, {
      subject: ADMIN,
      orgCode: ORG_A,
      targetSubject: ALICE,
      scope: 'memory.read'
    });
    expect(again.ok).toBe(false);
    if (again.ok) throw new Error('unreachable');
    expect(again.code).toBe('grant_not_found');
  });

  test('grant and revoke each audit exactly one row with the operation and outcome', async () => {
    const t = initConvexTest();
    await grantScope(t, ALICE, 'memory.read');
    await t.mutation(api.grants.revokeGrant, {
      subject: ADMIN,
      orgCode: ORG_A,
      targetSubject: ALICE,
      scope: 'memory.read',
      correlationId: 'corr-revoke-1'
    });
    const audit = await auditRows(t);
    expect(audit).toHaveLength(2);
    expect(audit[0].operation).toBe('grant');
    expect(audit[0].reasonCode).toBe('granted');
    expect(audit[1].operation).toBe('revoke_grant');
    expect(audit[1].reasonCode).toBe('revoked');
    expect(audit[1].correlationId).toBe('corr-revoke-1');
    // The target subject's raw identity is digested, never plain, in the
    // descriptor (the audit's own subject column is the CALLER).
    expect(audit[0].keyOrQueryDigest).toMatch(/^v1:grant:memory\.read:/);
    expect(audit[0].keyOrQueryDigest).not.toContain(ALICE);
  });

  test('tenant-context conflict on grant is denied and audited before any grant access', async () => {
    const t = initConvexTest();
    const denied = await t.mutation(api.grants.grant, {
      subject: ADMIN,
      orgCode: ORG_A,
      claimedOrgCode: ORG_B,
      targetSubject: ALICE,
      scope: 'memory.read'
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.code).toBe('tenant_context_conflict');
    const rows = await t.run(async (ctx) =>
      ctx.db.query('accessGrants').collect()
    );
    expect(rows).toHaveLength(0);
  });
});

describe('redaction-on-read (every path, one egress)', () => {
  async function setOrgPolicy(t: ConvexTest, fields: string[]) {
    const result = await t.mutation(api.policy.setRedaction, {
      subject: ADMIN,
      orgCode: ORG_A,
      fields
    });
    if (!result.ok) throw new Error(`test policy denied: ${result.code}`);
    return result;
  }

  test('get, list, and recall all egress the same redaction; the stored row is untouched', async () => {
    const t = initConvexTest();
    await writeAs(t, ALICE, 'a/doc');
    await setOrgPolicy(t, ['secret', 'content']);

    // get
    const got = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/doc'
    });
    if (!got.ok) throw new Error('unreachable');
    expect(got.memory?.content).toBe(CONTENT_REDACTED);
    expect(got.memory?.metadata).toEqual({keep: 'visible'});

    // list
    const listed = await t.mutation(api.memory.list, {
      subject: ALICE,
      orgCode: ORG_A,
      paginationOpts: {numItems: 10, cursor: null}
    });
    if (!listed.ok) throw new Error('unreachable');
    expect(listed.page).toHaveLength(1);
    expect(listed.page[0].content).toBe(CONTENT_REDACTED);
    expect(listed.page[0].metadata).toEqual({keep: 'visible'});

    // recall
    const recalled = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: unitEmbedding(),
      topK: 8
    });
    if (!recalled.ok) throw new Error('unreachable');
    expect(recalled.matches).toHaveLength(1);
    expect(recalled.matches[0].memory.content).toBe(CONTENT_REDACTED);
    expect(recalled.matches[0].memory.metadata).toEqual({keep: 'visible'});

    // The STORED row still holds the raw values — redaction is egress-only.
    const stored = await memoryRows(t);
    expect(stored[0].content).toBe(SECRET);
    expect(stored[0].metadata).toEqual({secret: HUSH, keep: 'visible'});

    // And no redacted value leaked into any audit row.
    const serialized = JSON.stringify(await auditRows(t));
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(HUSH);
  });

  test('a subject-targeted policy WINS OUTRIGHT over the org-wide one', async () => {
    const t = initConvexTest();
    await writeAs(t, ALICE, 'a/doc');
    await setOrgPolicy(t, ['content']);
    const targeted = await t.mutation(api.policy.setRedaction, {
      subject: ADMIN,
      orgCode: ORG_A,
      targetSubject: ALICE,
      fields: ['secret']
    });
    expect(targeted.ok).toBe(true);

    // ALICE reads under HER policy: content visible, 'secret' omitted.
    const aliceGet = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/doc'
    });
    if (!aliceGet.ok) throw new Error('unreachable');
    expect(aliceGet.memory?.content).toBe(SECRET);
    expect(aliceGet.memory?.metadata).toEqual({keep: 'visible'});

    // BOB reads under the ORG-WIDE policy: content sentineled, metadata kept.
    const bobGet = await t.mutation(api.memory.get, {
      subject: BOB,
      orgCode: ORG_A,
      key: 'a/doc'
    });
    if (!bobGet.ok) throw new Error('unreachable');
    expect(bobGet.memory?.content).toBe(CONTENT_REDACTED);
    expect(bobGet.memory?.metadata).toEqual({
      secret: HUSH,
      keep: 'visible'
    });
  });

  test('redaction is tenant-scoped: org A policy never touches org B reads', async () => {
    const t = initConvexTest();
    await setOrgPolicy(t, ['content']);
    await t.mutation(api.memory.write, {
      subject: BOB,
      orgCode: ORG_B,
      key: 'b/doc',
      content: 'b content'
    });
    const got = await t.mutation(api.memory.get, {
      subject: BOB,
      orgCode: ORG_B,
      key: 'b/doc'
    });
    if (!got.ok) throw new Error('unreachable');
    expect(got.memory?.content).toBe('b content');
  });

  test('setRedaction replaces the existing policy for the same target', async () => {
    const t = initConvexTest();
    await writeAs(t, ALICE, 'a/doc');
    await setOrgPolicy(t, ['content']);
    await setOrgPolicy(t, ['secret']); // replace: content no longer redacted
    const got = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/doc'
    });
    if (!got.ok) throw new Error('unreachable');
    expect(got.memory?.content).toBe(SECRET);
    expect(got.memory?.metadata).toEqual({keep: 'visible'});
    const policies = await t.run(async (ctx) =>
      ctx.db.query('redactionPolicies').collect()
    );
    expect(policies).toHaveLength(1);
  });

  test('DOCUMENTED CHOICE: empty fields clears the policy; clearing a nonexistent one is a typed denial', async () => {
    const t = initConvexTest();
    await writeAs(t, ALICE, 'a/doc');

    const nothingToClear = await t.mutation(api.policy.setRedaction, {
      subject: ADMIN,
      orgCode: ORG_A,
      fields: []
    });
    expect(nothingToClear.ok).toBe(false);
    if (nothingToClear.ok) throw new Error('unreachable');
    expect(nothingToClear.code).toBe('policy_not_found');

    await setOrgPolicy(t, ['content']);
    const cleared = await setOrgPolicy(t, []);
    expect(cleared.outcome).toBe('cleared');

    const got = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/doc'
    });
    if (!got.ok) throw new Error('unreachable');
    expect(got.memory?.content).toBe(SECRET);
  });

  test('malformed fields (empty string, duplicates) deny invalid_redaction_fields, audited', async () => {
    const t = initConvexTest();
    for (const fields of [[''], ['secret', 'secret']]) {
      const denied = await t.mutation(api.policy.setRedaction, {
        subject: ADMIN,
        orgCode: ORG_A,
        fields
      });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error('unreachable');
      expect(denied.code).toBe('invalid_redaction_fields');
    }
    const audit = await auditRows(t);
    expect(audit).toHaveLength(2);
    for (const row of audit) {
      expect(row.operation).toBe('set_redaction');
      expect(row.decision).toBe('denied');
      expect(row.reasonCode).toBe('invalid_redaction_fields');
    }
  });

  test('setRedaction audits one row per call with a digest, never raw field names', async () => {
    const t = initConvexTest();
    await t.mutation(api.policy.setRedaction, {
      subject: ADMIN,
      orgCode: ORG_A,
      fields: ['secret', 'content'],
      correlationId: 'corr-policy-1'
    });
    const audit = await auditRows(t);
    expect(audit).toHaveLength(1);
    expect(audit[0].operation).toBe('set_redaction');
    expect(audit[0].reasonCode).toBe('redaction_set');
    expect(audit[0].correlationId).toBe('corr-policy-1');
    expect(audit[0].keyOrQueryDigest).toMatch(/^v1:redaction:/);
    expect(audit[0].keyOrQueryDigest).not.toContain('secret');
  });
});
