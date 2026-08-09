import { sql } from "@vercel/postgres";
import { chunkTranscript } from "../lib/chunker";
import {
  EMBEDDING_DIMENSIONS,
  contextualizeChunk,
  embedBatch,
  toVectorLiteral,
} from "../lib/embeddings";

/**
 * Rebuilds every chunk from the transcripts already stored in `episodes`, then
 * embeds them.
 *
 * Needed after a chunker change. Episodes scraped without blank lines between
 * speaker turns previously collapsed into a single transcript-sized chunk, so
 * their rows have to be regenerated, not just re-embedded.
 *
 * Run with no arguments to rebuild everything, or pass episode numbers to limit
 * the scope: `npm run rechunk -- 9 10 15`.
 */

const EMBED_BATCH = 96;

const only = process.argv
  .slice(2)
  .map(Number)
  .filter((n) => Number.isInteger(n) && n > 0);

interface EpisodeRow {
  id: string;
  episode_number: number;
  title: string;
  transcript: string | null;
}

/**
 * Widen (or narrow) chunks.embedding to match EMBEDDING_DIMENSIONS. pgvector
 * fixes the width at the column level, so changing embedding model without
 * this fails on insert with a dimension mismatch.
 */
async function ensureColumnWidth() {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;

  const { rows } = await sql<{ dims: number }>`
    SELECT atttypmod AS dims FROM pg_attribute
    WHERE attrelid = 'chunks'::regclass AND attname = 'embedding'`;

  if (rows[0]?.dims === EMBEDDING_DIMENSIONS) return;

  console.log(`Resizing chunks.embedding ${rows[0]?.dims} -> ${EMBEDDING_DIMENSIONS}`);
  // The index binds to the old width and blocks the type change.
  await sql`DROP INDEX IF EXISTS idx_chunks_embedding`;
  // DDL takes no bind parameters, so the width is inlined. It's an integer
  // constant from our own module, never user input.
  await sql.query(
    `ALTER TABLE chunks ALTER COLUMN embedding TYPE vector(${Number(EMBEDDING_DIMENSIONS)}) USING NULL`
  );
}

async function main() {
  await ensureColumnWidth();

  const { rows: episodes } = only.length
    ? await sql<EpisodeRow>`
        SELECT id, episode_number, title, transcript FROM episodes
        WHERE episode_number = ANY(${`{${only.join(",")}}`}::int[])
        ORDER BY episode_number`
    : await sql<EpisodeRow>`
        SELECT id, episode_number, title, transcript FROM episodes ORDER BY episode_number`;

  console.log(`Rebuilding chunks for ${episodes.length} episode(s)\n`);

  for (const episode of episodes) {
    if (!episode.transcript?.trim()) {
      console.log(`  ep${episode.episode_number}: no transcript, skipped`);
      continue;
    }

    const chunks = chunkTranscript(episode.transcript);
    if (chunks.length === 0) {
      console.log(`  ep${episode.episode_number}: chunker produced nothing, skipped`);
      continue;
    }

    // Embed before deleting, so a failure here leaves the existing rows intact
    // rather than emptying the episode out of the index.
    const vectors: number[][] = [];
    for (let i = 0; i < chunks.length; i += EMBED_BATCH) {
      vectors.push(
        ...(await embedBatch(
          chunks
            .slice(i, i + EMBED_BATCH)
            .map((c) => contextualizeChunk(episode.title, c.text))
        ))
      );
    }

    await sql`DELETE FROM chunks WHERE episode_id = ${episode.id}`;
    for (let i = 0; i < chunks.length; i++) {
      await sql`
        INSERT INTO chunks (episode_id, start_position, text, embedding)
        VALUES (
          ${episode.id},
          ${chunks[i].startPosition},
          ${chunks[i].text},
          ${toVectorLiteral(vectors[i])}::vector
        )
      `;
    }

    const longest = Math.max(...chunks.map((c) => c.text.length));
    console.log(
      `  ep${episode.episode_number}: ${chunks.length} chunks (longest ${longest} chars)`
    );
  }

  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  await sql`
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON chunks USING hnsw (embedding vector_cosine_ops)
  `;

  const { rows } = await sql<{ total: number; embedded: number }>`
    SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM chunks
  `;
  console.log(`\nDone — ${rows[0].embedded}/${rows[0].total} chunks embedded.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
