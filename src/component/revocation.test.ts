/// <reference types="vite/client" />
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {EMBEDDING_DIMENSIONS} from './lib/embedding.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './setup.test.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

// Hardening: stub the declared signing secret before every test (file-scoped
// hook; see setup.test.ts). Keys the revoke/lift audit digests.
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const ADMIN = 'user_admin';
// A distinctive reason so a test can prove it NEVER lands in an audit row or a
// denial message — it must live on the revocation row alone.
const REASON = 'REASON-SENSITIVE-legal-hold-7c1f44';

async function auditRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('audit').collect());
}
async function revocationRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('revocations').collect());
}

function unitEmbedding(): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[0] = 1;
  return vector;
}

async function write(
  t: ConvexTest,
  subject: string,
  orgCode: string,
  key: string
) {
  return await t.mutation(api.memory.write, {
    subject,
    orgCode,
    key,
    content: 'content-body'
  });
}

async function getKey(
  t: ConvexTest,
  subject: string,
  orgCode: string,
  key: string
) {
  return await t.mutation(api.memory.get, {subject, orgCode, key});
}

async function grantScope(
  t: ConvexTest,
  orgCode: string,
  targetSubject: string,
  scope: 'memory.read' | 'memory.write' | 'memory.recall'
) {
  const result = await t.mutation(api.grants.grant, {
    subject: ADMIN,
    orgCode,
    targetSubject,
    scope
  });
  if (!result.ok) throw new Error(`test grant denied: ${result.code}`);
  return result;
}

type Target =
  | {kind: 'global'}
  | {kind: 'org'; orgCode: string}
  | {
      kind: 'subject';
      orgCode: string;
      subject: string;
    };

async function revoke(
  t: ConvexTest,
  orgCode: string,
  target: Target,
  correlationId?: string
) {
  return await t.mutation(api.revocations.revoke, {
    subject: ADMIN,
    orgCode,
    target,
    reason: REASON,
    ...(correlationId === undefined ? {} : {correlationId})
  });
}

async function lift(t: ConvexTest, orgCode: string, target: Target) {
  return await t.mutation(api.revocations.liftRevocation, {
    subject: ADMIN,
    orgCode,
    target
  });
}

describe('reactivity: the NEXT call re-evaluates the overlay', () => {
  test('succeeds → revoke → SAME call denied revoked → lift → succeeds again', async () => {
    const t = initConvexTest();
    const args = {subject: ALICE, orgCode: ORG_A, key: 'k', content: 'v'};

    const first = await t.mutation(api.memory.write, args);
    expect(first.ok).toBe(true);

    const r = await revoke(t, ORG_A, {
      kind: 'subject',
      orgCode: ORG_A,
      subject: ALICE
    });
    expect(r.ok).toBe(true);

    const denied = await t.mutation(api.memory.write, args);
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.code).toBe('revoked');

    const l = await lift(t, ORG_A, {
      kind: 'subject',
      orgCode: ORG_A,
      subject: ALICE
    });
    expect(l.ok).toBe(true);

    const again = await t.mutation(api.memory.write, args);
    expect(again.ok).toBe(true);
  });

  test('mid-run authority death: write, revoke(subject), the second write denies', async () => {
    const t = initConvexTest();
    const okWrite = await write(t, ALICE, ORG_A, 'note/1');
    expect(okWrite.ok).toBe(true);

    await revoke(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: ALICE});

    const blocked = await write(t, ALICE, ORG_A, 'note/2');
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    expect(blocked.code).toBe('revoked');
  });
});

describe('each level denies at its own breadth', () => {
  test('global blocks everyone in every org', async () => {
    const t = initConvexTest();
    const r = await revoke(t, ORG_A, {kind: 'global'});
    expect(r.ok).toBe(true);

    const a = await write(t, ALICE, ORG_A, 'k');
    const b = await write(t, BOB, ORG_B, 'k');
    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    if (a.ok || b.ok) throw new Error('unreachable');
    expect(a.code).toBe('revoked');
    expect(b.code).toBe('revoked');
    expect(a.message).toContain('global');
  });

  test('org blocks all subjects in that org but not another org', async () => {
    const t = initConvexTest();
    await revoke(t, ORG_A, {kind: 'org', orgCode: ORG_A});

    const aliceA = await write(t, ALICE, ORG_A, 'k');
    const bobA = await write(t, BOB, ORG_A, 'k');
    const aliceB = await write(t, ALICE, ORG_B, 'k');
    expect(aliceA.ok).toBe(false);
    expect(bobA.ok).toBe(false);
    expect(aliceB.ok).toBe(true); // another org: unaffected
    if (aliceA.ok) throw new Error('unreachable');
    expect(aliceA.code).toBe('revoked');
    expect(aliceA.message).toContain('org-level');
  });

  test('subject blocks exactly that subject in that org', async () => {
    const t = initConvexTest();
    await revoke(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: ALICE});

    const aliceA = await write(t, ALICE, ORG_A, 'k');
    const bobA = await write(t, BOB, ORG_A, 'k');
    const aliceB = await write(t, ALICE, ORG_B, 'k');
    expect(aliceA.ok).toBe(false); // exactly this subject+org
    expect(bobA.ok).toBe(true); // other subject, same org
    expect(aliceB.ok).toBe(true); // same subject, other org
    if (aliceA.ok) throw new Error('unreachable');
    expect(aliceA.message).toContain('subject-level');
  });
});

