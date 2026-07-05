/**
 * THE GOVERNED ACCESS PATH.
 *
 * CONTRACT — every read and write of the `memories` table, in this phase and
 * every later one (query, recall, redaction, revocation), flows through THIS
 * MODULE and no other. Grep-verifiable: `db.query('memories')`,
 * `db.insert('memories')`, `db.get('memories', …)`, and
 * `ctx.vectorSearch('memories', …)` appear in this file only (enforced by
 * `structure.test.ts`; production modules only — tests inspect table state
 * directly by design, and `schema.ts` merely defines the table). Id-based
 * fetches always use the table-scoped `db.get('memories', id)` overload so
 * the grep sees them too.
 *
 * Every function here takes the SERVER-VERIFIED tenant context (`orgCode`)
 * and applies it AT THE QUERY, as the leading `.eq('orgCode', …)` of a
 * `by_org_*` index range — never as a `.filter()` or a post-fetch check
 * someone could forget. A row whose orgCode differs from the caller's tenant
 * context is therefore outside the index range and can never be returned,
 * regardless of what later phases build on top.
 *
 * Public functions (`memory.ts`) are thin wrappers over this path: they
 * resolve tenant context, correlation, and audit, and contain NO direct
 * `memories` queries of their own.
 */
import {paginator} from 'convex-helpers/server/pagination';
import type {PaginationOptions} from 'convex/server';
import schema from './schema.js';
import {fail} from './lib/errors.js';
import type {ActionCtx, MutationCtx, QueryCtx} from './_generated/server.js';
import type {Doc, Id} from './_generated/dataModel.js';
import type {ListFilter, MemoryMetadata} from './validators.js';

type Db = QueryCtx['db'];
type WriteDb = MutationCtx['db'];

/**
 * Read one memory by key WITHIN the tenant. A key held by another tenant is
 * outside the `by_org_key` index range and resolves to null exactly as if it
 * did not exist. `.unique()` is safe: the write path maintains at most one
 * record per (orgCode, key).
 */
export async function getMemoryByKey(
  db: Db,
  orgCode: string,
  key: string
): Promise<Doc<'memories'> | null> {
  return await db
    .query('memories')
    .withIndex('by_org_key', (q) => q.eq('orgCode', orgCode).eq('key', key))
    .unique();
}

/**
 * Idempotency lookup, scoped WITHIN the tenant via `by_org_idempotency` — the
 * same idempotencyKey in two tenants resolves independently, so keys can
 * neither collide nor leak across the boundary.
 */
export async function getMemoryByIdempotencyKey(
  db: Db,
  orgCode: string,
  idempotencyKey: string
): Promise<Doc<'memories'> | null> {
  return await db
    .query('memories')
    .withIndex('by_org_idempotency', (q) =>
      q.eq('orgCode', orgCode).eq('idempotencyKey', idempotencyKey)
    )
    .unique();
}

/*
 * THE FILTER MODEL — two tiers, documented here because this is the module
 * that guarantees the distinction:
 *
 * 1. INDEX RANGE — what the tenant-leading indexes can express. Exactly one
 *    index carries each list call, chosen in this precedence order:
 *      - `bySubject`  → `by_org_subject` (orgCode, subject): both equalities
 *        ride the index.
 *      - `keyPrefix`  → `by_org_key` (orgCode, key): the prefix rides as the
 *        range [prefix, successor(prefix)).
 *      - otherwise    → `by_org` (orgCode).
 *    In EVERY case the range's leading term is `.eq('orgCode', …)` — the
 *    tenant constraint is part of the range itself.
 *
 * 2. IN-RANGE REFINEMENT — everything a range cannot express (`writtenAfter`/
 *    `writtenBefore` over writtenAt, `metadataEquals`, and whichever of
 *    `bySubject`/`keyPrefix` did not win the index) is applied in-memory to
 *    rows ALREADY INSIDE the tenant-scoped range. Refinement can only ever
 *    SHRINK the row set. A refined page may therefore hold fewer than
 *    `numItems` rows while `isDone` is still false; callers walk
 *    `continueCursor` until `isDone` (the standard Convex pattern).
 *
 * NEVER ACCEPTABLE: widening the range beyond the tenant to satisfy a filter.
 * No filter shape can influence the leading `.eq('orgCode', …)` term.
 */

/**
 * The tightest string upper bound for "starts with `prefix`": the rightmost
 * code unit below 0xFFFF is incremented and everything after it dropped, so
 * [prefix, bound) covers exactly the strings extending `prefix`. Null when no
 * finite bound exists (a prefix of only 0xFFFF units) — the range then stays
 * lower-bounded only, and in-range refinement still enforces the prefix.
 */
function keyPrefixUpperBound(prefix: string): string | null {
  for (let i = prefix.length - 1; i >= 0; i--) {
    const code = prefix.charCodeAt(i);
    if (code < 0xffff) {
      return prefix.slice(0, i) + String.fromCharCode(code + 1);
    }
  }
  return null;
}

