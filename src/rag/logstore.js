/**
 * Observability store — persists each query's trace to a searchable Neon table
 * (`query_logs`) so user attempts can be searched and aggregated. Best-effort:
 * a logging failure never breaks a request. The table auto-creates on first use.
 */
const { query } = require("./db");

const SCHEMA = `
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
CREATE INDEX IF NOT EXISTS query_logs_trace_idx ON query_logs (trace_id);
CREATE INDEX IF NOT EXISTS query_logs_question_fts_idx
  ON query_logs USING GIN (to_tsvector('english', coalesce(question, '')));
`;

let _ensured = null;
async function ensureSchema() {
  if (!_ensured) {
    _ensured = query(SCHEMA).then(() => true).catch((e) => { _ensured = null; throw e; });
  }
  return _ensured;
}

async function logQuery(question, result) {
  const m = (result && result.meta) || {};
  const L = m.latencyMs || {};
  const T = m.tokens || {};
  try {
    await ensureSchema();
    await query(
      `INSERT INTO query_logs
        (trace_id, question, search_query, rewritten, grounded, ok, retrieved, reranked, citations,
         provider, model, latency_total_ms, latency_rewrite_ms, latency_retrieve_ms, latency_rerank_ms,
         latency_llm_ms, tokens_prompt, tokens_completion, tokens_total, cost_usd, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
      [
        m.traceId || null, question, m.searchQuery || null, !!m.rewritten, !!(result && result.grounded),
        result ? result.ok !== false : false, m.retrieved ?? null, m.reranked ?? null,
        (result && result.citations ? result.citations.length : 0),
        m.provider || null, m.model || null, L.total ?? null, L.rewrite ?? null, L.retrieve ?? null,
        L.rerank ?? null, L.llm ?? null, T.prompt ?? null, T.completion ?? null, T.total ?? null,
        m.costUsd ?? 0, m.error || null,
      ]
    );
  } catch (e) {
    console.warn("logQuery failed (non-fatal):", e.message);
  }
}

async function getStats() {
  await ensureSchema();
  const { rows } = await query(`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE grounded)::int AS grounded_count,
      count(*) FILTER (WHERE error IS NOT NULL)::int AS error_count,
      round(avg(latency_total_ms))::int    AS avg_latency_ms,
      percentile_cont(0.5)  WITHIN GROUP (ORDER BY latency_total_ms)::int AS p50_latency_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_total_ms)::int AS p95_latency_ms,
      round(avg(latency_rewrite_ms))::int  AS avg_rewrite_ms,
      round(avg(latency_retrieve_ms))::int AS avg_retrieve_ms,
      round(avg(latency_rerank_ms))::int   AS avg_rerank_ms,
      round(avg(latency_llm_ms))::int      AS avg_llm_ms,
      round(avg(tokens_total))::int        AS avg_tokens,
      sum(tokens_total)::bigint            AS total_tokens,
      round(sum(cost_usd), 6)              AS total_cost_usd,
      min(created_at) AS first_at,
      max(created_at) AS last_at
    FROM query_logs`);
  return rows[0];
}

// Searchable: full-text over the question, newest first (aggregate-safe — no PII beyond the question text a user typed).
async function search(term, limit = 20) {
  await ensureSchema();
  const cols = `created_at, trace_id, question, grounded, latency_total_ms, tokens_total, cost_usd, model`;
  if (term) {
    const { rows } = await query(
      `SELECT ${cols} FROM query_logs
       WHERE to_tsvector('english', coalesce(question,'')) @@ plainto_tsquery('english', $1)
       ORDER BY created_at DESC LIMIT $2`,
      [term, limit]
    );
    return rows;
  }
  const { rows } = await query(`SELECT ${cols} FROM query_logs ORDER BY created_at DESC LIMIT $1`, [limit]);
  return rows;
}

module.exports = { ensureSchema, logQuery, getStats, search, SCHEMA };
