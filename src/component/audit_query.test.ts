/// <reference types="vite/client" />
import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {expectFail, initConvexTest, TEST_SIGNING_SECRET} from './setup.test.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

// Hardening: stub the declared signing secret before every test (file-scoped
// hook; see setup.test.ts). Audit digests are keyed by it.
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

async function write(
  t: ConvexTest,
  subject: string,
  orgCode: string,
  key: string,
  correlationId?: string
) {
  return await t.mutation(api.memory.write, {
    subject,
    orgCode,
    key,
    content: 'c',
    ...(correlationId === undefined ? {} : {correlationId})
  });
}

interface QueryOpts {
  filter?: Record<string, unknown>;
  numItems?: number;
  cursor?: string | null;
  claimedOrgCode?: string;
}

async function queryAudit(
  t: ConvexTest,
  orgCode: string,
  opts: QueryOpts = {}
) {
  return await t.query(api.audit.query, {
    orgCode,
    ...(opts.claimedOrgCode === undefined
      ? {}
      : {claimedOrgCode: opts.claimedOrgCode}),
    ...(opts.filter === undefined ? {} : {filter: opts.filter}),
    paginationOpts: {
      numItems: opts.numItems ?? 50,
      cursor: opts.cursor ?? null
    }
  });
}

describe('audit.query tenant isolation', () => {
  test('A never returns B rows, even filtering on a correlationId that exists in B', async () => {
    const t = initConvexTest();
    await write(t, ALICE, ORG_A, 'a/1', 'shared');
    await write(t, ALICE, ORG_A, 'a/2', 'shared');
    await write(t, BOB, ORG_B, 'b/1', 'shared'); // same correlationId, other tenant

    const a = await queryAudit(t, ORG_A, {filter: {correlationId: 'shared'}});
    expect(a.page).toHaveLength(2);
    expect(a.page.every((row) => row.orgCode === ORG_A)).toBe(true);

    const b = await queryAudit(t, ORG_B, {filter: {correlationId: 'shared'}});
    expect(b.page).toHaveLength(1);
    expect(b.page[0].orgCode).toBe(ORG_B);
  });
});

describe('audit.query ordering and filters', () => {
  test('newest-first (descending ts)', async () => {
    const t = initConvexTest();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    await write(t, ALICE, ORG_A, 'k1');
    vi.setSystemTime(2000);
    await write(t, ALICE, ORG_A, 'k2');
    vi.setSystemTime(3000);
    await write(t, ALICE, ORG_A, 'k3');

    const res = await queryAudit(t, ORG_A);
    const times = res.page.map((row) => row.ts);
    expect(times).toEqual([3000, 2000, 1000]);
  });

  test('filter: bySubject', async () => {
    const t = initConvexTest();
    await write(t, ALICE, ORG_A, 'k1');
    await write(t, BOB, ORG_A, 'k2');
    const res = await queryAudit(t, ORG_A, {filter: {subject: ALICE}});
    expect(res.page).toHaveLength(1);
    expect(res.page[0].subject).toBe(ALICE);
  });

  test('filter: operation', async () => {
    const t = initConvexTest();
    await write(t, ALICE, ORG_A, 'k1');
    await t.mutation(api.memory.get, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'k1'
    });
    const res = await queryAudit(t, ORG_A, {filter: {operation: 'get'}});
    expect(res.page).toHaveLength(1);
    expect(res.page[0].operation).toBe('get');
  });

  test('filter: decision (denied)', async () => {
    const t = initConvexTest();
    await write(t, ALICE, ORG_A, 'k1');
    // A tenant-conflict denial audits one denied row.
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      claimedOrgCode: 'other',
      key: 'k2',
      content: 'c'
    });
    const res = await queryAudit(t, ORG_A, {filter: {decision: 'denied'}});
    expect(res.page).toHaveLength(1);
    expect(res.page[0].decision).toBe('denied');
    expect(res.page[0].reasonCode).toBe('tenant_context_conflict');
  });

  test('filter: correlationId', async () => {
    const t = initConvexTest();
    await write(t, ALICE, ORG_A, 'k1', 'corr-1');
    await write(t, ALICE, ORG_A, 'k2', 'corr-2');
    const res = await queryAudit(t, ORG_A, {filter: {correlationId: 'corr-1'}});
    expect(res.page).toHaveLength(1);
    expect(res.page[0].correlationId).toBe('corr-1');
  });

  test('filter: time window (since/until, both exclusive)', async () => {
    const t = initConvexTest();
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    await write(t, ALICE, ORG_A, 'k1');
    vi.setSystemTime(2000);
    await write(t, ALICE, ORG_A, 'k2');
    vi.setSystemTime(3000);
    await write(t, ALICE, ORG_A, 'k3');
    const res = await queryAudit(t, ORG_A, {
      filter: {since: 1000, until: 3000}
    });
    expect(res.page.map((row) => row.ts)).toEqual([2000]);
  });
});

describe('audit.query pagination', () => {
  test('walks the tenant audit set once, never crossing tenants', async () => {
    const t = initConvexTest();
    for (let i = 0; i < 5; i++) {
      await write(t, ALICE, ORG_A, `a/${i}`);
    }
    for (let i = 0; i < 3; i++) {
      await write(t, BOB, ORG_B, `b/${i}`);
    }
    const collected: Array<{orgCode: string}> = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const res = await queryAudit(t, ORG_A, {numItems: 2, cursor});
      collected.push(...res.page);
      cursor = res.continueCursor;
      if (res.isDone) break;
    }
    expect(collected).toHaveLength(5);
    expect(collected.every((row) => row.orgCode === ORG_A)).toBe(true);
  });
});

describe('audit.query argument errors THROW (it is a query, it cannot audit)', () => {
  test('contradictory window throws typed invalid_filter', async () => {
    const t = initConvexTest();
    await expectFail(
      queryAudit(t, ORG_A, {filter: {since: 100, until: 50}}),
      'invalid_filter'
    );
    await expectFail(
      queryAudit(t, ORG_A, {filter: {since: 100, until: 100}}),
      'invalid_filter'
    );
  });

  test('claimedOrgCode conflict throws typed tenant_context_conflict', async () => {
    const t = initConvexTest();
    await expectFail(
      queryAudit(t, ORG_A, {claimedOrgCode: 'other'}),
      'tenant_context_conflict'
    );
  });

  test('reading the audit log writes NO audit row of its own', async () => {
    const t = initConvexTest();
    await write(t, ALICE, ORG_A, 'k1');
    const before = await t.run(async (ctx) => ctx.db.query('audit').collect());
    await queryAudit(t, ORG_A);
    const after = await t.run(async (ctx) => ctx.db.query('audit').collect());
    expect(after.length).toBe(before.length);
  });
});
