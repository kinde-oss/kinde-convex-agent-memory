/**
 * A GOVERNED LANGCHAIN VECTOR-STORE ADAPTER — example-only, framework-free.
 *
 * WHY THIS EXISTS. LangChain's own Convex vector store (`ConvexVectorStore`
 * from `@langchain/community/vectorstores/convex`) reads and writes a Convex
 * vector table directly, with deployment credentials and no per-call tenant
 * boundary. That path CANNOT be tenant-governed: it sees every tenant's vectors
 * and enforces no `subject`/`orgCode` scope, no audit, no redaction, no
 * revocation. THIS adapter routes the SAME Convex vector search through THIS
 * component's governed client instead — so recall is tenant-partitioned,
 * audited, redacted, and revocable. Same vector search underneath; ours is
 * IN-APP, PER-CALL, TENANT-BOUND. That contrast is the adapter's whole reason
 * to exist.
 *
 * INTERFACE PROVENANCE. `@langchain/core` is NOT installed in this repo, and the
 * shipped package (src/) must gain NO framework dependency. So the VectorStore
 * surface is declared LOCALLY below, mirroring the stable seam of
 * `@langchain/core/vectorstores`'s `VectorStore`: `addVectors(vectors,
 * documents, options?)`, `addDocuments(documents, options?)` (which embeds via
 * the store's `Embeddings` then calls `addVectors`),
 * `similaritySearchVectorWithScore(query, k, filter?)`, and
 * `_vectorstoreType()`. A `Document` is `{pageContent, metadata}` (plus an
 * optional `id`). A real integration would `extends VectorStore` from the
 * installed package; the shapes here match field-for-field so that swap is
 * mechanical.
 *
 * TENANT BINDING. The `orgCode` is the SERVER-VERIFIED tenant, bound once at
 * construction. It is NOT a filter the caller can set: a LangChain `filter` can
 * only NARROW within the already-tenant-partitioned result set, never widen
 * across tenants, and a top-level `orgCode` key in a filter is ignored.
 *
 * HONESTY ON SCOPE. This adapter governs the VECTOR path (add + similarity
 * search), which is where cross-tenant memory LEAKAGE happens. Store and recall
 * agent memory THROUGH this component to get the governed boundary; anything a
 * LangChain chain does on a raw, non-governed store is NOT governed here.
 */
import type {
  AgentMemory,
  MemoryWriteArgs,
  RunActionCtx,
  RunMutationCtx
} from '@kinde-oss/kinde-convex-agent-memory';

// --- Local mirror of @langchain/core/vectorstores (see provenance above) -----

/** A LangChain document: text plus arbitrary metadata, and an optional id. */
export interface LangChainDocument {
  pageContent: string;
  metadata: Record<string, unknown>;
  id?: string;
}

/** The LangChain `Embeddings` surface `addDocuments` uses to embed text. */
export interface LangChainEmbeddings {
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
}

/** A LangChain metadata filter. The Convex store uses an equality object; we
 * mirror the shape with `unknown` values (the shipped package forbids `any`). */
export type LangChainFilter = Record<string, unknown>;

export interface LangChainAddOptions {
  ids?: string[];
}

/** The subset of `VectorStore` this adapter implements. */
export interface LangChainVectorStore {
  addVectors(
    vectors: number[][],
    documents: LangChainDocument[],
    options?: LangChainAddOptions
  ): Promise<string[]>;
  addDocuments(
    documents: LangChainDocument[],
    options?: LangChainAddOptions
  ): Promise<string[]>;
  similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: LangChainFilter
  ): Promise<[LangChainDocument, number][]>;
  _vectorstoreType(): string;
}

// -----------------------------------------------------------------------------

/** Governed metadata shape (queryable primitives), recovered from the client. */
type GovernedMetadata = NonNullable<MemoryWriteArgs['metadata']>;

/**
 * The ctx the adapter drives the governed client with. `addVectors` runs a
 * mutation (`write`); `similaritySearchVectorWithScore` runs an action
 * (`recall`, a vector action). An app ACTION's ctx supplies both, so the
 * adapter is constructed inside one.
 */
export type GovernedVectorCtx = RunMutationCtx & RunActionCtx;

export interface GovernedLangChainVectorStoreConfig {
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
  /** Optional embeddings, required only by {@link addDocuments}. */
  embeddings?: LangChainEmbeddings;
}

/** Convert LangChain metadata (arbitrary values) to the governed store's
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
 * Does a governed record's metadata satisfy a LangChain filter? Equality only,
 * and — CRUCIALLY — a top-level `orgCode` key is IGNORED: the tenant is bound at
 * construction and can never be set (or widened) by a caller's filter. Every
 * other field NARROWS within the already-tenant-partitioned result set.
 */
function metadataMatchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: LangChainFilter
): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    if (field === 'orgCode') {
      continue; // not caller-settable — the construction-bound tenant wins
    }
    if (metadata === undefined || metadata[field] !== expected) {
      return false;
    }
  }
  return true;
}

/**
 * A LangChain-shaped vector store whose every read/write is routed through the
 * governed {@link AgentMemory} client, bound to ONE tenant at construction.
 *
 * - {@link addVectors} / {@link addDocuments} → `agentMemory.write`
 *   (tenant-stamped, audited, provenance). `pageContent` becomes the record
 *   content, `metadata` its queryable metadata, and the key is the document id
 *   when present else a minted uuid.
 * - {@link similaritySearchVectorWithScore} → `agentMemory.recall`
 *   (tenant-partitioned vector search), then the LangChain filter narrows the
 *   tenant-scoped matches. It can never widen: `recall` already returned only
 *   this tenant's rows (the `by_embedding` index filters on `orgCode`), and
 *   `orgCode` is not a caller-settable filter.
 *
 * NO RUNTIME INDEX CREATION. The `by_embedding` vector index is declared
 * statically in the component's `schema.ts`; there is no create-index method to
 * call (Convex has no runtime index creation).
 *
 * Redaction, revocation, and audit come for FREE: every call goes through the
 * governed client, so a redaction policy redacts these results, a revocation
 * denies these calls, and every write/recall lands exactly one audit row —
 * none of it re-implemented here.
 */
export class GovernedLangChainVectorStore implements LangChainVectorStore {
  constructor(private readonly config: GovernedLangChainVectorStoreConfig) {}

  _vectorstoreType(): string {
    return 'governed-convex';
  }

  /**
   * Write each (vector, document) pair as one governed memory record under the
   * bound tenant. The key is `document.id` if present, else `options.ids[i]`,
   * else a minted uuid. Returns the ids written (our write is an upsert keyed by
   * `(orgCode, key)`, so re-adding an id updates it).
   */
  async addVectors(
    vectors: number[][],
    documents: LangChainDocument[],
    options?: LangChainAddOptions
  ): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < vectors.length; index++) {
      const document = documents[index];
      const id = document.id ?? options?.ids?.[index] ?? crypto.randomUUID();
      const metadata = toGovernedMetadata(document.metadata);
      await this.config.agentMemory.write(this.config.ctx, {
        subject: this.config.subject,
        orgCode: this.config.orgCode, // BOUND — never from params
        key: id,
        content: document.pageContent,
        embedding: vectors[index],
        metadata
      } satisfies MemoryWriteArgs);
      ids.push(id);
    }
    return ids;
  }

  /**
   * Embed each document's `pageContent` via the configured embeddings, then
   * write through {@link addVectors} — exactly as LangChain's base `addDocuments`
   * does. Requires `config.embeddings`.
   */
  async addDocuments(
    documents: LangChainDocument[],
    options?: LangChainAddOptions
  ): Promise<string[]> {
    const embeddings = this.config.embeddings;
    if (embeddings === undefined) {
      throw new Error(
        'addDocuments requires `config.embeddings`; pass an Embeddings instance, or call addVectors with ready vectors.'
      );
    }
    const vectors = await embeddings.embedDocuments(
      documents.map((document) => document.pageContent)
    );
    return await this.addVectors(vectors, documents, options);
  }

  /**
   * Semantic search, tenant-partitioned by construction. Routes to
   * `agentMemory.recall` with the bound `orgCode` (NOT from the caller), then
   * narrows the tenant-scoped matches by the LangChain filter. Returns
   * `[Document, score]` tuples reconstructed from the governed results.
   */
  async similaritySearchVectorWithScore(
    query: number[],
    k: number,
    filter?: LangChainFilter
  ): Promise<[LangChainDocument, number][]> {
    const result = await this.config.agentMemory.recall(this.config.ctx, {
      subject: this.config.subject,
      orgCode: this.config.orgCode, // BOUND — the caller cannot widen past it
      embedding: query,
      topK: k
    });
    return result.matches
      .filter(
        (match) =>
          filter === undefined ||
          metadataMatchesFilter(match.memory.metadata, filter)
      )
      .map((match): [LangChainDocument, number] => [
        {
          pageContent: match.memory.content,
          metadata: match.memory.metadata ?? {},
          id: match.memory.key
        },
        match.score
      ]);
  }
}
