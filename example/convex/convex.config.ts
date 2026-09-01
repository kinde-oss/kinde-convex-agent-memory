import {defineApp} from 'convex/server';
import {v} from 'convex/values';
import memory from '@kinde-oss/kinde-convex-agent-memory/convex.config.js';

// Convex isolates component env: a deployment-wide `convex env set
// MEMORY_SIGNING_SECRET ...` reaches THIS app's functions but NOT the component
// unless the app binds it here. So the app declares the env var and threads it
// into the component by reference at `app.use`. `app.env.MEMORY_SIGNING_SECRET`
// is a reference to the deployment env var (never a hardcoded value), resolved
// at runtime; the component then reads it as its own `MEMORY_SIGNING_SECRET` and
// keys its audit digests. Without this binding the component takes its
// documented plain-SHA-256 fallback (unkeyed) on the real deployment.
const app = defineApp({
  env: {MEMORY_SIGNING_SECRET: v.optional(v.string())}
});

app.use(memory, {
  env: {MEMORY_SIGNING_SECRET: app.env.MEMORY_SIGNING_SECRET}
});

export default app;
