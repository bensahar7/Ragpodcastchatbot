import { sql } from "@vercel/postgres";
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MODEL,
  contextualizeChunk,
  embedBatch,
  toVectorLiteral,
} from "../lib/embeddings";

/**
 * Backfills embeddings for every chunk in Postgres that doesn't have one, then
 * makes sure the vector index exists.
 *
 * Idempotent and safe to re-run: it only touches rows where embedding IS NULL,
 * so the weekly ingest cron can insert new chunks and this fills them in.
 * Pass --all to re-embed everything (needed if the embedding model changes).
 */

const BATCH_SIZE = 96;
const reembedAll = process.argv.includes("--all");

interface PendingChunk {
  id: string;
  text: string;
  title: string;
}

async function ensureIndex() {
  await sql`CREATE EXTENSION IF NOT EXISTS vector`;
  // Cosine, matching the `<=>` operator the retriever orders by. At a few
  // hundred chunks a sequential scan is already fast, but the index keeps the
  // query flat as episodes accumulate.
  await sql`
    CREATE INDEX IF NOT EXISTS idx_chunks_embedding
    ON chunks USING hnsw (embedding vector_cosine_ops)
  `;
}

async function main() {
  console.log(`Model: ${EMBEDDING_MODEL} @ ${EMBEDDING_DIMENSIONS} dimensions`);

  if (reembedAll) {
    console.log("--all: clearing existing embeddings first");
    await sql`UPDATE chunks SET embedding = NULL`;
  }

  const { rows: pending } = await sql<PendingChunk>`
    SELECT c.id, c.text, e.title
    FROM chunks c JOIN episodes e ON e.id = c.episode_id
    WHERE c.embedding IS NULL
    ORDER BY c.created_at
  `;

  if (pending.length === 0) {
    console.log("Every chunk already has an embedding.");
    await ensureIndex();
    return;
  }

  console.log(`Embedding ${pending.length} chunks...`);

  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    // The e5-specific "passage: " prefix is gone; the episode title takes its
    // place as the chunk's topical anchor. See contextualizeChunk.
    const vectors = await embedBatch(
      batch.map((c) => contextualizeChunk(c.title, c.text))
    );

    for (let j = 0; j < batch.length; j++) {
      await sql`
        UPDATE chunks
        SET embedding = ${toVectorLiteral(vectors[j])}::vector,
            updated_at = now()
        WHERE id = ${batch[j].id}
      `;
    }

    console.log(`  ${Math.min(i + BATCH_SIZE, pending.length)}/${pending.length}`);
  }

  await ensureIndex();

  const { rows } = await sql<{ total: number; embedded: number }>`
    SELECT count(*)::int AS total, count(embedding)::int AS embedded FROM chunks
  `;
  console.log(`\nDone — ${rows[0].embedded}/${rows[0].total} chunks embedded.`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
