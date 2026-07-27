import { XMLParser } from "fast-xml-parser";

const RSS_URL = "https://anchor.fm/s/f75630a4/podcast/rss";

export interface RssEpisode {
  title: string;
  guid: string;
  pubDate: string;
  link: string;
  description: string;
  episodeNumber: number;
  duration: string;
}

export async function fetchRssEpisodes(): Promise<RssEpisode[]> {
  const res = await fetch(RSS_URL);
  if (!res.ok) throw new Error(`RSS fetch failed: ${res.status}`);

  const xml = await res.text();
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
  });
  const feed = parser.parse(xml);
  const items = feed.rss?.channel?.item ?? [];

  return (Array.isArray(items) ? items : [items]).map((item: Record<string, unknown>) => ({
    title: String(item.title ?? ""),
    guid: String(
      typeof item.guid === "object" && item.guid !== null
        ? (item.guid as Record<string, unknown>)["#text"]
        : item.guid ?? ""
    ),
    pubDate: String(item.pubDate ?? ""),
    link: String(item.link ?? ""),
    description: String(
      typeof item.description === "string"
        ? item.description.replace(/<[^>]*>/g, "").trim()
        : ""
    ),
    episodeNumber: Number(item["itunes:episode"] ?? 0),
    duration: String(item["itunes:duration"] ?? ""),
  }));
}
