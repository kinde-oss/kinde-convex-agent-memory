/**
 * PUBLIC API of the memory spine: governed `write`, `get` (read-by-key),
 * `list`, and `recall` (semantic vector search). Thin wrappers over the
 * governed access path (`access.ts`) — no direct `memories` queries live
 * here.
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
 *
 * P4 adds two gates around every operation here:
 * - SCOPES: after the tenant check, before any memories access, each
 *   operation checks its grant scope (write → memory.write, get/list →
 *   memory.read, recall → memory.recall). Subjects with no grant rows are
 *   PERMISSIVE (P1–P3 behavior, unchanged); see `lib/grantStore.ts`.
 * - EGRESS: every returned record passes through THE one redaction function
 *   (`lib/redaction.ts`), enforced at compile time by the Egressed* return
 *   annotations and pinned by `structure.test.ts`.
 */
import {action, internalMutation, mutation} from './_generated/server.js';
import {internal} from './_generated/api.js';
import {paginationOptsValidator} from 'convex/server';
import {v} from 'convex/values';
import {
  filterContradiction,
  getMemoriesByIds,
  getMemoryByIdempotencyKey,
  getMemoryByKey,
  insertMemory,
  listMemories,
  searchMemoriesByEmbedding,
  updateMemoryContent
} from './access.js';
import {deny, recordAudit} from './lib/audit.js';
import {resolveCorrelationId} from './lib/correlation.js';
import {describeRecall, digestFilter, digestKey} from './lib/digest.js';
import {embeddingProblem, topKProblem} from './lib/embedding.js';
import {fail, requireNonEmpty} from './lib/errors.js';
import {isOperationPermitted} from './lib/grantStore.js';
import {
  resolveRevocation,
  revocationDenial,
  revocationMessage,
  revokedTargetDigest
} from './lib/revocationStore.js';
import {
  egressMemories,
  egressMemory,
  resolveRedaction
} from './lib/redaction.js';
import {
  getResultValidator,
  listFilterValidator,
  listResultValidator,
  metadataValidator,
  recallDeniedCodeValidator,
  recallMatchValidator,
  recallResultValidator,
  writeResultValidator
} from './validators.js';
import type {
  DeniedResult,
  GrantScope,
  MemoryOperation,
  RecallDeniedCode,
  RecallResult
} from './validators.js';
import type {ActionCtx, MutationCtx} from './_generated/server.js';
import type {
  EgressedGetResult,
  EgressedListResult,
  EgressedRecallMatches
} from './lib/redaction.js';

/**
 * The P4 scope gate, run by every governed memory operation AFTER the
 * tenant-conflict check and BEFORE any memories access. Returns the denial
 * to hand back (audited, one row), or null when the operation may proceed —
 * either because the subject is PERMISSIVE (no grant rows: the P1–P3
 * standalone behavior, unchanged) or holds an unrevoked grant of the scope.
 */
async function scopeDenial(
  db: MutationCtx['db'],
  operation: MemoryOperation,
  args: {orgCode: string; subject: string},
  scope: GrantScope,
  keyOrQueryDigest: string,
  correlationId: string
): Promise<DeniedResult | null> {
  if (await isOperationPermitted(db, args.orgCode, args.subject, scope)) {
    return null;
  }
  return await deny(
    db,
    operation,
    args,
    'scope_not_granted',
    `The subject has no active grant of the '${scope}' scope in this tenant.`,
    keyOrQueryDigest,
    correlationId
  );
}

