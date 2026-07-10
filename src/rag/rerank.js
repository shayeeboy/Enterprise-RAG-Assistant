/**
 * Reranking (workflow steps: Reranking → Top-K).
 * A local cross-encoder (Xenova/bge-reranker-base via Transformers.js) scores
 * each (query, chunk) pair jointly — far more precise than the first-stage
 * bi-encoder similarity, because it attends across the query and passage
 * together. No API key, runs on CPU.
 */
const { RERANK_MODEL, RERANK_THRESHOLD, TOP_K } = require("./config");

let _tok = null;
let _model = null;
async function getModel() {
  if (_model) return { tok: _tok, model: _model };
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@xenova/transformers");
  _tok = await AutoTokenizer.from_pretrained(RERANK_MODEL);
  _model = await AutoModelForSequenceClassification.from_pretrained(RERANK_MODEL, { quantized: true });
  return { tok: _tok, model: _model };
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x));

async function rerank(queryText, candidates) {
  if (!candidates.length) return [];
  const { tok, model } = await getModel();

  // Batched pair scoring: query paired with each candidate passage.
  const queries = candidates.map(() => queryText);
  const docs = candidates.map((c) => c.text);
  const inputs = await tok(queries, { text_pair: docs, padding: true, truncation: true });
  const { logits } = await model(inputs);

  // bge-reranker emits a single relevance logit per pair → sigmoid to 0..1.
  const raw = logits.tolist().map((row) => (Array.isArray(row) ? row[0] : row));
  const scored = candidates.map((c, i) => ({ ...c, rerank: sigmoid(raw[i]) }));
  scored.sort((a, b) => b.rerank - a.rerank);

  const kept = scored.filter((c) => c.rerank >= RERANK_THRESHOLD);
  // If the floor filtered everything, fall back to the best few rather than
  // returning nothing (the retrieval guardrail already ensured relevance).
  return (kept.length ? kept : scored).slice(0, TOP_K);
}

module.exports = { rerank };
