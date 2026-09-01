/// <reference types="vite/client" />
//
// The one smoke test that proves the component test deployment comes up. It
// lives alone here and nothing imports this file, so it is collected once.
// Shared helpers live in `testHelpers.ts` (a non-test module).
//
import {beforeEach, expect, test, vi} from 'vitest';
import {initConvexTest, TEST_SIGNING_SECRET} from './testHelpers.shared.js';

beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

test('the component test deployment comes up', () => {
  const t = initConvexTest();
  expect(t).toBeDefined();
});
