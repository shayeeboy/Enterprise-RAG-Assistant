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
  // Default 0 (greedy): the eval showed sampling drift was a source of both
  // hallucination and run-to-run noise; deterministic generation is more
  // faithful and reproducible. Override with LLM_TEMPERATURE for more variety.
  LLM_TEMPERATURE: num(process.env.LLM_TEMPERATURE, 0),
  // Cost estimation (per 1K tokens). 0 = free/local (Ollama). Set these only if
  // you point at a metered provider, so the trace can report $ per request.
  LLM_COST_PROMPT_PER_1K: num(process.env.LLM_COST_PROMPT_PER_1K, 0),
  LLM_COST_COMPLETION_PER_1K: num(process.env.LLM_COST_COMPLETION_PER_1K, 0),

  // --- LLM-as-Judge (Phase 4 eval harness) ---
  // The judge reuses the same provider/endpoint as generation (so it stays on
  // the same free tier — no extra cost). By default it CROSS-JUDGES with a
  // different model than the generator to reduce self-preference bias; set
  // JUDGE_MODEL to "" to self-judge with LLM_MODEL. Temperature is forced to 0
  // for determinism. Optional JUDGE_BASE_URL/JUDGE_API_KEY override the endpoint.
  JUDGE_MODEL: process.env.JUDGE_MODEL !== undefined ? process.env.JUDGE_MODEL : "openai/gpt-oss-120b",
  JUDGE_TEMPERATURE: num(process.env.JUDGE_TEMPERATURE, 0),
  JUDGE_BASE_URL: process.env.JUDGE_BASE_URL || "",
  JUDGE_API_KEY: process.env.JUDGE_API_KEY || "",

  // --- Faithfulness ---
  // After generation, drop substantive answer sentences that carry no valid
  // citation (a claim with no source) to raise faithfulness. Conservative:
  // keeps lead-ins, refusals, and never trims an answer down to nothing.
  ENFORCE_CITATIONS: bool(process.env.ENFORCE_CITATIONS, true),
  // Opt-in NLI faithfulness filter: a local cross-encoder checks whether the
  // retrieved context ENTAILS each answer sentence, dropping claims it doesn't
  // (catches cited-but-unsupported statements the citation trim can't). Off by
  // default — it adds a model download + latency and its impact should be
  // measured via `npm run eval:judge` before enabling in production.
  ENFORCE_ENTAILMENT: bool(process.env.ENFORCE_ENTAILMENT, false),
  NLI_MODEL: process.env.NLI_MODEL || "Xenova/nli-deberta-v3-small",
  ENTAILMENT_THRESHOLD: num(process.env.ENTAILMENT_THRESHOLD, 0.4), // min P(entailment) to keep a claim

  // --- Retrieval / ranking knobs ---
  ENABLE_QUERY_REWRITE: bool(process.env.ENABLE_QUERY_REWRITE, true),
  HYBRID_CANDIDATES: num(process.env.HYBRID_CANDIDATES, 20), // pool size per search method
  RERANK_INPUT: num(process.env.RERANK_INPUT, 10), // shortlist fed to the reranker (tuned: 20→10 ~halves rerank latency)
  TOP_K: num(process.env.TOP_K, 6), // chunks kept for the prompt
  VECTOR_THRESHOLD: num(process.env.VECTOR_THRESHOLD, 0.3), // cosine-similarity floor
  RERANK_THRESHOLD: num(process.env.RERANK_THRESHOLD, 0.05), // per-chunk reranker relevance floor
  // If the BEST reranked chunk scores below this, treat the whole query as
  // out-of-scope and refuse rather than answer from irrelevant context.
  RELEVANCE_FLOOR: num(process.env.RELEVANCE_FLOOR, 0.05),
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
