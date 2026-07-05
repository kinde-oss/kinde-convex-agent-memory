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
  v.literal('list'),
  v.literal('recall'),
  v.literal('grant'),
  v.literal('revoke_grant'),
  v.literal('set_redaction'),
  v.literal('revoke'),
  v.literal('lift_revocation')
);
export type MemoryOperation = Infer<typeof operationValidator>;

/**
 * A revocation target, as accepted by `revoke`/`liftRevocation`. Kept
 * DELIBERATELY LOOSE at the validator layer (optional orgCode/subject rather
 * than a discriminated union) so that a CONTRADICTORY combination — e.g.
 * kind 'org' without an orgCode, or kind 'global' with a subject — reaches
 * the handler and is denied with a typed, AUDITED
 * `invalid_revocation_target`, instead of dying unaudited at the argument
 * validator. The handler normalizes it to the strict store shape.
 */
export const revocationTargetValidator = v.object({
  kind: v.union(v.literal('global'), v.literal('org'), v.literal('subject')),
  orgCode: v.optional(v.string()),
  subject: v.optional(v.string())
});
export type RevocationTargetArg = Infer<typeof revocationTargetValidator>;

/** The level at which an active revocation matched a caller. */
export type RevocationLevel = 'global' | 'org' | 'subject';

/**
 * The CLOSED set of grantable scopes, mapped one-to-one onto the governed
 * memory operations they gate: `memory.write` → write, `memory.read` → get
 * and list (both are reads), `memory.recall` → recall. The management
 * operations themselves (grant / revoke_grant / set_redaction) are
 * tenant-gated but NOT scope-gated in this phase — the trusted host app is
 * the trust boundary for administration; an admin scope is a later-phase
 * decision, made deliberately, not by accident here.
 */
export const grantScopeValidator = v.union(
  v.literal('memory.read'),
  v.literal('memory.write'),
  v.literal('memory.recall')
);
export type GrantScope = Infer<typeof grantScopeValidator>;

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
  v.literal('invalid_filter'),
  v.literal('invalid_embedding'),
  v.literal('invalid_topk'),
  v.literal('scope_not_granted'),
  v.literal('grant_not_found'),
  v.literal('policy_not_found'),
  v.literal('invalid_redaction_fields'),
  v.literal('revoked'),
  v.literal('revocation_not_found'),
  v.literal('invalid_revocation_target')
);
export type DeniedCode = Infer<typeof deniedCodeValidator>;

/**
 * The denial codes a RECALL can produce — the subset of {@link DeniedCode}
 * the recall action's denial-audit internal mutation accepts.
 */
export const recallDeniedCodeValidator = v.union(
  v.literal('tenant_context_conflict'),
  v.literal('invalid_embedding'),
  v.literal('invalid_topk')
);
export type RecallDeniedCode = Infer<typeof recallDeniedCodeValidator>;

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
  v.literal('recalled'),
  v.literal('granted'),
  v.literal('already_granted'),
  v.literal('revoked'),
  v.literal('redaction_set'),
  v.literal('redaction_cleared'),
  v.literal('tenant_context_conflict'),
  v.literal('idempotency_key_reused'),
  v.literal('invalid_filter'),
  v.literal('invalid_embedding'),
  v.literal('invalid_topk'),
  v.literal('scope_not_granted'),
  v.literal('grant_not_found'),
  v.literal('policy_not_found'),
  v.literal('invalid_redaction_fields'),
  // P5. NOTE: the literal 'revoked' (already in this union) does double duty
  // disambiguated by `decision`: (revoke_grant, ok) = a grant was revoked;
  // (any memory op, denied) = the caller is under an active revocation.
  v.literal('revocation_created'),
  v.literal('already_revoked'),
  v.literal('revocation_lifted'),
  v.literal('revocation_not_found'),
  v.literal('invalid_revocation_target')
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
  embedding: v.optional(v.array(v.float64())),
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

/** One semantic-recall hit: the full record and its similarity score. */
export const recallMatchValidator = v.object({
  memory: memoryRecordValidator,
  score: v.float64()
});
export type RecallMatch = Infer<typeof recallMatchValidator>;

export const recallResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    /** Matches ordered by similarity score, DESCENDING (best first). */
    matches: v.array(recallMatchValidator),
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type RecallResult = Infer<typeof recallResultValidator>;

/** How a successful grant resolved. Doubles as the grant's audit reason. */
export const grantOutcomeValidator = v.union(
  v.literal('granted'),
  v.literal('already_granted')
);
export type GrantOutcome = Infer<typeof grantOutcomeValidator>;

export const grantResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    grantId: v.id('accessGrants'),
    outcome: grantOutcomeValidator,
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type GrantResult = Infer<typeof grantResultValidator>;

export const revokeGrantResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    grantId: v.id('accessGrants'),
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type RevokeGrantResult = Infer<typeof revokeGrantResultValidator>;

/** How a successful setRedaction resolved (empty `fields` clears the policy). */
export const setRedactionOutcomeValidator = v.union(
  v.literal('set'),
  v.literal('cleared')
);
export type SetRedactionOutcome = Infer<typeof setRedactionOutcomeValidator>;

export const setRedactionResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    outcome: setRedactionOutcomeValidator,
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type SetRedactionResult = Infer<typeof setRedactionResultValidator>;

/** How a successful revoke resolved (re-revoking an active target replays). */
export const revokeOutcomeValidator = v.union(
  v.literal('revoked'),
  v.literal('already_revoked')
);
export type RevokeOutcome = Infer<typeof revokeOutcomeValidator>;

