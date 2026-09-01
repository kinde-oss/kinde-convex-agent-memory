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
 * unconfigured; production deployments SHOULD set it.
 *
 * REACHING THE COMPONENT: Convex isolates component env, so the host app MUST
 * BIND the secret in at `app.use(memory, { env: { MEMORY_SIGNING_SECRET:
 * app.env.MEMORY_SIGNING_SECRET } })`. A deployment-wide `npx convex env set`
 * alone does NOT reach the component (it took the unkeyed fallback in
 * production before this was wired). See the example app's `convex.config.ts`.
 * Secret values are always set out-of-band with `npx convex env set`, never
 * hardcoded. Every test file also stubs this env var in its `beforeEach`.
 */
export default defineComponent('memory', {
  env: {
    MEMORY_SIGNING_SECRET: v.optional(v.string())
  }
});
