/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {api} from './_generated/api.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './setup.test.js';

// Hardening: stub the declared signing secret before every test (file-scoped
// hook; see setup.test.ts).
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

test('write → get roundtrip through the AgentMemory client', async () => {
  const t = initConvexTest();
  const written = await t.mutation(api.example.writeMemory, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    key: 'preferences/theme',
    content: 'dark'
  });
  expect(written.outcome).toBe('created');

  const read = await t.mutation(api.example.getMemory, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    key: 'preferences/theme'
  });
  expect(read).toEqual({
    key: 'preferences/theme',
    content: 'dark',
    createdBy: 'user_alice',
    writtenBy: 'user_alice'
  });

  // Another tenant reading the same key gets null, as if it never existed.
  const crossTenant = await t.mutation(api.example.getMemory, {
    subject: 'user_bob',
    orgCode: 'org_beta',
    key: 'preferences/theme'
  });
  expect(crossTenant).toBeNull();
});

test('listMemories pages through the tenant via the client', async () => {
  const t = initConvexTest();
  for (const key of ['notes/1', 'notes/2', 'prefs/theme']) {
    await t.mutation(api.example.writeMemory, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      key,
      content: 'c'
    });
  }
  await t.mutation(api.example.writeMemory, {
    subject: 'user_bob',
    orgCode: 'org_beta',
    key: 'notes/9',
    content: 'c'
  });

  async function fetchPage(pageCursor: string | null) {
    return await t.mutation(api.example.listMemories, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      keyPrefix: 'notes/',
      numItems: 1,
      cursor: pageCursor
    });
  }

  const keys: string[] = [];
  let cursor: string | null = null;
  let isDone = false;
  while (!isDone) {
    const page = await fetchPage(cursor);
    keys.push(...page.keys);
    isDone = page.isDone;
    cursor = page.continueCursor;
  }
  expect(keys.sort()).toEqual(['notes/1', 'notes/2']);
});

test('a tenant context conflict surfaces as a typed ConvexError from the client', async () => {
  const t = initConvexTest();
  let error: unknown;
  try {
    await t.mutation(api.example.writeMemory, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      claimedOrgCode: 'org_beta',
      key: 'preferences/theme',
      content: 'dark'
    });
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ConvexError);
  const raw = (error as ConvexError<Value>).data;
  const data = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  expect((data as {code: string}).code).toBe('tenant_context_conflict');
});