describe('precedence: a broader active revocation wins', () => {
  test('subject clean but ORG revoked → denied, message names org', async () => {
    const t = initConvexTest();
    await revoke(t, ORG_A, {kind: 'org', orgCode: ORG_A});
    const denied = await write(t, ALICE, ORG_A, 'k');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.code).toBe('revoked');
    expect(denied.message).toContain('org-level');
  });

  test('org clean but GLOBAL revoked → denied, message names global', async () => {
    const t = initConvexTest();
    await revoke(t, ORG_A, {kind: 'global'});
    const denied = await write(t, ALICE, ORG_A, 'k');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.message).toContain('global');
  });

  test('global outranks a co-existing subject revocation (global reported)', async () => {
    const t = initConvexTest();
    await revoke(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: ALICE});
    await revoke(t, ORG_A, {kind: 'global'});
    const denied = await write(t, ALICE, ORG_A, 'k');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.message).toContain('global');
  });
});

describe('revocation OUTRANKS grants', () => {
  test('revoked subject with a valid grant → revoked, not scope_not_granted; new grant does not restore; lift does', async () => {
    const t = initConvexTest();
    // ALICE enforced with a valid memory.read grant, and a record to read.
    await write(t, ALICE, ORG_A, 'k'); // permissive write to seed the record
    await grantScope(t, ORG_A, ALICE, 'memory.read');
    const okRead = await getKey(t, ALICE, ORG_A, 'k');
    expect(okRead.ok).toBe(true);

    // Revoke at subject level: the read now denies 'revoked', NOT 'scope_*'.
    await revoke(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: ALICE});
    const revokedRead = await getKey(t, ALICE, ORG_A, 'k');
    expect(revokedRead.ok).toBe(false);
    if (revokedRead.ok) throw new Error('unreachable');
    expect(revokedRead.code).toBe('revoked');

    // Granting a NEW scope while revoked does not resurrect the subject.
    await grantScope(t, ORG_A, ALICE, 'memory.write');
    const stillBlocked = await write(t, ALICE, ORG_A, 'k2');
    expect(stillBlocked.ok).toBe(false);
    if (stillBlocked.ok) throw new Error('unreachable');
    expect(stillBlocked.code).toBe('revoked');

    // Lifting restores access; the grant then governs exactly as before.
    await lift(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: ALICE});
    const readAgain = await getKey(t, ALICE, ORG_A, 'k');
    expect(readAgain.ok).toBe(true);
  });

  test('permissive subjects (zero grants) are also revocable', async () => {
    const t = initConvexTest();
    // BOB has no grant rows anywhere: permissive. Revocation does not depend
    // on enforcement mode.
    const free = await write(t, BOB, ORG_A, 'free');
    expect(free.ok).toBe(true);
    await revoke(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: BOB});
    const blocked = await write(t, BOB, ORG_A, 'blocked');
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unreachable');
    expect(blocked.code).toBe('revoked');
  });
});

describe('recall path', () => {
  test('revoked subjectʼs recall denies revoked with exactly one audit row', async () => {
    const t = initConvexTest();
    await revoke(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: ALICE});
    const before = (await auditRows(t)).filter(
      (row) => row.operation === 'recall'
    ).length;

    const result = await t.action(api.memory.recall, {
      subject: ALICE,
      orgCode: ORG_A,
      embedding: unitEmbedding(),
      topK: 8
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('revoked');

    const recallRows = (await auditRows(t)).filter(
      (row) => row.operation === 'recall'
    );
    expect(recallRows).toHaveLength(before + 1);
    expect(recallRows[recallRows.length - 1].decision).toBe('denied');
    expect(recallRows[recallRows.length - 1].reasonCode).toBe('revoked');
  });
});

describe('lifecycle re-arms', () => {
  test('revoke → deny → lift → allow → re-revoke → deny; a fresh row on re-revoke', async () => {
    const t = initConvexTest();
    const target = {kind: 'subject', orgCode: ORG_A, subject: ALICE} as const;

    await revoke(t, ORG_A, target);
    expect((await write(t, ALICE, ORG_A, 'a')).ok).toBe(false);

    await lift(t, ORG_A, target);
    expect((await write(t, ALICE, ORG_A, 'b')).ok).toBe(true);

    const reRevoke = await revoke(t, ORG_A, target);
    expect(reRevoke.ok).toBe(true);
    if (!reRevoke.ok) throw new Error('unreachable');
    expect(reRevoke.outcome).toBe('revoked'); // fresh, not already_revoked
    expect((await write(t, ALICE, ORG_A, 'c')).ok).toBe(false);

    // History is kept: two subject rows exist (one lifted, one active).
    const rows = (await revocationRows(t)).filter(
      (row) => row.kind === 'subject'
    );
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.liftedAt === null)).toHaveLength(1);
  });
});

