import {defineSchema, defineTable} from 'convex/server';
import {v} from 'convex/values';
import {EMBEDDING_DIMENSIONS} from './lib/embedding.js';
import {
  auditDecisionValidator,
  auditReasonValidator,
  grantScopeValidator,
  metadataValidator,
  nullableString,
  operationValidator
} from './validators.js';

export default defineSchema({
  /**
   * Agent memory records. `orgCode` is THE isolation key: every index leads
   * with it, and every query runs through the governed access path
   * (`access.ts`), which applies the tenant constraint at the index range —
   * never as a post-filter. One record per (orgCode, key).
   *
   * Provenance is two stamps:
   *   - `createdBy`/`createdAt` — the IMMUTABLE creation event, written once
   *     at insert and never patched afterwards.
   *   - `writtenBy`/`writtenAt`/`mandateId` — the LATEST write event,
   *     re-stamped on every content update (an update is a new provenance
   *     event; the creation stamp is preserved untouched).
   *
   * `idempotencyKey` is the key of the most recent non-replay write (null when
   * none was supplied). It is only ever looked up WITHIN the tenant via
   * `by_org_idempotency`, so idempotency keys can neither collide nor leak
   * across tenants.
   *
   * `embedding` is the OPTIONAL semantic-recall vector, exactly
   * `EMBEDDING_DIMENSIONS` finite float64s (validated with a typed code before
   * any db access — the dimensionality is fixed by the vector index below). A
   * record without one simply never appears in vector search. The
   * `by_embedding` vector index declares `filterFields: ['orgCode']` and every
   * search supplies the orgCode filter, so tenant partitioning is enforced BY
   * THE VECTOR QUERY ITSELF — rows of other tenants are outside the searched
   * partition, not post-filtered out of it.
   */
  memories: defineTable({
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
  })
    .index('by_org_key', ['orgCode', 'key'])
    .index('by_org', ['orgCode'])
    .index('by_org_subject', ['orgCode', 'subject'])
    .index('by_org_idempotency', ['orgCode', 'idempotencyKey'])
    .vectorIndex('by_embedding', {
      vectorField: 'embedding',
      dimensions: EMBEDDING_DIMENSIONS,
      filterFields: ['orgCode']
    }),

  /**
   * The audit trail: exactly ONE row per governed operation — reads included,
   * denials included — written in the same mutation as the operation itself so
   * they commit or roll back together. `keyOrQueryDigest` is the redacted
   * digest (see `lib/digest.ts`); raw keys and raw memory content NEVER appear
   * here. A cross-tenant read audits as a plain `not_found` under the CALLER's
   * org — no cross-tenant information is recorded.
   */
  /**
   * Scope grants — the per-subject enforcement switch. THE MODE BOUNDARY
   * (P4's documented decision): a (orgCode, subject) with NO rows here is
   * PERMISSIVE — the component behaves exactly as P1–P3, fully standalone.
   * The moment ANY row exists for that (orgCode, subject) — REVOKED ROWS
   * INCLUDED — the subject is ENFORCED: each governed memory operation
   * requires an unrevoked grant of its scope, else a typed
   * `scope_not_granted` denial. Revoked rows count towards enforcement
   * deliberately: revoking a subject's last grant must lock the subject out,
   * never silently return it to permissive mode. All access to this table
   * lives in `lib/grantStore.ts` (grep-pinned), and the only index leads with
   * orgCode — grants can neither be read nor matched across tenants.
   */
  accessGrants: defineTable({
    orgCode: v.string(),
    /** The grantee: the subject the scope is granted TO. */
    subject: v.string(),
    scope: grantScopeValidator,
    /** The caller that performed the grant (provenance, not authority). */
    grantedBy: v.string(),
    grantedAt: v.number(),
    /** Null while active; set once by revokeGrant (grant-level revocation
     * ahead of P5's broader overlay). */
    revokedAt: v.union(v.number(), v.null())
  }).index('by_org_subject', ['orgCode', 'subject']),

  /**
   * Redaction-on-read policies. TARGETING MODEL (P4's documented decision,
   * the recommended simple shape): per-org with optional per-subject
   * targeting — `targetSubject: null` is the org-wide policy, a string
   * targets one subject. At most ONE policy per (orgCode, targetSubject);
   * `setRedaction` replaces. PRECEDENCE: a subject-targeted policy WINS
   * OUTRIGHT over the org-wide one (no merging — the more specific intent
   * replaces the general one; documented on `resolveRedaction`). `fields`
   * holds metadata field names and/or the literal 'content'. Policies shape
   * the EGRESS COPY only — stored rows are never altered. All access to this
   * table lives in `lib/redaction.ts` (grep-pinned).
   */
  redactionPolicies: defineTable({
    orgCode: v.string(),
    targetSubject: nullableString,
    fields: v.array(v.string()),
    createdBy: v.string(),
    createdAt: v.number()
  }).index('by_org', ['orgCode']),

  audit: defineTable({
    orgCode: v.string(),
    subject: v.string(),
    ts: v.number(),
    operation: operationValidator,
    decision: auditDecisionValidator,
    reasonCode: auditReasonValidator,
    keyOrQueryDigest: v.string(),
    correlationId: v.string(),
    mandateId: nullableString
  })
    .index('by_org_ts', ['orgCode', 'ts'])
    .index('by_correlation', ['correlationId'])
});
