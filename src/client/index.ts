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
export {
  CONTENT_REDACTED,
  REDACT_CONTENT_FIELD
} from '../component/lib/redaction.js';
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

/**
 * The ctx shape the read-only reporting surfaces need. `auditQuery`,
 * `provenanceOf`, and `inspectRevocation` run as QUERIES (`ctx.runQuery`), not
 * mutations — they are the FIRST client methods to do so, because they write
 * NO audit row (see the query-vs-mutation exception on the component's
 * `audit.ts`). Any app function context — query, mutation, or action — supplies
 * `runQuery`.
 */
export type RunQueryCtx = Pick<GenericActionCtx<GenericDataModel>, 'runQuery'>;

/**
 * The ctx an HTTP handler from {@link AgentMemory.httpHandlers} runs with. A
 * Convex `httpAction` runs as an ACTION, so its ctx can `runQuery`,
 * `runMutation`, AND `runAction` — the seam needs all three (write/get/list are
 * mutations, recall is an action).
 */
export type RunHttpActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  'runQuery' | 'runMutation' | 'runAction'
>;

/**
 * A Convex `httpAction`-shaped handler: `(ctx, request) => Promise<Response>`.
 * The app wraps each with its own generated `httpAction(...)` and mounts it on
 * its `httpRouter`. Kept `httpAction`-free here because the builder is
 * app-generated and the component/client import neither the app nor a framework.
 */
export type HttpActionHandler = (
  ctx: RunHttpActionCtx,
  request: Request
) => Promise<Response>;

/**
 * The core memory operations exposed over HTTP by
 * {@link AgentMemory.httpHandlers}. Each is a raw handler the app mounts:
 * `http.route({path, method: 'POST', handler: httpAction(handlers.write)})`.
 */
export interface AgentMemoryHttpHandlers {
  write: HttpActionHandler;
  get: HttpActionHandler;
  list: HttpActionHandler;
  recall: HttpActionHandler;
}

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
type GrantArgs = FunctionArgs<ComponentApi['grants']['grant']>;
type GrantResult = FunctionReturnType<ComponentApi['grants']['grant']>;
type RevokeGrantArgs = FunctionArgs<ComponentApi['grants']['revokeGrant']>;
type RevokeGrantResult = FunctionReturnType<
  ComponentApi['grants']['revokeGrant']
>;
type SetRedactionArgs = FunctionArgs<ComponentApi['policy']['setRedaction']>;
type SetRedactionResult = FunctionReturnType<
  ComponentApi['policy']['setRedaction']
>;
type RevokeArgs = FunctionArgs<ComponentApi['revocations']['revoke']>;
type RevokeResult = FunctionReturnType<ComponentApi['revocations']['revoke']>;
type LiftRevocationArgs = FunctionArgs<
  ComponentApi['revocations']['liftRevocation']
>;
type LiftRevocationResult = FunctionReturnType<
  ComponentApi['revocations']['liftRevocation']
>;
type AuditQueryArgs = FunctionArgs<ComponentApi['audit']['query']>;
type AuditQueryResult = FunctionReturnType<ComponentApi['audit']['query']>;
type ProvenanceOfArgs = FunctionArgs<ComponentApi['provenance']['of']>;
type ProvenanceOfResult = FunctionReturnType<ComponentApi['provenance']['of']>;
type InspectRevocationArgs = FunctionArgs<
  ComponentApi['revocations']['inspect']
>;
type InspectRevocationResult = FunctionReturnType<
  ComponentApi['revocations']['inspect']
