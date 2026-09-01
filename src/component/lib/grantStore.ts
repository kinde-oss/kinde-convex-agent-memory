/**
 * THE GOVERNED GRANT STORE. Every read and write of the `accessGrants` table
 * lives in THIS MODULE and no other (grep-enforced by `structure.test.ts`,
 * the same mechanic that pins `memories` to `access.ts`). Every function
 * takes the server-verified tenant context and applies it as the leading
 * `.eq('orgCode', …)` of the `by_org_subject` index range — grants can
 * neither be read nor matched across tenants.
 *
 * THE MODE BOUNDARY (see also the schema doc): a (orgCode, subject) with no
 * grant rows is PERMISSIVE — exactly the P1–P3 standalone behavior. ANY row
 * for the pair — revoked included — makes the subject ENFORCED: each
 * operation needs an unrevoked grant of its scope. Revoked rows keep the
 * subject enforced deliberately: revoking the last grant locks the subject
 * out rather than silently restoring permissive mode.
 */
import type {MutationCtx, QueryCtx} from '../_generated/server.js';
import type {Doc, Id} from '../_generated/dataModel.js';
import type {GrantScope} from '../validators.js';

type Db = QueryCtx['db'];
type WriteDb = MutationCtx['db'];

/** Every grant row — active AND revoked — for a subject WITHIN the tenant. */
export async function getGrantsForSubject(
  db: Db,
  orgCode: string,
  subject: string
): Promise<Doc<'accessGrants'>[]> {
  return await db
    .query('accessGrants')
    .withIndex('by_org_subject', (q) =>
      q.eq('orgCode', orgCode).eq('subject', subject)
    )
    .collect();
}

/**
 * The scope check every governed memory operation runs (after the
 * tenant-conflict check, before any memories access): true when the subject
 * is PERMISSIVE (no grant rows at all) or holds an unrevoked grant of the
 * required scope; false is a `scope_not_granted` denial.
 */
export async function isOperationPermitted(
  db: Db,
  orgCode: string,
  subject: string,
  scope: GrantScope
): Promise<boolean> {
  const grants = await getGrantsForSubject(db, orgCode, subject);
  if (grants.length === 0) {
    return true;
  }
  return grants.some(
    (grant) => grant.scope === scope && grant.revokedAt === null
  );
}

/** The subject's ACTIVE (unrevoked) grant of a scope, or null. */
export async function findActiveGrant(
  db: Db,
  orgCode: string,
  subject: string,
  scope: GrantScope
): Promise<Doc<'accessGrants'> | null> {
  const grants = await getGrantsForSubject(db, orgCode, subject);
  return (
    grants.find((grant) => grant.scope === scope && grant.revokedAt === null) ??
    null
  );
}

export interface InsertGrantInput {
  orgCode: string;
  subject: string;
  scope: GrantScope;
  grantedBy: string;
}

/** Create an active grant stamped with the tenant's orgCode. */
export async function insertGrant(
  db: WriteDb,
  input: InsertGrantInput,
  now: number
): Promise<Id<'accessGrants'>> {
  return await db.insert('accessGrants', {
    orgCode: input.orgCode,
    subject: input.subject,
    scope: input.scope,
    grantedBy: input.grantedBy,
    grantedAt: now,
    revokedAt: null
  });
}

/**
 * Revoke one grant by stamping `revokedAt`. The row is KEPT (never deleted):
 * it is the enforcement switch (see the mode boundary above) and the
 * revocation's own provenance. The caller obtained `grant` through this
 * module, so the tenant constraint has already been applied.
 */
export async function revokeGrantRow(
  db: WriteDb,
  grant: Doc<'accessGrants'>,
  now: number
): Promise<void> {
  await db.patch('accessGrants', grant._id, {revokedAt: now});
}
