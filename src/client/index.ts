import type {
  FunctionArgs,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel
} from 'convex/server';
import {ConvexError} from 'convex/values';
import {
  embeddingProblem,
  isWellFormedEmbedding
} from '../component/lib/embedding.js';
import type {ComponentApi} from '../component/_generated/component.js';

export type {ComponentApi} from '../component/_generated/component.js';
export {
  DEFAULT_RECALL_TOP_K,
  EMBEDDING_DIMENSIONS,
  MAX_RECALL_TOP_K
} from '../component/lib/embedding.js';
import {DEFAULT_RECALL_TOP_K} from '../component/lib/embedding.js';

export type RunMutationCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  'runQuery' | 'runMutation'
>;

/**
 * The ctx shape {@link AgentMemory.recall} needs: the component's recall is
 * an ACTION (vector search exists only in actions), so the calling app
 * function must be an action too and supply `runAction`. `write`/`get`/`list`
 * keep the mutation-capable {@link RunMutationCtx}.
 */
export type RunActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  'runAction'
>;

// The component functions' exact arg/return types, recovered from the
// generated component API so the client never re-declares (or drifts from)
// the validators.
type WriteArgs = FunctionArgs<ComponentApi['memory']['write']>;
type WriteResult = FunctionReturnType<ComponentApi['memory']['write']>;
type GetArgs = FunctionArgs<ComponentApi['memory']['get']>;
type GetResult = FunctionReturnType<ComponentApi['memory']['get']>;
type ListArgs = FunctionArgs<ComponentApi['memory']['list']>;
type ListResult = FunctionReturnType<ComponentApi['memory']['list']>;
type RecallArgs = FunctionArgs<ComponentApi['memory']['recall']>;
type RecallResult = FunctionReturnType<ComponentApi['memory']['recall']>;

/** Arguments to {@link AgentMemory.write}. */
export type MemoryWriteArgs = WriteArgs;
/** Arguments to {@link AgentMemory.get}. */
export type MemoryGetArgs = GetArgs;
/** Arguments to {@link AgentMemory.list}. */
export type MemoryListArgs = ListArgs;
/**
 * Arguments to {@link AgentMemory.recall}. Exactly ONE of `query` (text —
 * requires a configured embedder) or `embedding` (a ready vector — the
 * embedder is not consulted) must be supplied. `topK` defaults to
 * {@link DEFAULT_RECALL_TOP_K}.
 */
export type MemoryRecallArgs = Omit<RecallArgs, 'embedding' | 'topK'> & {
  query?: string;
  embedding?: number[];
  topK?: number;
};
/** A successful write: the record id, how it resolved, the correlation id. */
export type MemoryWriteOk = Extract<WriteResult, {ok: true}>;
/** One successful list page: rows, pagination state, correlation id. */
export type MemoryListOk = Extract<ListResult, {ok: true}>;
/** A successful recall: matches ordered by score desc, correlation id. */
export type MemoryRecallOk = Extract<RecallResult, {ok: true}>;
/** The list filter shape (plain data, closed object). */
export type MemoryListFilter = NonNullable<ListArgs['filter']>;
/** A full memory record, as returned by governed reads. */
export type MemoryRecord = NonNullable<
  Extract<GetResult, {ok: true}>['memory']
>;

/**
 * The verified identity of a caller, as produced by an app-supplied
 * {@link VerifyCaller}. The shape mirrors — field for field — what
 * `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller` returns
 * (its `VerifiedAgent`), so that client plugs straight into this seam.
 * The component itself imports no auth package.
 */
export interface VerifiedCaller {
  /** The authenticated principal the memory operations act for. */
  subject: string;
  /** The registry id of the calling agent, or null when unregistered. */
  agentId: string | null;
  /**
   * The organization the caller's token is scoped to. This is the
   * server-verified tenant context the memory boundary is keyed on — it can
   * never be overridden by request input.
   */
  orgCode: string | null;
  /** Scopes granted to the caller. */
  scopes: string[];
  /** The full verified token payload. */
  claims: Record<string, unknown>;
}

/**
 * OPTIONAL caller-authentication seam for the direct-HTTP case: given a bearer
 * token, authenticate the caller and resolve the server-verified tenant
 * context (throw to reject). Matches the signature of
 * `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller`, the blessed default —
 * but ANY auth can supply it, and the component is fully standalone without
 * it: in-Convex callers pass a subject and tenant context their app has
 * already verified.
 */
export type VerifyCaller = (token: string) => Promise<VerifiedCaller>;

/**
 * OPTIONAL injectable embedder seam: given a memory's text, return its
 * embedding vector for semantic recall. No embedding provider is hardcoded —
 * the app supplies whichever model it uses. Without an embedder the component
 * is fully standalone: structured memory works end to end, and only
 * vector-search recall is unavailable.
 */
export type Embedder = (text: string) => Promise<number[]>;

/**
 * Configuration for the {@link AgentMemory} client. Every slot is optional and
 * the component is fully standalone with none of them set.
 */
export interface MemoryComponentConfig {
  /** See {@link VerifyCaller}. Consumed by the app-mounted HTTP path only. */
  verifyCaller?: VerifyCaller;
  /** See {@link Embedder}. Enables semantic (vector) recall when present. */
  embedder?: Embedder;
  /**
   * Name of the env var the component reads its HMAC signing secret from,
   * for apps that mount the component under a different secret var. The value
   * itself is always set via `npx convex env set`, never hardcoded.
   */
  signingSecretEnvVar?: string;
}

/**
 * Convert a governed denial into a thrown, typed ConvexError. The component
 * RETURNS denials (so the denial's audit row commits — a throw inside the
 * component mutation would roll it back); the client restores fail(code,
 * message) semantics for app code here, AFTER that mutation has committed.
 */
