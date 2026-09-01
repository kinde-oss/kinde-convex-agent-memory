/// <reference types="vite/client" />
//
// The one health-check that proves the example app loads with the component
// mounted. It lives alone here and nothing imports this file, so it is
// collected once. Shared helpers live in `testHelpers.ts` (a non-test module).
//
import {beforeEach, expect, test, vi} from 'vitest';
import {internal} from './_generated/api.js';
import {initConvexTest, TEST_SIGNING_SECRET} from './testHelpers.shared.js';

beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

test('example app loads with the component mounted', async () => {
  const t = initConvexTest();
  expect(await t.query(internal.example.health, {})).toBe('ok');
});
