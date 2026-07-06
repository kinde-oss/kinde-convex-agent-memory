/// <reference types="vite/client" />
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {digestRevocationTarget} from './lib/digest.js';
import {EMBEDDING_DIMENSIONS} from './lib/embedding.js';
import {
  auditRows,
  expectFail,
  initConvexTest,
  TEST_SIGNING_SECRET
} from './testHelpers.shared.js';

beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const ADMIN = 'user_admin';

describe('the revocation-reason join', () => {
  test('revoked denial omits the reason; inspect returns it; the target digest joins them', async () => {
    const t = initConvexTest();
    const REASON = 'REASON-legal-hold-7c1f44';

    await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target: {kind: 'subject', orgCode: ORG_A, subject: ALICE},
      reason: REASON
    });

    // ALICE hits her revocation → one 'revoked' denial audit row.
    const denied = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'k',
      content: 'c'
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.code).toBe('revoked');
    expect(denied.message).not.toContain(REASON);

    const revokedRow = (await auditRows(t)).find(
      (row) => row.decision === 'denied' && row.reasonCode === 'revoked'
    );
    expect(revokedRow).toBeDefined();
    if (revokedRow === undefined) throw new Error('unreachable');
    // The reason NEVER entered the append-only audit log.
    expect(JSON.stringify(revokedRow)).not.toContain(REASON);

    // The join: inspect the target → reason + actor, plus the target digest.
    const inspection = await t.query(api.revocations.inspect, {
      orgCode: ORG_A,
      target: {kind: 'subject', orgCode: ORG_A, subject: ALICE}
    });
    expect(inspection.revocations).toHaveLength(1);
    expect(inspection.revocations[0].reason).toBe(REASON);
    expect(inspection.revocations[0].revokedBy).toBe(ADMIN);

    // The digest on the audit row === the inspected target's digest === an
    // independently computed digest: the join is followable.
    const expected = await digestRevocationTarget('subject', ORG_A, ALICE);
    expect(revokedRow.keyOrQueryDigest).toBe(expected);
    expect(inspection.targetDigest).toBe(expected);
  });

  test('recall path too: a revoked recall row carries the joinable target digest', async () => {
    const t = initConvexTest();
    await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target: {kind: 'subject', orgCode: ORG_A, subject: ALICE},
      reason: 'recall-reason'
    });
    const embedding = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    embedding[0] = 1;
    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding,
      topK: 8
    });
    expect(result.ok).toBe(false);
    const revokedRow = (await auditRows(t)).find(
      (row) =>
        row.operation === 'recall' &&
        row.decision === 'denied' &&
        row.reasonCode === 'revoked'
    );
    if (revokedRow === undefined) throw new Error('unreachable');
    const expected = await digestRevocationTarget('subject', ORG_A, ALICE);
    expect(revokedRow.keyOrQueryDigest).toBe(expected);
  });

  test('inspect is tenant-scoped: an org target for another tenant throws', async () => {
    const t = initConvexTest();
    await expectFail(
      t.query(api.revocations.inspect, {
        orgCode: ORG_A,
        target: {kind: 'org', orgCode: ORG_B}
      }),
      'invalid_revocation_target'
    );
  });

  test('inspect: claimedOrgCode conflict throws tenant_context_conflict', async () => {
    const t = initConvexTest();
    await expectFail(
      t.query(api.revocations.inspect, {
        orgCode: ORG_A,
        claimedOrgCode: 'other',
        target: {kind: 'global'}
      }),
      'tenant_context_conflict'
    );
  });

  test('a global revocation is inspectable (with reason) from any tenant it governs', async () => {
    const t = initConvexTest();
    const REASON = 'GLOBAL-REASON-platform-breach';
    await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target: {kind: 'global'},
      reason: REASON
    });
    // A DIFFERENT tenant, governed by the global revocation, reads its reason.
    const inspection = await t.query(api.revocations.inspect, {
      orgCode: ORG_B,
      target: {kind: 'global'}
    });
    expect(inspection.revocations).toHaveLength(1);
    expect(inspection.revocations[0].reason).toBe(REASON);
  });

  test('inspect returns active AND historical rows (newest first)', async () => {
    const t = initConvexTest();
    const target = {kind: 'subject', orgCode: ORG_A, subject: ALICE} as const;
    await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target,
      reason: 'first'
    });
    await t.mutation(api.revocations.liftRevocation, {
      subject: ADMIN,
      orgCode: ORG_A,
      target
    });
    await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target,
      reason: 'second'
    });
    const inspection = await t.query(api.revocations.inspect, {
      orgCode: ORG_A,
      target
    });
    expect(inspection.revocations).toHaveLength(2);
    // Newest first: the still-active 'second' precedes the lifted 'first'.
    expect(inspection.revocations[0].reason).toBe('second');
    expect(inspection.revocations[0].liftedAt).toBeNull();
    expect(inspection.revocations[1].reason).toBe('first');
    expect(inspection.revocations[1].liftedAt).not.toBeNull();
  });
});
