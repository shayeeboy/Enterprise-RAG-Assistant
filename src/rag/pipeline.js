/**
 * The Assistant — end-to-end query pipeline.
 *
 *   User Question → Query Rewrite → Embedding → Hybrid Search → Scoring →
 *   Threshold → Reranking → Top-K → Prompt Augmentation → LLM Reasoning →
 *   Generated Answer → Citations → Guardrails → Response
 *
 * Each stage lives in its own module; this file is just the orchestration and
 * the guardrail branch points.
 */
const cfg = require("./config");
const { validateInput, groundingGuard, REFUSAL } = require("./guardrails");
const { rewriteQuery } = require("./rewrite");
const { hybridRetrieve } = require("./retrieve");
const { rerank } = require("./rerank");
const { buildMessages } = require("./prompt");
const { chat } = require("./llm");

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

async function answerQuestion(rawQuestion, { filters = {}, onStage } = {}) {
  const stage = (name, data) => onStage && onStage(name, data);

  // 1. Guardrails — input
  const v = validateInput(rawQuestion);
  if (!v.ok) return { ok: false, stage: "input-guardrail", answer: v.message, citations: [] };
  const question = v.value;
  stage("input", { question });

  // 2. Query rewrite
  const { query: searchQuery, rewritten } = await rewriteQuery(question);
  stage("rewrite", { searchQuery, rewritten });

  // 3–6. Embedding → Hybrid Search → Scoring → Threshold
  const { candidates, vectorCount, keywordCount } = await hybridRetrieve(searchQuery, filters);
  stage("retrieve", { candidates: candidates.length, vectorCount, keywordCount });

  // Retrieval guardrail: nothing relevant → refuse (no hallucination).
  if (!candidates.length) {
    return {
      ok: true, grounded: false, answer: REFUSAL, citations: [], sources: [],
      meta: { searchQuery, rewritten, retrieved: 0 },
    };
  }

  // 7–8. Reranking → Top-K
  const top = await rerank(searchQuery, candidates);
  stage("rerank", {
    kept: top.length,
    top: top.map((c) => ({ title: c.title, pages: [c.page_start, c.page_end], rerank: Number(c.rerank?.toFixed(3)) })),
  });
  if (!top.length) {
    return {
      ok: true, grounded: false, answer: REFUSAL, citations: [], sources: [],
      meta: { searchQuery, rewritten, retrieved: candidates.length, reranked: 0 },
    };
  }

  // 9–10. Prompt Augmentation → LLM Reasoning
  const messages = buildMessages(question, top);
  let answer;
  try {
    answer = await chat(messages);
  } catch (e) {
    return {
      ok: false, stage: "llm",
      answer:
        `The language model is unavailable: ${e.message}\n\n` +
        `Start a local model with Ollama (see README) or configure LLM_* env vars.`,
      citations: [], sources: sourceList(top),
    };
  }

  // 11–12. Citations → Grounding guardrail
  const { grounded, citations } = groundingGuard(answer, top);
  const finalAnswer = grounded
    ? answer
    : answer +
      "\n\n⚠️ Note: this answer cited no source, so it may not be fully grounded in the knowledge base — treat with caution.";

  // 13. Response
  return {
    ok: true,
    grounded,
    answer: finalAnswer,
    citations,
    sources: sourceList(top),
    meta: {
      searchQuery,
      rewritten,
      retrieved: candidates.length,
      reranked: top.length,
      provider: cfg.LLM_PROVIDER,
      model: cfg.LLM_MODEL,
    },
  };
}

module.exports = { answerQuestion };
