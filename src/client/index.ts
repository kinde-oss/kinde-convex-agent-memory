import type {
  FunctionArgs,
  FunctionReturnType,
  GenericActionCtx,
  GenericDataModel
} from 'convex/server';
import {ConvexError} from 'convex/values';
import type {ComponentApi} from '../component/_generated/component.js';

export type {ComponentApi} from '../component/_generated/component.js';

export type RunMutationCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  'runQuery' | 'runMutation'
>;

// The component functions' exact arg/return types, recovered from the
// generated component API so the client never re-declares (or drifts from)
// the validators.
type WriteArgs = FunctionArgs<ComponentApi['memory']['write']>;
type WriteResult = FunctionReturnType<ComponentApi['memory']['write']>;
type GetArgs = FunctionArgs<ComponentApi['memory']['get']>;
type GetResult = FunctionReturnType<ComponentApi['memory']['get']>;

/** Arguments to {@link AgentMemory.write}. */
export type MemoryWriteArgs = WriteArgs;
/** Arguments to {@link AgentMemory.get}. */
export type MemoryGetArgs = GetArgs;
/** A successful write: the record id, how it resolved, the correlation id. */
export type MemoryWriteOk = Extract<WriteResult, {ok: true}>;
/** A full memory record, as returned by governed reads. */
export type MemoryRecord = NonNullable<
  Extract<GetResult, {ok: true}>['memory']
>;

/**
 * The verified identity of a caller, as produced by an app-supplied
 * {@link VerifyCaller}. The shape mirrors — field for field — what
 * `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller` returns
 * (its `VerifiedAgent`), so that client plugs straight into this seam.
 * The component itself imports no auth package.
 */
export interface VerifiedCaller {
  /** The authenticated principal the memory operations act for. */
  subject: string;
  /** The registry id of the calling agent, or null when unregistered. */
  agentId: string | null;
  /**
   * The organization the caller's token is scoped to. This is the
   * server-verified tenant context the memory boundary is keyed on — it can
   * never be overridden by request input.
   */
  orgCode: string | null;
  /** Scopes granted to the caller. */
  scopes: string[];
  /** The full verified token payload. */
  claims: Record<string, unknown>;
}

/**
 * OPTIONAL caller-authentication seam for the direct-HTTP case: given a bearer
 * token, authenticate the caller and resolve the server-verified tenant
 * context (throw to reject). Matches the signature of
 * `@kinde-oss/kinde-convex-agent-auth`'s `verifyCaller`, the blessed default —
 * but ANY auth can supply it, and the component is fully standalone without
 * it: in-Convex callers pass a subject and tenant context their app has
 * already verified.
 */
export type VerifyCaller = (token: string) => Promise<VerifiedCaller>;

/**
 * OPTIONAL injectable embedder seam: given a memory's text, return its
 * embedding vector for semantic recall. No embedding provider is hardcoded —
 * the app supplies whichever model it uses. Without an embedder the component
 * is fully standalone: structured memory works end to end, and only
 * vector-search recall is unavailable.
 */
export type Embedder = (text: string) => Promise<number[]>;

/**
 * Configuration for the {@link AgentMemory} client. Every slot is optional and
 * the component is fully standalone with none of them set.
 */
export interface MemoryComponentConfig {
  /** See {@link VerifyCaller}. Consumed by the app-mounted HTTP path only. */
  verifyCaller?: VerifyCaller;
  /** See {@link Embedder}. Enables semantic (vector) recall when present. */
  embedder?: Embedder;
  /**
   * Name of the env var the component reads its HMAC signing secret from,
   * for apps that mount the component under a different secret var. The value
   * itself is always set via `npx convex env set`, never hardcoded.
   */
  signingSecretEnvVar?: string;
}

/**
 * Convert a governed denial into a thrown, typed ConvexError. The component
 * RETURNS denials (so the denial's audit row commits — a throw inside the
 * component mutation would roll it back); the client restores fail(code,
 * message) semantics for app code here, AFTER that mutation has committed.
 */
function throwDenied(result: Extract<WriteResult, {ok: false}>): never {
  throw new ConvexError({
    code: result.code,
    message: result.message,
    correlationId: result.correlationId
  });
}

/**
 * Client for the Kinde agent memory component.
 *
 * Construct it with the component reference from your app's generated
 * `components` object:
 *
 * ```ts
 * import {AgentMemory} from '@kinde-oss/kinde-convex-agent-memory';
 * import {components} from './_generated/api.js';
 *
 * export const agentMemory = new AgentMemory(components.memory);
 * ```
 *
 * Every method takes the app's `ctx` plus a server-verified tenant context
 * (`orgCode`) and runs through the component's ONE governed access path. Both
 * `write` and `get` run as mutations — every governed operation, reads
 * included, writes exactly one audit row, and only mutations can write.
 *
 * DENIAL-AUDIT DURABILITY: on a governed denial these methods throw AFTER the
 * component has audited it. Called from an app ACTION, the component mutation
 * commits first, so the denial audit row is durable. Called from an app
 * MUTATION that lets the throw propagate, Convex rolls back the app's whole
 * transaction — the denial audit row included. Call from an action (or catch
 * the ConvexError) when denial-audit durability matters.
 */
export class AgentMemory {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: MemoryComponentConfig = {}
  ) {}

  /**
   * Governed write. Returns the record id, how the write resolved
   * (`created` | `updated` | `idempotent_replay`), and the correlation id.
   * Throws a typed ConvexError (`tenant_context_conflict`,
   * `idempotency_key_reused`) on a governed denial — the denial is already
   * audited by the component before this throws.
   */
  async write(
    ctx: RunMutationCtx,
    args: MemoryWriteArgs
  ): Promise<MemoryWriteOk> {
    const result = await ctx.runMutation(this.component.memory.write, args);
    if (!result.ok) {
      throwDenied(result);
    }
    return result;
  }

  /**
   * Governed read-by-key. Returns the record, or null when no record with
   * that key exists IN THIS TENANT (a key held by another tenant is
   * indistinguishable from a missing one). Throws a typed ConvexError on a
   * governed denial, after the denial's audit row has committed.
   */
  async get(
    ctx: RunMutationCtx,
    args: MemoryGetArgs
  ): Promise<MemoryRecord | null> {
    const result = await ctx.runMutation(this.component.memory.get, args);
    if (!result.ok) {
      throwDenied(result);
    }
    return result.memory;
  }
}