export const revokeResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    revocationId: v.id('revocations'),
    outcome: revokeOutcomeValidator,
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type RevokeResult = Infer<typeof revokeResultValidator>;

export const liftRevocationResultValidator = v.union(
  v.object({
    ok: v.literal(true),
    revocationId: v.id('revocations'),
    correlationId: v.string()
  }),
  deniedResultValidator
);
export type LiftRevocationResult = Infer<typeof liftRevocationResultValidator>;

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

// ---------------------------------------------------------------------------
// P6: PROVENANCE TRACING AND THE PAGINATED AUDIT QUERY (read-only surfaces).
// ---------------------------------------------------------------------------

/**
 * One audit row as returned by the read-only `audit.query` reporting surface.
 * STRUCTURAL SAFETY: this is the EXACT shape of the `audit` table — it has no
 * `content`, no `metadata`, no `embedding` field, and never has had one. Its
 * only free-form string is `keyOrQueryDigest`, which is a keyed digest by
 * construction (see `lib/digest.ts`). Audit rows are therefore structurally
 * incapable of carrying memory bodies, so `audit.query` returns them verbatim
 * and does NOT route them through the memory egress function (which is for
 * memory records, a different shape).
 */
export const auditRowValidator = v.object({
  _id: v.id('audit'),
  _creationTime: v.number(),
  orgCode: v.string(),
  subject: v.string(),
  ts: v.number(),
  operation: operationValidator,
  decision: auditDecisionValidator,
  reasonCode: auditReasonValidator,
  keyOrQueryDigest: v.string(),
  correlationId: v.string(),
  mandateId: nullableString
});
export type AuditRow = Infer<typeof auditRowValidator>;

/**
 * The CLOSED filter for `audit.query` (no `v.any()`). `since`/`until` are
 * EXCLUSIVE numeric `ts` bounds; the rest are exact-equality refinements.
 * Tenant scoping is NOT in this filter — it rides the index range from the
 * `orgCode` argument and can never be a filter field.
 */
export const auditFilterValidator = v.object({
  subject: v.optional(v.string()),
  operation: v.optional(operationValidator),
  decision: v.optional(auditDecisionValidator),
  correlationId: v.optional(v.string()),
  /** Exclusive lower bound on `ts` (strictly after). */
  since: v.optional(v.number()),
  /** Exclusive upper bound on `ts` (strictly before). */
  until: v.optional(v.number())
});
export type AuditFilter = Infer<typeof auditFilterValidator>;

/**
 * `audit.query` result: one newest-first, tenant-scoped page. `audit.query`
 * is a real reactive QUERY (it writes no audit row of its own), so unlike the
 * governed operations it has no `correlationId` echo and no denial branch —
 * its argument errors THROW (see the module doc on `audit.ts`).
 */
export const auditQueryResultValidator = v.object({
  page: v.array(auditRowValidator),
  isDone: v.boolean(),
  continueCursor: v.string()
});
export type AuditQueryResult = Infer<typeof auditQueryResultValidator>;

/**
 * The PROVENANCE shape returned by `provenance.of`. DELIBERATELY CARRIES NO
 * CONTENT: no `content`, no `metadata`, no `embedding` — only identity and
 * provenance stamps. Because it can hold no memory body, this surface can
 * never leak one even absent a redaction policy, so it needs no egress
 * redaction. `createdBy`/`createdAt` are the IMMUTABLE creation event;
 * `writtenBy`/`writtenAt`/`mandateId` are the LATEST write event (they
 * re-stamp on every update while the creation stamp never moves).
 */
export const provenanceRecordValidator = v.object({
  memoryId: v.id('memories'),
  orgCode: v.string(),
  key: v.string(),
  subject: v.string(),
  createdBy: v.string(),
  createdAt: v.number(),
  writtenBy: v.string(),
  writtenAt: v.number(),
  mandateId: nullableString
});
export type ProvenanceRecord = Infer<typeof provenanceRecordValidator>;

/**
 * `provenance.of` result: the provenance shape, or null when no memory with
 * that id exists IN THIS TENANT — a memoryId belonging to another tenant is
 * indistinguishable from a missing one (no cross-tenant existence oracle),
 * exactly as read-by-key behaves.
 */
export const provenanceResultValidator = v.union(
  provenanceRecordValidator,
  v.null()
);
export type ProvenanceResult = Infer<typeof provenanceResultValidator>;

/**
 * One revocation row as returned by the read-only `revocations.inspect`
 * reason-join surface. This is the ONE place `reason` (and the actor stamps)
 * leave the store — deliberately, because inspecting a revocation that governs
 * you is how "why was I denied" is answered. It is NEVER written to an audit
 * row; the audit trail references the revocation only by its target digest.
 */
export const revocationRowValidator = v.object({
  _id: v.id('revocations'),
  _creationTime: v.number(),
  kind: v.union(v.literal('global'), v.literal('org'), v.literal('subject')),
  orgCode: nullableString,
  subject: nullableString,
  reason: v.string(),
  revokedBy: v.string(),
  revokedAt: v.number(),
  liftedBy: nullableString,
  liftedAt: v.union(v.number(), v.null())
});
export type RevocationRow = Infer<typeof revocationRowValidator>;

/**
 * `revocations.inspect` result: the active and historical revocation rows for
 * one target, newest first, alongside the target's digest — the SAME digest a
 * `revoked` denial audit row carries, so an auditor can confirm the join
 * (audit row digest === this digest) followed the right target.
 */
export const inspectRevocationsResultValidator = v.object({
  targetDigest: v.string(),
  revocations: v.array(revocationRowValidator)
});
export type InspectRevocationsResult = Infer<
  typeof inspectRevocationsResultValidator
>;
