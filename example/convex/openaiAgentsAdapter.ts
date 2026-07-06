/**
 * GOVERNED OPENAI AGENTS SDK MEMORY TOOLS — example-only, framework-free.
 *
 * WHY THIS EXISTS. The OpenAI Agents SDK has no vector store to subclass; its
 * memory pattern is FUNCTION-TOOL-based — the app registers a `save_memory` and a
 * `search_memory` function tool and the model calls them (the Mem0 integration is
 * exactly this shape). The usual pattern has each tool reach a store or a
 * third-party memory service DIRECTLY, often admin-keyed, with the tenant left to
 * a `user_id`/`namespace` ARGUMENT the caller passes in — which the model, or a
 * mis-set arg, can get wrong and cross tenants. THESE tools instead CLOSE THE
 * SERVER-VERIFIED TENANT OVER THE TOOL at construction: `orgCode` (and `subject`)
 * are captured in the factory and are NOT parameters of either tool, so no
 * argument the model produces can name, change, or widen the tenant. Every call
 * routes through the in-app governed {@link AgentMemory} client —
 * tenant-partitioned, audited, redactable, revocable. That is the whole reason
 * these governed tools exist.
 *
 * INTERFACE PROVENANCE. `@openai/agents` is NOT installed in this repo, and the
 * shipped package (src/) must gain NO framework dependency. So the function-tool
 * shape is declared LOCALLY below, mirroring the SDK's `{name, description,
 * parameters, execute}` seam (execute: `(args) => Promise<result>`). `parameters`
 * is a real, minimal typed JSON-schema descriptor here; a real integration would
 * hand this to `tool()`/`function_tool()`, and the `execute` bodies transfer
 * unchanged. CRUCIALLY, neither tool's `parameters` contains an
 * `orgCode`/`subject` property — the tenant is simply not in the surface.
 *
 * HONESTY ON SCOPE. These govern the memory save/recall path, which is where
 * cross-tenant leakage happens. Anything an agent does on a raw, non-governed
 * tool is NOT governed here.
 */
import type {
  AgentMemory,
  MemoryWriteArgs,
  RunActionCtx,
  RunMutationCtx
} from '@kinde-oss/kinde-convex-agent-memory';

// --- Local mirror of the OpenAI Agents SDK function-tool seam ----------------

/** A minimal JSON-schema-ish descriptor mirroring the `parameters` slot. */
export interface OpenAIAgentsParameters {
  type: 'object';
  properties: Record<string, {type: string; description?: string}>;
  required: string[];
}

/** An OpenAI-Agents-SDK-shaped function tool. */
export interface OpenAIAgentsFunctionTool<TInput, TOutput> {
  name: string;
  description: string;
  parameters: OpenAIAgentsParameters;
  execute: (args: TInput) => Promise<TOutput>;
}

/** Input to `save_memory`. NOTE: no `orgCode`/`subject` — the tenant is bound at
 * construction and is not part of the tool surface. */
export interface SaveMemoryInput {
  /** Optional stable id; a uuid is minted when omitted. */
  key?: string;
  /** The memory text to store. */
  content: string;
  /** Optional ready vector; when omitted the content is embedded. */
  embedding?: number[];
}

export interface SaveMemoryResult {
  id: string;
  outcome: string;
}

/** Input to `search_memory`. NOTE: no `orgCode`/`subject`. */
export interface SearchMemoryInput {
  /** Text to search for; embedded server-side via the bound embedder. */
  query?: string;
  /** Optional ready query vector (used instead of `query`). */
  embedding?: number[];
  /** Max matches to return. */
  topK?: number;
}

export interface SearchMemoryMatch {
  key: string;
  content: string;
  score: number;
}

export type SearchMemoryResult = SearchMemoryMatch[];

export interface OpenAIAgentsMemoryTools {
  save_memory: OpenAIAgentsFunctionTool<SaveMemoryInput, SaveMemoryResult>;
  search_memory: OpenAIAgentsFunctionTool<
    SearchMemoryInput,
    SearchMemoryResult
  >;
}

// -----------------------------------------------------------------------------

/** Embeds text to a vector for save-by-content / search-by-query. */
export type ToolEmbedder = (text: string) => Promise<number[]>;

/**
 * The ctx the tools drive the governed client with. `save_memory` runs a
 * mutation (`write`); `search_memory` runs an action (`recall`). An app ACTION's
 * ctx supplies both, so the tools are constructed inside one.
 */