/**
 * Governed write. Idempotency (`idempotencyKey`) is tenant-scoped: a replay
 * within the tenant returns the original record's id without writing; the
 * same key in another tenant is a fresh, independent write. Re-writing an
 * existing (orgCode, key) updates content as a NEW write-provenance event —
 * `writtenBy`/`writtenAt` re-stamp, `createdBy`/`createdAt` never change.
 * Exactly one audit row per call, replay and denial included.
 *
 * EMBEDDING INTAKE: `embedding` optionally carries the record's semantic
 * vector — exactly `EMBEDDING_DIMENSIONS` finite numbers, validated with a
 * typed `invalid_embedding` denial BEFORE any db access. The component never
 * embeds; callers supply vectors (typically via the client's injected
 * embedder).
 *
 * EMBEDDING UPDATE SEMANTICS (deliberate choice): updating a record KEEPS the
 * stored embedding unless a new one is explicitly supplied — content and
 * embedding are supplied together by callers that care about recall, and
 * clearing on every content-only update would silently drop records out of
 * vector search. THE HONEST CAVEAT: a content update WITHOUT a fresh
 * embedding leaves the stored vector describing the OLD content; recall may
 * then rank the record by text it no longer contains. Callers that update
 * content should re-embed alongside it. (An idempotent replay ignores the
 * supplied embedding entirely, like every other replayed field: the first
 * write won.)
 */
export const write = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    key: v.string(),
    content: v.string(),
    metadata: v.optional(metadataValidator),
    embedding: v.optional(v.array(v.float64())),
    idempotencyKey: v.optional(v.string()),
    correlationId: v.optional(v.string())
  },
  returns: writeResultValidator,
  handler: async (ctx, args) => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    requireNonEmpty(args.key, 'key');
    const correlationId = resolveCorrelationId(args.correlationId);
    const keyDigest = await digestKey(args.key);

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

    // Revocation overlay (P5): after the tenant check, BEFORE the scope gate.
    // Outranks grants — a revoked caller is denied here whatever scopes it holds.
    const writeRevoked = await revocationDenial(
      ctx.db,
      'write',
      args,
      correlationId
    );
    if (writeRevoked !== null) {
      return writeRevoked;
    }

    // Scope gate (P4): after the tenant check, before any memories access.
    const writeScopeDenied = await scopeDenial(
      ctx.db,
      'write',
      args,
      'memory.write',
      keyDigest,
      correlationId
    );
    if (writeScopeDenied !== null) {
      return writeScopeDenied;
    }

    // Embedding validation: BEFORE any memories access (idempotency lookup
    // included).
    if (args.embedding !== undefined) {
      const embeddingIssue = embeddingProblem(args.embedding);
      if (embeddingIssue !== null) {
        return await deny(
          ctx.db,
          'write',
          args,
          'invalid_embedding',
          embeddingIssue,
          keyDigest,
          correlationId
        );
      }
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
          ...(args.embedding === undefined ? {} : {embedding: args.embedding}),
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
          ...(args.embedding === undefined ? {} : {embedding: args.embedding}),
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
  handler: async (ctx, args): Promise<EgressedGetResult> => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    requireNonEmpty(args.key, 'key');
    const correlationId = resolveCorrelationId(args.correlationId);
    const keyDigest = await digestKey(args.key);

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

    // Revocation overlay (P5): after the tenant check, BEFORE the scope gate.
    const getRevoked = await revocationDenial(
      ctx.db,
      'get',
      args,
      correlationId
    );
    if (getRevoked !== null) {
      return getRevoked;
    }

    // Scope gate (P4): after the tenant check, before any memories access.
    const scopeDenied = await scopeDenial(
      ctx.db,
      'get',
      args,
      'memory.read',
      keyDigest,
      correlationId
    );
    if (scopeDenied !== null) {
      return scopeDenied;
    }

    const memory = await getMemoryByKey(ctx.db, args.orgCode, args.key);
    const redaction = await resolveRedaction(
      ctx.db,
      args.orgCode,
      args.subject
    );
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
    return {
      ok: true as const,
      memory: memory === null ? null : egressMemory(memory, redaction),
      correlationId
    };
  }
});

/**
 * Governed, paginated listing over the tenant's memories. The filter is plain
 * data (a closed validator — see `listFilterValidator`); how each field is
 * applied — index range vs in-range refinement — is `access.ts`'s documented
 * contract. Standard Convex pagination shape in and out; after refinement a
 * page may hold fewer than `numItems` rows while `isDone` is false — walk
 * `continueCursor` until `isDone`. A contradictory filter denies typed
 * `invalid_filter`, never a silent empty result. Exactly one audit row per
 * call (operation `list`), carrying a digest of the WHOLE filter object —
 * raw filter values (prefixes, subjects, metadata values) never reach audit.
 */
