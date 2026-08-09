import fs from "fs";
import path from "path";
import { searchChunks } from "../lib/retrieval";

/**
 * Retrieval-only check against the golden set: did the expected episode make it
 * into the top-k? No LLM judge, so this is cheap enough to run on every
 * retrieval change (embedding model, chunker, top-k) to catch a regression
 * before it reaches generation.
 */

const GOLDEN_SET_PATH = path.resolve(__dirname, "../data/golden_set.json");
const TOP_K = Number(process.argv[2] ?? 2);

interface GoldenQuestion {
  id: string;
  question: string;
  expected_episode_ids: string[];
  category: string;
}

async function main() {
  const golden: GoldenQuestion[] = JSON.parse(
    fs.readFileSync(GOLDEN_SET_PATH, "utf-8")
  ).filter((q: GoldenQuestion) => q.question.trim() !== "");

  let hits = 0;
  let scored = 0;

  for (const q of golden) {
    const results = await searchChunks(q.question, TOP_K);
    const retrieved = [
      ...new Set(results.map((r) => `ep${String(r.episodeNumber).padStart(2, "0")}`)),
    ];

    // Out-of-scope questions have no expected episode — retrieval can't be
    // wrong, so they don't count toward recall either way.
    if (q.expected_episode_ids.length === 0) {
      console.log(`  ${q.id.padEnd(6)} n/a   (${q.category}) → ${retrieved.join(",")}`);
      continue;
    }

    scored++;
    const hit = q.expected_episode_ids.some((e) => retrieved.includes(e));
    if (hit) hits++;

    console.log(
      `  ${q.id.padEnd(6)} ${hit ? "HIT " : "MISS"}  expected ${q.expected_episode_ids.join(",")} → got ${retrieved.join(",")}`
    );
  }

  console.log(`\nRecall@${TOP_K}: ${hits}/${scored} (${Math.round((hits / scored) * 100)}%)`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
