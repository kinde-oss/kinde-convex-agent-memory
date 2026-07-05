/**
 * PUBLIC API of the memory spine: governed `write` and `get` (read-by-key).
 * Thin wrappers over the governed access path (`access.ts`) — no direct
 * `memories` queries live here.
 *
 * Two deliberate shapes:
 *
 * 1. DENIALS RETURN, THE CLIENT THROWS. A denial (e.g.
 *    `tenant_context_conflict`) must be audited, and a ConvexError thrown
 *    from this mutation would roll the audit row back with everything else.
 *    So denials commit their audit row and RETURN a typed `DeniedResult`; the
 *    `AgentMemory` client converts that into a thrown typed ConvexError, so
 *    app code still gets fail(code, message) semantics.
 *
 * 2. `get` IS A MUTATION. Every governed read writes exactly one audit row,
 *    and only mutations can write — a read that could not be audited would
 *    break the spine's contract. A reactive, audit-free query surface is a
 *    later-phase decision, made deliberately, not by accident here.
 *
 * TENANT CONTEXT: `orgCode` is the SERVER-VERIFIED tenant context supplied by
 * the trusted host app (the Convex trust boundary — only the app can call
 * component functions). `claimedOrgCode` is anything that arrived from a
 * client; when present and different from `orgCode` the call is denied
 * `tenant_context_conflict` BEFORE any memory access, and the denial is
 * audited. Neither value is ever silently preferred.
 */
import {mutation} from './_generated/server.js';
import {v} from 'convex/values';
import {
  getMemoryByIdempotencyKey,
  getMemoryByKey,
  insertMemory,
  updateMemoryContent
} from './access.js';
import {recordAudit} from './lib/audit.js';
import {resolveCorrelationId} from './lib/correlation.js';
import {digestKey} from './lib/digest.js';
import {fail} from './lib/errors.js';
import {
  getResultValidator,
  metadataValidator,
  writeResultValidator
} from './validators.js';
import type {DeniedCode, DeniedResult, MemoryOperation} from './validators.js';
import type {MutationCtx} from './_generated/server.js';

/** Reject blank identity fields — malformed calls never reach the spine. */
function requireNonEmpty(value: string, name: string): void {
  if (value === '') {
    fail('invalid_argument', `${name} must be a non-empty string.`);
  }
}

/**
 * Audit and return one governed denial. The audit row commits because this is
 * a return path, not a throw path (see the module doc).
 */
async function deny(
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

/**
 * Governed write. Idempotency (`idempotencyKey`) is tenant-scoped: a replay
 * within the tenant returns the original record's id without writing; the
 * same key in another tenant is a fresh, independent write. Re-writing an
 * existing (orgCode, key) updates content as a NEW write-provenance event —
 * `writtenBy`/`writtenAt` re-stamp, `createdBy`/`createdAt` never change.
 * Exactly one audit row per call, replay and denial included.
 */
export const write = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    key: v.string(),
    content: v.string(),
    metadata: v.optional(metadataValidator),
    idempotencyKey: v.optional(v.string()),
    correlationId: v.optional(v.string())
  },
  returns: writeResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    requireNonEmpty(args.key, 'key');
    const correlationId = resolveCorrelationId(args.correlationId);
    const keyDigest = digestKey(args.key);

    // Tenant-context conflict: checked BEFORE any memory access.
    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'write',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        keyDigest,
        correlationId
      );
    }

    const now = Date.now();

    // Tenant-scoped idempotency: a known idempotencyKey replays; reusing it
    // with a DIFFERENT key is contradictory and is rejected, never coerced.
    // (Replayed content is ignored by design: the first write won.)
    if (args.idempotencyKey !== undefined) {
      requireNonEmpty(args.idempotencyKey, 'idempotencyKey');
      const replayed = await getMemoryByIdempotencyKey(
        ctx.db,
        args.orgCode,
        args.idempotencyKey
      );
      if (replayed !== null) {
        if (replayed.key !== args.key) {
          return await deny(
            ctx.db,
            'write',
            args,
            'idempotency_key_reused',
            'This idempotencyKey was already used for a different key in this tenant.',
            keyDigest,
            correlationId
          );
        }
        await recordAudit(ctx.db, {
          orgCode: args.orgCode,
          subject: args.subject,
          operation: 'write',
          decision: 'ok',
          reasonCode: 'idempotent_replay',
          keyOrQueryDigest: keyDigest,
          correlationId,
          mandateId: replayed.mandateId
        });
        return {
          ok: true as const,
          memoryId: replayed._id,
          outcome: 'idempotent_replay' as const,
          correlationId
        };
      }
    }

    const existing = await getMemoryByKey(ctx.db, args.orgCode, args.key);
    const mandateId = null; // Mandate provenance arrives in a later phase.
    let memoryId;
    let outcome;
    if (existing === null) {
      memoryId = await insertMemory(
        ctx.db,
        {
          orgCode: args.orgCode,
          subject: args.subject,
          key: args.key,
          content: args.content,
          ...(args.metadata === undefined ? {} : {metadata: args.metadata}),
          mandateId,
          idempotencyKey: args.idempotencyKey ?? null
        },
        now
      );
      outcome = 'created' as const;
    } else {
      memoryId = await updateMemoryContent(
        ctx.db,
        existing,
        {
          content: args.content,
          ...(args.metadata === undefined ? {} : {metadata: args.metadata}),
          writtenBy: args.subject,
          mandateId,
          idempotencyKey: args.idempotencyKey ?? null
        },
        now
      );
      outcome = 'updated' as const;
    }

    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'write',
      decision: 'ok',
      reasonCode: outcome,
      keyOrQueryDigest: keyDigest,
      correlationId,
      mandateId
    });
    return {ok: true as const, memoryId, outcome, correlationId};
  }
});

/**
 * Governed read-by-key, constrained by the `by_org_key` index AT THE QUERY. A
 * key that exists in another tenant returns null exactly as if it did not
 * exist — no existence oracle across tenants — and the audit row records a
 * normal read under the CALLER's org with no cross-tenant information.
 * Exactly one audit row per call (hence a mutation; see the module doc).
 */
export const get = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    key: v.string(),
    correlationId: v.optional(v.string())
  },
  returns: getResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    requireNonEmpty(args.key, 'key');
    const correlationId = resolveCorrelationId(args.correlationId);
    const keyDigest = digestKey(args.key);

    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'get',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        keyDigest,
        correlationId
      );
    }

    const memory = await getMemoryByKey(ctx.db, args.orgCode, args.key);
    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'get',
      decision: 'ok',
      reasonCode: memory === null ? 'not_found' : 'found',
      keyOrQueryDigest: keyDigest,
      correlationId,
      mandateId: null
    });
    return {ok: true as const, memory, correlationId};
  }
});
