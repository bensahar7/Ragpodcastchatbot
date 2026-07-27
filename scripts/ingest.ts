import fs from "fs";
import path from "path";

const EPISODES_DIR =
  process.argv[2] ||
  path.resolve(
    __dirname,
    "../../../How_to_solve_this_website/Context/Episodes"
  );
const OUTPUT_PATH = path.resolve(__dirname, "../data/episodes.json");

interface Episode {
  id: number;
  folderName: string;
  title: string;
  topic: string;
  guests: string[];
  companies: { name: string; website?: string }[];
  transcript: string;
}

function parseEpisodeNumber(folderName: string): number {
  const match = folderName.match(/^ep(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

function parseMeta(
  content: string
): Pick<Episode, "title" | "topic" | "guests" | "companies"> {
  const titleMatch = content.match(/^#\s+Episode\s+\d+:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "Unknown";

  const topicMatch = content.match(/\*\*(?:Topic|Sector):\*\*\s*(.+)/);
  const topic = topicMatch ? topicMatch[1].trim() : "";

  // Extract guests from various formats
  const guests: string[] = [];
  const guestPatterns = [
    /\*\*Guests?:\*\*\s*(.+)/g,
    /\*\*Guest:\*\*\s*(.+)/g,
    /\*\*Company \d+ Guest:\*\*\s*(.+)/g,
  ];
  for (const pattern of guestPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      match[1].split(/[,،]/).forEach((g) => {
        const name = g.replace(/\(.*?\)/, "").trim();
        if (name && !guests.includes(name)) guests.push(name);
      });
    }
  }

  // Extract companies
  const companies: { name: string; website?: string }[] = [];
  const companyNamePattern = /\*\*Company(?: Name)?(?:\s+\d+)?.*?:\*\*\s*(.+)/g;
  const websitePattern =
    /\*\*Company(?: \d+)? Website:\*\*\s*(https?:\/\/\S+)/g;
  let cMatch;
  while ((cMatch = companyNamePattern.exec(content)) !== null) {
    const name = cMatch[1].replace(/[‏‎]/g, "").trim();
    if (name && !name.startsWith("http")) {
      companies.push({ name });
    }
  }
  let wMatch;
  let wIdx = 0;
  while ((wMatch = websitePattern.exec(content)) !== null) {
    if (wIdx < companies.length) {
      companies[wIdx].website = wMatch[1].trim();
    }
    wIdx++;
  }

  return { title, topic, guests, companies };
}

function main() {
  if (!fs.existsSync(EPISODES_DIR)) {
    console.error(`Episodes directory not found: ${EPISODES_DIR}`);
    process.exit(1);
  }

  const folders = fs
    .readdirSync(EPISODES_DIR)
    .filter(
      (f) =>
        f.startsWith("ep") &&
        fs.statSync(path.join(EPISODES_DIR, f)).isDirectory()
    )
    .sort((a, b) => parseEpisodeNumber(a) - parseEpisodeNumber(b));

  const episodes: Episode[] = [];

  for (const folder of folders) {
    const dir = path.join(EPISODES_DIR, folder);
    const metaPath = path.join(dir, "meta.md.txt");
    const transcriptPath = path.join(dir, "transcript.md");

    if (!fs.existsSync(transcriptPath)) {
      console.warn(`Skipping ${folder}: no transcript.md`);
      continue;
    }

    const metaContent = fs.existsSync(metaPath)
      ? fs.readFileSync(metaPath, "utf-8")
      : "";
    const transcript = fs.readFileSync(transcriptPath, "utf-8");

    const meta = parseMeta(metaContent);
    const id = parseEpisodeNumber(folder);

    episodes.push({
      id,
      folderName: folder,
      ...meta,
      transcript,
    });

    console.log(`✓ Episode ${id}: ${meta.title} (${transcript.length} chars)`);
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(episodes, null, 2), "utf-8");
  console.log(`\nWrote ${episodes.length} episodes to ${OUTPUT_PATH}`);
}

main();
