import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { searchChunksTraced, type SearchResult } from "@/lib/retrieval";
import { EMBEDDING_MODEL } from "@/lib/embeddings";
import {
  checkAndCount,
  clientIp,
  MAX_QUESTION_CHARS,
  PER_IP_DAILY_LIMIT,
} from "@/lib/ratelimit";
import fs from "fs";
import path from "path";

const TRACES_PATH = path.resolve(process.cwd(), "traces.jsonl");

/**
 * Feeds the /api/traces viewer. Serverless filesystems are read-only outside
 * /tmp, so this only ever worked locally — skipping it in production drops a
 * guaranteed-to-throw sync write off the request path. Never let it fail the
 * request.
 */
function appendTrace(trace: Record<string, unknown>) {
  if (process.env.NODE_ENV === "production") return;
  try {
    fs.appendFileSync(TRACES_PATH, JSON.stringify(trace) + "\n", "utf-8");
  } catch (error) {
    console.warn("trace write skipped:", (error as Error).message);
  }
}

// Constructed on first request, not at module load. Next imports every route
// while collecting page data at build time, and a client built there would
// fail the whole build when OPENAI_API_KEY is absent from the build env.
let openaiClient: OpenAI | null = null;
function getOpenAI(): OpenAI {
  if (!openaiClient) openaiClient = new OpenAI();
  return openaiClient;
}

// Keep system prompt minimal — every token costs money
const SYSTEM_PROMPT = `אתה עוזר של הפודקאסט "איך פותרים את זה?" — טכנולוגיה סביבתית.

ענה בקצרה — משפט או שניים לכל פרק, לא יותר. ענה רק על סמך הקטעים שסופקו.
אם אין תשובה בקטעים — אמור זאת בפירוש, אל תמציא.

בסוף התשובה, הוסף שורה ריקה ואז את הקישורים (כל קישור בשורה נפרדה):
- קישור לדף הפרק מתוך שדה page_url ב-metadata (כתובת URL חשופה, בלי markdown)
- קישור לספוטיפיי מתוך שדה spotify_url אם קיים
לעולם אל תמציא קישור. אל תשתמש בתחביר markdown לקישורים.

סגנון: טבעי וידידותי, כמו חבר שממליץ. לא רשימות שדות, לא תוויות כמו "נושא:" או "אורח:".
אם שדה חסר ב-metadata — פשוט אל תזכיר אותו.

אם רלוונטי ליותר מפרק אחד — משפט-שניים לכל פרק.

עברית בלבד.`;

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

/**
 * The metadata block the system prompt refers to. Only fields that actually
 * have a value are emitted, because the prompt instructs the model to skip
 * what isn't there and it can't do that if we hand it empty strings.
 */
function metadataLine(result: SearchResult): string {
  const fields: string[] = [`episode: ${result.episodeNumber}`, `title: ${result.title}`];
  if (result.guestName) fields.push(`guest: ${result.guestName}`);
  if (result.companyName) fields.push(`company: ${result.companyName}`);
  if (result.problemSummary) fields.push(`problem: ${result.problemSummary}`);
  if (result.solutionSummary) fields.push(`solution: ${result.solutionSummary}`);
  if (result.url) fields.push(`page_url: ${result.url}`);
  if (result.spotifyUrl) fields.push(`spotify_url: ${result.spotifyUrl}`);
  return fields.join(" | ");
}

