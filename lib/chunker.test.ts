import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chunkTranscript } from "./chunker";

// Mirrors the private constants in chunker.ts
const MIN_CHUNK_WORDS = 250;
const MAX_CHUNK_WORDS = 550;
const OVERLAP_WORDS = 30;
const QA_OVERFLOW_ALLOWANCE = 100;

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Builds a paragraph of `n` distinct Hebrew-ish words, tagged so it can be located later. */
function para(n: number, tag = "w"): string {
  return Array.from({ length: n }, (_, i) => `${tag}${i}`).join(" ");
}

/** Joins paragraphs the way the scraper emits them: blank line between speaker turns. */
function transcript(...paragraphs: string[]): string {
  return paragraphs.join("\n\n");
}

describe("chunkTranscript — degenerate input", () => {
  test("returns no chunks for an empty transcript", () => {
    assert.deepEqual(chunkTranscript(""), []);
  });

  test("returns no chunks for whitespace-only transcript", () => {
    assert.deepEqual(chunkTranscript("   \n\n  \n \t \n\n "), []);
  });

  test("keeps a single short paragraph as one chunk", () => {
    const chunks = chunkTranscript("שלום לכולם וברוכים הבאים.");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, "שלום לכולם וברוכים הבאים.");
    assert.equal(chunks[0].startPosition, 0);
  });

  test("drops empty paragraphs created by consecutive blank lines", () => {
    const chunks = chunkTranscript("ראשון\n\n\n\n   \n\nשני");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, "ראשון\n\nשני");
  });
});

describe("chunkTranscript — sizing", () => {
  test("splits a long transcript into multiple chunks", () => {
    const input = transcript(...Array.from({ length: 10 }, (_, i) => para(200, `p${i}_`)));
    const chunks = chunkTranscript(input);
    assert.ok(chunks.length > 1, `expected multiple chunks, got ${chunks.length}`);
  });

  test("no chunk exceeds MAX_CHUNK_WORDS beyond the Q&A allowance", () => {
    const input = transcript(...Array.from({ length: 12 }, (_, i) => para(180, `p${i}_`)));
    const ceiling = MAX_CHUNK_WORDS + QA_OVERFLOW_ALLOWANCE + OVERLAP_WORDS;
    for (const [i, chunk] of chunkTranscript(input).entries()) {
      assert.ok(
        words(chunk.text) <= ceiling,
        `chunk ${i} has ${words(chunk.text)} words, ceiling is ${ceiling}`
      );
    }
  });

  test("a paragraph larger than MAX_CHUNK_WORDS is not left oversized", () => {
    // Regression: transcripts scraped without blank lines (episodes 9, 11, 13)
    // collapse into one paragraph, so the size limits are never applied.
    const oneBigParagraph = para(3256, "x");
    const chunks = chunkTranscript(oneBigParagraph);
    const biggest = Math.max(...chunks.map((c) => words(c.text)));
    assert.ok(
      biggest <= MAX_CHUNK_WORDS + QA_OVERFLOW_ALLOWANCE,
      `single-paragraph transcript produced a ${biggest}-word chunk ` +
        `(limit ${MAX_CHUNK_WORDS + QA_OVERFLOW_ALLOWANCE}); ${chunks.length} chunk(s) total`
    );
  });

  test("chunks past the first reach roughly MIN_CHUNK_WORDS", () => {
    const input = transcript(...Array.from({ length: 20 }, (_, i) => para(100, `p${i}_`)));
    const chunks = chunkTranscript(input);
    // The final chunk is whatever remains, so exclude it.
    for (const [i, chunk] of chunks.slice(0, -1).entries()) {
      assert.ok(
        words(chunk.text) >= MIN_CHUNK_WORDS,
        `chunk ${i} has only ${words(chunk.text)} words, expected >= ${MIN_CHUNK_WORDS}`
      );
    }
  });
});

