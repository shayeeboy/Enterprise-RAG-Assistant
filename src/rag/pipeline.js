/**
 * The Assistant — end-to-end query pipeline, with built-in observability.
 *
 *   User Question → Query Rewrite → Embedding → Hybrid Search → Scoring →
 *   Threshold → Reranking → Top-K → Prompt Augmentation → LLM Reasoning →
 *   Generated Answer → Citations → Guardrails → Response
 *
 * Every stage is timed; token usage and estimated cost are accumulated; errors
 * are captured per stage. All of it is returned in `meta` (traceId, latencyMs,
 * tokens, costUsd) and logged by the server — see src/rag/trace.js.
 */
const cfg = require("./config");
const { validateInput, groundingGuard, REFUSAL } = require("./guardrails");
const { rewriteQuery } = require("./rewrite");
const { hybridRetrieve } = require("./retrieve");
const { rerank } = require("./rerank");
const { buildMessages } = require("./prompt");
const { chat } = require("./llm");
const { newTrace, span, addTokens, finalize } = require("./trace");

function sourceList(chunks) {
  return chunks.map((c, i) => ({
    n: i + 1,
    title: c.title,
    author: c.author,
    page_start: c.page_start,
    page_end: c.page_end,
    content_type: c.content_type,
    rerank: c.rerank != null ? Number(c.rerank.toFixed(4)) : null,
  }));
}

function buildMeta(trace, extra = {}) {
  finalize(trace, {
    costPer1kPrompt: cfg.LLM_COST_PROMPT_PER_1K,
    costPer1kCompletion: cfg.LLM_COST_COMPLETION_PER_1K,
  });
  return {
    ...extra,
    provider: trace.provider,
    model: trace.model,
    traceId: trace.traceId,
    latencyMs: { total: trace.totalMs, ...trace.stages },
    tokens: trace.tokens,
    costUsd: trace.costUsd,
    ...(trace.error ? { error: trace.error } : {}),
  };
}

async function answerQuestion(rawQuestion, { filters = {}, onStage } = {}) {
  const stage = (name, data) => onStage && onStage(name, data);
  const trace = newTrace({ provider: cfg.LLM_PROVIDER, model: cfg.LLM_MODEL });

  // 1. Guardrails — input
  const v = validateInput(rawQuestion);
  if (!v.ok) return { ok: false, stage: "input-guardrail", answer: v.message, citations: [], meta: buildMeta(trace) };
  const question = v.value;
  stage("input", { question });

  // 2. Query rewrite (non-fatal on failure)
  let rw = { query: question, rewritten: false };
  try {
    rw = await span(trace, "rewrite", () => rewriteQuery(question));
  } catch {
    /* fall back to original question */
  }
  addTokens(trace, rw.usage);
  const searchQuery = rw.query;
  stage("rewrite", { searchQuery, rewritten: rw.rewritten });

  // 3–6. Embedding → Hybrid Search → Scoring → Threshold
  let retrieval;
  try {
    retrieval = await span(trace, "retrieve", () => hybridRetrieve(searchQuery, filters));
  } catch (e) {
    trace.error = "retrieve: " + e.message;
    return { ok: false, stage: "retrieve", answer: "Retrieval failed: " + e.message, citations: [], meta: buildMeta(trace) };
  }
  const { candidates, vectorCount, keywordCount } = retrieval;
  stage("retrieve", { candidates: candidates.length, vectorCount, keywordCount });

  if (!candidates.length) {
    return {
      ok: true, grounded: false, answer: REFUSAL, citations: [], sources: [],
      meta: buildMeta(trace, { searchQuery, rewritten: rw.rewritten, retrieved: 0 }),
    };
  }

  // 7–8. Reranking → Top-K
  let top;
  try {
    top = await span(trace, "rerank", () => rerank(searchQuery, candidates));
  } catch (e) {
    trace.error = "rerank: " + e.message;
    return { ok: false, stage: "rerank", answer: "Rerank failed: " + e.message, citations: [], meta: buildMeta(trace) };
  }
  const bestScore = top.length ? top[0].rerank || 0 : 0;
  stage("rerank", { kept: top.length, bestScore: Number(bestScore.toFixed(3)) });
  // Relevance guardrail: nothing scored above the confidence floor → the query
  // is out of scope for this knowledge base; refuse instead of answering from
  // irrelevant context.
  if (!top.length || bestScore < cfg.RELEVANCE_FLOOR) {
    return {
      ok: true, grounded: false, answer: REFUSAL, citations: [], sources: [],
      meta: buildMeta(trace, { searchQuery, rewritten: rw.rewritten, retrieved: candidates.length, reranked: top.length }),
    };
  }

  // 9–10. Prompt Augmentation → LLM Reasoning
  const messages = buildMessages(question, top);
  let llmRes;
  try {
    llmRes = await span(trace, "llm", () => chat(messages));
  } catch (e) {
    trace.error = "llm: " + e.message;
    return {
      ok: false, stage: "llm",
      answer: `The language model is unavailable: ${e.message}\n\nStart a local model with Ollama (see README) or configure LLM_* env vars.`,
      citations: [], sources: sourceList(top),
      meta: buildMeta(trace, { searchQuery, rewritten: rw.rewritten, retrieved: candidates.length, reranked: top.length }),
    };
  }
  addTokens(trace, llmRes.usage);
  // Strip a stray literal "[n]" the model may echo from the instruction.
  const answer = (llmRes.content || "").replace(/^\s*\[n\]\s*/i, "").trim();

  // 11–12. Citations → Grounding guardrail
  const { grounded, citations } = groundingGuard(answer, top);
  const finalAnswer = grounded
    ? answer
    : answer + "\n\n⚠️ Note: this answer cited no source, so it may not be fully grounded in the knowledge base — treat with caution.";

  // 13. Response
  return {
    ok: true,
    grounded,
    answer: finalAnswer,
    citations,
    sources: sourceList(top),
    meta: buildMeta(trace, { searchQuery, rewritten: rw.rewritten, retrieved: candidates.length, reranked: top.length }),
  };
}

module.exports = { answerQuestion };
