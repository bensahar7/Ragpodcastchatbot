import fs from "fs";
import path from "path";

const RESULTS_DIR = path.resolve(__dirname, "../eval_results");

interface EvalResult {
  timestamp: string;
  model: string;
  top_k: number;
  total_questions: number;
  accuracy: { correct: number; partial: number; wrong: number; hallucinated: number };
  recall_at_k: number;
  verdicts: { id: string; question: string; verdict: string }[];
}

function loadResults(): EvalResult[] {
  if (!fs.existsSync(RESULTS_DIR)) return [];
  return fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), "utf-8")));
}

function main() {
  const results = loadResults();

  if (results.length === 0) {
    console.log("No eval results found. Run the eval script first: npm run eval");
    process.exit(0);
  }

  if (results.length === 1) {
    const r = results[0];
    console.log(`Only one eval run found (${r.timestamp}):`);
    console.log(`  Correct: ${r.accuracy.correct}/${r.total_questions}`);
    console.log(`  Partial: ${r.accuracy.partial}/${r.total_questions}`);
    console.log(`  Wrong: ${r.accuracy.wrong}/${r.total_questions}`);
    console.log(`  Hallucinated: ${r.accuracy.hallucinated}/${r.total_questions}`);
    console.log(`  Recall@${r.top_k}: ${(r.recall_at_k * 100).toFixed(0)}%`);
    console.log("\nRun eval again after making changes to see a diff.");
    process.exit(0);
  }

  const prev = results[results.length - 2];
  const curr = results[results.length - 1];

  console.log(`Comparing eval runs:`);
  console.log(`  Previous: ${prev.timestamp}`);
  console.log(`  Current:  ${curr.timestamp}\n`);

  // Overall accuracy delta
  const prevScore = prev.accuracy.correct / prev.total_questions;
  const currScore = curr.accuracy.correct / curr.total_questions;
  const delta = currScore - prevScore;
  const sign = delta >= 0 ? "+" : "";
  console.log(`Accuracy: ${(prevScore * 100).toFixed(0)}% → ${(currScore * 100).toFixed(0)}% (${sign}${(delta * 100).toFixed(0)}%)`);
  console.log(`Recall@k: ${(prev.recall_at_k * 100).toFixed(0)}% → ${(curr.recall_at_k * 100).toFixed(0)}%\n`);

  // Per-question flips
  const prevMap = new Map(prev.verdicts.map((v) => [v.id, v.verdict]));
  const currMap = new Map(curr.verdicts.map((v) => [v.id, v.verdict]));

  const improved: string[] = [];
  const regressed: string[] = [];

  for (const v of curr.verdicts) {
    const prevVerdict = prevMap.get(v.id);
    if (!prevVerdict) continue;
    if (prevVerdict !== v.verdict) {
      const isImprovement =
        (prevVerdict === "wrong" || prevVerdict === "hallucinated") &&
        (v.verdict === "correct" || v.verdict === "partial");
      const isRegression =
        (prevVerdict === "correct" || prevVerdict === "partial") &&
        (v.verdict === "wrong" || v.verdict === "hallucinated");

      if (isImprovement) {
        improved.push(`  ✓ ${v.id}: ${prevVerdict} → ${v.verdict} ("${v.question.slice(0, 50)}")`);
      } else if (isRegression) {
        regressed.push(`  ✗ ${v.id}: ${prevVerdict} → ${v.verdict} ("${v.question.slice(0, 50)}")`);
      }
    }
  }

  if (improved.length > 0) {
    console.log(`Improved (${improved.length}):`);
    improved.forEach((l) => console.log(l));
  }
  if (regressed.length > 0) {
    console.log(`Regressed (${regressed.length}):`);
    regressed.forEach((l) => console.log(l));
  }
  if (improved.length === 0 && regressed.length === 0) {
    console.log("No question-level changes between runs.");
  }
}

main();