>;

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
/** Arguments to {@link AgentMemory.grant}. */
export type MemoryGrantArgs = GrantArgs;
/** A successful grant: the grant id, how it resolved, the correlation id. */
export type MemoryGrantOk = Extract<GrantResult, {ok: true}>;
/** Arguments to {@link AgentMemory.revokeGrant}. */
export type MemoryRevokeGrantArgs = RevokeGrantArgs;
/** A successful revocation: the revoked grant's id and the correlation id. */
export type MemoryRevokeGrantOk = Extract<RevokeGrantResult, {ok: true}>;
/** Arguments to {@link AgentMemory.setRedaction}. */
export type MemorySetRedactionArgs = SetRedactionArgs;
/** A successful setRedaction: `set` or `cleared`, and the correlation id. */
export type MemorySetRedactionOk = Extract<SetRedactionResult, {ok: true}>;
/** Arguments to {@link AgentMemory.revoke}. */
export type MemoryRevokeArgs = RevokeArgs;
/** The revocation target shape (kind + optional orgCode/subject). */
export type MemoryRevocationTarget = RevokeArgs['target'];
/** A successful revoke: the revocation id, how it resolved, correlation id. */
export type MemoryRevokeOk = Extract<RevokeResult, {ok: true}>;
/** Arguments to {@link AgentMemory.liftRevocation}. */
export type MemoryLiftRevocationArgs = LiftRevocationArgs;
/** A successful lift: the lifted revocation's id and the correlation id. */
export type MemoryLiftRevocationOk = Extract<LiftRevocationResult, {ok: true}>;
/** Arguments to {@link AgentMemory.auditQuery}. */
export type MemoryAuditQueryArgs = AuditQueryArgs;
/** One newest-first, tenant-scoped page of audit rows. */
export type MemoryAuditPage = AuditQueryResult;
/** The closed audit-filter shape. */
export type MemoryAuditFilter = NonNullable<AuditQueryArgs['filter']>;
/**
 * The branded id of a memory record (`Id<'memories'>`). A consuming app stores
 * it as a plain string and passes it back to {@link AgentMemory.provenanceOf};
 * this type lets the app re-brand a stored string id without reaching into the
 * component's generated data model.
 */
