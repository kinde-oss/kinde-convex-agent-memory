/**
 * REDACTION-ON-READ: the policy store and THE ONE EGRESS FUNCTION.
 *
 * Every read and write of the `redactionPolicies` table lives in THIS MODULE
 * and no other (grep-enforced by `structure.test.ts`). More importantly,
 * this module is the single place memory records are SHAPED FOR RETURN:
 *
 * THE NON-BYPASSABILITY GUARANTEE (structural, two layers):
 * 1. COMPILE TIME — `EgressedMemoryRecord` is a BRANDED type whose brand is
 *    a module-private `unique symbol`: the only expression in the codebase
 *    that can produce it is the `as EgressedMemoryRecord` assertion inside
 *    `egressMemory` below. Every doc-returning read path (`get`, `list`,
 *    recall's `finalizeRecall`) explicitly annotates its handler to return
 *    the Egressed* result types, so returning a raw `Doc<'memories'>` — or
 *    anything that did not pass through `egressMemory` — is a TYPE ERROR,
 *    not a code-review hope.
 * 2. GREP — `structure.test.ts` pins the brand mint (`as
 *    EgressedMemoryRecord` appears in this module only) and pins the three
 *    egressed return-type annotations into `memory.ts`, so neither side of
 *    the compile-time guarantee can be quietly deleted.
 *
 * Redaction NEVER alters stored data — it shapes the egress COPY only.
 * Redacted metadata fields are OMITTED from the returned record; redacted
 * content is replaced by the fixed sentinel {@link CONTENT_REDACTED} (the
 * returned `content` is therefore ALWAYS a string, exactly as the record
 * validator promises).
 */
import type {MutationCtx, QueryCtx} from '../_generated/server.js';
import type {Doc, Id} from '../_generated/dataModel.js';
import type {DeniedResult, MemoryRecord} from '../validators.js';

type Db = QueryCtx['db'];
type WriteDb = MutationCtx['db'];

/**
 * The fixed sentinel a redacted `content` egresses as. A constant, not a
 * per-policy string: callers can rely on one honest, recognizable marker,
 * and no policy can impersonate real content.
 */
export const CONTENT_REDACTED = '[redacted]';

/**
 * The literal `fields` entry that redacts a record's content (every other
 * entry names a metadata field to omit).
 */
export const REDACT_CONTENT_FIELD = 'content';

declare const EGRESSED: unique symbol;

/**
 * A memory record that has passed through {@link egressMemory}. The brand is
 * a module-private unique symbol — no other module can mint this type, which
 * is what makes the egress structurally non-bypassable (see the module doc).
 */
export type EgressedMemoryRecord = MemoryRecord & {
  readonly [EGRESSED]: true;
};

/** `get`'s result with the egress brand enforced on the returned record. */
export type EgressedGetResult =
  | {ok: true; memory: EgressedMemoryRecord | null; correlationId: string}
  | DeniedResult;

/** `list`'s result with the egress brand enforced on every page row. */
export type EgressedListResult =
  | {
      ok: true;
      page: EgressedMemoryRecord[];
      isDone: boolean;
      continueCursor: string;
      correlationId: string;
    }
  | DeniedResult;

/** `finalizeRecall`'s matches with the egress brand enforced on each. */
export type EgressedRecallMatches = Array<{
  memory: EgressedMemoryRecord;
  score: number;
}>;

/** Every redaction policy of the tenant (org-wide and subject-targeted). */
export async function getPoliciesForOrg(
  db: Db,
  orgCode: string
): Promise<Doc<'redactionPolicies'>[]> {
  return await db
    .query('redactionPolicies')
    .withIndex('by_org', (q) => q.eq('orgCode', orgCode))
    .collect();
}

/**
 * Resolve the redaction that applies to one (tenant, subject) read.
 * PRECEDENCE (documented decision): a policy targeting the subject WINS
 * OUTRIGHT over the org-wide policy — no merging; the more specific intent
 * replaces the general one entirely. Returns the fields to redact, or null
 * when no policy applies (egress is then a plain copy).
 */
export async function resolveRedaction(
  db: Db,
  orgCode: string,
  subject: string
): Promise<string[] | null> {
  const policies = await getPoliciesForOrg(db, orgCode);
  const subjectPolicy = policies.find(
    (policy) => policy.targetSubject === subject
  );
  if (subjectPolicy !== undefined) {
    return subjectPolicy.fields;
  }
  const orgPolicy = policies.find((policy) => policy.targetSubject === null);
  return orgPolicy === undefined ? null : orgPolicy.fields;
}

/**
 * THE EGRESS FUNCTION — the only mint of {@link EgressedMemoryRecord}.
 * Applies the resolved redaction to a COPY of the stored doc: redacted
 * metadata fields are omitted, redacted content becomes the sentinel. The
 * stored row is never touched.
 */
export function egressMemory(
  doc: Doc<'memories'>,
  redactedFields: string[] | null
): EgressedMemoryRecord {
  if (redactedFields === null || redactedFields.length === 0) {
    return {...doc} as EgressedMemoryRecord;
  }
  const redactContent = redactedFields.includes(REDACT_CONTENT_FIELD);
  let metadata = doc.metadata;
  if (metadata !== undefined) {
    const cleaned = {...metadata};
    for (const field of redactedFields) {
      if (field !== REDACT_CONTENT_FIELD) {
        delete cleaned[field];
      }
    }
    metadata = cleaned;
  }
  return {
    ...doc,
    ...(metadata === undefined ? {} : {metadata}),
    content: redactContent ? CONTENT_REDACTED : doc.content
  } as EgressedMemoryRecord;
}

/** {@link egressMemory} over a page of docs, preserving order. */
export function egressMemories(
  docs: Doc<'memories'>[],
  redactedFields: string[] | null
): EgressedMemoryRecord[] {
  return docs.map((doc) => egressMemory(doc, redactedFields));
}

/** The tenant's policy for one target (null = the org-wide policy), if any. */
export async function findPolicy(
  db: Db,
  orgCode: string,
  targetSubject: string | null
): Promise<Doc<'redactionPolicies'> | null> {
  const policies = await getPoliciesForOrg(db, orgCode);
  return (
    policies.find((policy) => policy.targetSubject === targetSubject) ?? null
  );
}

export interface UpsertPolicyInput {
  orgCode: string;
  targetSubject: string | null;
  fields: string[];
  createdBy: string;
}

/**
 * Create or REPLACE the (orgCode, targetSubject) policy — at most one exists
 * per target. Replacement re-stamps `createdBy`/`createdAt`: a policy is a
 * single latest-intent record, not a provenance chain.
 */
export async function upsertPolicy(
  db: WriteDb,
  input: UpsertPolicyInput,
  now: number
): Promise<Id<'redactionPolicies'>> {
  const existing = await findPolicy(db, input.orgCode, input.targetSubject);
  if (existing !== null) {
    await db.patch('redactionPolicies', existing._id, {
      fields: input.fields,
      createdBy: input.createdBy,
      createdAt: now
    });
    return existing._id;
  }
  return await db.insert('redactionPolicies', {
    orgCode: input.orgCode,
    targetSubject: input.targetSubject,
    fields: input.fields,
    createdBy: input.createdBy,
    createdAt: now
  });
}

/**
 * Remove one policy row. The caller obtained `policy` through this module,
 * so the tenant constraint has already been applied.
 */
export async function removePolicy(
  db: WriteDb,
  policy: Doc<'redactionPolicies'>
): Promise<void> {
  await db.delete('redactionPolicies', policy._id);
}
