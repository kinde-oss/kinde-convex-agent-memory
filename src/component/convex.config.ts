import {defineComponent} from 'convex/server';

/**
 * The agent memory component. No environment variables are declared yet (P0
 * scaffold) — when one is added here, it MUST also be stubbed in every test
 * file's `beforeEach` and passed through by the example app's convex.config.
 * Secret values are always set out-of-band with `npx convex env set`, never
 * hardcoded.
 */
export default defineComponent('memory');
