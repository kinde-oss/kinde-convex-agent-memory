/**
 * THE GOVERNED REVOCATION STORE. Every read and write of the `revocations`
 * table lives in THIS MODULE and no other (grep-enforced by
 * `structure.test.ts`, the same mechanic that pins the other tables).
 *
 * This is the KILL-SWITCH OVERLAY: `resolveRevocation` is called by every
 * governed memory operation after the tenant-conflict check and BEFORE the
 * scope gate, and its verdict OUTRANKS grants — grant administration is
 * app-trusted (P4), so revocation must be the layer grants cannot override.
 * A revoked caller with valid unrevoked grants is still denied; granting
 * more scopes while revoked changes nothing; only `liftRevocation` restores
 * access (the grants then govern exactly as before).
 *
 * REACTIVITY, honestly: reads here are mutations, so there is no
 * subscription to invalidate — "reactive" means every governed call
 * re-evaluates this overlay at its own transaction time. The call after a
 * revocation commits is denied; the call after a lift commits succeeds.
 */
import {deny} from './audit.js';
import type {MutationCtx, QueryCtx} from '../_generated/server.js';
import type {Doc, Id} from '../_generated/dataModel.js';
import type {
  DeniedResult,
  MemoryOperation,
  RevocationLevel,
  RevocationTargetArg
} from '../validators.js';

type Db = QueryCtx['db'];
type WriteDb = MutationCtx['db'];

/** A normalized (contradiction-free) revocation target, the store's shape. */
export interface RevocationTarget {
  kind: RevocationLevel;
  /** Null for kind 'global'. */
  orgCode: string | null;
  /** Null for kinds 'global' and 'org'. */
  subject: string | null;
}

/**
 * Result of validating a caller-supplied {@link RevocationTargetArg}: either
 * the normalized store-shape target, or a human-readable problem describing the
 * contradiction. Exactly one side is non-null.
 */
export interface TargetResolution {
  target: RevocationTarget | null;
  problem: string | null;
}

/**
 * Validate a caller-supplied target STRICTLY and normalize it to the store
 * shape, or explain the contradiction. The validator layer keeps the target
 * loose (optional orgCode/subject) precisely so a bad combination reaches here
 * and becomes a typed, AUDITED `invalid_revocation_target` rather than dying
 * unaudited at the arg validator.
 *
 * TENANT SCOPING (documented decision): a `global` revocation is cross-tenant
 * BY NATURE and app-trusted — the host app gates who may call `revoke`, exactly
 * as with grant administration — so it carries neither orgCode nor subject.
 * `org` and `subject` revocations are tenant-scoped: their `orgCode` must equal
 * the caller's SERVER-VERIFIED `orgCode`, so a tenant-scoped call can never
 * revoke another tenant's org or subject (mismatch is rejected, never silently
 * coerced — the same principle as the tenant-conflict check).
 */
export function normalizeRevocationTarget(
  arg: RevocationTargetArg,
  callerOrgCode: string
): TargetResolution {
  const {kind, orgCode, subject} = arg;
  if (kind === 'global') {
    if (orgCode !== undefined || subject !== undefined) {
      return {
        target: null,
        problem:
          "A 'global' revocation targets every tenant and must carry neither an orgCode nor a subject."
      };
    }
    return {
      target: {kind: 'global', orgCode: null, subject: null},
      problem: null
    };
  }
  if (kind === 'org') {
    if (orgCode === undefined || orgCode === '') {
      return {
        target: null,
        problem: "An 'org' revocation requires a non-empty orgCode."
      };
    }
    if (subject !== undefined) {
      return {
        target: null,
        problem:
          "An 'org' revocation targets a whole tenant and must not carry a subject."
      };
    }
    if (orgCode !== callerOrgCode) {
      return {
        target: null,
        problem:
          "An 'org' revocation may only target the caller's own server-verified tenant."
      };
    }
    return {target: {kind: 'org', orgCode, subject: null}, problem: null};
  }
  // kind === 'subject'
  if (
    orgCode === undefined ||
    orgCode === '' ||
    subject === undefined ||
    subject === ''
  ) {
    return {
      target: null,
      problem:
        "A 'subject' revocation requires both a non-empty orgCode and a non-empty subject."
    };
  }
  if (orgCode !== callerOrgCode) {
    return {
      target: null,
      problem:
        "A 'subject' revocation may only target the caller's own server-verified tenant."
    };
  }
  return {target: {kind: 'subject', orgCode, subject}, problem: null};
}