function throwDenied(result: {
  code: string;
  message: string;
  correlationId: string;
}): never {
  throw new ConvexError({
    code: result.code,
    message: result.message,
    correlationId: result.correlationId
  });
}

/**
 * Client for the Kinde agent memory component.
 *
 * Construct it with the component reference from your app's generated
 * `components` object:
 *
 * ```ts
 * import {AgentMemory} from '@kinde-oss/kinde-convex-agent-memory';
 * import {components} from './_generated/api.js';
 *
 * export const agentMemory = new AgentMemory(components.memory);
 * ```
 *
 * Every method takes the app's `ctx` plus a server-verified tenant context
 * (`orgCode`) and runs through the component's ONE governed access path. Both
 * `write` and `get` run as mutations — every governed operation, reads
 * included, writes exactly one audit row, and only mutations can write.
 *
 * DENIAL-AUDIT DURABILITY: on a governed denial these methods throw AFTER the
 * component has audited it. Called from an app ACTION, the component mutation
 * commits first, so the denial audit row is durable. Called from an app
 * MUTATION that lets the throw propagate, Convex rolls back the app's whole
 * transaction — the denial audit row included. Call from an action (or catch
 * the ConvexError) when denial-audit durability matters.
 */
export class AgentMemory {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: MemoryComponentConfig = {}
  ) {}

  /**
   * Governed write. Returns the record id, how the write resolved
   * (`created` | `updated` | `idempotent_replay`), and the correlation id.
   * Throws a typed ConvexError (`tenant_context_conflict`,
   * `idempotency_key_reused`) on a governed denial — the denial is already
   * audited by the component before this throws.
   */
  async write(
    ctx: RunMutationCtx,
    args: MemoryWriteArgs
  ): Promise<MemoryWriteOk> {
    const result = await ctx.runMutation(this.component.memory.write, args);
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Governed read-by-key. Returns the record, or null when no record with
   * that key exists IN THIS TENANT (a key held by another tenant is
   * indistinguishable from a missing one). Throws a typed ConvexError on a
   * governed denial, after the denial's audit row has committed.
   */
  async get(
    ctx: RunMutationCtx,
    args: MemoryGetArgs
  ): Promise<MemoryRecord | null> {
    const result = await ctx.runMutation(this.component.memory.get, args);
    if (!result.ok) {
      throwDenied(result);
    }
    return result.memory;
  }

  /**
   * Governed, paginated listing over the tenant's memories. Standard Convex
   * pagination: pass `{numItems, cursor}` and walk `continueCursor` until
   * `isDone` (after in-range refinement a page may hold fewer than `numItems`
   * rows while `isDone` is still false). Throws a typed ConvexError
   * (`tenant_context_conflict`, `invalid_filter`) on a governed denial, after
   * the denial's audit row has committed.
   */
  async list(ctx: RunMutationCtx, args: MemoryListArgs): Promise<MemoryListOk> {
    const result = await ctx.runMutation(this.component.memory.list, args);
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Governed semantic recall: tenant-partitioned vector search, matches
   * ordered by similarity score descending. MUST be called from an app
   * ACTION (the component's recall is an action — vector search exists only
   * there), hence the {@link RunActionCtx} ctx shape.
   *
   * Supply exactly one of:
   * - `query` — text to embed. REQUIRES `config.embedder`; throws typed
   *   `embedder_not_configured` naming the missing config slot when absent.
   *   An embedder that throws, or returns anything other than an array of
   *   exactly `EMBEDDING_DIMENSIONS` finite numbers, becomes a typed
   *   `embedder_response_malformed` error — the malformed vector never
   *   reaches the component.
   * - `embedding` — a ready vector; the embedder is not consulted. The
   *   component validates it (typed `invalid_embedding` denial, audited).
   *
   * Throws a typed ConvexError (`tenant_context_conflict`,
   * `invalid_embedding`, `invalid_topk`) on a governed denial, after the
   * denial's audit row has committed.
   */
  async recall(
    ctx: RunActionCtx,
    args: MemoryRecallArgs
  ): Promise<MemoryRecallOk> {
    const {query, embedding: suppliedEmbedding, topK, ...rest} = args;
    if (query !== undefined && suppliedEmbedding !== undefined) {
      throw new ConvexError({
        code: 'invalid_argument',
        message:
          'Supply exactly one of `query` or `embedding` to recall, not both.'
      });
    }
    let embedding: number[];
    if (suppliedEmbedding !== undefined) {
      embedding = suppliedEmbedding;
    } else {
      if (query === undefined || query === '') {
        throw new ConvexError({
          code: 'invalid_argument',
          message:
            'Recall needs either a non-empty `query` string or an `embedding` vector.'
        });
      }
      const embedder = this.options.embedder;
      if (embedder === undefined) {
        throw new ConvexError({
          code: 'embedder_not_configured',
          message:
            'Recall by query text requires `config.embedder` on the AgentMemory client (new AgentMemory(component, {embedder})). Supply an embedder, or pass a ready `embedding` vector instead.'
        });
      }
      let response: unknown;
      try {
        response = await embedder(query);
      } catch (caught) {
        throw new ConvexError({
          code: 'embedder_response_malformed',
          message: `The configured embedder threw while embedding the query: ${
            caught instanceof Error ? caught.message : String(caught)
          }`
        });
      }
      if (!isWellFormedEmbedding(response)) {
        throw new ConvexError({
          code: 'embedder_response_malformed',
          message: `The configured embedder returned a malformed embedding: ${embeddingProblem(response) ?? 'unknown problem'}`
        });
      }
      embedding = response;
    }
    const result = await ctx.runAction(this.component.memory.recall, {
      ...rest,
      embedding,
      topK: topK ?? DEFAULT_RECALL_TOP_K
    });
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }
}
