/// <reference types="vite/client" />
import {beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {digestKey} from './lib/digest.js';
import {
  auditRows,
  expectFail,
  initConvexTest,
  TEST_SIGNING_SECRET
} from './testHelpers.shared.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

// Hardening: stub the declared signing secret before every test (file-scoped
// hook; see setup.test.ts). Keys the audit digests asserted below.
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const KEY = 'preferences/theme';
const SECRET = 'TOP-SECRET-CONTENT-a3f8c2';

async function memoryRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('memories').collect());
}

describe('tenant isolation (the invariant)', () => {
  test('a key written by tenant A reads as null for tenant B, indistinguishable from a missing key', async () => {
    const t = initConvexTest();
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: SECRET
    });

    // B reads A's key, and B reads a key that exists nowhere.
    const crossTenant = await t.mutation(api.memory.get, {
      subject: BOB,
      orgCode: ORG_B,
      key: KEY
    });
    const trulyMissing = await t.mutation(api.memory.get, {
      subject: BOB,
      orgCode: ORG_B,
      key: 'no/such/key'
    });
    expect(crossTenant.ok).toBe(true);
    if (!crossTenant.ok || !trulyMissing.ok) throw new Error('unreachable');
    expect(crossTenant.memory).toBeNull();
    expect(trulyMissing.memory).toBeNull();

    // The two reads are indistinguishable in the audit: both are normal 'ok'
    // reads with reasonCode 'not_found' under B's OWN org.
    const bAudit = (await auditRows(t)).filter((row) => row.orgCode === ORG_B);
    expect(bAudit).toHaveLength(2);
    for (const row of bAudit) {
      expect(row.operation).toBe('get');
      expect(row.decision).toBe('ok');
      expect(row.reasonCode).toBe('not_found');
      // No trace of A's record: not the org, not the writer, not the content.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(ORG_A);
      expect(serialized).not.toContain(ALICE);
      expect(serialized).not.toContain(SECRET);
    }

    // Sanity: A itself still reads the record.
    const own = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY
    });
    if (!own.ok) throw new Error('unreachable');
    expect(own.memory?.content).toBe(SECRET);
  });
});

describe('tenant context conflict', () => {
  test('claimedOrgCode differing from orgCode denies typed, touches no memory, and audits the denial', async () => {
    const t = initConvexTest();

    const writeDenied = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      claimedOrgCode: ORG_B,
      key: KEY,
      content: SECRET
    });
    expect(writeDenied.ok).toBe(false);
    if (writeDenied.ok) throw new Error('unreachable');
    expect(writeDenied.code).toBe('tenant_context_conflict');

    const getDenied = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      claimedOrgCode: ORG_B,
      key: KEY
    });
    expect(getDenied.ok).toBe(false);
    if (getDenied.ok) throw new Error('unreachable');
    expect(getDenied.code).toBe('tenant_context_conflict');

    // No memory was read or written: the table is untouched.
    expect(await memoryRows(t)).toHaveLength(0);

    // Both denials are audited, under the SERVER-VERIFIED org.
    const audit = await auditRows(t);
    expect(audit).toHaveLength(2);
    expect(audit.map((row) => row.operation).sort()).toEqual(['get', 'write']);
    for (const row of audit) {
      expect(row.decision).toBe('denied');
      expect(row.reasonCode).toBe('tenant_context_conflict');
      expect(row.orgCode).toBe(ORG_A);
      expect(JSON.stringify(row)).not.toContain(SECRET);
    }
  });

  test('matching claimedOrgCode is accepted (no false positives)', async () => {
    const t = initConvexTest();
    const result = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      claimedOrgCode: ORG_A,
      key: KEY,
      content: SECRET
    });
    expect(result.ok).toBe(true);
  });
});

