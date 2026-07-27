import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { searchChunksTraced } from "@/lib/retrieval";
import fs from "fs";
import path from "path";

const openai = new OpenAI();

// Keep system prompt minimal — every token costs money
const SYSTEM_PROMPT =  `אתה עוזר של הפודקאסט "איך פותרים את זה?" — טכנולוגיה סביבתית.

ענה רק על סמך הקטעים שסופקו. צטט פרטים ספציפיים מהתוכן (מספרים, שמות טכנולוגיות, 
מה שהדוברים אמרו בפועל) — אל תסכם בצורה כללית.
אם אין תשובה בקטעים — אמור זאת בפירוש, אל תמציא.

כשאתה ממליץ על פרק, ספר עליו כמו שחבר היה מספר — במשפטים רציפים וטבעיים, לא 
כרשימת שדות וכותרות. שלב באופן טבעי: שם הפרק, מי מדבר בו, ועל מה הוא עוסק — 
רק את השדות שבאמת קיימים ב-metadata שסופק. אל תשתמש בתוויות כמו "מי מדבר:" 
או "על עולם הבעיה:" — זה צריך להישמע כמו המלצה אנושית, לא מילוי טופס.

אם שדה מסוים (שמות דוברים, תיאור נושא) לא קיים ב-metadata — פשוט אל תזכיר 
אותו, בלי לציין שהוא חסר. לעולם אל תמלא placeholder כמו "Guest" או "לא צוין".

קישור לספוטיפיי מוצג בנפרד בסוף התשובה (לא בתוך הטקסט הרץ), רק אם spotify_url 
קיים ב-metadata. לעולם אל תמציא קישור.

אם רלוונטי ליותר מפרק אחד — ספר על כל פרק בפסקה נפרדת, באותו סגנון נרטיבי.

עברית בלבד.`;

const TRACES_PATH = path.resolve(process.cwd(), "traces.jsonl");

function appendTrace(trace: Record<string, unknown>) {
  fs.appendFileSync(TRACES_PATH, JSON.stringify(trace) + "\n", "utf-8");
}

export async function POST(request: NextRequest) {
  try {
    const { question } = await request.json();

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { error: "Missing question field" },
        { status: 400 }
      );
    }

    const t0 = Date.now();

    // Retrieve top 4 chunks (not 6 — saves ~30% input tokens)
    const TOP_K = 4;
    const search = await searchChunksTraced(question, TOP_K);
    const results = search.results;
    const tRetrieval = Date.now();

    // Build context — compact format, strip excess whitespace
    const contextText = results
      .map((r) => {
        const trimmed = r.text.replace(/\n{2,}/g, "\n").trim();
        return `[${r.episodeTitle}]\n${trimmed}`;
      })
      .join("\n---\n");

    const userMessage = `${question}\n\n${contextText}`;
    const tPromptBuilt = Date.now();

    // Built once and passed straight to the API, so what the viewer shows is
    // literally what was sent — not a reconstruction.
    const requestBody = {
      model: "gpt-4.1-nano",
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: userMessage },
      ],
    };

    const tGenStart = Date.now();
    const response = await openai.chat.completions.create(requestBody);
    const tGenEnd = Date.now();

    const rawAnswer = response.choices[0]?.message?.content ?? null;
    const answer = rawAnswer || "";

    const sources = [
      ...new Set(results.map((r) => `פרק ${r.episodeId}: ${r.episodeTitle}`)),
    ];

    // Log token usage for monitoring
    if (response.usage) {
      console.log(
        `Tokens — in: ${response.usage.prompt_tokens}, out: ${response.usage.completion_tokens}, total: ${response.usage.total_tokens}`
      );
    }

    const round = (n: number) => Math.round(n * 10000) / 10000;

    // Write full trace — one entry per pipeline step, each with its own
    // input/output, so the viewer can render the chain node by node.
    appendTrace({
      timestamp: new Date().toISOString(),
      question,
      retrieved_chunks: results.map((r) => ({
        chunk_id: `ep${r.episodeId}_chunk${r.chunkIndex}`,
        episode_id: `ep${String(r.episodeId).padStart(2, "0")}`,
        episode_title: r.episodeTitle,
        score: round(r.score),
      })),
      final_prompt: `${SYSTEM_PROMPT}\n\n${userMessage}`,
      answer,
      latency_ms: {
        retrieval: tRetrieval - t0,
        generation: tGenEnd - tGenStart,
        total: tGenEnd - t0,
      },
      steps: [
        {
          name: "Question Received",
          status: "ok",
          input: { question },
          output: { question },
        },
        {
          name: "Embedding",
          status: "ok",
          latency_ms: search.embedMs,
          input: {
            text: question,
            // e5 requires this prefix; worth seeing that it was applied
            embedded_text: search.embeddedQuery,
            model: "Xenova/multilingual-e5-small",
          },
          output: {
            dimensions: search.queryEmbedding.length,
            normalized: true,
            preview: search.queryEmbedding.slice(0, 8).map(round),
          },
        },
        {
          name: "Retrieval",
          status: "ok",
          latency_ms: tRetrieval - t0,
          input: {
            embedding_dimensions: search.queryEmbedding.length,
            embedding_preview: search.queryEmbedding.slice(0, 8).map(round),
            total_chunks_in_index: search.candidates.length,
            top_k: TOP_K,
            metric: "cosine similarity",
            scoring_ms: search.scoreMs,
          },
          output: {
            candidates: search.candidates.map((c, i) => ({
              rank: i + 1,
              episode_id: `ep${String(c.episodeId).padStart(2, "0")}`,
              episode_title: c.episodeTitle,
              chunk_index: c.chunkIndex,
              score: round(c.score),
              preview: c.preview,
              selected: i < TOP_K,
            })),
            selected: results.map((r, i) => ({
              rank: i + 1,
              episode_id: `ep${String(r.episodeId).padStart(2, "0")}`,
              episode_title: r.episodeTitle,
              chunk_index: r.chunkIndex,
              score: round(r.score),
              chunk_text: r.text,
            })),
          },
        },
        {
          name: "Prompt Construction",
          status: "ok",
          latency_ms: tPromptBuilt - tRetrieval,
          input: {
            system_prompt_template: SYSTEM_PROMPT,
            question,
            chunks_used: results.length,
            context_chars: contextText.length,
          },
          output: {
            request_params: {
              model: requestBody.model,
              temperature: requestBody.temperature,
              max_tokens: requestBody.max_tokens,
            },
            exact_prompt_sent: requestBody.messages
              .map((m) => `### ${m.role}\n${m.content}`)
              .join("\n\n"),
          },
        },
        {
          name: "Generation",
          status: "ok",
          latency_ms: tGenEnd - tGenStart,
          input: {
            source: "the exact prompt from step 4",
            model: requestBody.model,
            temperature: requestBody.temperature,
            max_tokens: requestBody.max_tokens,
            prompt_chars: SYSTEM_PROMPT.length + userMessage.length,
          },
          output: {
            raw_content: rawAnswer,
            finish_reason: response.choices[0]?.finish_reason ?? null,
            usage: response.usage ?? null,
          },
        },
        {
          name: "Post-processing",
          status: "passthrough",
          note: "No transformation of the answer text — empty content is coerced to \"\" and source labels are derived from the retrieved chunks.",
          input: { raw_content: rawAnswer },
          output: { answer, sources },
        },
      ],
    });

    return NextResponse.json({ answer, sources });
  } catch (error) {
    console.error("Chat API error:", error);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 }
    );
  }
}
