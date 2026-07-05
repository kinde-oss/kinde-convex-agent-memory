import {action, mutation, query} from './_generated/server.js';
import {components} from './_generated/api.js';
import {
  AgentMemory,
  EMBEDDING_DIMENSIONS
} from '@kinde-oss/kinde-convex-agent-memory';
import type {MemoryId} from '@kinde-oss/kinde-convex-agent-memory';
import {v} from 'convex/values';

/**
 * A FAKE, fully deterministic embedder for the example: hashes the text into
 * a fixed-dimension vector (identical text → identical vector; different
 * text → an unrelated vector). It demonstrates the injectable embedder seam
 * without any provider dependency — a real app supplies its embedding model
 * here instead. Exported so the example's tests reuse the same vectors.
 */
export function fakeEmbed(text: string): number[] {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const vector: number[] = [];
  for (let i = 0; i < EMBEDDING_DIMENSIONS; i++) {
    h ^= i;
    h = Math.imul(h, 0x01000193);
    vector.push(((h >>> 0) % 2001) / 1000 - 1);
  }
  return vector;
}

/**
 * The component client. Construct it once with the component reference from
 * the app's generated `components` object, then call its methods. The
 * embedder config slot enables recall by query text.
 */
export const agentMemory = new AgentMemory(components.memory, {
  embedder: async (text) => fakeEmbed(text)
});

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

/**
 * Governed listing through the client: one page of the tenant's keys,
 * optionally narrowed by a key prefix. Walk `continueCursor` until `isDone`.
 */
export const listMemories = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    keyPrefix: v.optional(v.string()),
    numItems: v.number(),
    cursor: v.union(v.string(), v.null())
  },
  returns: v.object({
    keys: v.array(v.string()),
    isDone: v.boolean(),
    continueCursor: v.string()
  }),
  handler: async (ctx, args) => {
    const result = await agentMemory.list(ctx, {
      subject: args.subject,
      orgCode: args.orgCode,
      ...(args.claimedOrgCode === undefined
        ? {}
        : {claimedOrgCode: args.claimedOrgCode}),
      ...(args.keyPrefix === undefined
        ? {}
        : {filter: {keyPrefix: args.keyPrefix}}),
      paginationOpts: {numItems: args.numItems, cursor: args.cursor}
    });
    return {
      keys: result.page.map((memory) => memory.key),
      isDone: result.isDone,
      continueCursor: result.continueCursor
    };
  }
});

/**
 * Governed write WITH an embedding: the content is embedded with the same
 * fake embedder recall uses, so `recallMemories` below can find it. The
 * vector is supplied to the component alongside the write — the component
 * itself never embeds.
 */
export const writeMemoryEmbedded = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    key: v.string(),
    content: v.string()
  },
  returns: v.object({
    memoryId: v.string(),
    outcome: v.string(),
    correlationId: v.string()
  }),
  handler: async (ctx, args) => {
    const result = await agentMemory.write(ctx, {
      ...args,
      embedding: fakeEmbed(args.content)
    });
    return {
      memoryId: result.memoryId,
      outcome: result.outcome,
      correlationId: result.correlationId
    };
  }
});

/**
 * The recall driver: semantic recall by QUERY TEXT, demonstrating the
 * injected-embedder path end to end. An ACTION, because the component's
 * recall is one (vector search exists only in actions).
 */
export const recallMemories = action({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    query: v.string(),
    topK: v.optional(v.number())
  },
  returns: v.array(
    v.object({
      key: v.string(),
      content: v.string(),
      orgCode: v.string(),
      score: v.number()
    })
  ),
  handler: async (ctx, args) => {
    const result = await agentMemory.recall(ctx, {
      subject: args.subject,
      orgCode: args.orgCode,
      ...(args.claimedOrgCode === undefined
        ? {}
        : {claimedOrgCode: args.claimedOrgCode}),
      query: args.query,
      ...(args.topK === undefined ? {} : {topK: args.topK})
    });
    return result.matches.map((match) => ({
      key: match.memory.key,
      content: match.memory.content,
      orgCode: match.memory.orgCode,
      score: match.score
    }));
  }
});

/**
 * Grant a memory scope to a subject through the client. The target's first
 * grant flips it from permissive to enforced mode.
 */
export const grantAccess = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    targetSubject: v.string(),
    scope: v.union(
      v.literal('memory.read'),
      v.literal('memory.write'),
      v.literal('memory.recall')
    )
  },
  returns: v.object({outcome: v.string(), correlationId: v.string()}),
  handler: async (ctx, args) => {
    const result = await agentMemory.grant(ctx, args);
    return {outcome: result.outcome, correlationId: result.correlationId};
  }
});

/** Revoke a subject's scope grant through the client. */
export const revokeAccess = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    targetSubject: v.string(),
    scope: v.union(
      v.literal('memory.read'),
      v.literal('memory.write'),
      v.literal('memory.recall')
    )
  },
  returns: v.object({correlationId: v.string()}),
  handler: async (ctx, args) => {
    const result = await agentMemory.revokeGrant(ctx, args);
    return {correlationId: result.correlationId};
  }
});

/**
 * Set (or clear, with an empty fields array) the tenant's redaction policy
 * through the client — org-wide, or targeted when targetSubject is given.
 */
