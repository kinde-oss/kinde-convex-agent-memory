import type {MutationCtx} from '../_generated/server.js';
import type {
  AuditDecision,
  AuditReason,
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
