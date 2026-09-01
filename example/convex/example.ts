import {
  internalAction,
  internalMutation,
  internalQuery
} from './_generated/server.js';
import {components} from './_generated/api.js';
import {
  AgentMemory,
  EMBEDDING_DIMENSIONS
} from '@kinde-oss/kinde-convex-agent-memory';
import type {
  MemoryId,
  VerifiedCaller,
  VerifyCaller
} from '@kinde-oss/kinde-convex-agent-memory';
import {GovernedConvexVector} from './mastraAdapter.js';
import {GovernedLangChainVectorStore} from './langchainAdapter.js';
import {GovernedLlamaIndexVectorStore} from './llamaindexAdapter.js';
import {governedMemoryTools} from './vercelAdapter.js';
import {governedMemoryFunctionTools} from './openaiAgentsAdapter.js';
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
 * A FAKE, deterministic `verifyCaller` for the example: maps a fixed set of
 * test bearer tokens to server-verified callers. A REAL app supplies its own
 * (e.g. `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller`, which validates a
 * JWT and returns the token's tenant). The `orgCode` here IS the authoritative
 * tenant the HTTP seam binds to — it comes from the (fake) token, never a body.
 *
 * - `token-alice-orgA` → org_alpha
 * - `token-bob-orgB`   → org_beta   (the isolation story is mountable)
 * - `token-no-org`     → a VALID shape with `orgCode: null` (no tenant), used to
 *   exercise the `verify_caller_response_malformed` path
 * - anything else      → throws (a rejected/unknown token → 401)
 */
const FAKE_TOKENS: Record<string, VerifiedCaller> = {
  'token-alice-orgA': {
    subject: 'user_alice',
    agentId: 'agent_alice',
    orgCode: 'org_alpha',
    scopes: ['memory.read', 'memory.write', 'memory.recall'],
    claims: {iss: 'fake', sub: 'user_alice'}
  },
  'token-bob-orgB': {
    subject: 'user_bob',
    agentId: 'agent_bob',
    orgCode: 'org_beta',
    scopes: ['memory.read', 'memory.write', 'memory.recall'],
    claims: {iss: 'fake', sub: 'user_bob'}
  },
  'token-no-org': {
    subject: 'user_ghost',
    agentId: null,
    orgCode: null,
    scopes: [],
    claims: {iss: 'fake', sub: 'user_ghost'}
  }
};

export const fakeVerifyCaller: VerifyCaller = async (token) => {
  const caller = FAKE_TOKENS[token];
  if (caller === undefined) {
    throw new Error('unknown token');
  }
  return caller;
};

/**
 * The component client. Construct it once with the component reference from
 * the app's generated `components` object, then call its methods. The
 * `embedder` slot enables recall by query text; the `verifyCaller` slot enables
 * the direct-HTTP handlers mounted in `http.ts`.
 */
export const agentMemory = new AgentMemory(components.memory, {
  embedder: async (text) => fakeEmbed(text),
  verifyCaller: fakeVerifyCaller
});

// DRIVER EXPOSURE. Every driver below is an internalMutation / internalQuery /
// internalAction, NOT a public one. Each trusts a caller-supplied `subject` and
// `orgCode` (the reporting drivers take only `orgCode`) with no verified-identity
// derivation of its own, so exposing them publicly would let a client name any
// tenant. They model HOST-SIDE calls: in a real app the host resolves the
// verified tenant (from its auth) and then calls these internally. The ONLY
// public surface is the HTTP seam in `http.ts`, whose handlers resolve the
// tenant from a verified bearer token before touching the component. The tests
// invoke these through `internal.example.*`, which is how convex-test reaches
// internal functions.

/** Trivial health check proving the example app and mounted component load. */
export const health = internalQuery({
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
export const writeMemory = internalMutation({
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
export const listMemories = internalMutation({
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
export const writeMemoryEmbedded = internalMutation({
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
export const recallMemories = internalAction({
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
export const grantAccess = internalMutation({
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
export const revokeAccess = internalMutation({
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
export const setRedactionPolicy = internalMutation({
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
export const revokeCaller = internalMutation({
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
export const liftCaller = internalMutation({
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
export const getMemory = internalMutation({
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
export const auditLog = internalQuery({
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
export const memoryProvenance = internalQuery({
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
export const inspectRevocation = internalQuery({
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

/**
 * MASTRA VECTOR-STORE ADAPTER DRIVERS (P8). Both are ACTIONS: the adapter's
 * `upsert` runs a governed mutation (`write`) and `query` runs the governed
 * vector action (`recall`), so an action ctx is required. Each constructs a
 * GovernedConvexVector BOUND to the (subject, orgCode) passed in — in a real
 * app that orgCode is the server-verified tenant, never request input. The
 * adapter routes to the SAME governed client the rest of the example uses, so
 * isolation, audit, redaction, and revocation are inherited, not re-added.
 */
export const mastraUpsert = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    id: v.string(),
    vector: v.array(v.float64()),
    metadata: v.optional(v.record(v.string(), v.string()))
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const store = new GovernedConvexVector({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode
    });
    return await store.upsert({
      indexName: 'memories',
      vectors: [args.vector],
      ids: [args.id],
      ...(args.metadata === undefined ? {} : {metadata: [args.metadata]})
    });
  }
});

export const mastraQuery = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    queryVector: v.array(v.float64()),
    topK: v.optional(v.number()),
    filter: v.optional(v.record(v.string(), v.string()))
  },
  returns: v.array(v.object({id: v.string(), score: v.float64()})),
  handler: async (ctx, args) => {
    const store = new GovernedConvexVector({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode
    });
    const results = await store.query({
      indexName: 'memories',
      queryVector: args.queryVector,
      ...(args.topK === undefined ? {} : {topK: args.topK}),
      ...(args.filter === undefined ? {} : {filter: args.filter})
    });
    return results.map((result) => ({id: result.id, score: result.score}));
  }
});

/**
 * LANGCHAIN VECTOR-STORE ADAPTER DRIVERS (P11). ACTIONS, like the Mastra ones:
 * the adapter's add path runs a governed mutation (`write`) and the search path
 * runs the governed vector action (`recall`). Each constructs a
 * GovernedLangChainVectorStore BOUND to the (subject, orgCode) passed in — in a
 * real app that orgCode is the server-verified tenant, never request input.
 */
export const langchainAddVectors = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    id: v.string(),
    vector: v.array(v.float64()),
    pageContent: v.string(),
    metadata: v.optional(v.record(v.string(), v.string()))
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const store = new GovernedLangChainVectorStore({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode
    });
    return await store.addVectors(
      [args.vector],
      [
        {
          pageContent: args.pageContent,
          metadata: args.metadata ?? {},
          id: args.id
        }
      ]
    );
  }
});

/** Exercises the addDocuments embed path (embeds pageContent via fakeEmbed). */
export const langchainAddDocuments = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    id: v.string(),
    pageContent: v.string(),
    metadata: v.optional(v.record(v.string(), v.string()))
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const store = new GovernedLangChainVectorStore({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode,
      embeddings: {
        embedDocuments: async (texts) => texts.map(fakeEmbed),
        embedQuery: async (text) => fakeEmbed(text)
      }
    });
    return await store.addDocuments([
      {
        pageContent: args.pageContent,
        metadata: args.metadata ?? {},
        id: args.id
      }
    ]);
  }
});

export const langchainQuery = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    queryVector: v.array(v.float64()),
    k: v.number(),
    filter: v.optional(v.record(v.string(), v.string()))
  },
  returns: v.array(
    v.object({id: v.string(), pageContent: v.string(), score: v.float64()})
  ),
  handler: async (ctx, args) => {
    const store = new GovernedLangChainVectorStore({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode
    });
    const results = await store.similaritySearchVectorWithScore(
      args.queryVector,
      args.k,
      args.filter
    );
    return results.map(([document, score]) => ({
      id: document.id ?? '',
      pageContent: document.pageContent,
      score
    }));
  }
});

/**
 * LLAMAINDEX VECTOR-STORE ADAPTER DRIVERS (P11). Same construction-bound-tenant,
 * same governed routing as above. `add` writes governed records; `query` runs
 * governed recall; `delete` surfaces the honest not-supported limitation.
 */
export const llamaindexAdd = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    id: v.string(),
    embedding: v.array(v.float64()),
    text: v.optional(v.string()),
    metadata: v.optional(v.record(v.string(), v.string()))
  },
  returns: v.array(v.string()),
  handler: async (ctx, args) => {
    const store = new GovernedLlamaIndexVectorStore({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode
    });
    return await store.add([
      {
        id_: args.id,
        embedding: args.embedding,
        ...(args.text === undefined ? {} : {text: args.text}),
        metadata: args.metadata ?? {}
      }
    ]);
  }
});

export const llamaindexQuery = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    queryEmbedding: v.array(v.float64()),
    similarityTopK: v.number(),
    filter: v.optional(v.record(v.string(), v.string()))
  },
  returns: v.array(
    v.object({id: v.string(), text: v.string(), similarity: v.float64()})
  ),
  handler: async (ctx, args) => {
    const store = new GovernedLlamaIndexVectorStore({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode
    });
    const filters =
      args.filter === undefined
        ? undefined
        : {
            filters: Object.entries(args.filter).map(([key, value]) => ({
              key,
              value
            }))
          };
    const result = await store.query({
      queryEmbedding: args.queryEmbedding,
      similarityTopK: args.similarityTopK,
      ...(filters === undefined ? {} : {filters})
    });
    return result.ids.map((id, index) => ({
      id,
      text: result.nodes[index].text ?? '',
      similarity: result.similarities[index]
    }));
  }
});

/** Drives the adapter's delete, which throws the honest not-supported error. */
export const llamaindexDelete = internalAction({
  args: {subject: v.string(), orgCode: v.string(), refDocId: v.string()},
  returns: v.null(),
  handler: async (ctx, args) => {
    const store = new GovernedLlamaIndexVectorStore({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode
    });
    await store.delete(args.refDocId);
    return null;
  }
});

/**
 * VERCEL AI SDK GOVERNED-TOOL DRIVERS (P12). The tools are a pair — saveMemory /
 * searchMemory — built by a factory that CLOSES the (subject, orgCode) over the
 * tools; orgCode is NOT a tool parameter. Both drivers are ACTIONS: save runs a
 * governed mutation (`write`), search runs the governed vector action (`recall`).
 */
export const vercelSaveMemory = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    key: v.optional(v.string()),
    content: v.string(),
    embedding: v.optional(v.array(v.float64()))
  },
  returns: v.object({id: v.string(), outcome: v.string()}),
  handler: async (ctx, args) => {
    const tools = governedMemoryTools({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode,
      embedder: async (text) => fakeEmbed(text)
    });
    return await tools.saveMemory.execute({
      ...(args.key === undefined ? {} : {key: args.key}),
      content: args.content,
      ...(args.embedding === undefined ? {} : {embedding: args.embedding})
    });
  }
});

export const vercelSearchMemory = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    query: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    topK: v.optional(v.number())
  },
  returns: v.array(
    v.object({key: v.string(), content: v.string(), score: v.float64()})
  ),
  handler: async (ctx, args) => {
    const tools = governedMemoryTools({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode,
      embedder: async (text) => fakeEmbed(text)
    });
    return await tools.searchMemory.execute({
      ...(args.query === undefined ? {} : {query: args.query}),
      ...(args.embedding === undefined ? {} : {embedding: args.embedding}),
      ...(args.topK === undefined ? {} : {topK: args.topK})
    });
  }
});

/** Reports the tool INPUT-SCHEMA property names, so a test can prove neither
 * tool exposes `orgCode`/`subject` (the tenant is not in the surface). */
export const vercelToolSurface = internalAction({
  args: {subject: v.string(), orgCode: v.string()},
  returns: v.object({
    saveProps: v.array(v.string()),
    searchProps: v.array(v.string())
  }),
  handler: async (ctx, args) => {
    const tools = governedMemoryTools({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode,
      embedder: async (text) => fakeEmbed(text)
    });
    return {
      saveProps: Object.keys(tools.saveMemory.inputSchema.properties),
      searchProps: Object.keys(tools.searchMemory.inputSchema.properties)
    };
  }
});

/**
 * OPENAI AGENTS SDK GOVERNED-TOOL DRIVERS (P12). The same governed pair in the
 * function-tool shape (save_memory / search_memory), same construction-bound
 * tenant not present in the tool surface.
 */
export const openaiSaveMemory = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    key: v.optional(v.string()),
    content: v.string(),
    embedding: v.optional(v.array(v.float64()))
  },
  returns: v.object({id: v.string(), outcome: v.string()}),
  handler: async (ctx, args) => {
    const tools = governedMemoryFunctionTools({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode,
      embedder: async (text) => fakeEmbed(text)
    });
    return await tools.save_memory.execute({
      ...(args.key === undefined ? {} : {key: args.key}),
      content: args.content,
      ...(args.embedding === undefined ? {} : {embedding: args.embedding})
    });
  }
});

