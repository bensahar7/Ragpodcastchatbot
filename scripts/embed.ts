import fs from "fs";
import path from "path";

const EPISODES_PATH = path.resolve(__dirname, "../data/episodes.json");
const OUTPUT_PATH = path.resolve(__dirname, "../data/embeddings.json");
const MODEL_NAME = "Xenova/multilingual-e5-small";

interface Episode {
  id: number;
  title: string;
  topic: string;
  guests: string[];
  transcript: string;
}

interface Chunk {
  episodeId: number;
  episodeTitle: string;
  chunkIndex: number;
  text: string;
}

interface EmbeddedChunk extends Chunk {
  embedding: number[];
}

function chunkTranscript(episode: Episode): Chunk[] {
  const lines = episode.transcript.split("\n").filter((l) => l.trim());
  const chunks: Chunk[] = [];
  let currentText = "";
  let chunkIndex = 0;

  for (const line of lines) {
    const isSpeakerLine = /^\[.+\]:/.test(line);

    if (isSpeakerLine && currentText.length > 400) {
      // Flush current chunk
      chunks.push({
        episodeId: episode.id,
        episodeTitle: episode.title,
        chunkIndex: chunkIndex++,
        text: currentText.trim(),
      });
      currentText = line + "\n";
    } else {
      currentText += line + "\n";

      // Force split if chunk gets very long
      if (currentText.length > 1500) {
        chunks.push({
          episodeId: episode.id,
          episodeTitle: episode.title,
          chunkIndex: chunkIndex++,
          text: currentText.trim(),
        });
        currentText = "";
      }
    }
  }

  if (currentText.trim()) {
    chunks.push({
      episodeId: episode.id,
      episodeTitle: episode.title,
      chunkIndex: chunkIndex++,
      text: currentText.trim(),
    });
  }

  return chunks;
}

async function main() {
  if (!fs.existsSync(EPISODES_PATH)) {
    console.error(
      "episodes.json not found. Run the ingest script first: npm run ingest"
    );
    process.exit(1);
  }

  const episodes: Episode[] = JSON.parse(
    fs.readFileSync(EPISODES_PATH, "utf-8")
  );
  console.log(`Loaded ${episodes.length} episodes`);

  // Chunk all episodes
  const allChunks: Chunk[] = [];
  for (const ep of episodes) {
    const chunks = chunkTranscript(ep);
    allChunks.push(...chunks);
    console.log(`Episode ${ep.id}: ${chunks.length} chunks`);
  }
  console.log(`Total chunks: ${allChunks.length}`);

  // Load the embedding model
  console.log(`\nLoading model: ${MODEL_NAME}...`);
  const { pipeline } = await import("@xenova/transformers");
  const extractor = await pipeline("feature-extraction", MODEL_NAME);

  // Embed all chunks
  const embeddedChunks: EmbeddedChunk[] = [];
  for (let i = 0; i < allChunks.length; i++) {
    const chunk = allChunks[i];
    // multilingual-e5 expects "passage: " prefix for documents
    const input = `passage: ${chunk.text}`;
    const output = await extractor(input, {
      pooling: "mean",
      normalize: true,
    });
    const embedding = Array.from(output.data as Float32Array);

    embeddedChunks.push({ ...chunk, embedding });

    if ((i + 1) % 10 === 0 || i === allChunks.length - 1) {
      console.log(`Embedded ${i + 1}/${allChunks.length} chunks`);
    }
  }

  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(embeddedChunks), "utf-8");
  const sizeMB = (fs.statSync(OUTPUT_PATH).size / 1024 / 1024).toFixed(1);
  console.log(
    `\nWrote ${embeddedChunks.length} embedded chunks to ${OUTPUT_PATH} (${sizeMB} MB)`
  );
}

main();