/**
 * In-range refinement (tier 2 of the filter model). Applied to every row the
 * index range returned — including belt-and-braces re-checks of conditions the
 * range already narrowed, which costs nothing per row and keeps correctness
 * independent of index-boundary subtleties.
 */
function matchesInRange(doc: Doc<'memories'>, filter: ListFilter): boolean {
  if (filter.bySubject !== undefined && doc.subject !== filter.bySubject) {
    return false;
  }
  if (filter.keyPrefix !== undefined && !doc.key.startsWith(filter.keyPrefix)) {
    return false;
  }
  if (
    filter.writtenAfter !== undefined &&
    doc.writtenAt <= filter.writtenAfter
  ) {
    return false;
  }
  if (
    filter.writtenBefore !== undefined &&
    doc.writtenAt >= filter.writtenBefore
  ) {
    return false;
  }
  if (filter.metadataEquals !== undefined) {
    const stored = doc.metadata?.[filter.metadataEquals.field];
    if (stored === undefined || Array.isArray(stored)) {
      return false;
    }
    if (stored !== filter.metadataEquals.value) {
      return false;
    }
  }
  return true;
}

/**
 * Detect a contradictory filter — arguments that cannot be satisfied, or
 * filter values that are present but unusable. Returns the human-readable
 * reason, or null for a satisfiable filter. Contradictions are DENIED typed by
 * the public wrapper, never silently coerced into an empty result.
 */
export function filterContradiction(
  filter: ListFilter | undefined
): string | null {
  if (filter === undefined) {
    return null;
  }
  if (filter.bySubject === '') {
    return 'bySubject must be a non-empty string when supplied.';
  }
  if (filter.keyPrefix === '') {
    return 'keyPrefix must be a non-empty string when supplied.';
  }
  if (
    filter.metadataEquals !== undefined &&
    filter.metadataEquals.field === ''
  ) {
    return 'metadataEquals.field must be a non-empty string when supplied.';
  }
  if (
    filter.writtenAfter !== undefined &&
    filter.writtenBefore !== undefined &&
    filter.writtenAfter >= filter.writtenBefore
  ) {
    return 'The (writtenAfter, writtenBefore) window is empty: writtenAfter must be strictly less than writtenBefore (both bounds are exclusive).';
  }
  return null;
}

export interface ListPage {
  page: Doc<'memories'>[];
  isDone: boolean;
  continueCursor: string;
}

/**
 * Paginated, tenant-scoped listing (see THE FILTER MODEL above). Pagination
 * uses convex-helpers' `paginator`, which walks a plain index range with plain
 * cursors — no reactivity journal — so it is safe inside this component's
 * mutations. The cursor walks the TENANT-SCOPED range only: a page boundary
 * can never step outside the leading `.eq('orgCode', …)` term, so pagination
 * cannot cross into another tenant's rows.
 */
export async function listMemories(
  db: Db,
  orgCode: string,
  filter: ListFilter,
  paginationOpts: PaginationOptions
): Promise<ListPage> {
  const query = paginator(db, schema).query('memories');
  const subject = filter.bySubject;
  const prefix = filter.keyPrefix;
  let ranged;
  if (subject !== undefined) {
    ranged = query.withIndex('by_org_subject', (q) =>
      q.eq('orgCode', orgCode).eq('subject', subject)
    );
  } else if (prefix !== undefined && prefix !== '') {
    const upper = keyPrefixUpperBound(prefix);
    ranged = query.withIndex('by_org_key', (q) => {
      const lower = q.eq('orgCode', orgCode).gte('key', prefix);
      return upper === null ? lower : lower.lt('key', upper);
    });
  } else {
    ranged = query.withIndex('by_org', (q) => q.eq('orgCode', orgCode));
  }
  const result = await ranged.paginate({
    numItems: paginationOpts.numItems,
    cursor: paginationOpts.cursor
  });
  return {
    page: result.page.filter((doc) => matchesInRange(doc, filter)),
    isDone: result.isDone,
    continueCursor: result.continueCursor
  };
}

/**
 * TENANT-PARTITIONED VECTOR SEARCH. `ctx.vectorSearch` exists only in
 * ACTIONS (a Convex platform rule — mutations cannot vector-search), so this
 * is the one function in the governed path that takes an `ActionCtx` instead
 * of a db handle. The isolation mechanic is unchanged in spirit: the
 * `by_embedding` vector index declares `filterFields: ['orgCode']` and this
 * function ALWAYS supplies the orgCode filter, so the search runs inside the
 * tenant's partition of the index — other tenants' vectors are outside the
 * searched set, never post-filtered out of the results. Returns (id, score)
 * pairs ordered by similarity DESCENDING; the caller re-fetches the docs
 * through `getMemoriesByIds` inside a mutation.
 */
