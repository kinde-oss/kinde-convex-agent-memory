import type {ComponentApi} from '../component/_generated/component.js';

export type {ComponentApi} from '../component/_generated/component.js';

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
 * the component is fully standalone with none of them set. Types only in P0 —
 * behavior arrives with the phases that consume each slot.
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
 * Client for the Kinde agent memory component (P0 skeleton).
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
 * The governed memory surface (write, recall, redaction, revocation) arrives
 * in later phases; P0 ships the construction contract only.
 */
export class AgentMemory {
  constructor(
    public readonly component: ComponentApi,
    public readonly options: MemoryComponentConfig = {}
  ) {}
}
