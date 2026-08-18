const MIN_CHUNK_WORDS = 250;
const MAX_CHUNK_WORDS = 550;
const OVERLAP_WORDS = 30;
const QA_OVERFLOW_ALLOWANCE = 100;

export interface Chunk {
  text: string;
  startPosition: number;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

/** A short paragraph ending in "?" — the host's question, which belongs with the answer. */
function isQuestion(paragraph: string | undefined): boolean {
  return (
    !!paragraph && paragraph.trim().endsWith("?") && countWords(paragraph) < 60
  );
}

/**
 * Break a paragraph that is on its own larger than MAX_CHUNK_WORDS into
 * sentence-aligned pieces.
 *
 * Some episodes are scraped without blank lines between speaker turns, so the
 * whole transcript arrives as a single paragraph. The sizing logic below only
 * ever splits *between* paragraphs, so those episodes collapsed into one
 * enormous chunk covering the entire episode — too big to embed, and useless
 * for retrieval even if it fit, since every query matched it equally.
 */
function splitOversizedParagraph(paragraph: string): string[] {
  if (countWords(paragraph) <= MAX_CHUNK_WORDS) return [paragraph];

  // Keep the delimiter attached to the sentence it ends.
  const sentences = paragraph.split(/(?<=[.!?…])\s+/).filter(Boolean);

  const pieces: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  const flush = () => {
    if (current.length > 0) pieces.push(current.join(" "));
    current = [];
    currentWords = 0;
  };

  for (const sentence of sentences) {
    const sentenceWords = countWords(sentence);

    // A "sentence" with no terminal punctuation anywhere can still exceed the
    // limit on its own; fall back to a hard word-count split for that case.
    if (sentenceWords > MAX_CHUNK_WORDS) {
      flush();
      const words = sentence.split(/\s+/).filter(Boolean);
      for (let i = 0; i < words.length; i += MAX_CHUNK_WORDS) {
        pieces.push(words.slice(i, i + MAX_CHUNK_WORDS).join(" "));
      }
      continue;
    }

    if (currentWords > 0 && currentWords + sentenceWords > MAX_CHUNK_WORDS) {
      flush();
    }
    current.push(sentence);
    currentWords += sentenceWords;
  }
  flush();

  return pieces;
}

/**
 * Split transcript into ~300-500 word chunks respecting paragraph/speaker-turn breaks.
 * Keeps a host question and its following answer together when possible.
 * Never cuts mid-sentence. Adds small word overlap between chunks.
 */
export function chunkTranscript(transcript: string): Chunk[] {
  // Split by double-newlines (paragraph/speaker turns)
  const paragraphs = transcript
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .flatMap(splitOversizedParagraph);

  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];
  let currentParagraphs: string[] = [];
  let currentWordCount = 0;

  const wordCount = countWords;

  function flushChunk() {
    if (currentParagraphs.length === 0) return;
    const text = currentParagraphs.join("\n\n");
    const startPosition = transcript.indexOf(currentParagraphs[0]);
    chunks.push({ text, startPosition: startPosition >= 0 ? startPosition : 0 });
    currentParagraphs = [];
    currentWordCount = 0;
  }

  for (let i = 0; i < paragraphs.length; i++) {
    const para = paragraphs[i];
    const pWords = wordCount(para);

    // If adding this paragraph would exceed max, flush first
    // But: if the current chunk is a question (short, ends with ?) and this is the answer,
    // try to keep them together
    if (
      currentWordCount > 0 &&
      currentWordCount + pWords > MAX_CHUNK_WORDS
    ) {
      // Check if current last paragraph looks like a question and this is the answer
      const lastPara = currentParagraphs[currentParagraphs.length - 1];

      if (
        isQuestion(lastPara) &&
        currentWordCount + pWords <= MAX_CHUNK_WORDS + QA_OVERFLOW_ALLOWANCE
      ) {
        // Allow slight overflow to keep Q&A together
        currentParagraphs.push(para);
        currentWordCount += pWords;
        continue;
      }

      flushChunk();
    }

    currentParagraphs.push(para);
    currentWordCount += pWords;

    // If we've reached a good size, flush
    if (currentWordCount >= MIN_CHUNK_WORDS && i < paragraphs.length - 1) {
      const nextWords = wordCount(paragraphs[i + 1]);
      // Flushing here would strand a trailing host question at the end of this
      // chunk, away from the answer that follows it — the exact case the
      // overflow allowance above exists to prevent. Let the next iteration
      // handle it so that logic gets a chance to run.
      const wouldStrandQuestion =
        isQuestion(currentParagraphs[currentParagraphs.length - 1]) &&
        currentWordCount + nextWords <= MAX_CHUNK_WORDS + QA_OVERFLOW_ALLOWANCE;

      // If adding next paragraph would exceed max, flush now
      if (currentWordCount + nextWords > MAX_CHUNK_WORDS && !wouldStrandQuestion) {
        flushChunk();
      }
    }
  }

  // Flush remaining
  flushChunk();

  // Add overlap: prepend last OVERLAP_WORDS of previous chunk to each subsequent chunk
  if (chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prevWords = chunks[i - 1].text.split(/\s+/);
      const overlapText = prevWords.slice(-OVERLAP_WORDS).join(" ");
      // Find the last sentence boundary in the overlap to avoid mid-sentence cuts
      const sentenceEnd = overlapText.search(/[.!?،]\s+[^\s]/);
      const cleanOverlap =
        sentenceEnd > 0
          ? overlapText.substring(sentenceEnd + 1).trim()
          : overlapText;
      if (cleanOverlap) {
        chunks[i] = {
          text: cleanOverlap + "\n\n" + chunks[i].text,
          startPosition: chunks[i].startPosition,
        };
      }
    }
  }

  return chunks;
}
