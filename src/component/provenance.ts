/**
 * PUBLIC READ-ONLY PROVENANCE SURFACE: `provenance.of`.
 *
 * A real reactive QUERY (the same query-vs-mutation exception documented on
 * `audit.ts`): tracing a record's provenance writes no audit row, so it need
 * not — and, being a query, cannot — be a mutation. Its argument errors THROW
 * typed ConvexErrors via `fail()`.
 *
 * ADMIN REPORTING SURFACE: like `audit.query`, this is a TENANT-WIDE reporting
 * surface — a caller with a server-verified `orgCode` can trace ANY record in
 * the tenant; there is no per-subject scope gate at the component level, by
 * design (the host app is the trust boundary; wrap it admin-only — see the
 * README security model).
 *
 * NO-CONTENT GUARANTEE: this surface returns ONLY provenance identity stamps —
 * the immutable creation event (`createdBy`/`createdAt`) and the latest write
 * event (`writtenBy`/`writtenAt`/`mandateId`), plus the record's `key`,
 * `subject`, and `orgCode`. It returns NO `content`, NO `metadata`, NO
 * `embedding` (see `provenanceRecordValidator`), so it is structurally
 * incapable of leaking a memory body.
 *
 * REDACTION-ON-READ (P6 hardening): the identity strings it DOES return are not
 * automatically safe — a `key` may encode a sensitive path, and audit rows
 * deliberately keep subject identity only as a keyed digest, never raw. So the
 * returned `key`/`subject` (and the actor stamps that equal that subject) run
 * through THE SAME redaction policy egress uses — `resolveRedaction` on the
 * record's (org, subject), then `redactProvenanceIdentity`: when a policy
 * applies they are replaced with the redaction sentinel; when none applies the
 * output is unchanged. `memoryId` and timestamps stay raw. The record is
 * fetched THROUGH `access.ts` with the tenant re-check, so a memoryId from
 * another tenant returns null (no cross-tenant existence oracle).
 */
import {query} from './_generated/server.js';
import {v} from 'convex/values';
import {getMemoryByIdInTenant} from './access.js';
import {fail, requireNonEmpty} from './lib/errors.js';
import {redactProvenanceIdentity, resolveRedaction} from './lib/redaction.js';
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
    // Redaction-on-read for the identity strings: resolve the SAME policy
    // egress uses, keyed on the RECORD's (org, subject), then apply it to the
    // provenance shape. `memoryId` and timestamps are kept raw.
    const redacted = await resolveRedaction(ctx.db, doc.orgCode, doc.subject);
    return redactProvenanceIdentity(
      {
        memoryId: doc._id,
        orgCode: doc.orgCode,
        key: doc.key,
        subject: doc.subject,
        createdBy: doc.createdBy,
        createdAt: doc.createdAt,
        writtenBy: doc.writtenBy,
        writtenAt: doc.writtenAt,
        mandateId: doc.mandateId
      },
      redacted
    );
  }
});
