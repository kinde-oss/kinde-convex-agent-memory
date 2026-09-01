/**
 * PUBLIC READ-ONLY REPORTING SURFACE: `audit.query` — a paginated, tenant-
 * scoped, newest-first view of the append-only audit log.
 *
 * THE QUERY-VS-MUTATION EXCEPTION (documented deliberately, because it inverts
 * the spine's core rule): every governed MEMORY read — `get`, `list`, `recall`
 * — is a MUTATION, because a governed read must write exactly one audit row and
 * only mutations can write. `audit.query` is the ONE deliberate exception: a
 * real reactive Convex QUERY, precisely BECAUSE querying the audit log is not
 * itself a governed memory event and writes NO audit row of its own. If it
 * audited itself, reading the log would grow the log without bound and every
 * report would perturb what it observes. So it may be reactive, and its
 * argument errors THROW typed ConvexErrors via `fail()` — a query cannot write,
 * and a reporting-surface argument error is not a governed operation that needs
 * an audit trail. (Contrast `memory.get`, whose denials RETURN so their audit
 * row commits.)
 *
 * The actual `audit`-table read lives in `lib/audit.ts` (`queryAuditPage`),
 * grep-pinned there like every table access; this module is a thin wrapper.
 */
import {query as queryBuilder} from './_generated/server.js';
import {v} from 'convex/values';
import {paginationOptsValidator} from 'convex/server';
import {auditFilterContradiction, queryAuditPage} from './lib/audit.js';
import {fail, requireNonEmpty} from './lib/errors.js';
import {auditFilterValidator, auditQueryResultValidator} from './validators.js';

/**
 * Paginated audit query. Tenant-scoped AT THE INDEX RANGE (never a post-filter);
 * newest ts first; the closed `filter` narrows within the tenant range. A
 * contradictory time window throws typed `invalid_filter`; a `claimedOrgCode`
 * that differs from the server-verified `orgCode` throws `tenant_context_conflict`
 * — both THROW (this is a query; see the module doc).
 */
export const query = queryBuilder({
  args: {
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    filter: v.optional(auditFilterValidator),
    paginationOpts: paginationOptsValidator
  },
  returns: auditQueryResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    if (args.paginationOpts.numItems <= 0) {
      fail('invalid_argument', 'paginationOpts.numItems must be positive.');
    }
    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      fail(
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.'
      );
    }
    const contradiction = auditFilterContradiction(args.filter);
    if (contradiction !== null) {
      fail('invalid_filter', contradiction);
    }
    const {page, isDone, continueCursor} = await queryAuditPage(
      ctx.db,
      args.orgCode,
      args.filter ?? {},
      args.paginationOpts
    );
    return {page, isDone, continueCursor};
  }
});
