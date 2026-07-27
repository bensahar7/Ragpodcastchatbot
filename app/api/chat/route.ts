import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { searchChunksTraced } from "@/lib/retrieval";
import {
  checkAndCount,
  clientIp,
  MAX_QUESTION_CHARS,
  PER_IP_DAILY_LIMIT,
} from "@/lib/ratelimit";
import fs from "fs";
import path from "path";

// Constructed on first request, not at module load. Next imports every route
// while collecting page data at build time, and a client built there would
// fail the whole build when OPENAI_API_KEY is absent from the build env.
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI();
  return openaiClient;
}

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
  // Serverless filesystems are read-only outside /tmp, so tracing is a
  // local-dev convenience only. Never let it fail the request.
  try {
    fs.appendFileSync(TRACES_PATH, JSON.stringify(trace) + "\n", "utf-8");
  } catch (error) {
    console.warn("trace write skipped:", (error as Error).message);
  }
}

// Origins allowed to call this API from a browser. Comma-separated env var,
// e.g. "https://podcast.example.com,https://www.podcast.example.com".
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

// Browsers send Origin on POST even same-origin, so in dev the local page
// would otherwise be rejected as a cross-origin caller. Never true in prod.
const isLocalDevOrigin = (origin: string) =>
  process.env.NODE_ENV !== "production" &&
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);

function corsHeaders(origin: string | null): Record<string, string> {
  // Same-origin requests send no Origin header and need no CORS headers.
  if (!origin) return {};
  if (!ALLOWED_ORIGINS.includes(origin) && !isLocalDevOrigin(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

/** CORS preflight. */
export async function OPTIONS(request: NextRequest) {
  const origin = request.headers.get("origin");
  const headers = corsHeaders(origin);
  if (Object.keys(headers).length === 0) {
    return new NextResponse(null, { status: 403 });
  }
  return new NextResponse(null, { status: 204, headers });
}

export async function POST(request: NextRequest) {
  const origin = request.headers.get("origin");
  const cors = corsHeaders(origin);

  // A cross-origin caller we don't recognise never reaches the LLM —
  // this endpoint spends money on every request.
  if (origin && Object.keys(cors).length === 0) {
    return NextResponse.json({ error: "Origin not allowed" }, { status: 403 });
  }

  try {
    const { question } = await request.json();

    if (!question || typeof question !== "string") {
      return NextResponse.json(
        { error: "Missing question field" },
        { status: 400, headers: cors }
      );
    }

    // A very long question inflates input tokens for no benefit.
    if (question.length > MAX_QUESTION_CHARS) {
      return NextResponse.json(
        { error: `השאלה ארוכה מדי (עד ${MAX_QUESTION_CHARS} תווים).` },
        { status: 400, headers: cors }
      );
    }

    // Daily caps — checked before any paid call.
    const limit = await checkAndCount(clientIp(request.headers));
    if (!limit.allowed) {
      return NextResponse.json(
        {
          error:
            limit.scope === "ip"
              ? `הגעת למכסת השאלות היומית (${PER_IP_DAILY_LIMIT} שאלות). נסו שוב מחר.`
              : "השירות הגיע למכסת השאלות היומית. נסו שוב מחר.",
        },
        { status: 429, headers: cors }
      );
    }

    const t0 = Date.now();

    // Retrieve top 4 chunks (not 6 — saves ~30% input tokens)
    const TOP_K = 2;
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
    const response = await getOpenAI().chat.completions.create(requestBody);
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

    return NextResponse.json({ answer, sources }, { headers: cors });
  } catch (error) {
    console.error("Chat API error:", error);
    // TEMPORARY: surface the cause so a failing deployment can be diagnosed
    // without runtime-log access. Remove once the endpoint is stable.
    const err = error as Error;
    return NextResponse.json(
      {
        error: "Internal server error",
        detail: err?.message ?? String(error),
        stack: err?.stack?.split("\n").slice(0, 6).join(" | "),
      },
      { status: 500, headers: cors }
    );
  }
}
