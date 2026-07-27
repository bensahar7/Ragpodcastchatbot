import { sql } from "./db";

/**
 * Daily spend guards for the chat endpoint. Every question costs money
 * (embedding is local, but generation is a paid OpenAI call), so both an
 * individual visitor and the site as a whole are capped per UTC day.
 *
 * Counters live in Postgres so they hold across serverless instances. If the
 * DB is unreachable we fall back to a per-instance in-memory counter — weaker,
 * but never fails open completely.
 */

export const PER_IP_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT_PER_IP ?? 15);
export const GLOBAL_DAILY_LIMIT = Number(process.env.CHAT_DAILY_LIMIT_GLOBAL ?? 300);
export const MAX_QUESTION_CHARS = Number(process.env.CHAT_MAX_QUESTION_CHARS ?? 400);

export interface LimitResult {
  allowed: boolean;
  /** Which cap was hit, for the error message. */
  scope?: "ip" | "global";
  ipCount: number;
  globalCount: number;
}

const memory = new Map<string, number>();
let tableReady = false;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function ensureTable() {
  if (tableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS chat_usage (
      day date NOT NULL,
      bucket text NOT NULL,
      count integer NOT NULL DEFAULT 0,
      PRIMARY KEY (day, bucket)
    )
  `;
  tableReady = true;
}

/** Increment a counter for today and return its new value. */
async function bump(bucket: string): Promise<number> {
  await ensureTable();
  const { rows } = await sql<{ count: number }>`
    INSERT INTO chat_usage (day, bucket, count)
    VALUES (CURRENT_DATE, ${bucket}, 1)
    ON CONFLICT (day, bucket)
    DO UPDATE SET count = chat_usage.count + 1
    RETURNING count
  `;
  return rows[0].count;
}

function bumpMemory(bucket: string): number {
  const key = `${today()}:${bucket}`;
  const next = (memory.get(key) ?? 0) + 1;
  memory.set(key, next);
  // Drop yesterday's keys so the map can't grow without bound.
  const prefix = `${today()}:`;
  for (const k of memory.keys()) {
    if (!k.startsWith(prefix)) memory.delete(k);
  }
  return next;
}

/**
 * Counts one question against both caps. Call this *before* spending money;
 * the counters are incremented optimistically, so a blocked request still
 * counts (which is what we want — it makes abuse self-limiting).
 */
export async function checkAndCount(ip: string): Promise<LimitResult> {
  let ipCount: number;
  let globalCount: number;

  try {
    [ipCount, globalCount] = await Promise.all([
      bump(`ip:${ip}`),
      bump("global"),
    ]);
  } catch (error) {
    console.warn("rate limit DB unavailable, using memory:", (error as Error).message);
    ipCount = bumpMemory(`ip:${ip}`);
    globalCount = bumpMemory("global");
  }

  if (globalCount > GLOBAL_DAILY_LIMIT) {
    return { allowed: false, scope: "global", ipCount, globalCount };
  }
  if (ipCount > PER_IP_DAILY_LIMIT) {
    return { allowed: false, scope: "ip", ipCount, globalCount };
  }
  return { allowed: true, ipCount, globalCount };
}

/** Best-effort client IP behind Vercel's proxy. */
export function clientIp(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0].trim();
  return headers.get("x-real-ip") ?? "unknown";
}
