/// <reference types="vite/client" />
import {expect, test} from 'vitest';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {api} from './_generated/api.js';
import {initConvexTest} from './setup.test.js';
import {CONTENT_REDACTED} from '@kinde-oss/kinde-convex-agent-memory';

async function expectClientError(
  promise: Promise<unknown>,
  code: string
): Promise<void> {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error, `expected ConvexError with code "${code}"`).toBeInstanceOf(
    ConvexError
  );
  const raw = (error as ConvexError<Value>).data;
  const data = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
  expect((data as {code: string}).code).toBe(code);
}

test('grant lifecycle through the client: enforced subject throws typed scope_not_granted', async () => {
  const t = initConvexTest();
  // ALICE starts permissive.
  await t.mutation(api.example.writeMemory, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    key: 'k1',
    content: 'c'
  });

  // First grant (read only) flips ALICE to enforced mode.
  const granted = await t.mutation(api.example.grantAccess, {
    subject: 'user_admin',
    orgCode: 'org_alpha',
    targetSubject: 'user_alice',
    scope: 'memory.read'
  });
  expect(granted.outcome).toBe('granted');

  // Writes now throw typed through the client; reads still work.
  await expectClientError(
    t.mutation(api.example.writeMemory, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      key: 'k2',
      content: 'c'
    }),
    'scope_not_granted'
  );
  const read = await t.mutation(api.example.getMemory, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    key: 'k1'
  });
  expect(read?.content).toBe('c');

  // Revoking the read grant locks reads out too.
  await t.mutation(api.example.revokeAccess, {
    subject: 'user_admin',
    orgCode: 'org_alpha',
    targetSubject: 'user_alice',
    scope: 'memory.read'
  });
  await expectClientError(
    t.mutation(api.example.getMemory, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      key: 'k1'
    }),
    'scope_not_granted'
  );
});

test('revoking a nonexistent grant throws typed grant_not_found through the client', async () => {
  const t = initConvexTest();
  await expectClientError(
    t.mutation(api.example.revokeAccess, {
      subject: 'user_admin',
      orgCode: 'org_alpha',
      targetSubject: 'user_alice',
      scope: 'memory.write'
    }),
    'grant_not_found'
  );
});

test('redaction policy set through the client redacts get and recall egress', async () => {
  const t = initConvexTest();
  await t.mutation(api.example.writeMemoryEmbedded, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    key: 'facts/sky',
    content: 'the sky is blue'
  });
  const set = await t.mutation(api.example.setRedactionPolicy, {
    subject: 'user_admin',
    orgCode: 'org_alpha',
    fields: ['content']
  });
  expect(set.outcome).toBe('set');

  const read = await t.mutation(api.example.getMemory, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    key: 'facts/sky'
  });
  expect(read?.content).toBe(CONTENT_REDACTED);

  // Recall still MATCHES on the stored embedding (vectors are not policy
  // fields), but the match egresses redacted.
  const matches = await t.action(api.example.recallMemories, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    query: 'the sky is blue',
    topK: 8
  });
  expect(matches).toHaveLength(1);
  expect(matches[0].key).toBe('facts/sky');
  expect(matches[0].content).toBe(CONTENT_REDACTED);
});

test('malformed redaction fields throw typed invalid_redaction_fields through the client', async () => {
  const t = initConvexTest();
  await expectClientError(
    t.mutation(api.example.setRedactionPolicy, {
      subject: 'user_admin',
      orgCode: 'org_alpha',
      fields: ['']
    }),
    'invalid_redaction_fields'
  );
});

test('clearing a nonexistent policy throws typed policy_not_found through the client', async () => {
  const t = initConvexTest();
  await expectClientError(
    t.mutation(api.example.setRedactionPolicy, {
      subject: 'user_admin',
      orgCode: 'org_alpha',
      fields: []
    }),
    'policy_not_found'
  );
});
