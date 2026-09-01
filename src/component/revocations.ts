/**
 * PUBLIC API of the revocation KILL SWITCH (P5): `revoke` and `liftRevocation`.
 * Thin wrappers over the governed revocation store (`lib/revocationStore.ts`) —
 * no direct `revocations` queries live here — following every established
 * pattern: tenant-conflict checked first, denials RETURN (the client throws),
 * exactly one audit row per call.
 *
 * AUTHORITY MODEL (same as grant administration, see `grants.ts`): these are
 * tenant-gated but NOT scope-gated — the Convex trust boundary (only the host
 * app can call component functions) is the authority, and the app gates who may
 * revoke. A `global` revocation is cross-tenant BY NATURE and is allowed from a
 * tenant-scoped call on exactly that app-trusted basis; `org`/`subject`
 * revocations are confined to the caller's own server-verified tenant (see
 * `normalizeRevocationTarget`). Revocation is deliberately NOT itself gated by
 * the overlay — an already-revoked admin must still be able to lift.
 *
 * RELATION TO P4 GRANT-LEVEL REVOCATION: revoking a single grant lives on the
 * grant row (`accessGrants.revokedAt`, via `grants.ts` `revokeGrant`) and keeps
 * a subject in enforced mode. THIS overlay is the broader kill switch —
 * global/org/subject targets that outrank grants entirely — and is a separate
 * table and separate lifecycle.
 */
import {mutation, query} from './_generated/server.js';
import {v} from 'convex/values';
import {deny, recordAudit} from './lib/audit.js';
import {resolveCorrelationId} from './lib/correlation.js';
import {digestRevocationTarget} from './lib/digest.js';
import {fail, requireNonEmpty} from './lib/errors.js';
import {
  findActiveRevocation,
  findRevocationsForTarget,
  insertRevocation,
  liftRevocationRow,
  normalizeRevocationTarget
} from './lib/revocationStore.js';
import {
  inspectRevocationsResultValidator,
  liftRevocationResultValidator,
  revocationTargetValidator,
  revokeResultValidator
} from './validators.js';

/**
 * Create a revocation at the target level. IDEMPOTENT (documented decision): an
 * already-active revocation of the exact same target is not re-inserted —
 * outcome `already_revoked`, no new row — mirroring `grant`'s `already_granted`
 * so a retry is safe and never stacks rows. A contradictory target (e.g. kind
 * 'org' without an orgCode, kind 'global' with a subject, or an org/subject
 * target outside the caller's tenant) denies typed `invalid_revocation_target`,
 * audited. `reason` is stored on the revocation row ONLY — it never reaches an
 * audit row or a denial message. Exactly one audit row per call (operation
 * 'revoke'): reason `revocation_created` or `already_revoked`.
 */
export const revoke = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    target: revocationTargetValidator,
    reason: v.string(),
    correlationId: v.optional(v.string())
  },
  returns: revokeResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    requireNonEmpty(args.reason, 'reason');
    const correlationId = resolveCorrelationId(args.correlationId);
    // Digest of the TARGET shape (kind + supplied org/subject) — never the
    // reason. Computed from the raw arg so it is stable across valid and
    // invalid targets alike, and correlates with a valid target's stored shape.
    const revocationDigest = await digestRevocationTarget(
      args.target.kind,
      args.target.orgCode ?? null,
      args.target.subject ?? null
    );

    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'revoke',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        revocationDigest,
        correlationId
      );
    }

    const {target, problem} = normalizeRevocationTarget(
      args.target,
      args.orgCode
    );
    if (target === null) {
      return await deny(
        ctx.db,
        'revoke',
        args,
        'invalid_revocation_target',
        problem ?? 'The revocation target is invalid.',
        revocationDigest,
        correlationId
      );
    }

    const existing = await findActiveRevocation(ctx.db, target);
    let revocationId;
    let outcome;
    if (existing !== null) {
      revocationId = existing._id;
      outcome = 'already_revoked' as const;
    } else {
      revocationId = await insertRevocation(
        ctx.db,
        {target, reason: args.reason, revokedBy: args.subject},
        Date.now()
      );
      outcome = 'revoked' as const;
    }

    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'revoke',
      decision: 'ok',
      reasonCode:
        outcome === 'revoked' ? 'revocation_created' : 'already_revoked',
      keyOrQueryDigest: revocationDigest,
      correlationId,
      mandateId: null
    });
    return {ok: true as const, revocationId, outcome, correlationId};
  }
});

