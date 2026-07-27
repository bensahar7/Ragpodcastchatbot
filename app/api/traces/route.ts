import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const TRACES_PATH = path.resolve(process.cwd(), "traces.jsonl");
const RESULTS_DIR = path.resolve(process.cwd(), "eval_results");

type Trace = Record<string, unknown>;
type EvalResult = { verdicts?: unknown[] } & Record<string, unknown>;

function readTraces(): Trace[] {
  if (!fs.existsSync(TRACES_PATH)) return [];
  return fs
    .readFileSync(TRACES_PATH, "utf-8")
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Trace];
      } catch {
        return [];
      }
    });
}

function readLatestEval(): EvalResult | null {
  if (!fs.existsSync(RESULTS_DIR)) return null;
  const files = fs
    .readdirSync(RESULTS_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort();
  const latest = files.at(-1);
  if (!latest) return null;
  try {
    return JSON.parse(
      fs.readFileSync(path.join(RESULTS_DIR, latest), "utf-8"),
    ) as EvalResult;
  } catch {
    return null;
  }
}

export async function GET() {
  return NextResponse.json(
    { traces: readTraces(), eval: readLatestEval() },
    { headers: { "Cache-Control": "no-store" } },
  );
}
