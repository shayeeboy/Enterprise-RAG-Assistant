/**
 * Retrieval-quality evaluation (Phase 2 acceptance criteria).
 *
 * Runs the real retrieval path (hybrid search + RRF + rerank) against a small
 * labeled question set and reports Hit@5, MRR, and refusal accuracy on
 * out-of-KB questions. Relevance is a lightweight PROXY: a retrieved chunk
 * counts as relevant if its text contains one of the question's expected
 * keywords. This is not human-judged ground truth — it's a fast, reproducible
 * regression signal for "is retrieval surfacing on-topic passages, and does the
 * system correctly retrieve nothing for out-of-corpus questions."
 *
 * Hit@5/MRR need DATABASE_URL + the local models. The refusal check runs the
 * full pipeline (so it needs the LLM too); it's skipped with a warning if the
 * LLM is unreachable, since refusal happens at the LLM/grounding stage — the
 * permissive retrieval threshold intentionally still surfaces candidates.
 *   npm run eval
 * Exit code 0 if targets met (Hit@5 >= 80%, refusal = 100% when tested), else 1.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { hybridRetrieve } = require("../src/rag/retrieve");
const { rerank } = require("../src/rag/rerank");
const { answerQuestion } = require("../src/rag/pipeline");
const { ping } = require("../src/rag/llm");
const { close } = require("../src/rag/db");

const K = 5;
const HIT_TARGET = 0.8;
const REFUSE_TARGET = 1.0;

const isRelevant = (chunk, kws) => {
  const t = (chunk.text || "").toLowerCase();
  return kws.some((k) => t.includes(k.toLowerCase()));
};

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const qs = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "eval", "questions.json"), "utf8"));
  const answerable = qs.filter((q) => q.answerable);
  const unanswerable = qs.filter((q) => !q.answerable);

  console.log(`Retrieval-quality eval — proxy: keyword relevance in top-${K} (reranked)\n`);

  let hits = 0;
  let rrSum = 0;
  for (const q of answerable) {
    const { candidates } = await hybridRetrieve(q.question);
    const top = (await rerank(q.question, candidates)).slice(0, K);
    let rank = 0;
    for (let i = 0; i < top.length; i++) {
      if (isRelevant(top[i], q.keywords)) { rank = i + 1; break; }
    }
    if (rank > 0) { hits++; rrSum += 1 / rank; }
    console.log(`  ${rank > 0 ? "HIT " : "MISS"} @${rank || "-"}  ${q.question}`);
  }

  console.log("");
  // Refusal is decided by the LLM + grounding guardrail (a well-behaved model
  // answers "not in the knowledge base" and cites nothing → grounded=false).
  let refused = 0;
  let refusalTested = 0;
  const llmUp = await ping();
  if (!llmUp) {
    console.log("  (LLM unreachable — skipping refusal check; run with an LLM configured to test it)");
  } else {
    for (const q of unanswerable) {
      const res = await answerQuestion(q.question);
      const refusedOk = res.grounded === false; // out-of-KB → ungrounded / refusal
      if (refusedOk) refused++;
      refusalTested++;
      console.log(`  ${refusedOk ? "REFUSED " : "ANSWERED"}  ${q.question}`);
    }
  }

  const hitRate = answerable.length ? hits / answerable.length : 0;
  const mrr = answerable.length ? rrSum / answerable.length : 0;
  const refusalRate = refusalTested ? refused / refusalTested : null;

  console.log("\n=== Results ===");
  console.log(`Hit@${K} (answerable):   ${(hitRate * 100).toFixed(0)}%  (${hits}/${answerable.length})`);
  console.log(`MRR:                  ${mrr.toFixed(3)}`);
  console.log(
    `Refusal on out-of-KB: ${refusalRate == null ? "not tested (no LLM)" : (refusalRate * 100).toFixed(0) + "%  (" + refused + "/" + refusalTested + ")"}`
  );

  const refusalOk = refusalRate == null || refusalRate >= REFUSE_TARGET;
  const pass = hitRate >= HIT_TARGET && refusalOk;
  console.log(`\n${pass ? "PASS" : "FAIL"}  (targets: Hit@${K} >= ${HIT_TARGET * 100}%, refusal = ${REFUSE_TARGET * 100}% when tested)`);
  await close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => {
  console.error(e);
  try { await close(); } catch {}
  process.exit(1);
});
