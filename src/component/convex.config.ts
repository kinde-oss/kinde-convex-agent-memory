import {defineComponent} from 'convex/server';
import {v} from 'convex/values';

/**
 * The agent memory component.
 *
 * ENV VARS: `MEMORY_SIGNING_SECRET` (OPTIONAL) is the HMAC key for audit
 * digests (see `lib/digest.ts`). When set, audit fingerprints are HMAC-SHA256
 * keyed by it, defeating enumeration of low-entropy keys/subjects from audit
 * rows; when absent, digests fall back to plain SHA-256 — the documented,
 * weaker standalone/dev default. It is declared OPTIONAL so the component runs
 * unconfigured; production deployments SHOULD set it. Any declared env var
 * MUST also be stubbed in every test file's `beforeEach` and may be passed
 * through by the example app's convex.config. Secret values are always set
 * out-of-band with `npx convex env set`, never hardcoded.
 */
export default defineComponent('memory', {
  env: {
    MEMORY_SIGNING_SECRET: v.optional(v.string())
  }
});
