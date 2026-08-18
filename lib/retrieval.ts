import { sql } from "./db";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  embedOne,
  toVectorLiteral,
} from "./embeddings";

/**
 * Retrieval over the `chunks` table using pgvector.
 *
 * Previously this scanned data/embeddings.json in memory. That file was a
 * snapshot baked into the deploy, so the weekly ingest cron — which writes new
 * episodes straight into Postgres — could never actually reach the retriever.
 * Reading from the same table the cron writes to closes that loop.
 */

export interface EpisodeMeta {
  episodeNumber: number;
  title: string;
  guestName: string | null;
  companyName: string | null;
  problemSummary: string | null;
  solutionSummary: string | null;
  spotifyUrl: string | null;
  url: string | null;
}

export interface SearchResult extends EpisodeMeta {
  chunkId: string;
  startPosition: number;
  text: string;
  score: number;
}

/** A near-miss shown in the trace viewer — same shape, text truncated. */
export interface Candidate {
  chunkId: string;
  episodeNumber: number;
  episodeTitle: string;
  startPosition: number;
  score: number;
  preview: string;
}

export interface TracedSearch {
  results: SearchResult[];
  candidates: Candidate[];
  queryEmbedding: number[];
  embedMs: number;
  scoreMs: number;
  totalChunks: number;
}

/**
 * How many rows to pull for the trace viewer. The old implementation scored
 * every chunk and returned all of them; with the index doing the work we only
 * ever see what the index returns, so we ask for a few extra beyond top-k to
 * keep near-misses visible.
 */
const CANDIDATE_POOL = 10;

interface Row {
  id: string;
  start_position: number;
  text: string;
  score: number;
  episode_number: number;
  title: string;
  guest_name: string | null;
  company_name: string | null;
  problem_summary: string | null;
  solution_summary: string | null;
  spotify_url: string | null;
  url: string | null;
}

function toResult(row: Row): SearchResult {
  return {
    chunkId: row.id,
    startPosition: row.start_position,
    text: row.text,
    score: row.score,
    episodeNumber: row.episode_number,
    title: row.title,
    guestName: row.guest_name,
    companyName: row.company_name,
    problemSummary: row.problem_summary,
    solutionSummary: row.solution_summary,
    spotifyUrl: row.spotify_url,
    url: row.url,
  };
}

/**
 * Vector search with the intermediate state (query embedding, candidate pool,
 * per-stage timings) the log viewer renders.
 */
export async function searchChunksTraced(
  query: string,
  topK = 2
): Promise<TracedSearch> {
  const tEmbedStart = Date.now();
  const queryEmbedding = await embedOne(query);
  const tEmbedEnd = Date.now();

  const literal = toVectorLiteral(queryEmbedding);
  const poolSize = Math.max(CANDIDATE_POOL, topK);

  // `<=>` is cosine distance; 1 - distance gives the similarity the old
  // in-memory scorer reported, so scores stay comparable across the migration.
  //
  // The vector is bound once in a CTE rather than interpolated at both the
  // score and the ORDER BY. Serialized, a 1536-dim literal is ~25KB, so
  // repeating it doubled the bytes uploaded on every question — which measured
  // as ~600ms of the query time on a slow uplink.
  const { rows } = await sql<Row>`
    WITH q AS (SELECT ${literal}::vector AS v)
    SELECT
      c.id,
      c.start_position,
      c.text,
      1 - (c.embedding <=> q.v) AS score,
      e.episode_number,
      e.title,
      e.guest_name,
      e.company_name,
      e.problem_summary,
      e.solution_summary,
      e.spotify_url,
      e.url
    FROM chunks c
    JOIN episodes e ON e.id = c.episode_id
    CROSS JOIN q
    WHERE c.embedding IS NOT NULL
    ORDER BY c.embedding <=> q.v
    LIMIT ${poolSize}
  `;
  const tScoreEnd = Date.now();

  const scored = rows.map(toResult);

  return {
    results: scored.slice(0, topK),
    candidates: scored.map((c) => ({
      chunkId: c.chunkId,
      episodeNumber: c.episodeNumber,
      episodeTitle: c.title,
      startPosition: c.startPosition,
      score: c.score,
      preview: c.text.replace(/\s+/g, " ").trim().slice(0, 160),
    })),
    queryEmbedding,
    embedMs: tEmbedEnd - tEmbedStart,
    scoreMs: tScoreEnd - tEmbedEnd,
    totalChunks: rows.length,
  };
}

export async function searchChunks(
  query: string,
  topK = 2
): Promise<SearchResult[]> {
  const { results } = await searchChunksTraced(query, topK);
  return results;
}

export { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
