import OpenAI from "openai";

/**
 * Query and passage embedding.
 *
 * This used to run Xenova/multilingual-e5-small locally via onnxruntime. On
 * Vercel that meant every cold start downloaded ~100MB of ONNX weights from the
 * HuggingFace CDN into /tmp before the first question could be answered — the
 * bulk of the 20s worst-case latency. /tmp is per-instance, so a new lambda
 * paid it again.
 *
 * OpenAI's text-embedding-3-small is one HTTP call (~100ms) with no model to
 * load, no native addon, and no cold-start penalty. Requested at 384 dimensions
 * so the stored vectors stay the same width as the existing vector(384) column.
 */

/**
 * Model choice is measured, not assumed. On a title-recall probe over all 17
 * episodes (queries derived from episode descriptions, so no overlap with the
 * chunk text), recall@2 was:
 *
 *   text-embedding-3-small  10/17 raw, 12/17 with the title prefix
 *   text-embedding-3-large  14/17 raw, 14/17 with the title prefix
 *   Xenova multilingual-e5  14/17 raw, 16/17 with the title prefix
 *
 * e5 is still the most accurate on Hebrew — it is explicitly multilingual,
 * where OpenAI's models are English-dominant — but it can only run locally,
 * which is what caused the cold-start problem in the first place. 3-large
 * matches the accuracy the deployed site actually had while removing it.
 *
 * 1536 rather than the full 3072: pgvector's HNSW index tops out at 2000
 * dimensions, and 1536 measured the same as 3072 on the probe above.
 */
export const EMBEDDING_MODEL = "text-embedding-3-large";
export const EMBEDDING_DIMENSIONS = 1536;

/**
 * What actually gets embedded for a chunk.
 *
 * Transcript chunks are conversational speech and often never name their own
 * subject — an episode about beekeeping may not contain the word "bees" in the
 * relevant passage. Prefixing the episode title gives every chunk that anchor
 * and measurably improves recall. The prefix is embedding input only; the
 * stored chunk text, and so the text sent to the model as context, is
 * unchanged.
 */
export function contextualizeChunk(title: string, text: string): string {
  return `${title}\n\n${text}`;
}

// Constructed lazily — Next imports route modules at build time, where
// OPENAI_API_KEY is absent, and a top-level client would fail the build.
let client: OpenAI | null = null;
function getClient(): OpenAI {
  if (!client) client = new OpenAI();
  return client;
}

/** Unit-length the vector so cosine distance and inner product agree. */
function normalize(v: number[]): number[] {
  let sum = 0;
  for (const x of v) sum += x * x;
  const norm = Math.sqrt(sum);
  if (norm === 0) return v;
  return v.map((x) => x / norm);
}

/** Embed a batch in one request. Order of the result matches the input. */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await getClient().embeddings.create({
    model: EMBEDDING_MODEL,
    dimensions: EMBEDDING_DIMENSIONS,
    input: texts,
  });
  // The API documents results as sorted by index, but it costs nothing to not
  // depend on that.
  return [...response.data]
    .sort((a, b) => a.index - b.index)
    .map((d) => normalize(d.embedding));
}

export async function embedOne(text: string): Promise<number[]> {
  const [embedding] = await embedBatch([text]);
  return embedding;
}

/** pgvector's text input format, e.g. "[0.1,0.2,0.3]". */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
