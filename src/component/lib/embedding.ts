/**
 * The embedding contract, in ONE place. This module is pure (no Convex
 * imports, no generated code) so both sides of the boundary share it: the
 * component validates every vector it is handed (write and recall), and the
 * client validates every vector an injected embedder returns. The component
 * itself NEVER embeds — no embedding provider is imported anywhere in it; it
 * only ever receives vectors.
 */

/**
 * The component's fixed embedding dimensionality. A Convex vector index
 * declares its dimensions statically, so every vector stored or searched MUST
 * have exactly this many components — a mismatched vector is rejected with a
 * typed code (`invalid_embedding` from the component, or
 * `embedder_response_malformed` from the client's embedder seam) BEFORE any
 * db access. 1536 matches the most common embedding-model output size (e.g.
 * OpenAI text-embedding-3-small); apps whose model emits another size must
 * pad or project to this dimensionality at the embedder seam.
 */
export const EMBEDDING_DIMENSIONS = 1536;

/** Upper bound on `topK` for one recall (validated as an integer in 1..64). */
export const MAX_RECALL_TOP_K = 64;

/** The `topK` the client supplies when the caller does not. */
export const DEFAULT_RECALL_TOP_K = 8;

/**
 * Validate a candidate embedding: it must be an array of exactly
 * {@link EMBEDDING_DIMENSIONS} finite numbers (NaN and ±Infinity are valid
 * Convex float64s but meaningless as vector components, so they are rejected
 * here). Returns a human-readable problem, or null for a valid embedding.
 * Takes `unknown` deliberately — the client runs it against whatever an
 * injected embedder actually returned, not what its type promised.
 */
export function embeddingProblem(value: unknown): string | null {
  if (!Array.isArray(value)) {
    return 'The embedding must be an array of numbers.';
  }
  if (value.length !== EMBEDDING_DIMENSIONS) {
    return `The embedding must have exactly ${EMBEDDING_DIMENSIONS} dimensions, got ${value.length}.`;
  }
  for (const component of value) {
    if (typeof component !== 'number' || !Number.isFinite(component)) {
      return 'Every embedding component must be a finite number.';
    }
  }
  return null;
}

/** Type-guard form of {@link embeddingProblem} for narrowing `unknown`. */
export function isWellFormedEmbedding(value: unknown): value is number[] {
  return embeddingProblem(value) === null;
}

/**
 * Validate a recall `topK`: an integer in [1, {@link MAX_RECALL_TOP_K}].
 * Returns a human-readable problem, or null for a valid bound.
 */
export function topKProblem(topK: number): string | null {
  if (!Number.isInteger(topK) || topK < 1 || topK > MAX_RECALL_TOP_K) {
    return `topK must be an integer between 1 and ${MAX_RECALL_TOP_K}, got ${topK}.`;
  }
  return null;
}
