import {v} from 'convex/values';
import type {Infer} from 'convex/values';

/**
 * A single metadata value: JSON primitives or an array of them. Deliberately
 * flat — metadata is queryable annotation, not a document store; an app with
 * nested structure JSON-stringifies it into one value. Keeping the validator
 * closed (no `v.any()`) keeps the inferred TypeScript types strict end to end.
 */
export const metadataValueValidator = v.union(
  v.string(),
  v.number(),
  v.boolean(),
  v.null(),
  v.array(v.union(v.string(), v.number(), v.boolean(), v.null()))
);

/** Optional annotation attached to a memory record. */
export const metadataValidator = v.record(v.string(), metadataValueValidator);
export type MemoryMetadata = Infer<typeof metadataValidator>;

export const nullableString = v.union(v.string(), v.null());

/** The governed operations audited today; later phases extend this union. */
export const operationValidator = v.union(
  v.literal('write'),
  v.literal('get'),
  v.literal('list')
);
export type MemoryOperation = Infer<typeof operationValidator>;

export const auditDecisionValidator = v.union(
  v.literal('ok'),
  v.literal('denied')
);
export type AuditDecision = Infer<typeof auditDecisionValidator>;

/** How a successful write resolved. Doubles as the write's audit reason. */
export const writeOutcomeValidator = v.union(
  v.literal('created'),
  v.literal('updated'),
  v.literal('idempotent_replay')
);
export type WriteOutcome = Infer<typeof writeOutcomeValidator>;

/** Machine-readable codes a governed operation can be denied with. */
export const deniedCodeValidator = v.union(
  v.literal('tenant_context_conflict'),
  v.literal('idempotency_key_reused'),
  v.literal('invalid_filter')
);
export type DeniedCode = Infer<typeof deniedCodeValidator>;

/**
 * Every audit reason: write outcomes, read outcomes, and denial codes.
 * `found`/`not_found` describe a read purely WITHIN the caller's tenant — a
 * key held by another tenant audits as `not_found`, indistinguishable from a
 * key that exists nowhere (no cross-tenant existence oracle).
 */
export const auditReasonValidator = v.union(
  v.literal('created'),
  v.literal('updated'),
  v.literal('idempotent_replay'),
  v.literal('found'),
  v.literal('not_found'),
  v.literal('listed'),
  v.literal('tenant_context_conflict'),
  v.literal('idempotency_key_reused'),
  v.literal('invalid_filter')
);
export type AuditReason = Infer<typeof auditReasonValidator>;

/** The full memory record as returned by governed reads. */
export const memoryRecordValidator = v.object({
  _id: v.id('memories'),
  _creationTime: v.number(),
  orgCode: v.string(),
  subject: v.string(),
  key: v.string(),
  content: v.string(),
  metadata: v.optional(metadataValidator),
  createdBy: v.string(),
  createdAt: v.number(),
  writtenBy: v.string(),
  writtenAt: v.number(),
  mandateId: nullableString,
  idempotencyKey: nullableString
});
export type MemoryRecord = Infer<typeof memoryRecordValidator>;

/**
 * A DENIED governed operation, returned (not thrown) by the component so the
 * denial's audit row COMMITS — a ConvexError thrown from the same mutation
 * would roll that row back. The client class converts this into a thrown,
 * typed ConvexError carrying the same `code`, so callers still get typed
 * failure semantics.
 */
export const deniedResultValidator = v.object({
  ok: v.literal(false),
  code: deniedCodeValidator,
  message: v.string(),
  correlationId: v.string()
});
export type DeniedResult = Infer<typeof deniedResultValidator>;

export const writeResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    memoryId: v.id('memories'),
    outcome: writeOutcomeValidator,
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type WriteResult = Infer<typeof writeResultValidator>;

export const getResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    memory: v.union(memoryRecordValidator, v.null()),
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type GetResult = Infer<typeof getResultValidator>;

/**
 * The list filter: plain data, never predicates, and a CLOSED object — every
 * shape the governed path can be asked for is enumerated here. How each field
 * is applied (index range vs in-range refinement) is access.ts's contract.
 * `metadataEquals` matches an exactly-equal primitive metadata value (a stored
 * array never matches; an absent field never matches, including `value: null`,
 * which matches only a stored explicit null).
 */
export const listFilterValidator = v.object({
  bySubject: v.optional(v.string()),
  keyPrefix: v.optional(v.string()),
  /** Exclusive lower bound on `writtenAt` (strictly after). */
  writtenAfter: v.optional(v.number()),
  /** Exclusive upper bound on `writtenAt` (strictly before). */
  writtenBefore: v.optional(v.number()),
  metadataEquals: v.optional(
    v.object({
      field: v.string(),
      value: v.union(v.string(), v.number(), v.boolean(), v.null())
    })
  )
});
export type ListFilter = Infer<typeof listFilterValidator>;

export const listResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    /**
     * One tenant-scoped page. After in-range refinement a page may hold fewer
     * than `numItems` rows (even zero) while `isDone` is still false — walk
     * `continueCursor` until `isDone`, the standard Convex pattern.
     */
    page: v.array(memoryRecordValidator),
    isDone: v.boolean(),
    continueCursor: v.string(),
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type ListResult = Infer<typeof listResultValidator>;