export type GovernedToolCtx = RunMutationCtx & RunActionCtx;

export interface GovernedMemoryToolsConfig {
  /** The governed component client (constructed with no admin key). */
  agentMemory: AgentMemory;
  /** THIS request's ctx (per-call, not a long-lived admin connection). */
  ctx: GovernedToolCtx;
  /** The acting principal. */
  subject: string;
  /**
   * The SERVER-VERIFIED tenant. CLOSED OVER at construction — it is NOT a tool
   * parameter, so no argument the model supplies can name, change, or widen it.
   * An admin-keyed tool that takes a `user_id` argument has no such guarantee.
   */
  orgCode: string;
  /** Required only for save-by-content / search-by-query text embedding. */
  embedder?: ToolEmbedder;
}

const SAVE_MEMORY_PARAMETERS: OpenAIAgentsParameters = {
  type: 'object',
  properties: {
    key: {
      type: 'string',
      description: 'Optional stable id; minted if omitted.'
    },
    content: {type: 'string', description: 'The memory text to store.'},
    embedding: {
      type: 'array',
      description:
        'Optional ready vector; else content is embedded server-side.'
    }
  },
  required: ['content']
};

const SEARCH_MEMORY_PARAMETERS: OpenAIAgentsParameters = {
  type: 'object',
  properties: {
    query: {
      type: 'string',
      description: 'Text to search for (embedded server-side).'
    },
    embedding: {type: 'array', description: 'Optional ready query vector.'},
    topK: {type: 'number', description: 'Max matches to return.'}
  },
  required: []
};

/**
 * Build the governed OpenAI-Agents-SDK memory function tools bound to ONE tenant.
 * `save_memory`/`search_memory` route every call through the governed
 * {@link AgentMemory} client under the closed-over `subject`/`orgCode`:
 *
 * - `save_memory` → `agentMemory.write` (tenant-stamped, audited, provenance).
 * - `search_memory` → `agentMemory.recall` (tenant-partitioned vector search).
 *
 * The tenant is not a parameter of either tool, so it can never be crossed from
 * the tool surface. Redaction, revocation, and audit are inherited from the
 * governed client, not re-implemented here.
 */
export function governedMemoryFunctionTools(
  config: GovernedMemoryToolsConfig
): OpenAIAgentsMemoryTools {
  const embed = async (text: string): Promise<number[]> => {
    if (config.embedder === undefined) {
      throw new Error(
        'This tool needs an `embedder` to turn text into a vector; supply one, or pass a ready `embedding`.'
      );
    }
    return await config.embedder(text);
  };

  const save_memory: OpenAIAgentsFunctionTool<
    SaveMemoryInput,
    SaveMemoryResult
  > = {
    name: 'save_memory',
    description:
      'Save a memory for later recall. The tenant is fixed by the server; do not pass it.',
    parameters: SAVE_MEMORY_PARAMETERS,
    execute: async (args) => {
      const key = args.key ?? crypto.randomUUID();
      const embedding = args.embedding ?? (await embed(args.content));
      const result = await config.agentMemory.write(config.ctx, {
        subject: config.subject,
        orgCode: config.orgCode, // CLOSED OVER — never from args
        key,
        content: args.content,
        embedding
      } satisfies MemoryWriteArgs);
      return {id: key, outcome: result.outcome};
    }
  };

  const search_memory: OpenAIAgentsFunctionTool<
    SearchMemoryInput,
    SearchMemoryResult
  > = {
    name: 'search_memory',
    description:
      'Search your memories semantically. The tenant is fixed by the server; do not pass it.',
    parameters: SEARCH_MEMORY_PARAMETERS,
    execute: async (args) => {
      let embedding: number[];
      if (args.embedding !== undefined) {
        embedding = args.embedding;
      } else if (args.query !== undefined && args.query !== '') {
        embedding = await embed(args.query);
      } else {
        throw new Error(
          'search_memory needs a non-empty `query` string or an `embedding` vector.'
        );
      }
      const result = await config.agentMemory.recall(config.ctx, {
        subject: config.subject,
        orgCode: config.orgCode, // CLOSED OVER — the model cannot widen past it
        embedding,
        ...(args.topK === undefined ? {} : {topK: args.topK})
      });
      return result.matches.map((match) => ({
        key: match.memory.key,
        content: match.memory.content,
        score: match.score
      }));
    }
  };

  return {save_memory, search_memory};
}
