/**
 * PUBLIC API of redaction administration: `setRedaction`. Thin wrapper over
 * the governed policy store (`lib/redaction.ts`) — no direct
 * `redactionPolicies` queries live here. Tenant-gated but not scope-gated,
 * like the grant administration (see `grants.ts`'s authority-model note).
 */
import {mutation} from './_generated/server.js';
import {v} from 'convex/values';
import {deny, recordAudit} from './lib/audit.js';
import {resolveCorrelationId} from './lib/correlation.js';
import {digestRedaction} from './lib/digest.js';
import {requireNonEmpty} from './lib/errors.js';
import {findPolicy, removePolicy, upsertPolicy} from './lib/redaction.js';
import {setRedactionResultValidator} from './validators.js';

/**
 * Validate the closed `fields` shape: entries are metadata field names
 * (non-empty strings) and/or the literal 'content'; duplicates are
 * contradictory-free but redundant and are rejected too — a policy is a
 * deliberate artifact and a duplicated entry signals a caller bug. Returns
 * the human-readable problem, or null.
 */
function fieldsProblem(fields: string[]): string | null {
  for (const field of fields) {
    if (field === '') {
      return "Every redaction field must be a non-empty string ('content' or a metadata field name).";
    }
  }
  if (new Set(fields).size !== fields.length) {
    return 'Redaction fields must not contain duplicates.';
  }
  return null;
}

/**
 * Create or REPLACE the tenant's redaction policy — org-wide when
 * `targetSubject` is omitted, targeted at one subject otherwise (a targeted
 * policy WINS OUTRIGHT over the org-wide one on read; see
 * `lib/redaction.ts`). DOCUMENTED CHOICE: an EMPTY `fields` array REMOVES
 * the policy for that target (outcome `cleared`) — it is the natural
 * "redact nothing" intent; clearing a policy that does not exist is
 * contradictory input and denies typed `policy_not_found`, never a silent
 * no-op. Policies shape the egress copy only; stored memory rows are never
 * altered. Exactly one audit row per call (operation 'set_redaction'), and
 * the audit carries only a digest — raw field names never reach it.
 */
export const setRedaction = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    targetSubject: v.optional(v.string()),
    fields: v.array(v.string()),
    correlationId: v.optional(v.string())
  },
  returns: setRedactionResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    if (args.targetSubject !== undefined) {
      requireNonEmpty(args.targetSubject, 'targetSubject');
    }
    const correlationId = resolveCorrelationId(args.correlationId);
    const target = args.targetSubject ?? null;
    const redactionDigest = digestRedaction(target, args.fields);

    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'set_redaction',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        redactionDigest,
        correlationId
      );
    }

    const problem = fieldsProblem(args.fields);
    if (problem !== null) {
      return await deny(
        ctx.db,
        'set_redaction',
        args,
        'invalid_redaction_fields',
        problem,
        redactionDigest,
        correlationId
      );
    }

    let outcome;
    if (args.fields.length === 0) {
      const existing = await findPolicy(ctx.db, args.orgCode, target);
      if (existing === null) {
        return await deny(
          ctx.db,
          'set_redaction',
          args,
          'policy_not_found',
          'No redaction policy exists for that target in this tenant, so there is nothing to clear.',
          redactionDigest,
          correlationId
        );
      }
      await removePolicy(ctx.db, existing);
      outcome = 'cleared' as const;
    } else {
      await upsertPolicy(
        ctx.db,
        {
          orgCode: args.orgCode,
          targetSubject: target,
          fields: args.fields,
          createdBy: args.subject
        },
        Date.now()
      );
      outcome = 'set' as const;
    }

    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'set_redaction',
      decision: 'ok',
      reasonCode: outcome === 'set' ? 'redaction_set' : 'redaction_cleared',
      keyOrQueryDigest: redactionDigest,
      correlationId,
      mandateId: null
    });
    return {ok: true as const, outcome, correlationId};
  }
});
