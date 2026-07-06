/**
 * LIVE-ONLY real embedder. Calls OpenAI text-embedding-3-small (1536 dims,
 * matching the component's EMBEDDING_DIMENSIONS) via the deployment's
 * OPENAI_API_KEY. This is the injectable embedder the AgentMemory client takes;
 * the live harness wires it through the client the way a real app would.
 *
 * This lives under example/convex/live/, clearly separated from the unit-test
 * hash fake (`fakeEmbed` in example.ts). It is NOT used by any convex-test.
 *
 * Typed-error discipline: a failed HTTP call or a malformed response is a typed
 * ConvexError (never a raw throw), so the client's own embedder-response
 * handling sees a well-shaped failure exactly as it expects.
 */
import {ConvexError} from 'convex/values';
import {EMBEDDING_DIMENSIONS} from '@kinde-oss/kinde-convex-agent-memory';

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const MODEL = 'text-embedding-3-small';

interface OpenAIEmbeddingItem {
  index: number;
  embedding: number[];
}

function isFiniteVector(value: unknown): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === EMBEDDING_DIMENSIONS &&
    value.every((x) => typeof x === 'number' && Number.isFinite(x))
  );
}

/** Embed a batch of texts in one request; returns one vector per input, in order. */
export async function embedTexts(texts: string[]): Promise<number[][]> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (apiKey === undefined || apiKey === '') {
    throw new ConvexError({
      code: 'openai_not_configured',
      message: 'OPENAI_API_KEY is not set on the deployment.'
    });
  }

  let response: Response;
  try {
    response = await fetch(OPENAI_EMBEDDINGS_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({model: MODEL, input: texts})
    });
  } catch (caught) {
    throw new ConvexError({
      code: 'openai_http_error',
      message: `The embeddings request failed to send: ${
        caught instanceof Error ? caught.message : String(caught)
      }`
    });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new ConvexError({
      code: 'openai_http_error',
      message: `The embeddings API returned ${response.status}: ${detail.slice(0, 200)}`
    });
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConvexError({
      code: 'openai_response_malformed',
      message: 'The embeddings response was not valid JSON.'
    });
  }

  const data =
    body !== null && typeof body === 'object' && 'data' in body
      ? (body as {data: unknown}).data
      : undefined;
  if (!Array.isArray(data) || data.length !== texts.length) {
    throw new ConvexError({
      code: 'openai_response_malformed',
      message: `Expected ${texts.length} embeddings, got ${
        Array.isArray(data) ? data.length : 'a non-array response'
      }.`
    });
  }

  const items = data as OpenAIEmbeddingItem[];
  const ordered = [...items].sort((a, b) => a.index - b.index);
  const vectors = ordered.map((item) => item.embedding);
  for (const vector of vectors) {
    if (!isFiniteVector(vector)) {
      throw new ConvexError({
        code: 'openai_response_malformed',
        message: `An embedding was not ${EMBEDDING_DIMENSIONS} finite numbers.`
      });
    }
  }
  return vectors;
}

/** Embed one text (the shape the AgentMemory client's `embedder` slot takes). */
export async function embedText(text: string): Promise<number[]> {
  const vectors = await embedTexts([text]);
  const vector = vectors[0];
  if (vector === undefined) {
    throw new ConvexError({
      code: 'openai_response_malformed',
      message: 'The embeddings API returned no vector for the input.'
    });
  }
  return vector;
}
