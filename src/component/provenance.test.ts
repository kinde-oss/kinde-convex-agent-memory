/// <reference types="vite/client" />
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './setup.test.js';

beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});
afterEach(() => {
  vi.useRealTimers();
});

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const BOB = 'user_bob';

describe('provenance.of', () => {
  test('surfaces immutable creation provenance AND the latest write provenance (distinct)', async () => {
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

    // A later update by a DIFFERENT subject re-stamps the write provenance.
    vi.setSystemTime(2000);
    const updated = await t.mutation(api.memory.write, {
      subject: BOB,
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
    // Latest write event re-stamped, and is DISTINCT from creation.
    expect(prov.writtenBy).toBe(BOB);
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
