import {paginator} from 'convex-helpers/server/pagination';
import schema from '../schema.js';
import type {PaginationOptions} from 'convex/server';
import type {MutationCtx, QueryCtx} from '../_generated/server.js';
import type {Doc} from '../_generated/dataModel.js';
import type {
  AuditDecision,
  AuditFilter,
  AuditReason,
  DeniedCode,
  DeniedResult,
  MemoryOperation
} from '../validators.js';

/**
 * One governed operation's audit event. `keyOrQueryDigest` is ALWAYS the
 * redacted digest (see `lib/digest.ts`) — raw keys and raw memory content
 * never reach this module. `mandateId` carries the write's provenance where
 * relevant and is null for reads and denials.
 */
export interface AuditEvent {
  orgCode: string;
  subject: string;
  operation: MemoryOperation;
  decision: AuditDecision;
  reasonCode: AuditReason;
  keyOrQueryDigest: string;
  correlationId: string;
  mandateId: string | null;
}

/**
 * Append exactly one audit row for one governed operation, stamped with the
 * transaction time. Every write and read of the memory spine — including
 * denials — funnels through here, in the SAME mutation as the operation, so
 * the operation and its audit row commit or roll back together.
 */
export async function recordAudit(
  db: MutationCtx['db'],
  event: AuditEvent
): Promise<void> {
  await db.insert('audit', {...event, ts: Date.now()});
}

/**
 * Audit and return one governed denial — shared by every governed mutation
 * (memory, grants, policy). The audit row commits because this is a RETURN
 * path, not a throw path (see the module doc on `memory.ts`).
 */
export async function deny(
  db: MutationCtx['db'],
  operation: MemoryOperation,
  args: {orgCode: string; subject: string},
  code: DeniedCode,
  message: string,
  keyOrQueryDigest: string,
  correlationId: string
): Promise<DeniedResult> {
  await recordAudit(db, {
    orgCode: args.orgCode,
    subject: args.subject,
    operation,
    decision: 'denied',
    reasonCode: code,
    keyOrQueryDigest,
    correlationId,
    mandateId: null
  });
  return {ok: false, code, message, correlationId};
}

// ---------------------------------------------------------------------------
// THE READ SIDE — the paginated audit reporting surface (P6).
//
// This is the ONLY module that reads the `audit` table too (grep-pinned by
// `structure.test.ts` exactly like the write side): the public `audit.query`
// is a thin wrapper over `queryAuditPage`. Reading the audit log writes NO
// audit row — see the query-vs-mutation exception documented on `audit.ts`.
// ---------------------------------------------------------------------------

export interface AuditPage {
  page: Doc<'audit'>[];
  isDone: boolean;
  continueCursor: string;
}

/**
 * Detect a contradictory audit filter (an empty time window, or a present-but-
 * blank string field). Returns the human-readable reason, or null. `audit.query`
 * is a QUERY and cannot write a denial audit row, so on a contradiction it
 * THROWS a typed `invalid_filter` (a reporting-surface argument error, not a
 * governed operation) rather than returning a `DeniedResult`.
 */
export function auditFilterContradiction(
  filter: AuditFilter | undefined
): string | null {
  if (filter === undefined) {
    return null;
  }
  if (filter.subject === '') {
    return 'subject must be a non-empty string when supplied.';
  }
  if (filter.correlationId === '') {
    return 'correlationId must be a non-empty string when supplied.';
  }
  if (
    filter.since !== undefined &&
    filter.until !== undefined &&
    filter.since >= filter.until
  ) {
    return 'The (since, until) window is empty: since must be strictly less than until (both bounds are exclusive).';
  }
  return null;
}

/** In-range refinement for the audit filter fields not carried by the range. */
function matchesAuditFilter(row: Doc<'audit'>, filter: AuditFilter): boolean {
  if (filter.subject !== undefined && row.subject !== filter.subject) {
    return false;
  }
  if (filter.operation !== undefined && row.operation !== filter.operation) {
    return false;
  }
  if (filter.decision !== undefined && row.decision !== filter.decision) {
    return false;
  }
  if (
    filter.correlationId !== undefined &&
    row.correlationId !== filter.correlationId
  ) {
    return false;
  }
  if (filter.since !== undefined && row.ts <= filter.since) {
    return false;
  }
  if (filter.until !== undefined && row.ts >= filter.until) {
    return false;
  }
  return true;
}

/**
 * Paginated, tenant-scoped, NEWEST-FIRST audit page. TENANT AT THE INDEX RANGE:
 * `by_org_ts` leads with `orgCode`, so the leading `.eq('orgCode', …)` term IS
 * the range — never a post-filter — and `.order('desc')` walks it newest ts
 * first. The `since`/`until` ts bounds also ride the range (both exclusive).
 *
 * `subject`/`operation`/`decision`/`correlationId` are IN-RANGE refinement,
 * applied to rows already inside the tenant range. `correlationId` is
 * DELIBERATELY refined in-range rather than routed through the `by_correlation`
 * index: that index leads with `correlationId`, so using it here would force
 * `orgCode` to become a post-filter — forbidden. Keeping the tenant-leading
 * `by_org_ts` range means a correlationId that exists only in another tenant
 * simply never appears. A refined page may hold fewer than `numItems` rows
 * while `isDone` is false; walk `continueCursor` until `isDone`.
 *
 * Pagination uses convex-helpers' `paginator` (plain cursors, component-safe).
 */
export async function queryAuditPage(
  db: QueryCtx['db'],
  orgCode: string,
  filter: AuditFilter,
  paginationOpts: PaginationOptions
): Promise<AuditPage> {
  const since = filter.since;
  const until = filter.until;
  const ranged = paginator(db, schema)
    .query('audit')
    .withIndex('by_org_ts', (q) => {
      const base = q.eq('orgCode', orgCode);
      if (since !== undefined && until !== undefined) {
        return base.gt('ts', since).lt('ts', until);
      }
      if (since !== undefined) {
        return base.gt('ts', since);
      }
      if (until !== undefined) {
        return base.lt('ts', until);
      }
      return base;
    })
    .order('desc');
  const result = await ranged.paginate({
    numItems: paginationOpts.numItems,
    cursor: paginationOpts.cursor
  });
  return {
    page: result.page.filter((row) => matchesAuditFilter(row, filter)),
    isDone: result.isDone,
    continueCursor: result.continueCursor
  };
}
