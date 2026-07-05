/// <reference types="vite/client" />
import {afterEach, describe, expect, test, vi} from 'vitest';
import {api} from './_generated/api.js';
import {digestFilter} from './lib/digest.js';
import {initConvexTest} from './setup.test.js';

type ConvexTest = ReturnType<typeof initConvexTest>;

const ORG_A = 'org_alpha';
const ORG_B = 'org_beta';
const ALICE = 'user_alice';
const BOB = 'user_bob';
const SENSITIVE_VALUE = 'SENSITIVE-TOPIC-77';

async function write(
  t: ConvexTest,
  orgCode: string,
  subject: string,
  key: string,
  metadata?: Record<string, string>
) {
  const result = await t.mutation(api.memory.write, {
    subject,
    orgCode,
    key,
    content: `content of ${key} in ${orgCode}`,
    ...(metadata === undefined ? {} : {metadata})
  });
  if (!result.ok) throw new Error('seed write denied');
  return result.memoryId;
}

async function auditRows(t: ConvexTest) {
  return await t.run(async (ctx) => ctx.db.query('audit').collect());
}

const firstPage = {numItems: 100, cursor: null};

/**
 * Seed both tenants. ORG_B deliberately holds MORE rows matching every filter
 * shape than ORG_A (more notes/, more of the sensitive topic, an extra
 * subject match), so a leaky filter would "prefer" B's rows.
 */
async function seed(t: ConvexTest) {
  await write(t, ORG_A, ALICE, 'notes/1', {topic: SENSITIVE_VALUE});
  await write(t, ORG_B, ALICE, 'notes/1', {topic: SENSITIVE_VALUE});
  await write(t, ORG_A, ALICE, 'notes/2');
  await write(t, ORG_B, ALICE, 'notes/2', {topic: SENSITIVE_VALUE});
  await write(t, ORG_A, BOB, 'notes/3');
  await write(t, ORG_B, BOB, 'notes/3', {topic: SENSITIVE_VALUE});
  await write(t, ORG_A, ALICE, 'prefs/theme');
  await write(t, ORG_B, ALICE, 'notes/4');
  await write(t, ORG_B, ALICE, 'prefs/theme');
}

async function listKeys(
  t: ConvexTest,
  orgCode: string,
  filter?: Record<string, unknown>
) {
  const result = await t.mutation(api.memory.list, {
    subject: ALICE,
    orgCode,
    ...(filter === undefined ? {} : {filter}),
    paginationOpts: firstPage
  });
  if (!result.ok) throw new Error(`list denied: ${result.code}`);
  for (const row of result.page) {
    expect(row.orgCode).toBe(orgCode);
  }
  return result.page.map((row) => row.key).sort();
}

describe('isolation under listing (every filter shape)', () => {
  test("A's list returns only A's rows even when B's rows match better", async () => {
    const t = initConvexTest();
    await seed(t);

    expect(await listKeys(t, ORG_A)).toEqual([
      'notes/1',
      'notes/2',
      'notes/3',
      'prefs/theme'
    ]);
    expect(await listKeys(t, ORG_A, {bySubject: ALICE})).toEqual([
      'notes/1',
      'notes/2',
      'prefs/theme'
    ]);
    expect(await listKeys(t, ORG_A, {keyPrefix: 'notes/'})).toEqual([
      'notes/1',
      'notes/2',
      'notes/3'
    ]);
    expect(
      await listKeys(t, ORG_A, {
        writtenAfter: 0,
        writtenBefore: Date.now() + 60_000
      })
    ).toEqual(['notes/1', 'notes/2', 'notes/3', 'prefs/theme']);
    expect(
      await listKeys(t, ORG_A, {
        metadataEquals: {field: 'topic', value: SENSITIVE_VALUE}
      })
    ).toEqual(['notes/1']);
    // Combined: subject rides the index, prefix refines in-range.
    expect(
      await listKeys(t, ORG_A, {bySubject: ALICE, keyPrefix: 'notes/'})
    ).toEqual(['notes/1', 'notes/2']);
  });
});

