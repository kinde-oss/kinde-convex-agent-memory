/// <reference types="vite/client" />
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './testHelpers.shared.js';

beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});
afterEach(() => {
  vi.useRealTimers();
});

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';

describe('provenance.of', () => {
  test('surfaces immutable creation provenance AND the latest write provenance (writtenAt re-stamps)', async () => {
    const t = initConvexTest();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const created = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'facts/sky',
      content: 'v1'
    });
    if (!created.ok) throw new Error('unreachable');

    // A later update BY THE OWNING SUBJECT re-stamps the write provenance in
    // time. A different subject cannot overwrite the key (key ownership; proven
    // in memory.test.ts), so the writer is always the owner — what moves is
    // `writtenAt`, not `writtenBy`.
    vi.setSystemTime(2000);
    const updated = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'facts/sky',
      content: 'v2'
    });
    if (!updated.ok) throw new Error('unreachable');
    expect(updated.memoryId).toBe(created.memoryId); // same record
    vi.useRealTimers();

    const prov = await t.query(api.provenance.of, {
      orgCode: ORG_A,
      memoryId: created.memoryId
    });
    expect(prov).not.toBeNull();
    if (prov === null) throw new Error('unreachable');
    // Creation event is IMMUTABLE — survived the update untouched.
    expect(prov.createdBy).toBe(ALICE);
    expect(prov.createdAt).toBe(1000);
    // Latest write event re-stamped in time; the owning subject is the writer.
    expect(prov.writtenBy).toBe(ALICE);
    expect(prov.writtenAt).toBe(2000);
    expect(prov.key).toBe('facts/sky');
    expect(prov.orgCode).toBe(ORG_A);
  });

  test('a memoryId from another tenant returns null (no cross-tenant oracle)', async () => {
    const t = initConvexTest();
    const w = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'k',
      content: 'v'
    });
    if (!w.ok) throw new Error('unreachable');
    const prov = await t.query(api.provenance.of, {
      orgCode: ORG_B, // different tenant asking about A's record id
      memoryId: w.memoryId
    });
    expect(prov).toBeNull();
  });

  test('with a redaction policy on the record subject, the identity strings are redacted; ids and timestamps stay raw', async () => {
    const t = initConvexTest();
    vi.useFakeTimers();
    vi.setSystemTime(5000);
    const SENSITIVE_KEY = 'clients/acme/merger/secret-path';
    const w = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: SENSITIVE_KEY,
      content: 'body'
    });
    if (!w.ok) throw new Error('unreachable');
    vi.useRealTimers();

    // A subject-targeted policy applies to ALICE (the record's subject).
    const policy = await t.mutation(api.policy.setRedaction, {
      subject: ALICE,
      orgCode: ORG_A,
      targetSubject: ALICE,
      fields: ['content']
    });
    if (!policy.ok) throw new Error('unreachable');

    const prov = await t.query(api.provenance.of, {
      orgCode: ORG_A,
      memoryId: w.memoryId
    });
    if (prov === null) throw new Error('unreachable');
    // Identity strings redacted to the sentinel — the sensitive key never leaves.
    expect(prov.key).toBe('[redacted]');
    expect(prov.subject).toBe('[redacted]');
    expect(prov.createdBy).toBe('[redacted]');
    expect(prov.writtenBy).toBe('[redacted]');
    expect(JSON.stringify(prov)).not.toContain(SENSITIVE_KEY);
    expect(JSON.stringify(prov)).not.toContain(ALICE);
    // Ids and timestamps are kept raw (durable handle + ordering).
    expect(prov.memoryId).toBe(w.memoryId);
    expect(prov.createdAt).toBe(5000);
    expect(prov.writtenAt).toBe(5000);
    expect(prov.orgCode).toBe(ORG_A);
  });

  test('an org-wide redaction policy also redacts provenance identity', async () => {
    const t = initConvexTest();
    const w = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'k',
      content: 'body'
    });
    if (!w.ok) throw new Error('unreachable');
    // Org-wide policy (no targetSubject) — applies to every record in the tenant.
    await t.mutation(api.policy.setRedaction, {
      subject: ALICE,
      orgCode: ORG_A,
      fields: ['content']
    });
    const prov = await t.query(api.provenance.of, {
      orgCode: ORG_A,
      memoryId: w.memoryId
    });
    if (prov === null) throw new Error('unreachable');
    expect(prov.subject).toBe('[redacted]');
    expect(prov.key).toBe('[redacted]');
  });

  test('with NO redaction policy, provenance identity passes through unchanged', async () => {
    const t = initConvexTest();
    const SENSITIVE_KEY = 'clients/acme/secret';
    const w = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: SENSITIVE_KEY,
      content: 'body'
    });
    if (!w.ok) throw new Error('unreachable');
    const prov = await t.query(api.provenance.of, {
      orgCode: ORG_A,
      memoryId: w.memoryId
    });
    if (prov === null) throw new Error('unreachable');
    // No policy: raw identity, exactly as before the hardening.
    expect(prov.key).toBe(SENSITIVE_KEY);
    expect(prov.subject).toBe(ALICE);
    expect(prov.createdBy).toBe(ALICE);
    expect(prov.writtenBy).toBe(ALICE);
  });

  test('the returned shape carries NO content, metadata, or embedding', async () => {
    const t = initConvexTest();
    const SECRET = 'SECRET-BODY-9f3a2c';
    const SENSITIVE_META = 'SENSITIVE-META-b17e';
    const w = await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'k',
      content: SECRET,
      metadata: {tag: SENSITIVE_META}
    });
    if (!w.ok) throw new Error('unreachable');
    const prov = await t.query(api.provenance.of, {
      orgCode: ORG_A,
      memoryId: w.memoryId
    });
    if (prov === null) throw new Error('unreachable');
    // Structurally absent — the surface cannot leak a memory body.
    expect('content' in prov).toBe(false);
    expect('metadata' in prov).toBe(false);
    expect('embedding' in prov).toBe(false);
    const serialized = JSON.stringify(prov);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).not.toContain(SENSITIVE_META);
  });
});