export const openaiSearchMemory = internalAction({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    query: v.optional(v.string()),
    embedding: v.optional(v.array(v.float64())),
    topK: v.optional(v.number())
  },
  returns: v.array(
    v.object({key: v.string(), content: v.string(), score: v.float64()})
  ),
  handler: async (ctx, args) => {
    const tools = governedMemoryFunctionTools({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode,
      embedder: async (text) => fakeEmbed(text)
    });
    return await tools.search_memory.execute({
      ...(args.query === undefined ? {} : {query: args.query}),
      ...(args.embedding === undefined ? {} : {embedding: args.embedding}),
      ...(args.topK === undefined ? {} : {topK: args.topK})
    });
  }
});

/** Reports the function-tool PARAMETERS property names (see vercelToolSurface). */
export const openaiToolSurface = internalAction({
  args: {subject: v.string(), orgCode: v.string()},
  returns: v.object({
    saveProps: v.array(v.string()),
    searchProps: v.array(v.string())
  }),
  handler: async (ctx, args) => {
    const tools = governedMemoryFunctionTools({
      agentMemory,
      ctx,
      subject: args.subject,
      orgCode: args.orgCode,
      embedder: async (text) => fakeEmbed(text)
    });
    return {
      saveProps: Object.keys(tools.save_memory.parameters.properties),
      searchProps: Object.keys(tools.search_memory.parameters.properties)
    };
  }
});