export const list = mutation({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    filter: v.optional(listFilterValidator),
    paginationOpts: paginationOptsValidator,
    correlationId: v.optional(v.string())
  },
  returns: listResultValidator,
  handler: async (ctx, args): Promise<EgressedListResult> => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    if (args.paginationOpts.numItems <= 0) {
      fail('invalid_argument', 'paginationOpts.numItems must be positive.');
    }
    const correlationId = resolveCorrelationId(args.correlationId);
    const filterDigest = await digestFilter(args.filter);

    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await deny(
        ctx.db,
        'list',
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        filterDigest,
        correlationId
      );
    }

    // Revocation overlay (P5): after the tenant check, BEFORE the scope gate.
    const listRevoked = await revocationDenial(
      ctx.db,
      'list',
      args,
      correlationId
    );
    if (listRevoked !== null) {
      return listRevoked;
    }

    // Scope gate (P4): after the tenant check, before any memories access.
    const scopeDenied = await scopeDenial(
      ctx.db,
      'list',
      args,
      'memory.read',
      filterDigest,
      correlationId
    );
    if (scopeDenied !== null) {
      return scopeDenied;
    }

    const contradiction = filterContradiction(args.filter);
    if (contradiction !== null) {
      return await deny(
        ctx.db,
        'list',
        args,
        'invalid_filter',
        contradiction,
        filterDigest,
        correlationId
      );
    }

    const {page, isDone, continueCursor} = await listMemories(
      ctx.db,
      args.orgCode,
      args.filter ?? {},
      args.paginationOpts
    );

    // The P4 redaction seam, now live: every row egresses through the ONE
    // redaction function inside the governed path, before rows leave it.
    const redaction = await resolveRedaction(
      ctx.db,
      args.orgCode,
      args.subject
    );

    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'list',
      decision: 'ok',
      reasonCode: 'listed',
      keyOrQueryDigest: filterDigest,
      correlationId,
      mandateId: null
    });
    return {
      ok: true as const,
      page: egressMemories(page, redaction),
      isDone,
      continueCursor,
      correlationId
    };
  }
});

/**
 * Audit one recall DENIAL and build the returned `DeniedResult`. Recall runs
 * as an ACTION (a Convex platform rule: `ctx.vectorSearch` exists only there)
 * and actions cannot write — so the denial's ONE audit row is committed by a
 * dedicated internal mutation before the action returns the denial. The
 * one-audit-row-per-operation invariant holds: a denied recall runs exactly
 * this mutation and nothing else.
 */
async function denyRecall(
  ctx: ActionCtx,
  args: {orgCode: string; subject: string; topK: number},
  code: RecallDeniedCode,
  message: string,
  correlationId: string
): Promise<DeniedResult> {
  await ctx.runMutation(internal.memory.recordRecallDenial, {
    orgCode: args.orgCode,
    subject: args.subject,
    reasonCode: code,
    keyOrQueryDigest: describeRecall(args.topK),
    correlationId
  });
  return {ok: false, code, message, correlationId};
}

/**
 * The recall action's COMBINED gate (P5 revocation overlay + P4 scope gate).
 * Actions cannot touch the db, so both the revocation lookup and the grant
 * lookup run in this one internal mutation, in the mandated order — REVOCATION
 * FIRST (it outranks grants), scope second. Whichever denies ALSO commits the
 * denial's one audit row in the same transaction, so a denied recall audits
 * exactly once (this is then the only mutation that recall runs). Returns a
 * discriminated result so the action re-raises the exact code/message.
 */