describe("chunkTranscript — content preservation", () => {
  test("every paragraph survives into some chunk", () => {
    const paragraphs = Array.from({ length: 15 }, (_, i) => para(120, `p${i}_`));
    const chunks = chunkTranscript(transcript(...paragraphs));
    const joined = chunks.map((c) => c.text).join("\n\n");
    for (const [i, p] of paragraphs.entries()) {
      assert.ok(joined.includes(p), `paragraph ${i} missing from output`);
    }
  });

  test("preserves Hebrew text and punctuation verbatim", () => {
    const hebrew = "אז מה הסיפור עם היעלמות הדבורים? זו שאלה מרתקת.";
    const chunks = chunkTranscript(hebrew);
    assert.equal(chunks[0].text, hebrew);
  });
});

describe("chunkTranscript — startPosition", () => {
  test("startPosition indexes into the original transcript", () => {
    const paragraphs = Array.from({ length: 8 }, (_, i) => para(150, `p${i}_`));
    const input = transcript(...paragraphs);
    for (const chunk of chunkTranscript(input)) {
      assert.ok(chunk.startPosition >= 0, "startPosition must not be negative");
      assert.ok(
        chunk.startPosition < input.length,
        `startPosition ${chunk.startPosition} is past end of transcript (${input.length})`
      );
    }
  });

  test("startPosition marks where the chunk's own first paragraph begins", () => {
    const first = para(300, "a");
    const second = para(300, "b");
    const input = transcript(first, second);
    const chunks = chunkTranscript(input);
    assert.equal(chunks[0].startPosition, 0);
    if (chunks.length > 1) {
      assert.equal(chunks[1].startPosition, input.indexOf(second));
    }
  });

  test("startPositions increase monotonically", () => {
    const input = transcript(...Array.from({ length: 12 }, (_, i) => para(140, `p${i}_`)));
    const positions = chunkTranscript(input).map((c) => c.startPosition);
    for (let i = 1; i < positions.length; i++) {
      assert.ok(
        positions[i] >= positions[i - 1],
        `startPosition went backwards: ${positions[i - 1]} then ${positions[i]}`
      );
    }
  });
});

describe("chunkTranscript — overlap", () => {
  test("chunks after the first begin with text carried over from the previous chunk", () => {
    const input = transcript(...Array.from({ length: 10 }, (_, i) => para(200, `p${i}_`)));
    const chunks = chunkTranscript(input);
    assert.ok(chunks.length > 1, "test needs at least two chunks");
    for (let i = 1; i < chunks.length; i++) {
      const overlap = chunks[i].text.split("\n\n")[0];
      assert.ok(
        chunks[i - 1].text.includes(overlap),
        `chunk ${i} overlap not found in chunk ${i - 1}`
      );
      assert.ok(
        words(overlap) <= OVERLAP_WORDS,
        `overlap is ${words(overlap)} words, max is ${OVERLAP_WORDS}`
      );
    }
  });

  test("a single chunk gets no overlap prefix", () => {
    const chunks = chunkTranscript("קצר מאוד.");
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].text, "קצר מאוד.");
  });
});

describe("chunkTranscript — question/answer grouping", () => {
  test("keeps a short host question with the answer that follows it", () => {
    const filler = para(MAX_CHUNK_WORDS - 40, "f");
    const question = "אז איך בעצם מסירים פחמן מהאטמוספירה?";
    const answer = para(80, "ans");
    const chunks = chunkTranscript(transcript(filler, question, answer));

    const chunkWithQuestion = chunks.find((c) => c.text.includes(question));
    assert.ok(chunkWithQuestion, "question paragraph vanished");
    assert.ok(
      chunkWithQuestion.text.includes("ans0"),
      "answer was split away from the question it belongs to"
    );
  });

  test("does not glue a long non-question paragraph onto an overflowing chunk", () => {
    const filler = para(MAX_CHUNK_WORDS - 40, "f");
    const statement = "זה משפט שמסתיים בנקודה ולא בשאלה.";
    const answer = para(80, "ans");
    const chunks = chunkTranscript(transcript(filler, statement, answer));
    assert.ok(chunks.length > 1, "expected a flush when the limit is exceeded");
  });
});