describe('provenance', () => {
  test('creation stamp is immutable; each same-subject update is a new write-provenance event', async () => {
    const t = initConvexTest();
    const first = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'v1'
    });
    if (!first.ok) throw new Error('unreachable');
    expect(first.outcome).toBe('created');

    const [created] = await memoryRows(t);
    expect(created.createdBy).toBe(ALICE);
    expect(created.writtenBy).toBe(ALICE);
    expect(created.writtenAt).toBe(created.createdAt);
    expect(created.mandateId).toBeNull();

    // The OWNING subject re-writes: an update (a new write-provenance event).
    // A different subject cannot — that path is proven below in 'key ownership'.
    const second = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'v2'
    });
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('updated');
    expect(second.memoryId).toBe(first.memoryId);

    const rows = await memoryRows(t);
    expect(rows).toHaveLength(1);
    const [updated] = rows;
    // Content updated; creation provenance byte-for-byte intact.
    expect(updated.content).toBe('v2');
    expect(updated.createdBy).toBe(ALICE);
    expect(updated.createdAt).toBe(created.createdAt);
    // The write stamp re-stamps (writtenAt moves forward in time); the writer
    // is always the owning subject, so writtenBy stays ALICE.
    expect(updated.writtenBy).toBe(ALICE);
    expect(updated.writtenAt).toBeGreaterThanOrEqual(created.createdAt);
  });
});

describe('key ownership (cross-subject overwrite is denied)', () => {
  test('a subject may re-write its OWN key (same-subject upsert unchanged)', async () => {
    const t = initConvexTest();
    const first = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'v1'
    });
    if (!first.ok) throw new Error('unreachable');
    expect(first.outcome).toBe('created');

    const second = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'v2'
    });
    if (!second.ok) throw new Error('unreachable');
    expect(second.outcome).toBe('updated');
    const [row] = await memoryRows(t);
    expect(row.content).toBe('v2');
  });

  test('a DIFFERENT subject is denied key_owned_by_other_subject, the row is untouched, and exactly one audit row is written', async () => {
    const t = initConvexTest();
    const created = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: SECRET
    });
    if (!created.ok) throw new Error('unreachable');
    const auditAfterCreate = (await auditRows(t)).length;

    // BOB (same tenant) tries to overwrite ALICE's key.
    const denied = await t.mutation(api.memory.write, {
      subject: BOB,
      orgCode: ORG_A,
      key: KEY,
      content: 'bob-overwrite-attempt'
    });
    expect(denied.ok).toBe(false);
    if (denied.ok) throw new Error('unreachable');
    expect(denied.code).toBe('key_owned_by_other_subject');

    // The stored row is byte-for-byte intact: still ALICE's, still the secret.
    const rows = await memoryRows(t);
    expect(rows).toHaveLength(1);
    expect(rows[0].subject).toBe(ALICE);
    expect(rows[0].content).toBe(SECRET);

    // Exactly one NEW audit row (the denial), carrying no raw content.
    const audit = await auditRows(t);
    expect(audit.length - auditAfterCreate).toBe(1);
    const denialRow = audit[audit.length - 1];
    expect(denialRow.operation).toBe('write');
    expect(denialRow.decision).toBe('denied');
    expect(denialRow.reasonCode).toBe('key_owned_by_other_subject');
    expect(denialRow.subject).toBe(BOB);
    expect(JSON.stringify(denialRow)).not.toContain(SECRET);
  });

  test('the same key held by a DIFFERENT tenant is a fresh, independent write (ownership is tenant-scoped)', async () => {
    const t = initConvexTest();
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'a-owns-this'
    });
    // BOB in ORG_B writes the same key: a brand-new key in his tenant, created.
    const bWrite = await t.mutation(api.memory.write, {
      subject: BOB,
      orgCode: ORG_B,
      key: KEY,
      content: 'b-owns-this'
    });
    if (!bWrite.ok) throw new Error('unreachable');
    expect(bWrite.outcome).toBe('created');
    expect((await memoryRows(t)).filter((r) => r.orgCode === ORG_B)).toHaveLength(
      1
    );
  });
});