export const ensureRecallAccess = internalMutation({
  args: {
    orgCode: v.string(),
    subject: v.string(),
    keyOrQueryDigest: v.string(),
    correlationId: v.string()
  },
  returns: v.union(
    v.object({permitted: v.literal(true)}),
    v.object({
      permitted: v.literal(false),
      code: v.union(v.literal('revoked'), v.literal('scope_not_granted')),
      message: v.string()
    })
  ),
  handler: async (ctx, args) => {
    // Revocation overlay FIRST: outranks the scope gate. The `revoked` row
    // records the revocation TARGET digest (the reason-join key), not the
    // recall descriptor — same choice as revocationDenial for write/get/list.
    const level = await resolveRevocation(ctx.db, args.orgCode, args.subject);
    if (level !== null) {
      await recordAudit(ctx.db, {
        orgCode: args.orgCode,
        subject: args.subject,
        operation: 'recall',
        decision: 'denied',
        reasonCode: 'revoked',
        keyOrQueryDigest: await revokedTargetDigest(
          level,
          args.orgCode,
          args.subject
        ),
        correlationId: args.correlationId,
        mandateId: null
      });
      return {
        permitted: false as const,
        code: 'revoked' as const,
        message: revocationMessage(level)
      };
    }
    const permitted = await isOperationPermitted(
      ctx.db,
      args.orgCode,
      args.subject,
      'memory.recall'
    );
    if (!permitted) {
      await recordAudit(ctx.db, {
        orgCode: args.orgCode,
        subject: args.subject,
        operation: 'recall',
        decision: 'denied',
        reasonCode: 'scope_not_granted',
        keyOrQueryDigest: args.keyOrQueryDigest,
        correlationId: args.correlationId,
        mandateId: null
      });
      return {
        permitted: false as const,
        code: 'scope_not_granted' as const,
        message:
          "The subject has no active grant of the 'memory.recall' scope in this tenant."
      };
    }
    return {permitted: true as const};
  }
});

/** Commits the ONE audit row of a denied recall (see {@link denyRecall}). */
export const recordRecallDenial = internalMutation({
  args: {
    orgCode: v.string(),
    subject: v.string(),
    reasonCode: recallDeniedCodeValidator,
    keyOrQueryDigest: v.string(),
    correlationId: v.string()
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'recall',
      decision: 'denied',
      reasonCode: args.reasonCode,
      keyOrQueryDigest: args.keyOrQueryDigest,
      correlationId: args.correlationId,
      mandateId: null
    });
    return null;
  }
});

/**
 * Second half of a successful recall: fetches the vector-search hits THROUGH
 * the governed path (`getMemoriesByIds`, which re-checks every doc's orgCode
 * and fails loudly with `isolation_invariant_violation` on any mismatch —
 * never a silent drop), writes the recall's EXACTLY ONE audit row, and
 * returns the matches in the action's score order (descending). The audit
 * row records only the requested `topK` and the result count — never the
 * query vector, never content. A hit whose document was deleted between the
 * action's search and this mutation is dropped: the record genuinely no
 * longer exists.
 */
export const finalizeRecall = internalMutation({
  args: {
    orgCode: v.string(),
    subject: v.string(),
    hits: v.array(v.object({id: v.id('memories'), score: v.float64()})),
    topK: v.number(),
    correlationId: v.string()
  },
  returns: v.array(recallMatchValidator),
  handler: async (ctx, args): Promise<EgressedRecallMatches> => {
    const docs = await getMemoriesByIds(
      ctx.db,
      args.orgCode,
      args.hits.map((hit) => hit.id)
    );
    // Redaction-on-read applies to recall matches exactly as to get/list:
    // every returned record egresses through the ONE redaction function.
    const redaction = await resolveRedaction(
      ctx.db,
      args.orgCode,
      args.subject
    );
    const matches: EgressedRecallMatches = [];
    for (const hit of args.hits) {
      const doc = docs.get(hit.id);
      if (doc !== undefined) {
        matches.push({memory: egressMemory(doc, redaction), score: hit.score});
      }
    }
    await recordAudit(ctx.db, {
      orgCode: args.orgCode,
      subject: args.subject,
      operation: 'recall',
      decision: 'ok',
      reasonCode: 'recalled',
      keyOrQueryDigest: describeRecall(args.topK, matches.length),
      correlationId: args.correlationId,
      mandateId: null
    });
    return matches;
  }
});

