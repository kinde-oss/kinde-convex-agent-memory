import {defineSchema, defineTable} from 'convex/server';
import {v} from 'convex/values';
import {EMBEDDING_DIMENSIONS} from './lib/embedding.js';
import {
  auditDecisionValidator,
  auditReasonValidator,
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
