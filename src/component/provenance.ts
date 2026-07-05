/**
 * PUBLIC READ-ONLY PROVENANCE SURFACE: `provenance.of`.
 *
 * A real reactive QUERY (the same query-vs-mutation exception documented on
 * `audit.ts`): tracing a record's provenance writes no audit row, so it need
 * not — and, being a query, cannot — be a mutation. Its argument errors THROW
 * typed ConvexErrors via `fail()`.
 *
 * NO-CONTENT GUARANTEE: this surface returns ONLY provenance identity stamps —
 * the immutable creation event (`createdBy`/`createdAt`) and the latest write
 * event (`writtenBy`/`writtenAt`/`mandateId`), plus the record's `key`,
 * `subject`, and `orgCode`. It returns NO `content`, NO `metadata`, NO
 * `embedding` (see `provenanceRecordValidator`), so it is structurally
 * incapable of leaking a memory body and therefore needs no egress redaction —
 * redaction protects content, and there is none here. The record is fetched
 * THROUGH `access.ts` with the tenant re-check, so a memoryId from another
 * tenant returns null (no cross-tenant existence oracle).
 */
import {query} from './_generated/server.js';
import {v} from 'convex/values';
import {getMemoryByIdInTenant} from './access.js';
import {fail, requireNonEmpty} from './lib/errors.js';
import {provenanceResultValidator} from './validators.js';

export const of = query({
  args: {
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    memoryId: v.id('memories'),
    // Accepted for call-site symmetry with the governed surfaces; a query
    // writes no audit row, so there is nothing for it to correlate to.
    correlationId: v.optional(v.string())
  },
  returns: provenanceResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      fail(
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.'
      );
    }
    const doc = await getMemoryByIdInTenant(
      ctx.db,
      args.orgCode,
      args.memoryId
    );
    if (doc === null) {
      return null;
    }
    return {
      memoryId: doc._id,
      orgCode: doc.orgCode,
      key: doc.key,
      subject: doc.subject,
      createdBy: doc.createdBy,
      createdAt: doc.createdAt,
      writtenBy: doc.writtenBy,
      writtenAt: doc.writtenAt,
      mandateId: doc.mandateId
    };
  }
});
