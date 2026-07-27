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
- **LLM**: Anthropic Claude API (Sonnet/Haiku) for answer generation
- **Embeddings**: Free multilingual model via `@xenova/transformers` or `sentence-transformers` (e.g. `intfloat/multilingual-e5-small`)
- **Vector storage**: In-memory JSON file with cosine similarity (sufficient for ~17 episodes)

## Architecture

The RAG pipeline has these stages:

1. **Ingestion** — one-time script extracts transcripts + metadata from the podcast site into per-episode JSON files
2. **Chunking + Embedding** — splits transcripts into ~300-500 token chunks (respecting speaker turns/paragraphs), embeds them, outputs a single `embeddings.json`
3. **Retrieval** — at query time, embed the question with the same model, cosine-similarity search against chunks, return top-k results with metadata
4. **Generation** — Next.js API route sends retrieved chunks + question to Claude API, which answers in Hebrew citing episode sources
5. **Frontend** — React chat widget (RTL) calling the API route

## Key Constraints

- Hebrew language throughout — embeddings model must be multilingual
- Free/simple stack: no paid embedding APIs, no hosted vector DB (JSON file is sufficient at this scale)
- Answers must cite which episode(s) they draw from
- Bot must refuse to answer when transcripts don't contain relevant content
- Next.js 16 has breaking changes vs. prior versions — read `node_modules/next/dist/docs/` before using unfamiliar APIs

## Environment Variables

See `.env.example` for required keys. The only paid service is the Anthropic API for generation.