describe('tenant-scoped idempotency', () => {
  test('the same idempotencyKey replays within a tenant and is independent across tenants', async () => {
    const t = initConvexTest();
    const idempotencyKey = 'op-123';

    const first = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'original',
      idempotencyKey
    });
    if (!first.ok) throw new Error('unreachable');
    expect(first.outcome).toBe('created');

    // Replay in the SAME tenant: no duplicate, same id, first write wins.
    const replay = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'replayed-content-is-ignored',
      idempotencyKey
    });
    if (!replay.ok) throw new Error('unreachable');
    expect(replay.outcome).toBe('idempotent_replay');
    expect(replay.memoryId).toBe(first.memoryId);
    const inOrgA = (await memoryRows(t)).filter((r) => r.orgCode === ORG_A);
    expect(inOrgA).toHaveLength(1);
    expect(inOrgA[0].content).toBe('original');

    // The SAME idempotencyKey in ANOTHER tenant is a fresh, independent write.
    const otherTenant = await t.mutation(api.memory.write, {
      subject: BOB,
      orgCode: ORG_B,
      key: KEY,
      content: 'b-content',
      idempotencyKey
    });
    if (!otherTenant.ok) throw new Error('unreachable');
    expect(otherTenant.outcome).toBe('created');
    expect(otherTenant.memoryId).not.toBe(first.memoryId);
    expect(await memoryRows(t)).toHaveLength(2);
  });

  test('reusing an idempotencyKey for a DIFFERENT key is contradictory and denies typed', async () => {
    const t = initConvexTest();
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'original',
      idempotencyKey: 'op-123'
    });
    const reused = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'a/different/key',
      content: 'other',
      idempotencyKey: 'op-123'
    });
    expect(reused.ok).toBe(false);
    if (reused.ok) throw new Error('unreachable');
    expect(reused.code).toBe('idempotency_key_reused');
    expect(await memoryRows(t)).toHaveLength(1);
  });
});

describe('audit discipline', () => {
  test('exactly one audit row per operation; correlationId round-trips or is minted; content and raw key never appear', async () => {
    const t = initConvexTest();

    const written = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: SECRET,
      correlationId: 'corr-fixed-1'
    });
    if (!written.ok) throw new Error('unreachable');
    expect(written.correlationId).toBe('corr-fixed-1');
    expect(await auditRows(t)).toHaveLength(1);

    const read = await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY
    });
    if (!read.ok) throw new Error('unreachable');
    // Minted when absent: non-empty and present on the read's audit row.
    expect(read.correlationId.length).toBeGreaterThan(0);

    const audit = await auditRows(t);
    expect(audit).toHaveLength(2);

    const writeRow = audit.find((row) => row.operation === 'write');
    const getRow = audit.find((row) => row.operation === 'get');
    if (writeRow === undefined || getRow === undefined) {
      throw new Error('unreachable');
    }
    expect(writeRow.correlationId).toBe('corr-fixed-1');
    expect(writeRow.reasonCode).toBe('created');
    expect(getRow.correlationId).toBe(read.correlationId);
    expect(getRow.reasonCode).toBe('found');

    // The digest is the redacted fingerprint — never the raw key, never the
    // content. Assert both positively (digest matches) and negatively (raw
    // strings absent from EVERY audit row).
    for (const row of audit) {
      expect(row.keyOrQueryDigest).toBe(await digestKey(KEY));
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).not.toContain(KEY);
    }
  });

  test('an idempotent replay audits distinctly from a fresh write', async () => {
    const t = initConvexTest();
    const args = {
      subject: ALICE,
      orgCode: ORG_A,
      key: KEY,
      content: 'c',
      idempotencyKey: 'op-9'
    };
    await t.mutation(api.memory.write, args);
    await t.mutation(api.memory.write, args);
    const reasons = (await auditRows(t)).map((row) => row.reasonCode).sort();
    expect(reasons).toEqual(['created', 'idempotent_replay']);
  });
});

describe('malformed calls (typed fail, thrown — nothing written yet to roll back)', () => {
  test('blank identity fields and blank supplied correlationId are rejected typed', async () => {
    const t = initConvexTest();
    await expectFail(
      t.mutation(api.memory.write, {
        subject: ALICE,
        orgCode: '',
        key: KEY,
        content: 'c'
      }),
      'invalid_argument'
    );
    await expectFail(
      t.mutation(api.memory.get, {subject: ALICE, orgCode: ORG_A, key: ''}),
      'invalid_argument'
    );
    await expectFail(
      t.mutation(api.memory.write, {
        subject: ALICE,
        orgCode: ORG_A,
        key: KEY,
        content: 'c',
        correlationId: ''
      }),
      'invalid_argument'
    );
    expect(await memoryRows(t)).toHaveLength(0);
  });
});
