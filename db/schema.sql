-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
-- Enable pgvector for future embedding support
CREATE EXTENSION IF NOT EXISTS "vector";

CREATE TABLE IF NOT EXISTS episodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT,
  description TEXT,
  publish_date DATE,
  url TEXT NOT NULL UNIQUE,
  spotify_url TEXT,
  thumbnail_url TEXT,
  guest_name TEXT,
  guest_linkedin_url TEXT,
  company_name TEXT,
  company_url TEXT,
  problem_summary TEXT,
  solution_summary TEXT,
  transcript TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS chunks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  episode_id UUID NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
  start_position INTEGER,
  embedding vector(384),
  text TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chunks_episode_id ON chunks(episode_id);
CREATE INDEX IF NOT EXISTS idx_episodes_episode_number ON episodes(episode_number);