export type MemoryId = ProvenanceOfArgs['memoryId'];
/** Arguments to {@link AgentMemory.provenanceOf}. */
export type MemoryProvenanceArgs = ProvenanceOfArgs;
/** A record's provenance stamps (no content/metadata), or null. */
export type MemoryProvenance = NonNullable<ProvenanceOfResult>;
/** Arguments to {@link AgentMemory.inspectRevocation}. */
export type MemoryInspectRevocationArgs = InspectRevocationArgs;
/** A target's revocation rows (reason + actors) plus the target digest. */
export type MemoryRevocationInspection = InspectRevocationResult;
/** The closed set of grantable scopes. */
export type MemoryGrantScope = GrantArgs['scope'];
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

  /**
   * Grant a scope to `targetSubject` in the tenant. The target's FIRST grant
   * flips it from permissive (the no-grants default, where the component
   * behaves as if grants did not exist) to enforced mode — from then on it
   * holds exactly the scopes granted. Idempotent for an already-active
   * scope (`outcome: 'already_granted'`). Throws a typed ConvexError
   * (`tenant_context_conflict`) on a governed denial, after the denial's
   * audit row has committed.
   */
  async grant(
    ctx: RunMutationCtx,
    args: MemoryGrantArgs
  ): Promise<MemoryGrantOk> {
    const result = await ctx.runMutation(this.component.grants.grant, args);
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Revoke `targetSubject`'s active grant of a scope. The subject STAYS in
   * enforced mode (revoked rows keep the switch on — revoking the last grant
   * locks the subject out, never restores permissive mode). Throws a typed
   * ConvexError (`grant_not_found`, `tenant_context_conflict`) on a governed
   * denial — revoking a nonexistent grant is a denial, not a no-op.
   */
  async revokeGrant(
    ctx: RunMutationCtx,
    args: MemoryRevokeGrantArgs
  ): Promise<MemoryRevokeGrantOk> {
    const result = await ctx.runMutation(
      this.component.grants.revokeGrant,
      args
    );
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Create or replace the tenant's redaction policy (org-wide, or targeted
   * at one subject via `targetSubject`; a targeted policy wins outright over
   * the org-wide one on read). `fields` holds metadata field names and/or
   * the literal 'content' (see `REDACT_CONTENT_FIELD`); redacted metadata is
   * omitted on read and redacted content egresses as `CONTENT_REDACTED`.
   * An empty `fields` array CLEARS the target's policy. Throws a typed
   * ConvexError (`invalid_redaction_fields`, `policy_not_found`,
   * `tenant_context_conflict`) on a governed denial.
   */
  async setRedaction(
    ctx: RunMutationCtx,
    args: MemorySetRedactionArgs
  ): Promise<MemorySetRedactionOk> {
    const result = await ctx.runMutation(
      this.component.policy.setRedaction,
      args
    );
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Revoke access via the P5 KILL SWITCH OVERLAY — a `global`, `org`, or
   * `subject` target that OUTRANKS grants: a revoked caller is denied `revoked`
   * regardless of the scopes it holds, and a fresh grant cannot resurrect it —
   * only {@link AgentMemory.liftRevocation} does. Idempotent for an
   * already-active target (`outcome: 'already_revoked'`). `reason` is stored on
   * the revocation row only and never surfaces in audit rows or denial
   * messages. Throws a typed ConvexError (`invalid_revocation_target`,
   * `tenant_context_conflict`) on a governed denial, after it has committed.
   *
   * NOTE on targets: `global` is cross-tenant by nature and app-trusted (the
   * host app gates who may call this); `org`/`subject` are confined to the
   * caller's server-verified tenant.
   */
  async revoke(
    ctx: RunMutationCtx,
    args: MemoryRevokeArgs
  ): Promise<MemoryRevokeOk> {
    const result = await ctx.runMutation(
      this.component.revocations.revoke,
      args
    );
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Lift an active revocation, restoring access (grants then govern exactly as
   * before). The revocation row is kept as history; a later revoke re-arms the
   * overlay. Lifting a target with no active revocation throws typed
   * `revocation_not_found` — a denial, not a no-op — after it has committed.
   */
  async liftRevocation(
    ctx: RunMutationCtx,
    args: MemoryLiftRevocationArgs
  ): Promise<MemoryLiftRevocationOk> {
    const result = await ctx.runMutation(
      this.component.revocations.liftRevocation,
      args
    );
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Paginated, tenant-scoped, newest-first view of the audit log. RUNS AS A
   * QUERY (`ctx.runQuery`) — the first read-only surface on this client, and it
   * writes no audit row of its own (querying the log is not itself a governed
   * event). Argument errors (contradictory `filter` window →
   * `invalid_filter`; `claimedOrgCode` mismatch → `tenant_context_conflict`)
   * throw typed ConvexErrors directly; there is no returned-denial path here
   * because a query cannot audit. Walk `continueCursor` until `isDone`.
   */
  async auditQuery(
    ctx: RunQueryCtx,
    args: MemoryAuditQueryArgs
  ): Promise<MemoryAuditPage> {
    return await ctx.runQuery(this.component.audit.query, args);
  }

  /**
   * Trace one record's provenance: its immutable creation event and its latest
   * write event, plus key/subject/orgCode — and DELIBERATELY no content or
   * metadata, so this surface can never leak a memory body. RUNS AS A QUERY.
   * Returns null when no record with that id exists IN THIS TENANT (a memoryId
   * from another tenant is indistinguishable from a missing one).
   */
  async provenanceOf(
    ctx: RunQueryCtx,
    args: MemoryProvenanceArgs
  ): Promise<MemoryProvenance | null> {
    return await ctx.runQuery(this.component.provenance.of, args);
  }

  /**
   * The reason-join surface: given a revocation target, return its active and
   * historical rows (INCLUDING the reason and actor stamps) plus the target
   * digest — the same digest a `revoked` denial audit row carries, so "why was
   * this denied?" is answerable without the reason ever entering the audit log.
   * RUNS AS A QUERY. A cross-tenant `org`/`subject` target throws
   * `invalid_revocation_target`; a global target is readable from any tenant it
   * governs.
   */
  async inspectRevocation(
    ctx: RunQueryCtx,
    args: MemoryInspectRevocationArgs
  ): Promise<MemoryRevocationInspection> {
    return await ctx.runQuery(this.component.revocations.inspect, args);
  }

  /**
   * Build the DIRECT-HTTP handlers (write/get/list/recall) for the app to mount
   * on its own `httpRouter`. THE SEAM'S CONTRACT:
   *
   * - REQUIRES `config.verifyCaller`: you cannot serve HTTP without a way to
   *   verify who is calling, so this THROWS a typed `verify_caller_not_configured`
   *   at mount time (when the app calls this) if the slot is empty.
   * - The verified caller is the ONLY source of `subject` and `orgCode` — the
   *   server-verified tenant comes from the token, NEVER the request body. The
   *   body carries only the operation payload (key, content, filter, query, …).
   * - BODY-vs-TOKEN CONFLICT: a body-supplied `orgCode` is passed as
   *   `claimedOrgCode`, so the EXISTING `tenant_context_conflict` machinery
   *   rejects a mismatch AND audits it inside the governed op — the seam invents
   *   no new tenant logic and the body cannot smuggle a foreign tenant. A
   *   body-supplied `subject` is ignored outright.
   * - TOKEN SCOPES ARE NOT MEMORY GRANTS: `verifyCaller`'s `scopes` describe the
   *   token and ride along in `claims`; they do NOT auto-grant the component's
   *   own P4 grant scopes. Grants remain the component's authority — an app that
   *   wants a token scope to imply a grant must call `grant()` explicitly.
   * - AUDIT BOUNDARY: seam-level rejections (missing/bad token, malformed body)
   *   happen BEFORE any governed call and write NO audit row. Once a handler
   *   invokes a governed op, that op audits exactly once (denials included) — the
   *   audit always comes from the component, never the seam.
   */
  httpHandlers(): AgentMemoryHttpHandlers {
    const verifyCaller = this.options.verifyCaller;
    if (verifyCaller === undefined) {
      throw new ConvexError({
        code: 'verify_caller_not_configured',
        message:
          'AgentMemory.httpHandlers() requires `config.verifyCaller` on the client (new AgentMemory(component, {verifyCaller})). HTTP callers cannot be served without a way to verify the bearer token and resolve the server-verified tenant.'
      });
    }
    return buildHttpHandlers(this, verifyCaller);
  }
}

// ---------------------------------------------------------------------------
// THE DIRECT-HTTP SEAM (P7). Client-side handlers the app mounts on its own
// http router; see AgentMemory.httpHandlers for the contract. Everything here
// runs in the app's httpAction and goes through the client methods only — it
// touches no component table directly.
// ---------------------------------------------------------------------------

/** The subset of {@link AgentMemory} the HTTP handlers drive. */
interface HttpMemoryClient {
  write(ctx: RunHttpActionCtx, args: MemoryWriteArgs): Promise<MemoryWriteOk>;
  get(ctx: RunHttpActionCtx, args: MemoryGetArgs): Promise<MemoryRecord | null>;
  list(ctx: RunHttpActionCtx, args: MemoryListArgs): Promise<MemoryListOk>;
  recall(
    ctx: RunHttpActionCtx,
    args: MemoryRecallArgs
  ): Promise<MemoryRecallOk>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isFiniteNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isFiniteNumber);
}

function isMetadataArg(
  value: unknown
): value is NonNullable<MemoryWriteArgs['metadata']> {
  if (!isPlainObject(value)) {
    return false;
  }
  const isPrimitive = (member: unknown): boolean =>
    member === null ||
    typeof member === 'string' ||
    typeof member === 'number' ||
    typeof member === 'boolean';
  return Object.values(value).every(
    (member) =>
      isPrimitive(member) ||
      (Array.isArray(member) && member.every(isPrimitive))
  );
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'}
  });
}