export async function searchMemoriesByEmbedding(
  ctx: ActionCtx,
  orgCode: string,
  embedding: number[],
  limit: number
): Promise<Array<{_id: Id<'memories'>; _score: number}>> {
  return await ctx.vectorSearch('memories', 'by_embedding', {
    vector: embedding,
    limit,
    filter: (q) => q.eq('orgCode', orgCode)
  });
}

/**
 * Fetch memories by id with a BELT-AND-BRACES tenant re-check. The ids come
 * from `searchMemoriesByEmbedding`, whose orgCode filter already partitions
 * the search — so a fetched doc whose orgCode differs from the caller's
 * tenant context should be IMPOSSIBLE. If one ever appears, that is a hard
 * isolation-invariant violation and this function fails LOUDLY with a typed
 * code — it is never silently dropped. A null doc (deleted between the
 * action's search and this mutation's fetch) is NOT a violation — the record
 * genuinely no longer exists — and is dropped from the result.
 */
export async function getMemoriesByIds(
  db: Db,
  orgCode: string,
  ids: Id<'memories'>[]
): Promise<Map<Id<'memories'>, Doc<'memories'>>> {
  const docs = new Map<Id<'memories'>, Doc<'memories'>>();
  for (const id of ids) {
    const doc = await db.get('memories', id);
    if (doc === null) {
      continue;
    }
    if (doc.orgCode !== orgCode) {
      fail(
        'isolation_invariant_violation',
        'A vector-search hit resolved to a document outside the tenant partition. This should be impossible; refusing to return any results.'
      );
    }
    docs.set(id, doc);
  }
  return docs;
}

/**
 * Fetch ONE memory by id WITHIN the tenant, for the provenance surface. Unlike
 * {@link getMemoriesByIds} (belt-and-braces for vector-search hits, where a
 * tenant mismatch is impossible and so fails loudly), here the id is
 * caller-supplied and may legitimately belong to ANOTHER tenant — so a mismatch
 * is EXPECTED and resolves to null, exactly as read-by-key does for a key held
 * elsewhere. No cross-tenant existence oracle: "not yours" and "does not exist"
 * are indistinguishable. Uses the table-scoped `db.get('memories', id)` overload
 * so the structural grep still sees this access.
 */
export async function getMemoryByIdInTenant(
  db: Db,
  orgCode: string,
  id: Id<'memories'>
): Promise<Doc<'memories'> | null> {
  const doc = await db.get('memories', id);
  if (doc === null || doc.orgCode !== orgCode) {
    return null;
  }
  return doc;
}

export interface InsertMemoryInput {
  orgCode: string;
  subject: string;
  key: string;
  content: string;
  metadata?: MemoryMetadata;
  embedding?: number[];
  mandateId: string | null;
  idempotencyKey: string | null;
}

/**
 * Create a memory stamped with the tenant's orgCode and BOTH provenance
 * stamps: the immutable creation event (`createdBy`/`createdAt`) and the
 * initial write event (`writtenBy`/`writtenAt`), which start out identical.
 */
export async function insertMemory(
  db: WriteDb,
  input: InsertMemoryInput,
  now: number
): Promise<Id<'memories'>> {
  return await db.insert('memories', {
    orgCode: input.orgCode,
    subject: input.subject,
    key: input.key,
    content: input.content,
    ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
    ...(input.embedding === undefined ? {} : {embedding: input.embedding}),
    createdBy: input.subject,
    createdAt: now,
    writtenBy: input.subject,
    writtenAt: now,
    mandateId: input.mandateId,
    idempotencyKey: input.idempotencyKey
  });
}

export interface UpdateMemoryInput {
  content: string;
  /** Omitted → the stored metadata is left unchanged (pass `{}` to clear). */
  metadata?: MemoryMetadata;
  /**
   * Omitted → the STORED embedding is KEPT (see the update-semantics note on
   * `memory.write`); supplied → replaced.
   */
  embedding?: number[];
  writtenBy: string;
  mandateId: string | null;
  idempotencyKey: string | null;
}

/**
 * Update a memory's content as a NEW write-provenance event: re-stamps
 * `writtenBy`/`writtenAt`/`mandateId` (and the stored `idempotencyKey`).
 * IMMUTABILITY: `createdBy`/`createdAt` are NEVER patched — the creation
 * provenance survives every subsequent write. The caller obtained `existing`
 * through this module, so the tenant constraint has already been applied.
 */
export async function updateMemoryContent(
  db: WriteDb,
  existing: Doc<'memories'>,
  input: UpdateMemoryInput,
  now: number
): Promise<Id<'memories'>> {
  await db.patch('memories', existing._id, {
    content: input.content,
    ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
    ...(input.embedding === undefined ? {} : {embedding: input.embedding}),
    writtenBy: input.writtenBy,
    writtenAt: now,
    mandateId: input.mandateId,
    idempotencyKey: input.idempotencyKey
  });
  return existing._id;
}
