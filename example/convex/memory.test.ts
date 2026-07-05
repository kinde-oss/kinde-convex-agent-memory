/// <reference types="vite/client" />
import {expect, test} from 'vitest';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {api} from './_generated/api.js';
import {initConvexTest} from './setup.test.js';

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
