/// <reference types="vite/client" />
import {beforeEach, expect, test, vi} from 'vitest';
import {TEST_SIGNING_SECRET} from './testHelpers.shared.js';

// Hardening convention: stub the declared env var before each test. This is a
// static source-text check that runs no functions, so the stub is inert here,
// but the convention is kept uniform across files.
beforeEach(() => {
  vi.stubEnv('MEMORY_SIGNING_SECRET', TEST_SIGNING_SECRET);
});

// WHY A SOURCE-TEXT GUARD, and why it is necessary.
//
// Convex isolates component env, but convex-test runs every component in the
// SAME process against one global `process.env` (this suite's `vi.stubEnv`), so
// a convex-test run cannot distinguish the secret arriving through the real
// config binding from it merely being present in the global stub. Live phase 1
// proved the difference is real: `MEMORY_SIGNING_SECRET` was set on the
// deployment, yet the component ran UNKEYED because the app never bound it into
// the component. The keyed/unkeyed digest tests (digest.test.ts) still hold, but
// they stub `process.env` globally and so cannot catch a regression where the
// binding is removed. And `app.use` throws outside the Convex runtime, so the
// config cannot be imported and its binding object inspected at test time.
//
// This guard therefore asserts the WIRING that the live run showed is required:
// the component declares the env var, and the app both declares it and binds it
// into the component by reference at `app.use`. Remove any of those and this
// fails here in convex-test, not only against a real deployment.

const exampleConfig = import.meta.glob('./convex.config.ts', {
  query: '?raw',
  import: 'default',
  eager: true
}) as Record<string, string>;

const componentConfig = import.meta.glob(
  '../../src/component/convex.config.ts',
  {query: '?raw', import: 'default', eager: true}
) as Record<string, string>;

/** The one matched file's source, whitespace-collapsed for stable matching. */
function sourceOf(glob: Record<string, string>): string {
  const values = Object.values(glob);
  expect(values.length).toBe(1); // the glob really matched exactly one file
  const source = values[0] ?? '';
  return source.replace(/\s+/g, ' ');
}

test('the component declares MEMORY_SIGNING_SECRET as a component env var', () => {
  const source = sourceOf(componentConfig);
  // defineComponent('memory', { env: { MEMORY_SIGNING_SECRET: ... } })
  expect(source).toMatch(/env:\s*{[^}]*MEMORY_SIGNING_SECRET/);
});

test('the example app declares MEMORY_SIGNING_SECRET and BINDS it into the component (a `convex env set` alone would not reach it)', () => {
  const source = sourceOf(exampleConfig);
  // The app declares the env var so `app.env.MEMORY_SIGNING_SECRET` exists ...
  expect(source).toMatch(/defineApp\(\s*{[^)]*env:[^)]*MEMORY_SIGNING_SECRET/);
  // ... and binds it into the memory component BY REFERENCE at app.use.
  expect(source).toMatch(
    /app\.use\(\s*memory\s*,\s*{[^)]*MEMORY_SIGNING_SECRET:\s*app\.env\.MEMORY_SIGNING_SECRET/
  );
});
