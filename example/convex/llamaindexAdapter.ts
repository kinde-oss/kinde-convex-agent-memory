/**
 * A GOVERNED LLAMAINDEX VECTOR-STORE ADAPTER — example-only, framework-free.
 *
 * WHY THIS EXISTS. A Convex-backed LlamaIndex vector store manages a Convex
 * vector table directly, with deployment credentials and no per-call tenant
 * boundary. That path CANNOT be tenant-governed: it sees every tenant's vectors
 * and enforces no `subject`/`orgCode` scope, no audit, no redaction, no
 * revocation. THIS adapter routes the SAME Convex vector search through THIS
 * component's governed client instead — so recall is tenant-partitioned,
 * audited, redacted, and revocable. Same vector search underneath; ours is
 * IN-APP, PER-CALL, TENANT-BOUND. That contrast is the adapter's whole reason
 * to exist.
 *
 * INTERFACE PROVENANCE. `llamaindex` is NOT installed in this repo, and the
 * shipped package (src/) must gain NO framework dependency. So the
 * `BaseVectorStore` surface is declared LOCALLY below, mirroring the stable seam
 * of `llamaindex`'s `BaseVectorStore`: `add(nodes)`, `query(vectorStoreQuery,
 * options?)`, `delete(refDocId, deleteKwargs?)`, and `storesText`. A
 * `VectorStoreQuery` carries `queryEmbedding` + `similarityTopK` (+ optional
 * `filters`); a `VectorStoreQueryResult` carries `nodes`, `similarities`, `ids`.
 * A real integration would `extends BaseVectorStore` from the installed package;
 * the shapes here match field-for-field so that swap is mechanical.
 *
 * TENANT BINDING. The `orgCode` is the SERVER-VERIFIED tenant, bound once at
 * construction. It is NOT a filter the caller can set: query `filters` can only
 * NARROW within the already-tenant-partitioned result set, never widen across
 * tenants, and an `orgCode` filter key is ignored.
 *
 * HONESTY ON SCOPE. This adapter governs the VECTOR path (add + query), which is
 * where cross-tenant memory LEAKAGE happens. Store and recall agent memory
 * THROUGH this component to get the governed boundary; anything a LlamaIndex
 * pipeline does on a raw, non-governed store is NOT governed here.
 */
import type {
  AgentMemory,
  MemoryWriteArgs,
  RunActionCtx,
  RunMutationCtx
} from '@kinde-oss/kinde-convex-agent-memory';

// --- Local mirror of llamaindex's BaseVectorStore (see provenance above) -----

/**
 * A LlamaIndex node. The real `BaseNode` exposes content via `getContent()`; the
 * minimal mirror carries the fields this adapter needs: id, embedding, metadata,
 * and the text content of a `TextNode`.
 */
export interface LlamaIndexNode {
  id_: string;
  embedding?: number[];
  metadata: Record<string, unknown>;
  text?: string;
}

/** One equality metadata filter (mirrors LlamaIndex's `MetadataFilter`). */
export interface LlamaIndexMetadataFilter {
  key: string;
  value: string | number | boolean;
  operator?: '==';
}

/** A set of metadata filters (mirrors LlamaIndex's `MetadataFilters`). */
export interface LlamaIndexMetadataFilters {
  filters: LlamaIndexMetadataFilter[];
  condition?: 'and' | 'or';
}

export interface LlamaIndexVectorStoreQuery {
  queryEmbedding: number[];
  similarityTopK: number;
  filters?: LlamaIndexMetadataFilters;
}

export interface LlamaIndexVectorStoreQueryResult {
  nodes: LlamaIndexNode[];
  similarities: number[];
  ids: string[];
}

/** The subset of `BaseVectorStore` this adapter implements. */
export interface LlamaIndexVectorStore {
  readonly storesText: boolean;
  add(nodes: LlamaIndexNode[]): Promise<string[]>;
  query(
    query: LlamaIndexVectorStoreQuery
  ): Promise<LlamaIndexVectorStoreQueryResult>;
  delete(refDocId: string): Promise<void>;
}

// -----------------------------------------------------------------------------

/** Governed metadata shape (queryable primitives), recovered from the client. */
type GovernedMetadata = NonNullable<MemoryWriteArgs['metadata']>;

/**
 * The ctx the adapter drives the governed client with. `add` runs a mutation
 * (`write`); `query` runs an action (`recall`, a vector action). An app ACTION's
 * ctx supplies both, so the adapter is constructed inside one.
 */
export type GovernedVectorCtx = RunMutationCtx & RunActionCtx;

export interface GovernedLlamaIndexVectorStoreConfig {
  /** The governed component client (constructed with no admin key). */
  agentMemory: AgentMemory;
  /** THIS request's ctx (per-call, not a long-lived admin connection). */
  ctx: GovernedVectorCtx;
  /** The acting principal. */
  subject: string;
  /**
   * The SERVER-VERIFIED tenant. BOUND HERE, at construction — it is NOT a filter
   * the caller can set, and no method can widen beyond it. An admin-keyed store
   * has no such binding.
   */
  orgCode: string;
}

/** Convert LlamaIndex node metadata (arbitrary values) to the governed store's
 * queryable primitive metadata, or throw — the store rejects nested objects by
 * design (metadata is queryable annotation, not a document blob). */