/**
 * Governed semantic recall: tenant-partitioned vector search. An ACTION,
 * because `ctx.vectorSearch` exists only in actions (mutations cannot
 * vector-search) — the search itself therefore runs OUTSIDE any transaction.
 * Everything transactional happens in ONE internal mutation per call:
 * validation denials commit their audit row via `recordRecallDenial`; a
 * successful search hands its (id, score) hits to `finalizeRecall`, which
 * re-fetches the docs through the governed path (belt-and-braces orgCode
 * re-check), writes the recall's exactly-one audit row, and returns the
 * matches. HONESTY NOTE: the audit row records the recall whose results were
 * returned to the caller; the vector search that produced the hits ran just
 * before that mutation, outside its transaction.
 *
 * CRASH-GAP, and why it is SAFE: if the action dies between the vector search
 * and `finalizeRecall`, the caller receives NOTHING — the action throws before
 * returning, so no matches egress. The only casualty is the audit row: an
 * attempted-but-crashed recall leaves none. This asymmetry is deliberate and
 * accepted: no data can leave the component unaudited (the audit row and the
 * returned matches are written together in `finalizeRecall`, or neither is);
 * the sole loss is observability of a recall that crashed before returning
 * anything. This is an accepted property of the action model — a recall's
 * transactional half is one mutation, and a crash before it commits nothing.
 *
 * Isolation mechanic: the `by_embedding` vector index declares
 * `filterFields: ['orgCode']` and the search ALWAYS carries the orgCode
 * filter, so other tenants' vectors are outside the searched partition — the
 * headline test proves a better-matching foreign row cannot appear.
 *
 * Denials RETURN (same contract as every governed operation); the client
 * converts them into thrown typed ConvexErrors.
 */
export const recall = action({
  args: {
    subject: v.string(),
    orgCode: v.string(),
    claimedOrgCode: v.optional(v.string()),
    embedding: v.array(v.float64()),
    topK: v.number(),
    correlationId: v.optional(v.string())
  },
  returns: recallResultValidator,
  handler: async (ctx, args): Promise<RecallResult> => {
    requireNonEmpty(args.orgCode, 'orgCode');
    requireNonEmpty(args.subject, 'subject');
    const correlationId = resolveCorrelationId(args.correlationId);

    // Tenant-context conflict: checked BEFORE anything else.
    if (
      args.claimedOrgCode !== undefined &&
      args.claimedOrgCode !== args.orgCode
    ) {
      return await denyRecall(
        ctx,
        args,
        'tenant_context_conflict',
        'The claimed org code does not match the server-verified tenant context.',
        correlationId
      );
    }

    // Combined gate (P5 revocation overlay → P4 scope gate): after the tenant
    // check, before any search. The internal mutation audits whichever denial
    // fires itself (one row, committed there) and reports the exact code.
    const gate = await ctx.runMutation(internal.memory.ensureRecallAccess, {
      orgCode: args.orgCode,
      subject: args.subject,
      keyOrQueryDigest: describeRecall(args.topK),
      correlationId
    });
    if (!gate.permitted) {
      return {
        ok: false as const,
        code: gate.code,
        message: gate.message,
        correlationId
      };
    }

    // Embedding and bound validation: BEFORE any search.
    const embeddingIssue = embeddingProblem(args.embedding);
    if (embeddingIssue !== null) {
      return await denyRecall(
        ctx,
        args,
        'invalid_embedding',
        embeddingIssue,
        correlationId
      );
    }
    const topKIssue = topKProblem(args.topK);
    if (topKIssue !== null) {
      return await denyRecall(
        ctx,
        args,
        'invalid_topk',
        topKIssue,
        correlationId
      );
    }

    const hits = await searchMemoriesByEmbedding(
      ctx,
      args.orgCode,
      args.embedding,
      args.topK
    );
    const matches = await ctx.runMutation(internal.memory.finalizeRecall, {
      orgCode: args.orgCode,
      subject: args.subject,
      hits: hits.map((hit) => ({id: hit._id, score: hit._score})),
      topK: args.topK,
      correlationId
    });
    return {ok: true as const, matches, correlationId};
  }
});
