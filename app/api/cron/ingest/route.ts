import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { fetchRssEpisodes } from "@/lib/rss";
import { fetchSiteEpisodeList, scrapeEpisodePage } from "@/lib/scraper";
import { chunkTranscript } from "@/lib/chunker";
import { contextualizeChunk, embedBatch, toVectorLiteral } from "@/lib/embeddings";

export const maxDuration = 300; // 5 min max for Vercel serverless
export const dynamic = "force-dynamic";

const BATCH_SIZE = 5;

interface IngestResult {
  episodeNumber: number;
  title: string;
  status: "ingested" | "error";
  error?: string;
  chunksCreated?: number;
}

/**
 * Step 1: Parse RSS feed, match to site URLs, find episodes not yet in DB.
 * Step 2: For each new episode, scrape the page, extract data, chunk transcript, insert into DB.
 */
export async function GET(request: Request) {
  // Verify cron secret in production
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    // ---- Step 1: Parse RSS and find new episodes ----
    const [rssEpisodes, siteEpisodes] = await Promise.all([
      fetchRssEpisodes(),
      fetchSiteEpisodeList(),
    ]);

    // Get existing episode numbers from DB
    const existing = await sql`SELECT episode_number FROM episodes`;
    const existingNumbers = new Set(
      existing.rows.map((r) => r.episode_number as number)
    );

    // The site listing drives discovery, not the RSS feed. An episode is only
    // ingestable if it has a page to scrape, and the feed turned out to be the
    // narrower source — episodes 11-14 are on the site but absent from RSS, so
    // an RSS-driven loop could never reach them. RSS is now only used to flag
    // published episodes the site hasn't listed.
    const toIngest: { episodeNumber: number; siteUrl: string }[] = [];
    const skipped: { title: string; reason: string }[] = [];

    for (const site of siteEpisodes) {
      if (site.episodeNumber === 0) {
        skipped.push({ title: site.url, reason: "No episode number on site page" });
        continue;
      }
      if (existingNumbers.has(site.episodeNumber)) {
        continue; // Already in DB
      }
      toIngest.push({
        episodeNumber: site.episodeNumber,
        siteUrl: site.url,
      });
    }

    const siteNumbers = new Set(siteEpisodes.map((e) => e.episodeNumber));
    for (const rss of rssEpisodes) {
      if (rss.episodeNumber && !siteNumbers.has(rss.episodeNumber)) {
        skipped.push({
          title: rss.title,
          reason: `In RSS but no site page for episode ${rss.episodeNumber}`,
        });
      }
    }

    if (toIngest.length === 0) {
      return NextResponse.json({
        message: "No new episodes to ingest",
        totalRss: rssEpisodes.length,
        totalInDb: existingNumbers.size,
        skipped,
      });
    }

    // ---- Step 2: Scrape and ingest in batches of 5 ----
    const results: IngestResult[] = [];

    for (let i = 0; i < toIngest.length; i += BATCH_SIZE) {
      const batch = toIngest.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.allSettled(
        batch.map(async (ep) => {
          const scraped = await scrapeEpisodePage(ep.siteUrl);

          // Insert episode
          const insertResult = await sql`
            INSERT INTO episodes (
              episode_number, title, category, description,
              publish_date, url, spotify_url, thumbnail_url,
              guest_name, guest_linkedin_url,
              company_name, company_url,
              problem_summary, solution_summary, transcript
            ) VALUES (
              ${scraped.episodeNumber},
              ${scraped.title},
              ${scraped.category},
              ${scraped.description},
              ${scraped.publishDate ? scraped.publishDate : null},
              ${scraped.url},
              ${scraped.spotifyUrl},
              ${scraped.thumbnailUrl},
              ${scraped.guestName},
              ${scraped.guestLinkedinUrl},
              ${scraped.companyName},
              ${scraped.companyUrl},
              ${scraped.problemSummary},
              ${scraped.solutionSummary},
              ${scraped.transcript}
            )
            ON CONFLICT (episode_number) DO NOTHING
            RETURNING id
          `;

          const episodeId = insertResult.rows[0]?.id;
          if (!episodeId) {
            return {
              episodeNumber: scraped.episodeNumber,
              title: scraped.title,
              status: "ingested" as const,
              chunksCreated: 0,
            };
          }

          // Chunk, embed, and insert transcript chunks. The embedding is
          // written here rather than backfilled later — a chunk with a NULL
          // embedding is invisible to retrieval, so a newly ingested episode
          // would otherwise be unreachable until someone ran a script.
          let chunksCreated = 0;
          if (scraped.transcript) {
            const chunks = chunkTranscript(scraped.transcript);
            const vectors = await embedBatch(
              chunks.map((c) => contextualizeChunk(scraped.title, c.text))
            );

            for (let i = 0; i < chunks.length; i++) {
              await sql`
                INSERT INTO chunks (episode_id, start_position, text, embedding)
                VALUES (
                  ${episodeId},
                  ${chunks[i].startPosition},
                  ${chunks[i].text},
                  ${toVectorLiteral(vectors[i])}::vector
                )
              `;
              chunksCreated++;
            }
          }

          return {
            episodeNumber: scraped.episodeNumber,
            title: scraped.title,
            status: "ingested" as const,
            chunksCreated,
          };
        })
      );

      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            episodeNumber: 0,
            title: "unknown",
            status: "error",
            error: result.reason?.message ?? String(result.reason),
          });
        }
      }
    }

    return NextResponse.json({
      message: `Ingested ${results.filter((r) => r.status === "ingested").length} episodes`,
      results,
      skipped,
    });
  } catch (error) {
    console.error("Ingest error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
