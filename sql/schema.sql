-- ============================================================
-- Vector Database Schema — Neon Postgres + pgvector
-- Enterprise Learning RAG AI Assistant: Piano Learning KB
-- ============================================================

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS documents (
  doc_id      TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  author      TEXT,
  source_type TEXT NOT NULL,       -- 'method-book' | 'exercise-book'
  page_count  INTEGER,
  source_url  TEXT,                -- public PDF URL; citations deep-link as source_url#page=N
  created_at  TIMESTAMPTZ DEFAULT now()
);
-- Backward-compatible migration for DBs created before source_url.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS source_url TEXT;

CREATE TABLE IF NOT EXISTS chunks (
  chunk_id       TEXT PRIMARY KEY,
  doc_id         TEXT NOT NULL REFERENCES documents(doc_id) ON DELETE CASCADE,
  chunk_index    INTEGER NOT NULL,
  page_start     INTEGER,
  page_end       INTEGER,
  char_count     INTEGER,
  text           TEXT NOT NULL,

  -- metadata (stage 4)
  content_type   TEXT,             -- 'exercise' | 'technique' | 'theory' | 'practice-method' | 'narrative'
  skill_level    TEXT,             -- 'beginner' | 'intermediate' | 'advanced' | 'unspecified'
  finger_numbers TEXT[],           -- e.g. {'3-4-5'}
  keywords       TEXT[],

  -- embedding (stage 5) — mxbai-embed-large-v1 (local, Transformers.js) at 1024 dimensions
  embedding      vector(1024),

  created_at     TIMESTAMPTZ DEFAULT now()
);

-- Vector similarity index (HNSW — better recall/speed tradeoff than IVFFlat
-- for a KB this size; pgvector >= 0.5.0 required, Neon supports this).
CREATE INDEX IF NOT EXISTS chunks_embedding_hnsw_idx
  ON chunks USING hnsw (embedding vector_cosine_ops);

-- Metadata filter indexes — support pre-filtering before/alongside vector search
CREATE INDEX IF NOT EXISTS chunks_doc_id_idx ON chunks (doc_id);
CREATE INDEX IF NOT EXISTS chunks_content_type_idx ON chunks (content_type);
CREATE INDEX IF NOT EXISTS chunks_skill_level_idx ON chunks (skill_level);

-- Full-text index for hybrid (keyword + vector) retrieval
ALTER TABLE chunks ADD COLUMN IF NOT EXISTS text_tsv tsvector
  GENERATED ALWAYS AS (to_tsvector('english', text)) STORED;
CREATE INDEX IF NOT EXISTS chunks_text_tsv_idx ON chunks USING GIN (text_tsv);

-- ============================================================
-- Observability log (Phase 3) — one row per user query attempt.
-- Auto-created by the API at runtime (src/rag/logstore.js); included here for
-- reference. Powers `npm run logs` (search) and `npm run stats` (aggregates).
-- ============================================================
CREATE TABLE IF NOT EXISTS query_logs (
  id                  BIGSERIAL PRIMARY KEY,
  trace_id            TEXT,
  question            TEXT,
  search_query        TEXT,
  rewritten           BOOLEAN,
  grounded            BOOLEAN,
  ok                  BOOLEAN,
  retrieved           INTEGER,
  reranked            INTEGER,
  citations           INTEGER,
  provider            TEXT,
  model               TEXT,
  latency_total_ms    INTEGER,
  latency_rewrite_ms  INTEGER,
  latency_retrieve_ms INTEGER,
  latency_rerank_ms   INTEGER,
  latency_llm_ms      INTEGER,
  tokens_prompt       INTEGER,
  tokens_completion   INTEGER,
  tokens_total        INTEGER,
  cost_usd            NUMERIC(12,6),
  error               TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS query_logs_created_at_idx ON query_logs (created_at DESC);
CREATE INDEX IF NOT EXISTS query_logs_question_fts_idx
  ON query_logs USING GIN (to_tsvector('english', coalesce(question, '')));

-- Example hybrid query: vector similarity + content_type filter
-- SELECT chunk_id, text, page_start,
--        1 - (embedding <=> $1::vector) AS similarity
-- FROM chunks
-- WHERE content_type = 'exercise'
-- ORDER BY embedding <=> $1::vector
-- LIMIT 8;