/**
 * Lift an active revocation (stamps `liftedBy`/`liftedAt`; the row is KEPT as
 * history — a later re-revoke inserts a fresh row, re-arming the overlay).
 * Lifting a target with no active revocation is contradictory input and denies
 * typed `revocation_not_found`, never a silent no-op — the same shape as
 * `revokeGrant`'s `grant_not_found`. A contradictory target denies
 * `invalid_revocation_target`. Exactly one audit row per call (operation
 * 'lift_revocation', reason `revocation_lifted`).
 */
export const liftRevocation = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    target: revocationTargetValidator,
    correlationId: v.optional(v.string())
  },
  returns: liftRevocationResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    const correlationId = resolveCorrelationId(args.correlationId);
    const revocationDigest = await digestRevocationTarget(
      args.target.kind,
      args.target.orgCode ?? null,
      args.target.subject ?? null
    );

    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'lift_revocation',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        revocationDigest,
        correlationId
      );
    }

    const {target, problem} = normalizeRevocationTarget(
      args.target,
      args.orgCode
    );
    if (target === null) {
      return await deny(
        ctx.db,
        'lift_revocation',
        args,
        'invalid_revocation_target',
        problem ?? 'The revocation target is invalid.',
        revocationDigest,
        correlationId
      );
    }

    const active = await findActiveRevocation(ctx.db, target);
    if (active === null) {
      return await deny(
        ctx.db,
        'lift_revocation',
        args,
        'revocation_not_found',
        'No active revocation matches that target in this tenant.',
        revocationDigest,
        correlationId
      );
    }

    await liftRevocationRow(ctx.db, active, args.subject, Date.now());
    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'lift_revocation',
      decision: 'ok',
      reasonCode: 'revocation_lifted',
      keyOrQueryDigest: revocationDigest,
      correlationId,
      mandateId: null
    });
    return {ok: true as const, revocationId: active._id, correlationId};
  }
});

/**
 * THE REASON-JOIN SURFACE (read-only QUERY, same query-vs-mutation exception as
 * `audit.query`/`provenance.of`: inspecting revocations writes no audit row).
 *
 * Given a target, return its active and historical revocation rows — INCLUDING
 * the `reason` and actor stamps — newest first, plus the target's digest. This
 * is how "why was this call denied `revoked`?" is answered WITHOUT the reason
 * ever entering the append-only audit log: the `revoked` denial row carries the
 * target DIGEST (see `revocationDenial`); an auditor matches that digest to
 * `targetDigest` here and reads the reason from the returned rows.
 *
 * TENANT SCOPING: `org`/`subject` targets are confined to the caller's
 * server-verified tenant by `normalizeRevocationTarget` (a mismatch throws
 * typed `invalid_revocation_target`). A `global` target is intentionally
 * tenant-agnostic and readable from any tenant-scoped call — DOCUMENTED CHOICE:
 * a global revocation governs every tenant, so a tenant it governs may read its
 * existence and reason (the reason explains a denial that affects that tenant).
 * Argument errors THROW (this is a query and cannot audit).
 */
export const inspect = query({
  args: {
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    target: revocationTargetValidator
  },
  returns: inspectRevocationsResultValidator,
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
    const {target, problem} = normalizeRevocationTarget(
      args.target,
      args.orgCode
    );
    if (target === null) {
      fail(
        'invalid_revocation_target',
        problem ?? 'Invalid revocation target.'
      );
    }
    const targetDigest = await digestRevocationTarget(
      target.kind,
      target.orgCode,
      target.subject
    );
    const revocations = await findRevocationsForTarget(ctx.db, target);
    return {targetDigest, revocations};
  }
});
