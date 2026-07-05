/**
 * A GOVERNED MASTRA VECTOR-STORE ADAPTER — example-only, framework-free.
 *
 * WHY THIS EXISTS. Mastra's own Convex vector store (`@mastra/convex`'s
 * `ConvexNativeVector`) connects with a `deploymentUrl` + `adminAuthToken` and
 * reads/writes the vector table with ADMIN credentials from OUTSIDE the app.
 * That path CANNOT be tenant-governed: an admin key sees every tenant's vectors
 * and no per-call `subject`/`orgCode` boundary, no audit, no redaction, no
 * revocation is possible. THIS adapter routes the SAME Convex vector search
 * through THIS component's governed client instead — so recall is
 * tenant-partitioned, audited, redacted, and revocable. Same vector search
 * underneath; ours is IN-APP, PER-CALL, TENANT-BOUND. That contrast is the
 * adapter's entire justification.
 *
 * INTERFACE PROVENANCE. `@mastra/core` / `@mastra/convex` are NOT installed in
 * this repo, and the shipped package (src/) must gain NO framework dependency.
 * So the vector-store surface is declared LOCALLY below, mirroring the stable
 * seam of `@mastra/core`'s `MastraVector` (as implemented by
 * `ConvexNativeVector`): `query({indexName, queryVector, topK, filter?})`,
 * `upsert({indexName, vectors, metadata?, ids?})`, and `createIndex(...)`. A
 * real integration would `implements MastraVector` from the installed package;
 * the shapes here match field-for-field so that swap is mechanical.
 *
 * HONESTY ON SCOPE. Mastra memory also has a broader `MastraStorage` surface
 * (threads/messages per `resourceId`). This adapter governs the VECTOR RECALL
 * path only — that is where cross-tenant memory LEAKAGE happens (semantic search
 * over everyone's embeddings). The honest position: store and recall agent
 * memory THROUGH this component to get the governed boundary; anything that
 * bypasses this seam (e.g. raw thread storage on an admin-keyed store) is NOT
 * governed by this component and must not be assumed to be.
 */
import type {
  AgentMemory,
  MemoryWriteArgs,
  RunActionCtx,
  RunMutationCtx
} from '@kinde-oss/kinde-convex-agent-memory';

// --- Local mirror of @mastra/core's MastraVector seam (see provenance above) --

/** A vector-store filter. Mastra's is a Mongo-like object; we mirror the shape
 * with `unknown` values (the shipped package forbids `any`). */
export type MastraVectorFilter = Record<string, unknown>;

export interface MastraQueryParams {
  indexName: string;
  queryVector: number[];
  topK?: number;
  filter?: MastraVectorFilter;
  includeVector?: boolean;
}

export interface MastraQueryResult {
  id: string;
  score: number;
  metadata?: Record<string, unknown>;
  vector?: number[];
}

export interface MastraUpsertParams {
  indexName: string;
  vectors: number[][];
  metadata?: Record<string, unknown>[];
  ids?: string[];
}

export interface MastraCreateIndexParams {
  indexName: string;
  dimension: number;
  metric?: 'cosine' | 'euclidean' | 'dotproduct';
}

/** The subset of `MastraVector` this adapter implements. */
export interface MastraVectorStore {
  query(params: MastraQueryParams): Promise<MastraQueryResult[]>;
  upsert(params: MastraUpsertParams): Promise<string[]>;
  createIndex(params: MastraCreateIndexParams): Promise<void>;
}

// --------------------------------------------------------------------------

/** Governed metadata shape (queryable primitives), recovered from the client. */
type GovernedMetadata = NonNullable<MemoryWriteArgs['metadata']>;

/**
 * The ctx the adapter drives the governed client with. `upsert` runs a
 * mutation (`write`); `query` runs an action (`recall`, a vector action). An
 * app ACTION's ctx supplies both, so the adapter is constructed inside one.
 */
export type GovernedVectorCtx = RunMutationCtx & RunActionCtx;

export interface GovernedConvexVectorConfig {
  /** The governed component client (constructed with no admin key). */
  agentMemory: AgentMemory;
  /** THIS request's ctx (per-call, not a long-lived admin connection). */
  ctx: GovernedVectorCtx;
  /** The acting principal. */
  subject: string;
  /**
   * The SERVER-VERIFIED tenant. BOUND HERE, at construction — it is NOT a filter
   * the caller can set on `query`, and no method can widen beyond it. This is
   * the whole point: an admin-keyed store has no such binding.
   */
  orgCode: string;
}

