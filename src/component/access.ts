/**
 * THE GOVERNED ACCESS PATH.
 *
 * CONTRACT — every read and write of the `memories` table, in this phase and
 * every later one (query, recall, redaction, revocation), flows through THIS
 * MODULE and no other. Grep-verifiable: `db.query('memories')` and
 * `db.insert('memories')` appear in this file only (enforced by
 * `structure.test.ts`; production modules only — tests inspect table state
 * directly by design, and `schema.ts` merely defines the table).
 *
 * Every function here takes the SERVER-VERIFIED tenant context (`orgCode`)
 * and applies it AT THE QUERY, as the leading `.eq('orgCode', …)` of a
 * `by_org_*` index range — never as a `.filter()` or a post-fetch check
 * someone could forget. A row whose orgCode differs from the caller's tenant
 * context is therefore outside the index range and can never be returned,
 * regardless of what later phases build on top.
 *
 * Public functions (`memory.ts`) are thin wrappers over this path: they
 * resolve tenant context, correlation, and audit, and contain NO direct
 * `memories` queries of their own.
 */
import type {MutationCtx, QueryCtx} from './_generated/server.js';
import type {Doc, Id} from './_generated/dataModel.js';
import type {MemoryMetadata} from './validators.js';

type Db = QueryCtx['db'];
type WriteDb = MutationCtx['db'];

/**
 * Read one memory by key WITHIN the tenant. A key held by another tenant is
 * outside the `by_org_key` index range and resolves to null exactly as if it
 * did not exist. `.unique()` is safe: the write path maintains at most one
 * record per (orgCode, key).
 */
export async function getMemoryByKey(
  db: Db,
  orgCode: string,
  key: string
): Promise<Doc<'memories'> | null> {
  return await db
    .query('memories')
    .withIndex('by_org_key', (q) => q.eq('orgCode', orgCode).eq('key', key))
    .unique();
}

/**
 * Idempotency lookup, scoped WITHIN the tenant via `by_org_idempotency` — the
 * same idempotencyKey in two tenants resolves independently, so keys can
 * neither collide nor leak across the boundary.
 */
export async function getMemoryByIdempotencyKey(
  db: Db,
  orgCode: string,
  idempotencyKey: string
): Promise<Doc<'memories'> | null> {
  return await db
    .query('memories')
    .withIndex('by_org_idempotency', (q) =>
      q.eq('orgCode', orgCode).eq('idempotencyKey', idempotencyKey)
    )
    .unique();
}

export interface InsertMemoryInput {
  orgCode: string;
  subject: string;
  key: string;
  content: string;
  metadata?: MemoryMetadata;
  mandateId: string | null;
  idempotencyKey: string | null;
}

/**
 * Create a memory stamped with the tenant's orgCode and BOTH provenance
 * stamps: the immutable creation event (`createdBy`/`createdAt`) and the
 * initial write event (`writtenBy`/`writtenAt`), which start out identical.
 */
export async function insertMemory(
  db: WriteDb,
  input: InsertMemoryInput,
  now: number
): Promise<Id<'memories'>> {
  return await db.insert('memories', {
    orgCode: input.orgCode,
    subject: input.subject,
    key: input.key,
    content: input.content,
    ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
    createdBy: input.subject,
    createdAt: now,
    writtenBy: input.subject,
    writtenAt: now,
    mandateId: input.mandateId,
    idempotencyKey: input.idempotencyKey
  });
}

export interface UpdateMemoryInput {
  content: string;
  /** Omitted → the stored metadata is left unchanged (pass `{}` to clear). */
  metadata?: MemoryMetadata;
  writtenBy: string;
  mandateId: string | null;
  idempotencyKey: string | null;
}

/**
 * Update a memory's content as a NEW write-provenance event: re-stamps
 * `writtenBy`/`writtenAt`/`mandateId` (and the stored `idempotencyKey`).
 * IMMUTABILITY: `createdBy`/`createdAt` are NEVER patched — the creation
 * provenance survives every subsequent write. The caller obtained `existing`
 * through this module, so the tenant constraint has already been applied.
 */
export async function updateMemoryContent(
  db: WriteDb,
  existing: Doc<'memories'>,
  input: UpdateMemoryInput,
  now: number
): Promise<Id<'memories'>> {
  await db.patch('memories', existing._id, {
    content: input.content,
    ...(input.metadata === undefined ? {} : {metadata: input.metadata}),
    writtenBy: input.writtenBy,
    writtenAt: now,
    mandateId: input.mandateId,
    idempotencyKey: input.idempotencyKey
  });
  return existing._id;
}
