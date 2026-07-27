import fs from "fs";
import path from "path";

interface EmbeddedChunk {
  episodeId: number;
  episodeTitle: string;
  chunkIndex: number;
  text: string;
  embedding: number[];
}

export interface SearchResult {
  episodeId: number;
  episodeTitle: string;
  chunkIndex: number;
  text: string;
  score: number;
}

let chunks: EmbeddedChunk[] | null = null;
let extractorPromise: Promise<any> | null = null;

function loadChunks(): EmbeddedChunk[] {
  if (!chunks) {
    const filePath = path.resolve(
      process.cwd(),
      "data/embeddings.json"
    );
    chunks = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  }
  return chunks!;
}

async function getExtractor() {
  if (!extractorPromise) {
    extractorPromise = import("@xenova/transformers").then(({ pipeline, env }) => {
      // Serverless filesystems are read-only apart from /tmp, so the default
      // node_modules/.cache download location fails at request time.
      env.cacheDir = "/tmp/transformers-cache";
      env.allowLocalModels = false;
      env.useBrowserCache = false;
      return pipeline("feature-extraction", "Xenova/multilingual-e5-small");
    });
  }
  return extractorPromise;
}

function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  // Vectors are already normalized, so dot product = cosine similarity
  return dot;
}

export interface Candidate {
  episodeId: number;
  episodeTitle: string;
  chunkIndex: number;
  score: number;
  preview: string;
}

export interface TracedSearch {
  results: SearchResult[];
  /** Every chunk considered, scored and sorted — lets the viewer show near-misses. */
  candidates: Candidate[];
  queryEmbedding: number[];
  embeddedQuery: string;
  embedMs: number;
  scoreMs: number;
}

/**
 * Same search as searchChunks, but returns the intermediate state (query
 * embedding, all scored candidates, per-stage timings) for the log viewer.
 */
export async function searchChunksTraced(
  query: string,
  topK = 2
): Promise<TracedSearch> {
  const extractor = await getExtractor();
  // multilingual-e5 expects "query: " prefix for queries
  const embeddedQuery = `query: ${query}`;

  const tEmbedStart = Date.now();
  const output = await extractor(embeddedQuery, {
    pooling: "mean",
    normalize: true,
  });
  const queryEmbedding = Array.from(output.data as Float32Array) as number[];
  const tEmbedEnd = Date.now();

  const allChunks = loadChunks();

  const scored = allChunks.map((chunk) => ({
    episodeId: chunk.episodeId,
    episodeTitle: chunk.episodeTitle,
    chunkIndex: chunk.chunkIndex,
    text: chunk.text,
    score: cosineSimilarity(queryEmbedding, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  const tScoreEnd = Date.now();

  return {
    results: scored.slice(0, topK),
    // Full text would be ~350KB per trace across all chunks — preview is enough
    // to recognise a near-miss; the top-k keep their full text.
    candidates: scored.map((c) => ({
      episodeId: c.episodeId,
      episodeTitle: c.episodeTitle,
      chunkIndex: c.chunkIndex,
      score: c.score,
      preview: c.text.replace(/\s+/g, " ").trim().slice(0, 160),
    })),
    queryEmbedding,
    embeddedQuery,
    embedMs: tEmbedEnd - tEmbedStart,
    scoreMs: tScoreEnd - tEmbedEnd,
  };
}

export async function searchChunks(
  query: string,
  topK = 2
): Promise<SearchResult[]> {
  const { results } = await searchChunksTraced(query, topK);
  return results;
}
