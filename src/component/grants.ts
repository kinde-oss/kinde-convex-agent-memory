/**
 * PUBLIC API of access administration: `grant` and `revokeGrant`. Thin
 * wrappers over the governed grant store (`lib/grantStore.ts`) — no direct
 * `accessGrants` queries live here — following every established pattern:
 * tenant-conflict checked first, denials RETURN (the client throws), exactly
 * one audit row per call.
 *
 * AUTHORITY MODEL (P4's documented decision): these management operations
 * are tenant-gated but NOT scope-gated — any subject the trusted host app
 * lets call them can administer grants within its own tenant. The Convex
 * trust boundary (only the app can call component functions) is the
 * authority; a dedicated admin scope is a later-phase decision. `grantedBy`
 * records provenance, not authority.
 */
import {mutation} from './_generated/server.js';
import {v} from 'convex/values';
import {deny, recordAudit} from './lib/audit.js';
import {resolveCorrelationId} from './lib/correlation.js';
import {digestGrant} from './lib/digest.js';
import {requireNonEmpty} from './lib/errors.js';
import {
  findActiveGrant,
  insertGrant,
  revokeGrantRow
} from './lib/grantStore.js';
import {
  grantResultValidator,
  grantScopeValidator,
  revokeGrantResultValidator
} from './validators.js';

/**
 * Grant a scope to `targetSubject` in the tenant. GRANTING IS THE
 * ENFORCEMENT SWITCH: the target's FIRST grant row flips it from permissive
 * to enforced mode (see the mode boundary in `lib/grantStore.ts`) — from
 * then on it holds exactly the scopes granted. Granting an already-active
 * scope is idempotent: no new row, outcome `already_granted`. Granting a
 * previously revoked scope inserts a fresh row (outcome `granted`) — the
 * revoked row is kept as provenance. Exactly one audit row per call
 * (operation 'grant').
 */
export const grant = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    targetSubject: v.string(),
    scope: grantScopeValidator,
    correlationId: v.optional(v.string())
  },
  returns: grantResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    requireNonEmpty(args.targetSubject, 'targetSubject');
    const correlationId = resolveCorrelationId(args.correlationId);
    const grantDigest = digestGrant(args.scope, args.targetSubject);

    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'grant',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        grantDigest,
        correlationId
      );
    }

    const existing = await findActiveGrant(
      ctx.db,
      args.orgCode,
      args.targetSubject,
      args.scope
    );
    let grantId;
    let outcome;
    if (existing !== null) {
      grantId = existing._id;
      outcome = 'already_granted' as const;
    } else {
      grantId = await insertGrant(
        ctx.db,
        {
          orgCode: args.orgCode,
          subject: args.targetSubject,
          scope: args.scope,
          grantedBy: args.subject
        },
        Date.now()
      );
      outcome = 'granted' as const;
    }

    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'grant',
      decision: 'ok',
      reasonCode: outcome,
      keyOrQueryDigest: grantDigest,
      correlationId,
      mandateId: null
    });
    return {ok: true as const, grantId, outcome, correlationId};
  }
});

/**
 * Revoke `targetSubject`'s active grant of a scope (stamps `revokedAt`; the
 * row is kept — it holds the subject in enforced mode and records the
 * revocation). Revoking a grant that does not exist (or is already revoked)
 * is contradictory input and denies typed `grant_not_found` — never a silent
 * no-op. Exactly one audit row per call (operation 'revoke_grant').
 */
export const revokeGrant = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    targetSubject: v.string(),
    scope: grantScopeValidator,
    correlationId: v.optional(v.string())
  },
  returns: revokeGrantResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    requireNonEmpty(args.targetSubject, 'targetSubject');
    const correlationId = resolveCorrelationId(args.correlationId);
    const grantDigest = digestGrant(args.scope, args.targetSubject);

    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'revoke_grant',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        grantDigest,
        correlationId
      );
    }

    const active = await findActiveGrant(
      ctx.db,
      args.orgCode,
      args.targetSubject,
      args.scope
    );
    if (active === null) {
      return await deny(
        ctx.db,
        'revoke_grant',
        args,
        'grant_not_found',
        'No active grant of that scope exists for the target subject in this tenant.',
        grantDigest,
        correlationId
      );
    }

    await revokeGrantRow(ctx.db, active, Date.now());
    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'revoke_grant',
      decision: 'ok',
      reasonCode: 'revoked',
      keyOrQueryDigest: grantDigest,
      correlationId,
      mandateId: null
    });
    return {ok: true as const, grantId: active._id, correlationId};
  }
});