/** A typed, JSON, non-cross-tenant-leaking error response. */
function httpError(
  status: number,
  code: string,
  message: string,
  correlationId?: string
): Response {
  return jsonResponse(status, {
    ok: false,
    code,
    message,
    ...(correlationId === undefined ? {} : {correlationId})
  });
}

/**
 * Recover the typed payload of a ConvexError thrown by a client method. Handles
 * convex-test's occasional re-serialization of `.data` to a JSON string.
 */
function typedError(
  error: unknown
): {code: string; message: string; correlationId?: string} | null {
  if (!(error instanceof ConvexError)) {
    return null;
  }
  const raw: unknown = error.data;
  let data: unknown = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch {
      data = raw;
    }
  }
  if (!isPlainObject(data) || typeof data.code !== 'string') {
    return null;
  }
  return {
    code: data.code,
    message:
      typeof data.message === 'string'
        ? data.message
        : 'The operation was denied.',
    correlationId:
      typeof data.correlationId === 'string' ? data.correlationId : undefined
  };
}

/** Map a governed/typed error code to an HTTP status. */
function statusForCode(code: string): number {
  switch (code) {
    case 'tenant_context_conflict':
    case 'scope_not_granted':
    case 'revoked':
      return 403;
    case 'embedder_not_configured':
    case 'embedder_response_malformed':
      return 500;
    default:
      // Every other typed code is an argument/validation denial.
      return 400;
  }
}

