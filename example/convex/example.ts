import {query} from './_generated/server.js';
import {v} from 'convex/values';

/** Trivial health check proving the example app and mounted component load. */
export const health = query({
  args: {},
  returns: v.string(),
  handler: async () => 'ok'
});