export const setRedactionPolicy = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    targetSubject: v.optional(v.string()),
    fields: v.array(v.string())
  },
  returns: v.object({outcome: v.string(), correlationId: v.string()}),
  handler: async (ctx, args) => {
    const result = await agentMemory.setRedaction(ctx, args);
    return {outcome: result.outcome, correlationId: result.correlationId};
  }
});

/** The revocation-target shape accepted by the overlay kill switch. */
const revocationTargetArg = v.object({
  kind: v.union(v.literal('global'), v.literal('org'), v.literal('subject')),
  orgCode: v.optional(v.string()),
  subject: v.optional(v.string())
});

/**
 * Revoke a caller via the P5 kill-switch OVERLAY through the client. Outranks
 * grants — a revoked caller is denied `revoked` whatever scopes it holds, until
 * the revocation is lifted. Distinct from `revokeAccess` above, which revokes a
 * single scope grant.
 */
export const revokeCaller = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    target: revocationTargetArg,
    reason: v.string()
  },
  returns: v.object({outcome: v.string(), correlationId: v.string()}),
  handler: async (ctx, args) => {
    const result = await agentMemory.revoke(ctx, args);
    return {outcome: result.outcome, correlationId: result.correlationId};
  }
});

/** Lift an overlay revocation through the client, restoring access. */
export const liftCaller = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    target: revocationTargetArg
  },
  returns: v.object({correlationId: v.string()}),
  handler: async (ctx, args) => {
    const result = await agentMemory.liftRevocation(ctx, args);
    return {correlationId: result.correlationId};
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

/**
 * READ SURFACE 1 — the paginated audit log through the client. Runs as a QUERY
 * (not a mutation): reading the log writes no audit row.
 */
export const auditLog = query({
  args: {
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    subject: v.optional(v.string()),
    correlationId: v.optional(v.string()),
    numItems: v.number(),
    cursor: v.union(v.string(), v.null())
  },
  returns: v.object({
    rows: v.array(
      v.object({
        subject: v.string(),
        operation: v.string(),
        decision: v.string(),
        reasonCode: v.string(),
        keyOrQueryDigest: v.string(),
        correlationId: v.string(),
        ts: v.number()
      })
    ),
    isDone: v.boolean(),
    continueCursor: v.string()
  }),
  handler: async (ctx, args) => {
    const filter = {
      ...(args.subject === undefined ? {} : {subject: args.subject}),
      ...(args.correlationId === undefined
        ? {}
        : {correlationId: args.correlationId})
    };
    const page = await agentMemory.auditQuery(ctx, {
      orgCode: args.orgCode,
      ...(args.claimedOrgCode === undefined
        ? {}
        : {claimedOrgCode: args.claimedOrgCode}),
      ...(Object.keys(filter).length === 0 ? {} : {filter}),
      paginationOpts: {numItems: args.numItems, cursor: args.cursor}
    });
    return {
      rows: page.page.map((row) => ({
        subject: row.subject,
        operation: row.operation,
        decision: row.decision,
        reasonCode: row.reasonCode,
        keyOrQueryDigest: row.keyOrQueryDigest,
        correlationId: row.correlationId,
        ts: row.ts
      })),
      isDone: page.isDone,
      continueCursor: page.continueCursor
    };
  }
});

/**
 * READ SURFACE 2 — a record's provenance through the client. Runs as a QUERY.
 * `memoryId` arrives as a plain string (the app stored it from a write result)
 * and is re-branded via the client's exported {@link MemoryId} type. Returns no
 * content/metadata by construction.
 */
export const memoryProvenance = query({
  args: {
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    memoryId: v.string()
  },
  returns: v.union(
    v.null(),
    v.object({
      key: v.string(),
      subject: v.string(),
      createdBy: v.string(),
      createdAt: v.number(),
      writtenBy: v.string(),
      writtenAt: v.number()
    })
  ),
  handler: async (ctx, args) => {
    const provenance = await agentMemory.provenanceOf(ctx, {
      orgCode: args.orgCode,
      ...(args.claimedOrgCode === undefined
        ? {}
        : {claimedOrgCode: args.claimedOrgCode}),
      memoryId: args.memoryId as MemoryId
    });
    if (provenance === null) {
      return null;
    }
    return {
      key: provenance.key,
      subject: provenance.subject,
      createdBy: provenance.createdBy,
      createdAt: provenance.createdAt,
      writtenBy: provenance.writtenBy,
      writtenAt: provenance.writtenAt
    };
  }
});

/**
 * READ SURFACE 3 — the revocation reason-join through the client. Runs as a
 * QUERY. Given a target, returns the target digest (matches the `revoked` audit
 * row's digest) and the revocation rows INCLUDING the reason.
 */
export const inspectRevocation = query({
  args: {
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    target: revocationTargetArg
  },
  returns: v.object({
    targetDigest: v.string(),
    revocations: v.array(
      v.object({
        reason: v.string(),
        revokedBy: v.string(),
        revokedAt: v.number(),
        liftedBy: v.union(v.string(), v.null()),
        liftedAt: v.union(v.number(), v.null())
      })
    )
  }),
  handler: async (ctx, args) => {
    const result = await agentMemory.inspectRevocation(ctx, args);
    return {
      targetDigest: result.targetDigest,
      revocations: result.revocations.map((row) => ({
        reason: row.reason,
        revokedBy: row.revokedBy,
        revokedAt: row.revokedAt,
        liftedBy: row.liftedBy,
        liftedAt: row.liftedAt
      }))
    };
  }
});