/** Turn a caught error (governed denial or otherwise) into an HTTP response. */
function responseForError(error: unknown): Response {
  const typed = typedError(error);
  if (typed === null) {
    return httpError(
      500,
      'internal_error',
      'An unexpected error occurred while handling the request.'
    );
  }
  return httpError(
    statusForCode(typed.code),
    typed.code,
    typed.message,
    typed.correlationId
  );
}

interface VerifiedIdentity {
  subject: string;
  orgCode: string;
}

type AuthOutcome =
  | {ok: true; identity: VerifiedIdentity}
  | {ok: false; response: Response};

/**
 * Extract the bearer token, verify it, and resolve the server-verified tenant.
 * All failures here are SEAM-LEVEL (pre-governed-op): they write no audit row.
 */
async function authenticate(
  verifyCaller: VerifyCaller,
  request: Request
): Promise<AuthOutcome> {
  const header = request.headers.get('authorization');
  if (header === null) {
    return {
      ok: false,
      response: httpError(
        401,
        'missing_authorization',
        'The request is missing the Authorization header.'
      )
    };
  }
  const match = /^Bearer[ ]+(\S+)$/.exec(header);
  if (match === null) {
    return {
      ok: false,
      response: httpError(
        401,
        'malformed_authorization',
        "The Authorization header must be of the form 'Bearer <token>'."
      )
    };
  }
  let caller: VerifiedCaller;
  try {
    caller = await verifyCaller(match[1]);
  } catch {
    // A verifyCaller that throws is a rejected token — 401, message fixed so no
    // internal detail (or cross-tenant hint) leaks.
    return {
      ok: false,
      response: httpError(
        401,
        'unauthorized',
        'The bearer token could not be verified.'
      )
    };
  }
  if (
    !isPlainObject(caller) ||
    typeof caller.subject !== 'string' ||
    caller.subject === '' ||
    typeof caller.orgCode !== 'string' ||
    caller.orgCode === ''
  ) {
    // Wrapped exactly like a malformed embedder response: a typed shape error.
    return {
      ok: false,
      response: httpError(
        500,
        'verify_caller_response_malformed',
        'verifyCaller returned a response without a non-empty `subject` and `orgCode`; a tenant-scoped verified caller is required.'
      )
    };
  }
  return {
    ok: true,
    identity: {subject: caller.subject, orgCode: caller.orgCode}
  };
}

/** Parse the request body as a JSON object, or null if malformed. */
async function parseJsonBody(
  request: Request
): Promise<Record<string, unknown> | null> {
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return null;
  }
  return isPlainObject(parsed) ? parsed : null;
}

/** A body-supplied orgCode rides as `claimedOrgCode` (the conflict path). */
function claimedOrgCodeFromBody(
  body: Record<string, unknown>
): string | undefined {
  return typeof body.orgCode === 'string' ? body.orgCode : undefined;
}