/**
 * The ACTIVE (unlifted) revocation row for one exact target, or null. Each
 * level is an exact-equality lookup on `by_kind_org_subject` (nulls are
 * indexed values in Convex, so the three shapes are three point lookups).
 * Lifted rows are kept as history and filtered here.
 */
export async function findActiveRevocation(
  db: Db,
  target: RevocationTarget
): Promise<Doc<'revocations'> | null> {
  const rows = await db
    .query('revocations')
    .withIndex('by_kind_org_subject', (q) =>
      q
        .eq('kind', target.kind)
        .eq('orgCode', target.orgCode)
        .eq('subject', target.subject)
    )
    .collect();
  return rows.find((row) => row.liftedAt === null) ?? null;
}

/**
 * THE OVERLAY CHECK: is this caller under an active revocation, and at what
 * level? Resolution precedence is global → org → subject — the BROADEST
 * matching level is reported, even when narrower levels are clean. Returns
 * null for an unrevoked caller. (Grant-level revocation is not consulted
 * here; it lives in the grant store and is enforced by the scope gate.)
 */
export async function resolveRevocation(
  db: Db,
  orgCode: string,
  subject: string
): Promise<RevocationLevel | null> {
  const globalRow = await findActiveRevocation(db, {
    kind: 'global',
    orgCode: null,
    subject: null
  });
  if (globalRow !== null) {
    return 'global';
  }
  const orgRow = await findActiveRevocation(db, {
    kind: 'org',
    orgCode,
    subject: null
  });
  if (orgRow !== null) {
    return 'org';
  }
  const subjectRow = await findActiveRevocation(db, {
    kind: 'subject',
    orgCode,
    subject
  });
  return subjectRow === null ? null : 'subject';
}

/**
 * The denial message for a matched revocation. It NAMES THE LEVEL so the caller
 * (and the audit correlate) can see how broadly the kill switch fired, but it
 * NEVER carries the stored `reason` — the reason may be sensitive and lives on
 * the revocation row alone; auditors join to it through this store by digest.
 */
export function revocationMessage(level: RevocationLevel): string {
  switch (level) {
    case 'global':
      return 'Access is denied by an active global revocation.';
    case 'org':
      return 'Access is denied by an active org-level revocation in this tenant.';
    case 'subject':
      return 'Access is denied by an active subject-level revocation for this subject in this tenant.';
  }
}

/**
 * THE OVERLAY DENIAL, called by every governed memory operation AFTER the
 * tenant-conflict check and BEFORE the scope gate. Resolves global → org →
 * subject; if any level is active, audits and returns the typed `revoked`
 * denial (one row, via the shared {@link deny} helper — the audit insert still
 * lives in `lib/audit.ts`, so the table pin holds); otherwise returns null and
 * the operation proceeds to the scope gate. This OUTRANKS grants: a revoked
 * caller is denied here no matter what scopes it holds, and no fresh grant can
 * reach the scope gate past this check — only lifting the revocation does.
 */
export async function revocationDenial(
  db: WriteDb,
  operation: MemoryOperation,
  args: {orgCode: string; subject: string},
  keyOrQueryDigest: string,
  correlationId: string
): Promise<DeniedResult | null> {
  const level = await resolveRevocation(db, args.orgCode, args.subject);
  if (level === null) {
    return null;
  }
  return await deny(
    db,
    operation,
    args,
    'revoked',
    revocationMessage(level),
    keyOrQueryDigest,
    correlationId
  );
}

export interface InsertRevocationInput {
  target: RevocationTarget;
  reason: string;
  revokedBy: string;
}

/** Create an active revocation. `reason` is stored here and NOWHERE else. */
export async function insertRevocation(
  db: WriteDb,
  input: InsertRevocationInput,
  now: number
): Promise<Id<'revocations'>> {
  return await db.insert('revocations', {
    kind: input.target.kind,
    orgCode: input.target.orgCode,
    subject: input.target.subject,
    reason: input.reason,
    revokedBy: input.revokedBy,
    revokedAt: now,
    liftedBy: null,
    liftedAt: null
  });
}

/**
 * Lift one revocation by stamping `liftedBy`/`liftedAt`. The row is KEPT as
 * history; a later re-revocation inserts a fresh row. The caller obtained
 * `revocation` through this module.
 */
export async function liftRevocationRow(
  db: WriteDb,
  revocation: Doc<'revocations'>,
  liftedBy: string,
  now: number
): Promise<void> {
  await db.patch('revocations', revocation._id, {liftedBy, liftedAt: now});
}
