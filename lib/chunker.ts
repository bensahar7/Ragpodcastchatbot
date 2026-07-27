const MIN_CHUNK_WORDS = 250;
const MAX_CHUNK_WORDS = 550;
const OVERLAP_WORDS = 30;

export interface Chunk {
  text: string;
  startPosition: number;
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
    .filter((p) => p.length > 0);

  if (paragraphs.length === 0) return [];

  const chunks: Chunk[] = [];
  let currentParagraphs: string[] = [];
  let currentWordCount = 0;

  function wordCount(text: string): number {
    return text.split(/\s+/).filter(Boolean).length;
  }

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
      const isQuestion =
        lastPara && lastPara.trim().endsWith("?") && wordCount(lastPara) < 60;

      if (isQuestion && currentWordCount + pWords <= MAX_CHUNK_WORDS + 100) {
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
      // If adding next paragraph would exceed max, flush now
      if (currentWordCount + nextWords > MAX_CHUNK_WORDS) {
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
