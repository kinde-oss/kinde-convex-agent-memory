import {httpRouter} from 'convex/server';
import {httpAction} from './_generated/server.js';
import {agentMemory} from './example.js';

/**
 * DIRECT-HTTP SEAM (P7). The component itself defines no HTTP routes — component
 * HTTP actions cannot read the app's env or `ctx.auth`. Instead the CLIENT
 * provides `httpAction`-shaped handlers (`agentMemory.httpHandlers()`) and the
 * APP mounts them on its OWN router with its OWN `httpAction` builder, passing
 * its `verifyCaller` in via the client config (see `example.ts`). This is the
 * established Convex component pattern (auth/billing/Twilio).
 *
 * `httpHandlers()` throws `verify_caller_not_configured` at THIS mount point if
 * the client has no `verifyCaller` — you cannot serve HTTP without verifying
 * callers. Every route is POST-with-JSON-body RPC style (agent-friendly); the
 * server-verified tenant comes from the bearer token, never the body.
 */
const handlers = agentMemory.httpHandlers();

const http = httpRouter();

http.route({
  path: '/memory/write',
  method: 'POST',
  handler: httpAction(handlers.write)
});
http.route({
  path: '/memory/get',
  method: 'POST',
  handler: httpAction(handlers.get)
});
http.route({
  path: '/memory/list',
  method: 'POST',
  handler: httpAction(handlers.list)
});
http.route({
  path: '/memory/recall',
  method: 'POST',
  handler: httpAction(handlers.recall)
});

export default http;