/** Whitelist-parse the list filter; returns 'invalid' on any shape error. */
function parseListFilter(value: unknown): MemoryListFilter | 'invalid' {
  if (!isPlainObject(value)) {
    return 'invalid';
  }
  const filter: MemoryListFilter = {};
  if (value.bySubject !== undefined) {
    if (typeof value.bySubject !== 'string') return 'invalid';
    filter.bySubject = value.bySubject;
  }
  if (value.keyPrefix !== undefined) {
    if (typeof value.keyPrefix !== 'string') return 'invalid';
    filter.keyPrefix = value.keyPrefix;
  }
  if (value.writtenAfter !== undefined) {
    if (!isFiniteNumber(value.writtenAfter)) return 'invalid';
    filter.writtenAfter = value.writtenAfter;
  }
  if (value.writtenBefore !== undefined) {
    if (!isFiniteNumber(value.writtenBefore)) return 'invalid';
    filter.writtenBefore = value.writtenBefore;
  }
  if (value.metadataEquals !== undefined) {
    const me = value.metadataEquals;
    if (!isPlainObject(me) || typeof me.field !== 'string') return 'invalid';
    const memberValue = me.value;
    if (
      !(
        memberValue === null ||
        typeof memberValue === 'string' ||
        typeof memberValue === 'number' ||
        typeof memberValue === 'boolean'
      )
    ) {
      return 'invalid';
    }
    filter.metadataEquals = {field: me.field, value: memberValue};
  }
  return filter;
}

function malformedBody(message: string): Response {
  return httpError(400, 'request_body_malformed', message);
}