function toGovernedMetadata(value: Record<string, unknown>): GovernedMetadata {
  const isPrimitive = (member: unknown): boolean =>
    member === null ||
    typeof member === 'string' ||
    typeof member === 'number' ||
    typeof member === 'boolean';
  const result: GovernedMetadata = {};
  for (const [field, member] of Object.entries(value)) {
    if (isPrimitive(member)) {
      result[field] = member as string | number | boolean | null;
    } else if (Array.isArray(member) && member.every(isPrimitive)) {
      result[field] = member as Array<string | number | boolean | null>;
    } else {
      throw new Error(
        `Metadata field '${field}' is not a primitive or primitive array; the governed store accepts only queryable primitive metadata.`
      );
    }
  }
  return result;
}

/**
 * Does a governed record's metadata satisfy the query's filters? Equality only,
 * and — CRUCIALLY — a filter whose `key` is `orgCode` is IGNORED: the tenant is
 * bound at construction and can never be set (or widened) by a caller filter.
 * Every other filter NARROWS within the already-tenant-partitioned result set.
 * The `condition` is honored: `and` (default) requires all, `or` requires any.
 */
function metadataMatchesFilters(
  metadata: Record<string, unknown> | undefined,
  filters: LlamaIndexMetadataFilters
): boolean {
  const applicable = filters.filters.filter(
    (filter) => filter.key !== 'orgCode' // not caller-settable — tenant wins
  );
  if (applicable.length === 0) {
    return true;
  }
  const matches = (filter: LlamaIndexMetadataFilter): boolean =>
    metadata !== undefined && metadata[filter.key] === filter.value;
  return filters.condition === 'or'
    ? applicable.some(matches)
    : applicable.every(matches);
}

/**
 * A LlamaIndex-shaped vector store whose every read/write is routed through the
 * governed {@link AgentMemory} client, bound to ONE tenant at construction.
 *
 * - {@link add} → one `agentMemory.write` per node (tenant-stamped, audited,
 *   provenance): the key is the node id, the embedding is the node embedding,
 *   the content is the node text, and the metadata is the node metadata.
 * - {@link query} → `agentMemory.recall` (tenant-partitioned vector search) with
 *   the query embedding and `similarityTopK`, then the query filters narrow the
 *   tenant-scoped matches. It can never widen: `recall` already returned only
 *   this tenant's rows (the `by_embedding` index filters on `orgCode`), and
 *   `orgCode` is not a caller-settable filter.
 * - {@link delete} — see its doc: the governed client exposes no delete, so this
 *   does NOT delete, by design.
 *
 * NO RUNTIME INDEX CREATION. The `by_embedding` vector index is declared
 * statically in the component's `schema.ts`.
 *
 * Redaction, revocation, and audit come for FREE: every call goes through the
 * governed client, so a redaction policy redacts these results, a revocation
 * denies these calls, and every write/recall lands exactly one audit row —
 * none of it re-implemented here.
 */
export class GovernedLlamaIndexVectorStore implements LlamaIndexVectorStore {
  /** This store persists node text (as the governed record's `content`). */
  readonly storesText = true;

  constructor(private readonly config: GovernedLlamaIndexVectorStoreConfig) {}

  /**
   * Write each node as one governed memory record under the bound tenant. A node
   * must carry an `embedding` to be recallable (as with any LlamaIndex vector
   * store, embedding happens upstream in the ingestion pipeline). Returns the
   * ids written (our write is an upsert keyed by `(orgCode, key)`).
   */
  async add(nodes: LlamaIndexNode[]): Promise<string[]> {
    const ids: string[] = [];
    for (const node of nodes) {
      if (node.embedding === undefined) {
        throw new Error(
          `Node '${node.id_}' has no embedding; embed nodes before adding them to the vector store.`
        );
      }
      await this.config.agentMemory.write(this.config.ctx, {
        subject: this.config.subject,
        orgCode: this.config.orgCode, // BOUND — never from the node
        key: node.id_,
        content: node.text ?? '',
        embedding: node.embedding,
        metadata: toGovernedMetadata(node.metadata)
      } satisfies MemoryWriteArgs);
      ids.push(node.id_);
    }
    return ids;
  }

  /**
   * Semantic query, tenant-partitioned by construction. Routes to
   * `agentMemory.recall` with the bound `orgCode` (NOT from the caller), then
   * narrows the tenant-scoped matches by the query filters. Returns the nodes,
   * their similarities, and their ids.
   */
  async query(
    query: LlamaIndexVectorStoreQuery
  ): Promise<LlamaIndexVectorStoreQueryResult> {
    const result = await this.config.agentMemory.recall(this.config.ctx, {
      subject: this.config.subject,
      orgCode: this.config.orgCode, // BOUND — the caller cannot widen past it
      embedding: query.queryEmbedding,
      topK: query.similarityTopK
    });
    const narrowed = result.matches.filter(
      (match) =>
        query.filters === undefined ||
        metadataMatchesFilters(match.memory.metadata, query.filters)
    );
    return {
      nodes: narrowed.map((match) => ({
        id_: match.memory.key,
        embedding: match.memory.embedding,
        metadata: match.memory.metadata ?? {},
        text: match.memory.content
      })),
      similarities: narrowed.map((match) => match.score),
      ids: narrowed.map((match) => match.memory.key)
    };
  }

  /**
   * NOT SUPPORTED. The governed {@link AgentMemory} client exposes no delete
   * surface, and deleting rows directly would bypass the governed access path
   * (no tenant check, no audit row), which this adapter must never do. So delete
   * is a hard, honest error rather than a silent no-op or a table-level bypass.
   * A future governed delete on the client would be wired here.
   */
  async delete(refDocId: string): Promise<void> {
    throw new Error(
      `delete('${refDocId}') is not supported: the governed memory client exposes no delete, and this adapter will not bypass the governed access path to remove rows. Remove memory through a governed operation once one exists.`
    );
  }
}