/** Convert Mastra metadata (arbitrary values) to the governed store's queryable
 * primitive metadata, or throw a clear error — the store rejects nested objects
 * by design (metadata is queryable annotation, not a document blob). */
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
 * Does a governed record's metadata satisfy a Mastra filter? Equality only,
 * and — CRUCIALLY — a top-level `orgCode` key is IGNORED: the tenant is bound at
 * construction and can never be set (or widened) by a caller's filter. Every
 * other field NARROWS within the already-tenant-partitioned result set.
 */
function metadataMatchesFilter(
  metadata: Record<string, unknown> | undefined,
  filter: MastraVectorFilter
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
 * A Mastra-shaped vector store whose every read/write is routed through the
 * governed {@link AgentMemory} client, bound to ONE tenant at construction.
 *
 * - {@link upsert} → `agentMemory.write` (tenant-stamped, audited, provenance).
 * - {@link query}  → `agentMemory.recall` (tenant-partitioned vector search),
 *   then a Mastra filter is applied as a NARROWING post-filter within the
 *   tenant. It can never widen: `recall` already returned only this tenant's
 *   rows (the `by_embedding` index filters on `orgCode`), and `orgCode` is not a
 *   caller-settable filter.
 * - {@link createIndex} is a documented NO-OP: the Convex vector index is
 *   declared in the component's `schema.ts`, not created at runtime.
 *
 * Redaction, revocation, and audit come for FREE: every call goes through the
 * governed client, so a redaction policy redacts these results, a revocation
 * denies these calls, and every write/recall lands exactly one audit row —
 * none of it re-implemented here.
 */
export class GovernedConvexVector implements MastraVectorStore {
  constructor(private readonly config: GovernedConvexVectorConfig) {}

  /**
   * NO-OP. The `by_embedding` vector index (dimensions + `filterFields:
   * ['orgCode']`) is declared statically in the component's `schema.ts`; Convex
   * has no runtime index creation. Present only to satisfy the interface.
   */
  async createIndex(_params: MastraCreateIndexParams): Promise<void> {
    // Intentionally empty — see the doc comment.
  }

  /**
   * Upsert vectors as governed memory records. Each vector becomes one
   * `agentMemory.write` under the bound tenant: the record `key` is the
   * caller-supplied id (or a generated one), the embedding is the vector, and
   * Mastra `metadata[i]` becomes the record's queryable metadata. Mastra vectors
   * carry no text, so `content` is taken from a conventional `text` metadata
   * field when present, else empty. Returns the ids written (our write is an
   * upsert keyed by `(orgCode, key)`, so re-upserting an id updates it).
   */
  async upsert(params: MastraUpsertParams): Promise<string[]> {
    const ids: string[] = [];
    for (let index = 0; index < params.vectors.length; index++) {
      const id = params.ids?.[index] ?? crypto.randomUUID();
      const rawMetadata = params.metadata?.[index];
      const metadata =
        rawMetadata === undefined ? undefined : toGovernedMetadata(rawMetadata);
      const text = rawMetadata?.text;
      await this.config.agentMemory.write(this.config.ctx, {
        subject: this.config.subject,
        orgCode: this.config.orgCode, // BOUND — never from params
        key: id,
        content: typeof text === 'string' ? text : '',
        embedding: params.vectors[index],
        ...(metadata === undefined ? {} : {metadata})
      } satisfies MemoryWriteArgs);
      ids.push(id);
    }
    return ids;
  }

  /**
   * Semantic query, tenant-partitioned by construction. Routes to
   * `agentMemory.recall` with the bound `orgCode` (NOT from the caller), then
   * narrows the tenant-scoped matches by the Mastra filter.
   */
  async query(params: MastraQueryParams): Promise<MastraQueryResult[]> {
    const result = await this.config.agentMemory.recall(this.config.ctx, {
      subject: this.config.subject,
      orgCode: this.config.orgCode, // BOUND — the caller cannot widen past it
      embedding: params.queryVector,
      ...(params.topK === undefined ? {} : {topK: params.topK})
    });
    const filter = params.filter;
    return result.matches
      .filter(
        (match) =>
          filter === undefined ||
          metadataMatchesFilter(match.memory.metadata, filter)
      )
      .map((match) => ({
        id: match.memory.key,
        score: match.score,
        ...(match.memory.metadata === undefined
          ? {}
          : {metadata: match.memory.metadata}),
        ...(params.includeVector && match.memory.embedding !== undefined
          ? {vector: match.memory.embedding}
          : {})
      }));
  }
}
