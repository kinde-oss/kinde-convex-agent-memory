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

/**
 * Resolve the redaction that applies to one (tenant, subject) read, with TWO
 * targeted point queries on `by_org_target` rather than scanning the tenant's
 * policies. PRECEDENCE (documented decision): a policy targeting the subject
 * WINS OUTRIGHT over the org-wide policy — no merging; the more specific intent
 * replaces the general one entirely, so the subject lookup runs first and short
 * circuits. Returns the fields to redact, or null when no policy applies (egress
 * is then a plain copy).
 */
export async function resolveRedaction(
  db: Db,
  orgCode: string,
  subject: string
): Promise<string[] | null> {
  const subjectPolicy = await findPolicy(db, orgCode, subject);
  if (subjectPolicy !== null) {
    return subjectPolicy.fields;
  }
  const orgPolicy = await findPolicy(db, orgCode, null);
  return orgPolicy === null ? null : orgPolicy.fields;
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

/**
 * The identity fields of a PROVENANCE result — the strings that name a record
 * and its owner, as opposed to its ids and timestamps.
 */
export interface ProvenanceIdentity {
  key: string;
  subject: string;
  createdBy: string;
  writtenBy: string;
}

/**
 * Redact a PROVENANCE result's identity fields through THE SAME policy egress
 * uses. The provenance surface structurally carries no content or metadata (it
 * cannot leak a memory body), but its `key` may encode a sensitive path, and
 * its subject identity is exactly what the audit trail keeps only as a keyed
 * digest, never raw. So provenance runs through this seam: when ANY redaction
 * policy applies to the record's (org, subject) — resolved by the very
 * `resolveRedaction` egress calls — the identity strings are replaced with the
 * fixed {@link CONTENT_REDACTED} sentinel; when no policy applies (`redacted`
 * is null), they pass through unchanged. Ids and timestamps stay raw (the
 * caller keeps a durable handle and ordering). `createdBy`/`writtenBy` are
 * redacted ALONGSIDE `subject`: after cross-subject writes are denied they
 * equal the owning subject, so redacting `subject` while returning them raw
 * would be a hollow control.
 */
export function redactProvenanceIdentity<T extends ProvenanceIdentity>(
  record: T,
  redacted: string[] | null
): T {
  if (redacted === null || redacted.length === 0) {
    return record;
  }
  return {
    ...record,
    key: CONTENT_REDACTED,
    subject: CONTENT_REDACTED,
    createdBy: CONTENT_REDACTED,
    writtenBy: CONTENT_REDACTED
  };
}

/**
 * The tenant's policy for one target (null = the org-wide policy), if any. A
 * single point query on `by_org_target`; at most one row exists per
 * (orgCode, targetSubject) — `upsertPolicy` maintains that — so `.unique()` is
 * exact.
 */
export async function findPolicy(
  db: Db,
  orgCode: string,
  targetSubject: string | null
): Promise<Doc<'redactionPolicies'> | null> {
  return await db
    .query('redactionPolicies')
    .withIndex('by_org_target', (q) =>
      q.eq('orgCode', orgCode).eq('targetSubject', targetSubject)
    )
    .unique();
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
