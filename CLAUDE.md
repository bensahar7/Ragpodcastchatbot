# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

RAG chatbot for the Hebrew podcast "Eich Potrim Et Ze" (~17 episodes). Users ask questions and get answers grounded in episode transcripts, with source citations. All UI is RTL Hebrew.

## Commands

```bash
# All commands run from the ragpodcastchatbot/ subdirectory
npm run dev      # Start dev server (Next.js 16)
npm run build    # Production build
npm run lint     # ESLint
```

## Tech Stack

- **Framework**: Next.js 16 (App Router) with React 19, TypeScript, Tailwind CSS 4
- **LLM**: OpenAI `gpt-4.1-nano` for answer generation, streamed to the client
- **Embeddings**: OpenAI `text-embedding-3-large` at 1536 dimensions (`lib/embeddings.ts`)
- **Vector storage**: Postgres (Neon) + pgvector, `chunks.embedding vector(1536)`

## Architecture

The RAG pipeline has these stages:

1. **Ingestion** — `/api/cron/ingest` (weekly, Monday 06:00) scrapes the podcast site, writes `episodes`, chunks each transcript, and embeds the chunks in the same pass. Discovery is driven by the **site listing, not the RSS feed** — the feed omits several published episodes.
2. **Chunking** — `lib/chunker.ts` splits on speaker turns to ~250-550 words. Transcripts without blank-line breaks are sentence-split first, so a whole episode can't collapse into one chunk.
3. **Retrieval** — embed the question, then `ORDER BY embedding <=> query` in Postgres, joining `episodes` for metadata. Top-k = 2.
4. **Generation** — chunks plus an episode metadata line go to `gpt-4.1-nano`; the answer streams back as newline-delimited JSON.
5. **Frontend** — React chat widget (RTL) that renders tokens as they arrive.

### Embedding notes

- Chunks are embedded as `"<episode title>\n\n<chunk text>"` (`contextualizeChunk`). Transcript speech often never names its own subject, and the title prefix measurably improves recall. The prefix is embedding input only — stored text is unchanged.
- Changing the embedding model means re-embedding everything: `npm run rechunk` (it resizes the pgvector column to match `EMBEDDING_DIMENSIONS`).
- `multilingual-e5-small` still scores slightly better on Hebrew than any OpenAI model, but only runs locally; on Vercel that meant downloading ~100MB of ONNX weights per cold start, which is why it was replaced. See the comment in `lib/embeddings.ts` for the measured comparison.

## Scripts

```bash
npm run rechunk   # rebuild + re-embed all chunks from stored transcripts
npm run rechunk -- 9 10   # limit to specific episode numbers
npm run embed     # backfill embeddings for chunks that lack them
npm run recall    # retrieval-only recall@k against data/golden_set.json
npm run eval      # full LLM-judged eval (needs ANTHROPIC_API_KEY)
```

`data/embeddings.json` and `scripts/ingest.ts` are leftovers from the pre-database
setup and are no longer read at request time.

## Key Constraints

- Hebrew language throughout — embeddings model must be multilingual
- Answers must cite which episode(s) they draw from
- Bot must refuse to answer when transcripts don't contain relevant content
- Next.js 16 has breaking changes vs. prior versions — read `node_modules/next/dist/docs/` before using unfamiliar APIs

## Environment Variables

See `.env.example` for required keys. `OPENAI_API_KEY` covers both generation and
embeddings; `POSTGRES_URL` is what `@vercel/postgres` reads. Never put a real key
in `.env.example` — `.gitignore` only excludes `.env*.local`.
