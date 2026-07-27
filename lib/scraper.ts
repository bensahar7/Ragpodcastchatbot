const SITE_BASE = "https://howtosolvethis.com";
const EPISODES_LIST_URL = `${SITE_BASE}/episodes/`;

export interface SiteEpisode {
  episodeNumber: number;
  slug: string;
  url: string;
}

/**
 * Fetch the episodes listing page and extract all episode URLs with their numbers.
 */
export async function fetchSiteEpisodeList(): Promise<SiteEpisode[]> {
  const res = await fetch(EPISODES_LIST_URL);
  if (!res.ok) throw new Error(`Episodes list fetch failed: ${res.status}`);
  const html = await res.text();

  const episodes: SiteEpisode[] = [];
  // Match hrefs like /episodes/12-brevel
  const pattern = /href="\/episodes\/(\d+)-([^"]+)"/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const num = parseInt(match[1], 10);
    const slug = match[2];
    const url = `${SITE_BASE}/episodes/${num}-${slug}`;
    // Deduplicate (links may appear multiple times)
    if (!episodes.some((e) => e.episodeNumber === num)) {
      episodes.push({ episodeNumber: num, slug, url });
    }
  }
  return episodes.sort((a, b) => a.episodeNumber - b.episodeNumber);
}

export interface ScrapedEpisode {
  episodeNumber: number;
  title: string;
  category: string | null;
  description: string | null;
  publishDate: string | null; // ISO date string
  url: string;
  spotifyUrl: string | null;
  thumbnailUrl: string | null;
  guestName: string | null;
  guestLinkedinUrl: string | null;
  companyName: string | null;
  companyUrl: string | null;
  problemSummary: string | null;
  solutionSummary: string | null;
  transcript: string | null;
}

/**
 * Scrape a single episode page using its /markdown endpoint for clean structured data,
 * plus the HTML page for og:image, spotify URL, and guest LinkedIn.
 */
export async function scrapeEpisodePage(
  pageUrl: string
): Promise<ScrapedEpisode> {
  const [htmlRes, mdRes] = await Promise.all([
    fetch(pageUrl),
    fetch(`${pageUrl}/markdown`),
  ]);

  if (!htmlRes.ok) throw new Error(`HTML fetch failed for ${pageUrl}: ${htmlRes.status}`);
  if (!mdRes.ok) throw new Error(`Markdown fetch failed for ${pageUrl}/markdown: ${mdRes.status}`);

  const html = await htmlRes.text();
  const md = await mdRes.text();

  // --- Parse markdown structured data ---
  const episodeNumberMatch = md.match(/^# Episode (\d+):/m);
  const episodeNumber = episodeNumberMatch
    ? parseInt(episodeNumberMatch[1], 10)
    : 0;

  const titleMatch = md.match(/^# Episode \d+:\s*(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  const sectorMatch = md.match(/\*\*Sector:\*\*\s*(.+)/);
  const category = sectorMatch ? sectorMatch[1].trim() : null;

  const publishedMatch = md.match(/\*\*Published:\*\*\s*(.+)/);
  const publishDate = publishedMatch ? publishedMatch[1].trim() : null;

  // Description from the ## About section
  const aboutMatch = md.match(
    /## About\s*\n([\s\S]*?)(?=\n## |\n\*\*|$)/
  );
  const description = aboutMatch ? aboutMatch[1].trim() || null : null;

  // Problem and solution
  const problemMatch = md.match(
    /## The Problem\s*\n([\s\S]*?)(?=\n## |$)/
  );
  const problemSummary = problemMatch ? problemMatch[1].trim() || null : null;

  const solutionMatch = md.match(
    /## The Solution\s*\n([\s\S]*?)(?=\n## |$)/
  );
  const solutionSummary = solutionMatch
    ? solutionMatch[1].trim() || null
    : null;

  // Company name and URL from ## Company section
  const companyMatch = md.match(
    /## Company\s*\n\*\*([^*]+)\*\*\s*\nWebsite:\s*(https?:\/\/\S+)?/
  );
  const companyName = companyMatch ? companyMatch[1].trim() : null;
  const companyUrl = companyMatch && companyMatch[2] ? companyMatch[2].trim() : null;

  // Transcript from ## Full Transcript section
  const transcriptMatch = md.match(/## Full Transcript\s*\n([\s\S]*?)$/);
  let transcript = transcriptMatch ? transcriptMatch[1].trim() : null;
  // Clean up leading ** markers that are formatting artifacts
  if (transcript) {
    transcript = transcript.replace(/^\*\*\s*\n/, "").trim();
  }

  // --- Parse HTML for metadata not in markdown ---

  // og:image
  const ogImageMatch = html.match(
    /property="og:image"\s+content="([^"]+)"/
  );
  const thumbnailUrl = ogImageMatch ? ogImageMatch[1] : null;

  // Spotify episode URL: look for podcasters.spotify.com episode link
  // (distinct from show-level open.spotify.com/show/ links)
  const spotifyEpMatch = html.match(
    /https:\/\/podcasters\.spotify\.com\/pod\/show\/[^"\\]+\/episodes\/[^"\\]+/
  );
  const spotifyUrl = spotifyEpMatch ? spotifyEpMatch[0] : null;

  // Guest name from markdown
  const guestsMatch = md.match(/\*\*Guests?:\*\*\s*(.+)/);
  const guestName = guestsMatch ? guestsMatch[1].trim() : null;

  // Guest LinkedIn from the RSC payload in HTML
  // Look for patterns like {"name":"...","linkedIn":"https://...linkedin.com/in/..."}
  const guestLinkedinMatch = html.match(
    /"linkedIn"\s*:\s*"(https?:\/\/[^"]*linkedin\.com\/in\/[^"]+)"/
  );
  const guestLinkedinUrl = guestLinkedinMatch
    ? guestLinkedinMatch[1]
    : null;

  return {
    episodeNumber,
    title,
    category,
    description,
    publishDate,
    url: pageUrl,
    spotifyUrl,
    thumbnailUrl,
    guestName,
    guestLinkedinUrl,
    companyName,
    companyUrl,
    problemSummary,
    solutionSummary,
    transcript,
  };
}