/** OpenAI billing exhaustion / quota, as opposed to a genuine bug. */
function isQuotaError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const e = error as { status?: number; type?: string; code?: string };
  return (
    e.type === "insufficient_quota" ||
    e.code === "credit_balance_exhausted" ||
    e.code === "insufficient_quota" ||
    e.status === 429
  );
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

    const t0 = Date.now();

    // The rate-limit check and retrieval are independent, and both are network
    // round-trips. Running them together rather than back to back takes the
    // slower of the two off the critical path instead of summing them. Nothing
    // has been *spent* yet — the paid generation call still waits on the limit.
    const TOP_K = 2;
    const [limit, search] = await Promise.all([
      checkAndCount(clientIp(request.headers)),
      searchChunksTraced(question, TOP_K),
    ]);

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

    const results = search.results;
    const tRetrieval = Date.now();

    if (results.length === 0) {
      return NextResponse.json(
        { error: "לא נמצא תוכן רלוונטי. נסו לנסח את השאלה אחרת." },
        { status: 503, headers: cors }
      );
    }

    // Build context — compact format, strip excess whitespace
    const contextText = results
      .map((r) => {
        const trimmed = r.text.replace(/\n{2,}/g, "\n").trim();
        return `[metadata: ${metadataLine(r)}]\n${trimmed}`;
      })
      .join("\n---\n");

    const userMessage = `${question}\n\n${contextText}`;

    const requestBody = {
      model: "gpt-4.1-nano",
      max_tokens: 300,
      temperature: 0.3,
      messages: [
        { role: "system" as const, content: SYSTEM_PROMPT },
        { role: "user" as const, content: userMessage },
      ],
    };

    const sources = [
      ...new Set(results.map((r) => `פרק ${r.episodeNumber}: ${r.title}`)),
    ];

    const tGenStart = Date.now();
    const stream = await getOpenAI().chat.completions.create({
      ...requestBody,
      stream: true,
      stream_options: { include_usage: true },
    });

    // Newline-delimited JSON. Sources go out first so the widget can render the
    // citation line immediately, then answer text arrives token by token —
    // first paint lands in well under a second instead of after generation.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (event: Record<string, unknown>) =>
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));

        let answer = "";
        let usage: unknown = null;

        try {
          send({ type: "sources", sources });

          for await (const part of stream) {
            const delta = part.choices[0]?.delta?.content;
            if (delta) {
              answer += delta;
              send({ type: "delta", text: delta });
            }
            if (part.usage) usage = part.usage;
          }

          send({ type: "done" });
        } catch (error) {
          console.error("Chat stream error:", error);
          send({ type: "error", error: "שגיאה: לא הצלחתי לעבד את השאלה." });
        } finally {
          controller.close();

          const tGenEnd = Date.now();
          const round = (n: number) => Math.round(n * 10000) / 10000;
          const latency = {
            retrieval: tRetrieval - t0,
            embedding: search.embedMs,
            vector_search: search.scoreMs,
            generation: tGenEnd - tGenStart,
            total: tGenEnd - t0,
          };

          // Always visible in `vercel logs` — this is what tells you whether a
          // slow request was embedding, the vector query, or generation.
          console.log(
            JSON.stringify({ question, embedding_model: EMBEDDING_MODEL, usage, latency_ms: latency })
          );

          appendTrace({
            timestamp: new Date().toISOString(),
            question,
            retrieved_chunks: results.map((r) => ({
              chunk_id: r.chunkId,
              episode_id: `ep${String(r.episodeNumber).padStart(2, "0")}`,
              episode_title: r.title,
              score: round(r.score),
            })),
            final_prompt: `${SYSTEM_PROMPT}\n\n${userMessage}`,
            answer,
            latency_ms: latency,
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
                input: { text: question, model: EMBEDDING_MODEL },
                output: {
                  dimensions: search.queryEmbedding.length,
                  normalized: true,
                  preview: search.queryEmbedding.slice(0, 8).map(round),
                },
              },
              {
                name: "Retrieval",
                status: "ok",
                latency_ms: search.scoreMs,
                input: {
                  store: "postgres + pgvector",
                  embedding_dimensions: search.queryEmbedding.length,
                  candidates_fetched: search.totalChunks,
                  top_k: TOP_K,
                  metric: "cosine distance (<=>)",
                },
                output: {
                  candidates: search.candidates.map((c, i) => ({
                    rank: i + 1,
                    chunk_id: c.chunkId,
                    episode_id: `ep${String(c.episodeNumber).padStart(2, "0")}`,
                    episode_title: c.episodeTitle,
                    score: round(c.score),
                    preview: c.preview,
                    selected: i < TOP_K,
                  })),
                  selected: results.map((r, i) => ({
                    rank: i + 1,
                    chunk_id: r.chunkId,
                    episode_id: `ep${String(r.episodeNumber).padStart(2, "0")}`,
                    episode_title: r.title,
                    score: round(r.score),
                    chunk_text: r.text,
                  })),
                },
              },
              {
                name: "Prompt Construction",
                status: "ok",
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
                  streamed: true,
                },
                output: { raw_content: answer, usage },
              },
              {
                name: "Post-processing",
                status: "passthrough",
                note: "Answer text is streamed through untransformed; source labels are derived from the retrieved chunks.",
                input: { raw_content: answer },
                output: { answer, sources },
              },
            ],
          });
        }
      },
    });

    return new Response(body, {
      headers: {
        ...cors,
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        // Vercel's edge buffers responses without this, which would defeat
        // streaming entirely — the user would still wait for the last token.
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    console.error("Chat API error:", error);

    // A drained OpenAI balance is an operational state, not a code fault: it
    // surfaces here as a 429/insufficient_quota from the embedding call before
    // retrieval even runs. Reporting it as a 500 sent the widget a generic
    // "couldn't process the question" and left no trace in the browser of what
    // was actually wrong.
    if (isQuotaError(error)) {
      return NextResponse.json(
        { error: "השירות אינו זמין כרגע. נסו שוב מאוחר יותר." },
        { status: 503, headers: cors }
      );
    }

    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500, headers: cors }
    );
  }
}