describe('pagination', () => {
  test('pages walk the full tenant set exactly once and never cross tenants at page boundaries', async () => {
    const t = initConvexTest();
    // Interleave creations so A and B rows alternate in creation order —
    // every A-page boundary lands next to a B row.
    for (let i = 0; i < 5; i++) {
      await write(t, ORG_A, ALICE, `k/${i}`);
      await write(t, ORG_B, ALICE, `k/${i}`);
    }

    async function fetchPage(pageCursor: string | null) {
      return await t.mutation(api.memory.list, {
        subject: ALICE,
        orgCode: ORG_A,
        paginationOpts: {numItems: 2, cursor: pageCursor}
      });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let isDone = false;
    let pages = 0;
    let sawNotDone = false;
    while (!isDone) {
      const result = await fetchPage(cursor);
      if (!result.ok) throw new Error('unreachable');
      expect(result.page.length).toBeLessThanOrEqual(2);
      for (const row of result.page) {
        expect(row.orgCode).toBe(ORG_A);
        seen.push(row.key);
      }
      if (!result.isDone) sawNotDone = true;
      isDone = result.isDone;
      cursor = result.continueCursor;
      pages += 1;
      if (pages > 10) throw new Error('pagination did not terminate');
    }
    expect(sawNotDone).toBe(true); // isDone was false mid-walk, then flipped.
    expect(seen).toHaveLength(5); // exactly once each: no dupes, no misses
    expect([...seen].sort()).toEqual(['k/0', 'k/1', 'k/2', 'k/3', 'k/4']);
  });
});

describe('per-call freshness', () => {
  test('a list after a new write includes it', async () => {
    const t = initConvexTest();
    await write(t, ORG_A, ALICE, 'a');
    expect(await listKeys(t, ORG_A)).toEqual(['a']);
    await write(t, ORG_A, ALICE, 'b');
    expect(await listKeys(t, ORG_A)).toEqual(['a', 'b']);
  });
});

describe('filter correctness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test('time window is exclusive on both bounds', async () => {
    const t = initConvexTest();
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    await write(t, ORG_A, ALICE, 'first');
    vi.setSystemTime(2_000);
    await write(t, ORG_A, ALICE, 'middle');
    vi.setSystemTime(3_000);
    await write(t, ORG_A, ALICE, 'last');
    vi.useRealTimers();

    expect(
      await listKeys(t, ORG_A, {writtenAfter: 1_000, writtenBefore: 3_000})
    ).toEqual(['middle']);
    expect(await listKeys(t, ORG_A, {writtenAfter: 1_000})).toEqual([
      'last',
      'middle'
    ]);
    expect(await listKeys(t, ORG_A, {writtenBefore: 3_000})).toEqual([
      'first',
      'middle'
    ]);
  });

  test('metadataEquals matches exact primitives only (arrays and absent fields never match)', async () => {
    const t = initConvexTest();
    await t.mutation(api.memory.write, {
      subject: ALICE,
      orgCode: ORG_A,
      key: 'array-valued',
      content: 'c',
      metadata: {topic: [SENSITIVE_VALUE]}
    });
    await write(t, ORG_A, ALICE, 'exact', {topic: SENSITIVE_VALUE});
    await write(t, ORG_A, ALICE, 'no-metadata');

    expect(
      await listKeys(t, ORG_A, {
        metadataEquals: {field: 'topic', value: SENSITIVE_VALUE}
      })
    ).toEqual(['exact']);
  });

  test('contradictory filters deny typed, never a silent empty page', async () => {
    const t = initConvexTest();
    await write(t, ORG_A, ALICE, 'k');

    const contradictions = [
      {writtenAfter: 10, writtenBefore: 5},
      {writtenAfter: 5, writtenBefore: 5},
      {bySubject: ''},
      {keyPrefix: ''},
      {metadataEquals: {field: '', value: 'x'}}
    ];
    for (const filter of contradictions) {
      const result = await t.mutation(api.memory.list, {
        subject: ALICE,
        orgCode: ORG_A,
        filter,
        paginationOpts: firstPage
      });
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.code).toBe('invalid_filter');
    }

    const denials = (await auditRows(t)).filter(
      (row) => row.decision === 'denied'
    );
    expect(denials).toHaveLength(contradictions.length);
    for (const row of denials) {
      expect(row.operation).toBe('list');
      expect(row.reasonCode).toBe('invalid_filter');
    }
  });
});

describe('audit discipline for list', () => {
  test('one row per list call (ok and denied), digested filter, correlation round-trip', async () => {
    const t = initConvexTest();
    await write(t, ORG_A, ALICE, 'notes/1', {topic: SENSITIVE_VALUE});
    const before = (await auditRows(t)).length;

    const filter = {
      keyPrefix: 'notes/',
      metadataEquals: {field: 'topic', value: SENSITIVE_VALUE}
    };
    const ok = await t.mutation(api.memory.list, {
      subject: ALICE,
      orgCode: ORG_A,
      filter,
      correlationId: 'corr-list-1',
      paginationOpts: firstPage
    });
    if (!ok.ok) throw new Error('unreachable');
    expect(ok.correlationId).toBe('corr-list-1');

    const denied = await t.mutation(api.memory.list, {
      subject: ALICE,
      orgCode: ORG_A,
      claimedOrgCode: ORG_B,
      filter,
      paginationOpts: firstPage
    });
    expect(denied.ok).toBe(false);

    const audit = await auditRows(t);
    expect(audit.length).toBe(before + 2); // exactly one row per list call

    const listRows = audit.filter((row) => row.operation === 'list');
    expect(listRows).toHaveLength(2);
    for (const row of listRows) {
      // The digest is the fingerprint of the WHOLE filter object; raw filter
      // values never appear anywhere in the row.
      expect(row.keyOrQueryDigest).toBe(digestFilter(filter));
      const serialized = JSON.stringify(row);
      expect(serialized).not.toContain('notes/');
      expect(serialized).not.toContain(SENSITIVE_VALUE);
    }
    const okRow = listRows.find((row) => row.decision === 'ok');
    expect(okRow?.correlationId).toBe('corr-list-1');
    expect(okRow?.reasonCode).toBe('listed');
  });
});
