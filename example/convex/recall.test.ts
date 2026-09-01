/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {ConvexError} from 'convex/values';
import type {Value} from 'convex/values';
import {components, internal} from './_generated/api.js';
import {
  expectClientError,
  initConvexTest,
  TEST_SIGNING_SECRET
} from './testHelpers.shared.js';
import {
  AgentMemory,
  EMBEDDING_DIMENSIONS
} from '@kinde-oss/kinde-convex-agent-memory';
import type {
  Embedder,
  RunActionCtx
} from '@kinde-oss/kinde-convex-agent-memory';

// Hardening: stub the declared signing secret before every test (file-scoped
// hook; see testHelpers.ts).
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

test('recall by query text through the fake embedder, end to end', async () => {
  const t = initConvexTest();
  for (const [key, content] of [
    ['facts/sky', 'the sky is blue'],
    ['facts/cats', 'cats purr when content']
  ] as const) {
    await t.mutation(internal.example.writeMemoryEmbedded, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      key,
      content
    });
  }
  // Another tenant holds the EXACT text being queried — it must not surface.
  await t.mutation(internal.example.writeMemoryEmbedded, {
    subject: 'user_bob',
    orgCode: 'org_beta',
    key: 'facts/sky',
    content: 'the sky is blue'
  });

  const matches = await t.action(internal.example.recallMemories, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    query: 'the sky is blue',
    topK: 8
  });

  expect(matches.length).toBeGreaterThan(0);
  for (const match of matches) {
    expect(match.orgCode).toBe('org_alpha');
  }
  // The fake embedder is deterministic: identical text embeds identically,
  // so the matching record scores ~1 and ranks first.
  expect(matches[0].key).toBe('facts/sky');
  expect(matches[0].content).toBe('the sky is blue');
  expect(matches[0].score).toBeGreaterThan(0.99);
});

// The client-side embedder seam runs BEFORE any component call, so these
// tests drive the AgentMemory class directly with a ctx whose runAction
// must never be reached.
const unreachedCtx: RunActionCtx = {
  runAction: async () => {
    throw new Error('the component must not be reached in this test');
  }
};

test('query text without a configured embedder throws typed, naming the missing config', async () => {
  const bare = new AgentMemory(components.memory);
  const attempt = bare.recall(unreachedCtx, {
    subject: 'user_alice',
    orgCode: 'org_alpha',
    query: 'anything'
  });
  await expectClientError(attempt, 'embedder_not_configured');
  await attempt.catch((error: unknown) => {
    const raw = (error as ConvexError<Value>).data;
    const data = typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw;
    expect((data as {message: string}).message).toContain('config.embedder');
  });
});

test.each<[string, Embedder]>([
  ['wrong dimension', async () => [1, 2, 3]],
  [
    'non-finite values',
    async () => new Array<number>(EMBEDDING_DIMENSIONS).fill(NaN)
  ],
  [
    'non-array response',
    // Deliberately smuggle a non-array past the Embedder type: the client
    // must validate the RUNTIME value, not trust the signature.
    async () => JSON.parse('"not a vector"') as number[]
  ],
  [
    'throwing embedder',
    async () => {
      throw new Error('provider exploded');
    }
  ]
])(
  'a misbehaving embedder (%s) becomes a typed embedder_response_malformed error',
  async (_label, embedder) => {
    const client = new AgentMemory(components.memory, {embedder});
    await expectClientError(
      client.recall(unreachedCtx, {
        subject: 'user_alice',
        orgCode: 'org_alpha',
        query: 'anything'
      }),
      'embedder_response_malformed'
    );
  }
);

test('supplying both query and embedding, or neither, throws typed invalid_argument', async () => {
  const client = new AgentMemory(components.memory, {
    embedder: async () => new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
  });
  await expectClientError(
    client.recall(unreachedCtx, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      query: 'text',
      embedding: new Array<number>(EMBEDDING_DIMENSIONS).fill(0)
    }),
    'invalid_argument'
  );
  await expectClientError(
    client.recall(unreachedCtx, {
      subject: 'user_alice',
      orgCode: 'org_alpha'
    }),
    'invalid_argument'
  );
});

test('a recall denial surfaces as a typed ConvexError from the client', async () => {
  const t = initConvexTest();
  await expectClientError(
    t.action(internal.example.recallMemories, {
      subject: 'user_alice',
      orgCode: 'org_alpha',
      claimedOrgCode: 'org_beta',
      query: 'anything'
    }),
    'tenant_context_conflict'
  );
});