function buildHttpHandlers(
  client: HttpMemoryClient,
  verifyCaller: VerifyCaller
): AgentMemoryHttpHandlers {
  const write: HttpActionHandler = async (ctx, request) => {
    const auth = await authenticate(verifyCaller, request);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request);
    if (body === null) {
      return malformedBody('The request body must be a JSON object.');
    }
    const {key, content} = body;
    if (typeof key !== 'string' || typeof content !== 'string') {
      return malformedBody(
        '`write` requires a string `key` and string `content`.'
      );
    }
    const metadata = body.metadata;
    if (metadata !== undefined && !isMetadataArg(metadata)) {
      return malformedBody(
        '`metadata` must be an object of primitive or primitive-array values.'
      );
    }
    const embedding = body.embedding;
    if (embedding !== undefined && !isFiniteNumberArray(embedding)) {
      return malformedBody('`embedding` must be an array of finite numbers.');
    }
    const idempotencyKey = body.idempotencyKey;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== 'string') {
      return malformedBody('`idempotencyKey` must be a string.');
    }
    const correlationId = body.correlationId;
    if (correlationId !== undefined && typeof correlationId !== 'string') {
      return malformedBody('`correlationId` must be a string.');
    }
    const claimedOrgCode = claimedOrgCodeFromBody(body);
    try {
      const result = await client.write(ctx, {
        subject: auth.identity.subject,
        orgCode: auth.identity.orgCode,
        ...(claimedOrgCode === undefined ? {} : {claimedOrgCode}),
        key,
        content,
        ...(metadata === undefined ? {} : {metadata}),
        ...(embedding === undefined ? {} : {embedding}),
        ...(idempotencyKey === undefined ? {} : {idempotencyKey}),
        ...(correlationId === undefined ? {} : {correlationId})
      });
      // `result` is already `{ok: true, memoryId, outcome, correlationId}`.
      return jsonResponse(200, result);
    } catch (error) {
      return responseForError(error);
    }
  };

  const get: HttpActionHandler = async (ctx, request) => {
    const auth = await authenticate(verifyCaller, request);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request);
    if (body === null) {
      return malformedBody('The request body must be a JSON object.');
    }
    const key = body.key;
    if (typeof key !== 'string') {
      return malformedBody('`get` requires a string `key`.');
    }
    const correlationId = body.correlationId;
    if (correlationId !== undefined && typeof correlationId !== 'string') {
      return malformedBody('`correlationId` must be a string.');
    }
    const claimedOrgCode = claimedOrgCodeFromBody(body);
    try {
      const memory = await client.get(ctx, {
        subject: auth.identity.subject,
        orgCode: auth.identity.orgCode,
        ...(claimedOrgCode === undefined ? {} : {claimedOrgCode}),
        key,
        ...(correlationId === undefined ? {} : {correlationId})
      });
      return jsonResponse(200, {ok: true, memory});
    } catch (error) {
      return responseForError(error);
    }
  };

  const list: HttpActionHandler = async (ctx, request) => {
    const auth = await authenticate(verifyCaller, request);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request);
    if (body === null) {
      return malformedBody('The request body must be a JSON object.');
    }
    const numItems = body.numItems;
    if (!isFiniteNumber(numItems)) {
      return malformedBody('`list` requires a numeric `numItems`.');
    }
    let cursor: string | null = null;
    if (body.cursor !== undefined && body.cursor !== null) {
      if (typeof body.cursor !== 'string') {
        return malformedBody('`cursor` must be a string or null.');
      }
      cursor = body.cursor;
    }
    let filter: MemoryListFilter | undefined;
    if (body.filter !== undefined) {
      const parsed = parseListFilter(body.filter);
      if (parsed === 'invalid') {
        return malformedBody('`filter` has an invalid shape.');
      }
      filter = parsed;
    }
    const correlationId = body.correlationId;
    if (correlationId !== undefined && typeof correlationId !== 'string') {
      return malformedBody('`correlationId` must be a string.');
    }
    const claimedOrgCode = claimedOrgCodeFromBody(body);
    try {
      const result = await client.list(ctx, {
        subject: auth.identity.subject,
        orgCode: auth.identity.orgCode,
        ...(claimedOrgCode === undefined ? {} : {claimedOrgCode}),
        ...(filter === undefined ? {} : {filter}),
        paginationOpts: {numItems, cursor},
        ...(correlationId === undefined ? {} : {correlationId})
      });
      return jsonResponse(200, {
        ok: true,
        page: result.page,
        isDone: result.isDone,
        continueCursor: result.continueCursor,
        correlationId: result.correlationId
      });
    } catch (error) {
      return responseForError(error);
    }
  };

  const recall: HttpActionHandler = async (ctx, request) => {
    const auth = await authenticate(verifyCaller, request);
    if (!auth.ok) return auth.response;
    const body = await parseJsonBody(request);
    if (body === null) {
      return malformedBody('The request body must be a JSON object.');
    }
    const query = body.query;
    if (query !== undefined && typeof query !== 'string') {
      return malformedBody('`query` must be a string.');
    }
    const embedding = body.embedding;
    if (embedding !== undefined && !isFiniteNumberArray(embedding)) {
      return malformedBody('`embedding` must be an array of finite numbers.');
    }
    const topK = body.topK;
    if (topK !== undefined && !isFiniteNumber(topK)) {
      return malformedBody('`topK` must be a number.');
    }
    const correlationId = body.correlationId;
    if (correlationId !== undefined && typeof correlationId !== 'string') {
      return malformedBody('`correlationId` must be a string.');
    }
    const claimedOrgCode = claimedOrgCodeFromBody(body);
    try {
      const result = await client.recall(ctx, {
        subject: auth.identity.subject,
        orgCode: auth.identity.orgCode,
        ...(claimedOrgCode === undefined ? {} : {claimedOrgCode}),
        ...(query === undefined ? {} : {query}),
        ...(embedding === undefined ? {} : {embedding}),
        ...(topK === undefined ? {} : {topK}),
        ...(correlationId === undefined ? {} : {correlationId})
      });
      return jsonResponse(200, {
        ok: true,
        matches: result.matches,
        correlationId: result.correlationId
      });
    } catch (error) {
      return responseForError(error);
    }
  };

  return {write, get, list, recall};
}
