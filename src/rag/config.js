/**
 * Central, env-driven configuration for the query-time RAG assistant.
 * Every default is free / local — no paid API is required to run the pipeline.
 */
require("dotenv").config();

const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
const bool = (v, d) => (v === undefined ? d : /^(1|true|yes|on)$/i.test(v));

module.exports = {
  DATABASE_URL: process.env.DATABASE_URL,

  // --- Embeddings: same local model as ingestion (Transformers.js, no API key) ---
  EMBED_MODEL: process.env.EMBED_MODEL || "mixedbread-ai/mxbai-embed-large-v1",
  EMBEDDING_DIM: 1024,

  // --- Reranker: local cross-encoder (Transformers.js, no API key) ---
  RERANK_MODEL: process.env.RERANK_MODEL || "Xenova/bge-reranker-base",

  // --- LLM: local & free by default via Ollama; provider-agnostic ---
  LLM_PROVIDER: (process.env.LLM_PROVIDER || "ollama").toLowerCase(), // ollama | openai-compatible
  LLM_MODEL: process.env.LLM_MODEL || "llama3.2:3b", // small, fast default; bump to llama3.1:8b for higher quality
  OLLAMA_HOST: process.env.OLLAMA_HOST || "http://127.0.0.1:11434",
  LLM_BASE_URL: process.env.LLM_BASE_URL || "", // for any OpenAI-compatible endpoint
  LLM_API_KEY: process.env.LLM_API_KEY || "",
  LLM_TEMPERATURE: num(process.env.LLM_TEMPERATURE, 0.2),
  // Cost estimation (per 1K tokens). 0 = free/local (Ollama). Set these only if
  // you point at a metered provider, so the trace can report $ per request.
  LLM_COST_PROMPT_PER_1K: num(process.env.LLM_COST_PROMPT_PER_1K, 0),
  LLM_COST_COMPLETION_PER_1K: num(process.env.LLM_COST_COMPLETION_PER_1K, 0),

  // --- Retrieval / ranking knobs ---
  ENABLE_QUERY_REWRITE: bool(process.env.ENABLE_QUERY_REWRITE, true),
  HYBRID_CANDIDATES: num(process.env.HYBRID_CANDIDATES, 20), // pool size per search method
  RERANK_INPUT: num(process.env.RERANK_INPUT, 10), // shortlist fed to the reranker (tuned: 20→10 ~halves rerank latency)
  TOP_K: num(process.env.TOP_K, 6), // chunks kept for the prompt
  VECTOR_THRESHOLD: num(process.env.VECTOR_THRESHOLD, 0.3), // cosine-similarity floor
  RERANK_THRESHOLD: num(process.env.RERANK_THRESHOLD, 0.05), // reranker relevance floor
  RRF_K: num(process.env.RRF_K, 60), // Reciprocal Rank Fusion constant

  // --- Server / deployment ---
  PORT: num(process.env.PORT, 8080),
  // Comma-separated allowlist of browser origins (e.g. https://you.github.io).
  // Empty = allow all (fine for local dev; set it in production).
  ALLOWED_ORIGINS: (process.env.ALLOWED_ORIGINS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  RATE_LIMIT_MAX: num(process.env.RATE_LIMIT_MAX, 30), // requests per window per IP
  RATE_LIMIT_WINDOW_MS: num(process.env.RATE_LIMIT_WINDOW_MS, 60000),
  ACCESS_CODE: process.env.ACCESS_CODE || "", // optional shared secret to gate /ask
};
