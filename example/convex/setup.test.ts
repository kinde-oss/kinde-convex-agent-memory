/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {convexTest} from 'convex-test';
import {api} from './_generated/api.js';
import schema from './schema.js';
import component from '@kinde-oss/kinde-convex-agent-memory/test';

const modules = import.meta.glob('./**/*.*s');

/**
 * Hardening: stub ALL declared component env vars before every test. Each test
 * file carries its OWN copy of this hook (vitest hooks are file-scoped) — keep
 * them in sync. `MEMORY_SIGNING_SECRET` keys the component's audit digests
 * (see the component's `lib/digest.ts`); the component runs inside these tests,
 * so the same stub applies process-wide.
 */
export const TEST_SIGNING_SECRET = 'test-signing-secret';
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

// When users want to write tests that use the component, they need to
// explicitly register it with its schema and modules.
export function initConvexTest() {
  const t = convexTest(schema, modules);
  component.register(t);
  return t;
}

test('example app loads with the component mounted', async () => {
  const t = initConvexTest();
  expect(await t.query(api.example.health, {})).toBe('ok');
});
