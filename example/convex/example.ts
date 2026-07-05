import {mutation, query} from './_generated/server.js';
import {components} from './_generated/api.js';
import {AgentMemory} from '@kinde-oss/kinde-convex-agent-memory';
import {v} from 'convex/values';

/**
 * The component client. Construct it once with the component reference from
 * the app's generated `components` object, then call its methods.
 */
export const agentMemory = new AgentMemory(components.memory);

/** Trivial health check proving the example app and mounted component load. */
export const health = query({
  args: {},
  returns: v.string(),
  handler: async () => 'ok'
});

/**
 * Governed write through the client. `orgCode` is the SERVER-VERIFIED tenant
 * context this trusted app supplies; `claimedOrgCode` models a value that
 * arrived from a client and is passed through so the component can reject a
 * conflict (the app never resolves the conflict itself).
 */
export const writeMemory = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    key: v.string(),
    content: v.string()
  },
  returns: v.object({
    memoryId: v.string(),
    outcome: v.string(),
    correlationId: v.string()
  }),
  handler: async (ctx, args) => {
    const result = await agentMemory.write(ctx, args);
    return {
      memoryId: result.memoryId,
      outcome: result.outcome,
      correlationId: result.correlationId
    };
  }
});

/** Governed read-by-key through the client (null when absent IN THIS TENANT). */
export const getMemory = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    key: v.string()
  },
  returns: v.union(
    v.null(),
    v.object({
      key: v.string(),
      content: v.string(),
      createdBy: v.string(),
      writtenBy: v.string()
    })
  ),
  handler: async (ctx, args) => {
    const memory = await agentMemory.get(ctx, args);
    if (memory === null) {
      return null;
    }
    return {
      key: memory.key,
      content: memory.content,
      createdBy: memory.createdBy,
      writtenBy: memory.writtenBy
    };
  }
});
