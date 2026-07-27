import fs from "fs";
import path from "path";
import Anthropic from "@anthropic-ai/sdk";
// Use relative path (not @/ alias) since this runs via tsx, not Next.js
import { searchChunks } from "../lib/retrieval";

const GOLDEN_SET_PATH = path.resolve(__dirname, "../data/golden_set.json");
const RESULTS_DIR = path.resolve(__dirname, "../eval_results");

interface GoldenQuestion {
  id: string;
  question: string;
  expected_episode_ids: string[];
  expected_answer_summary: string;
  difficulty: "easy" | "hard";
  category: "factual" | "multi-episode" | "out-of-scope";
}

interface EvalVerdict {
  id: string;
  question: string;
  category: string;
  difficulty: string;
  retrieved_episode_ids: string[];
  expected_episode_ids: string[];
  recall_at_k: boolean;
  generated_answer: string;
  verdict: "correct" | "partial" | "wrong" | "hallucinated";
  judge_reasoning: string;
}

interface EvalResult {
  timestamp: string;
  model: string;
  top_k: number;
  total_questions: number;
  accuracy: { correct: number; partial: number; wrong: number; hallucinated: number };
  recall_at_k: number;
  verdicts: EvalVerdict[];
}

const TOP_K = 4;

const anthropic = new Anthropic();

async function generateAnswer(question: string, topK: number): Promise<{ answer: string; retrievedEpisodeIds: string[] }> {
  const results = await searchChunks(question, topK);

  const retrievedEpisodeIds = [...new Set(results.map((r) => `ep${String(r.episodeId).padStart(2, "0")}`))];

  const contextText = results
    .map((r) => {
      const trimmed = r.text.replace(/\n{2,}/g, "\n").trim();
      return `[${r.episodeTitle}]\n${trimmed}`;
    })
    .join("\n---\n");

  const systemPrompt = `עוזר פודקאסט "איך פותרים את זה?" על טכנולוגיה סביבתית.
ענה רק מהקטעים שסופקו. ציין מאיזה פרק. עברית בלבד. אם אין תשובה — אמור זאת.`;

  // Use OpenAI for generation (matching the API route)
  const { default: OpenAI } = await import("openai");
  const openai = new OpenAI();
  const response = await openai.chat.completions.create({
    model: "gpt-4.1-nano",
    max_tokens: 300,
    temperature: 0.3,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `${question}\n\n${contextText}` },
    ],
  });

  return {
    answer: response.choices[0]?.message?.content || "",
    retrievedEpisodeIds,
  };
}

async function judgeAnswer(
  question: string,
  generatedAnswer: string,
  expectedSummary: string,
  expectedEpisodeIds: string[],
  category: string
): Promise<{ verdict: "correct" | "partial" | "wrong" | "hallucinated"; reasoning: string }> {
  const judgePrompt = `You are an evaluation judge for a Hebrew podcast RAG chatbot.

Given:
- Question: ${question}
- Expected answer summary: ${expectedSummary}
- Expected source episodes: ${expectedEpisodeIds.join(", ")}
- Question category: ${category}
- Generated answer: ${generatedAnswer}

Evaluate the generated answer and output a JSON object with:
- "verdict": one of "correct", "partial", "wrong", "hallucinated"
  - "correct": answer matches expected content and cites the right episode(s)
  - "partial": answer is partially correct or missing some expected content/citations
  - "wrong": answer does not match expected content
  - "hallucinated": answer fabricates information not present in the expected content
  For "out-of-scope" questions: "correct" means the bot refused to answer / said it doesn't know.
- "reasoning": short explanation (1-2 sentences)

Output ONLY the JSON object, no markdown fences.`;

  const response = await anthropic.messages.create({
    model: "claude-sonnet-4-20250514",
    max_tokens: 300,
    messages: [{ role: "user", content: judgePrompt }],
  });

  const text = response.content[0].type === "text" ? response.content[0].text : "";

  try {
    const parsed = JSON.parse(text);
    return { verdict: parsed.verdict, reasoning: parsed.reasoning };
  } catch {
    return { verdict: "wrong", reasoning: `Failed to parse judge response: ${text}` };
  }
}

async function main() {
  if (!fs.existsSync(GOLDEN_SET_PATH)) {
    console.error("golden_set.json not found at", GOLDEN_SET_PATH);
    process.exit(1);
  }

  const goldenSet: GoldenQuestion[] = JSON.parse(fs.readFileSync(GOLDEN_SET_PATH, "utf-8"));

  // Validate: skip empty questions
  const validQuestions = goldenSet.filter((q) => q.question.trim() !== "");
  if (validQuestions.length === 0) {
    console.error("No questions with content in golden_set.json. Fill in the questions first.");
    process.exit(1);
  }

  console.log(`Running eval on ${validQuestions.length} questions (top_k=${TOP_K})...\n`);

  const verdicts: EvalVerdict[] = [];
  let recallHits = 0;

  for (const q of validQuestions) {
    process.stdout.write(`  ${q.id}: ${q.question.slice(0, 50)}... `);

    const { answer, retrievedEpisodeIds } = await generateAnswer(q.question, TOP_K);

    // Recall@k: was at least one expected episode in retrieved results?
    const recallHit = q.expected_episode_ids.length === 0 ||
      q.expected_episode_ids.some((eid) => retrievedEpisodeIds.includes(eid));
    if (recallHit) recallHits++;

    const { verdict, reasoning } = await judgeAnswer(
      q.question,
      answer,
      q.expected_answer_summary,
      q.expected_episode_ids,
      q.category
    );

    verdicts.push({
      id: q.id,
      question: q.question,
      category: q.category,
      difficulty: q.difficulty,
      retrieved_episode_ids: retrievedEpisodeIds,
      expected_episode_ids: q.expected_episode_ids,
      recall_at_k: recallHit,
      generated_answer: answer,
      verdict,
      judge_reasoning: reasoning,
    });

    console.log(verdict.toUpperCase());
  }

  const accuracy = { correct: 0, partial: 0, wrong: 0, hallucinated: 0 };
  for (const v of verdicts) {
    accuracy[v.verdict]++;
  }

  const result: EvalResult = {
    timestamp: new Date().toISOString(),
    model: "gpt-4.1-nano",
    top_k: TOP_K,
    total_questions: validQuestions.length,
    accuracy,
    recall_at_k: recallHits / validQuestions.length,
    verdicts,
  };

  fs.mkdirSync(RESULTS_DIR, { recursive: true });
  const filename = `${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const outPath = path.join(RESULTS_DIR, filename);
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");

  console.log(`\n--- Results ---`);
  console.log(`Correct: ${accuracy.correct}/${validQuestions.length}`);
  console.log(`Partial: ${accuracy.partial}/${validQuestions.length}`);
  console.log(`Wrong: ${accuracy.wrong}/${validQuestions.length}`);
  console.log(`Hallucinated: ${accuracy.hallucinated}/${validQuestions.length}`);
  console.log(`Recall@${TOP_K}: ${(result.recall_at_k * 100).toFixed(0)}%`);
  console.log(`\nSaved to ${outPath}`);
}

main();