describe('idempotency', () => {
  test('re-revoking an active target replays already_revoked without a new row', async () => {
    const t = initConvexTest();
    const target = {kind: 'org', orgCode: ORG_A} as const;
    const first = await revoke(t, ORG_A, target);
    expect(first.ok).toBe(true);
    if (!first.ok) throw new Error('unreachable');
    expect(first.outcome).toBe('revoked');

    const second = await revoke(t, ORG_A, target);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('already_revoked');
    expect(second.revocationId).toBe(first.revocationId);

    expect(
      (await revocationRows(t)).filter((r) => r.kind === 'org')
    ).toHaveLength(1);
  });
});

describe('contradictory targets and lifting a non-revoked target', () => {
  test('kind org without orgCode → invalid_revocation_target, audited', async () => {
    const t = initConvexTest();
    const result = await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target: {kind: 'org'},
      reason: REASON
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_revocation_target');
    const denials = (await auditRows(t)).filter(
      (row) => row.operation === 'revoke' && row.decision === 'denied'
    );
    expect(denials).toHaveLength(1);
    expect(denials[0].reasonCode).toBe('invalid_revocation_target');
  });

  test('kind global WITH a subject → invalid_revocation_target', async () => {
    const t = initConvexTest();
    const result = await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target: {kind: 'global', subject: ALICE},
      reason: REASON
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_revocation_target');
  });

  test('kind subject without a subject → invalid_revocation_target', async () => {
    const t = initConvexTest();
    const result = await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target: {kind: 'subject', orgCode: ORG_A},
      reason: REASON
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_revocation_target');
  });

  test('org/subject targeting ANOTHER tenant → invalid_revocation_target', async () => {
    const t = initConvexTest();
    const result = await t.mutation(api.revocations.revoke, {
      subject: ADMIN,
      orgCode: ORG_A,
      target: {kind: 'org', orgCode: ORG_B}, // not the caller's tenant
      reason: REASON
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('invalid_revocation_target');
  });

  test('lifting a non-revoked target → revocation_not_found, audited', async () => {
    const t = initConvexTest();
    const result = await lift(t, ORG_A, {
      kind: 'subject',
      orgCode: ORG_A,
      subject: ALICE
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.code).toBe('revocation_not_found');
    const denials = (await auditRows(t)).filter(
      (row) => row.operation === 'lift_revocation' && row.decision === 'denied'
    );
    expect(denials).toHaveLength(1);
    expect(denials[0].reasonCode).toBe('revocation_not_found');
  });
});

describe('global revocation is allowed from a tenant-scoped call (app-trusted)', () => {
  test('a global revoke from ORG_A blocks ORG_B too', async () => {
    const t = initConvexTest();
    const r = await revoke(t, ORG_A, {kind: 'global'});
    expect(r.ok).toBe(true);
    if (!r.ok) throw new Error('unreachable');
    expect(r.outcome).toBe('revoked');
    expect((await write(t, BOB, ORG_B, 'k')).ok).toBe(false);
  });
});

describe('audit trail', () => {
  test('revoke and lift each audit exactly one row with operation + outcome', async () => {
    const t = initConvexTest();
    const target = {kind: 'subject', orgCode: ORG_A, subject: ALICE} as const;
    await revoke(t, ORG_A, target, 'corr-revoke-1');
    await lift(t, ORG_A, target);

    const revokeRows = (await auditRows(t)).filter(
      (row) => row.operation === 'revoke'
    );
    const liftRows = (await auditRows(t)).filter(
      (row) => row.operation === 'lift_revocation'
    );
    expect(revokeRows).toHaveLength(1);
    expect(revokeRows[0].decision).toBe('ok');
    expect(revokeRows[0].reasonCode).toBe('revocation_created');
    expect(revokeRows[0].correlationId).toBe('corr-revoke-1');
    expect(liftRows).toHaveLength(1);
    expect(liftRows[0].reasonCode).toBe('revocation_lifted');
  });

  test('the raw reason never appears in ANY audit row or denial message', async () => {
    const t = initConvexTest();
    await revoke(t, ORG_A, {kind: 'subject', orgCode: ORG_A, subject: ALICE});
    const denied = await write(t, ALICE, ORG_A, 'k');
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');

    // The reason lives on the revocation row...
    const rows = await revocationRows(t);
    expect(rows.some((row) => row.reason === REASON)).toBe(true);

    // ...but never leaks to audit rows or the denial message.
    const auditSerialized = JSON.stringify(await auditRows(t));
    expect(auditSerialized).not.toContain(REASON);
    expect(denied.message).not.toContain(REASON);
    // The revoked denial names the level, never the subject id verbatim.
    expect(denied.message).toContain('subject-level');
  });
});
