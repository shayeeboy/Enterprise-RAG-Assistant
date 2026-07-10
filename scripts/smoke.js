/**
 * Smoke test — verifies every layer of the RAG assistant is wired up and the
 * vector DB is loaded, without needing a full manual query. Safe to run any
 * time (read-only; makes no writes).
 *
 * Checks, in order:
 *   1. DATABASE_URL is set
 *   2. DB connectivity + row counts (documents / chunks / embedded chunks)
 *   3. Local query embedding produces the right dimension
 *   4. Hybrid retrieval returns candidates for a sample question
 *   5. Reranking orders them
 *   6. LLM reachability (soft — a warning, not a failure)
 *   7. Full end-to-end answer (only if the LLM is up)
 *
 * Usage:
 *     npm run smoke
 *     npm run smoke -- "your own sample question"
 *
 * Exit code: 0 if all hard checks pass, 1 otherwise (CI-friendly).
 */
require("dotenv").config();
const cfg = require("../src/rag/config");
const { pool, close } = require("../src/rag/db");
const { embedQuery } = require("../src/rag/embed");
const { hybridRetrieve } = require("../src/rag/retrieve");
const { rerank } = require("../src/rag/rerank");
const { ping } = require("../src/rag/llm");
const { answerQuestion } = require("../src/rag/pipeline");

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok });
  const tag = ok === true ? "PASS" : ok === "warn" ? "WARN" : "FAIL";
  console.log(`[${tag}] ${name}${detail ? " — " + detail : ""}`);
}

async function main() {
  const SAMPLE = process.argv.slice(2).join(" ").trim() || "How should I practice a difficult passage?";
  console.log(`Smoke test — sample question: "${SAMPLE}"\n`);
  let hardFail = false;

  // 1. env
  if (!process.env.DATABASE_URL) {
    record("DATABASE_URL is set", false, "missing — set it in .env");
    finish(true);
    return;
  }
  record("DATABASE_URL is set", true);

  // 2. DB connectivity + data
  try {
    await pool.query("SELECT 1");
    const d = await pool.query("SELECT count(*)::int AS n FROM documents");
    const c = await pool.query("SELECT count(*)::int AS n FROM chunks");
    const e = await pool.query("SELECT count(*)::int AS n FROM chunks WHERE embedding IS NOT NULL");
    record("DB connectivity + data", true, `${d.rows[0].n} documents, ${c.rows[0].n} chunks (${e.rows[0].n} embedded)`);
    if (e.rows[0].n === 0) {
      record("embeddings loaded", false, "no embedded chunks — run `npm run build`");
      hardFail = true;
    }
  } catch (err) {
    record("DB connectivity + data", false, err.message);
    hardFail = true;
  }

  // 3. embedding
  try {
    const v = await embedQuery("test query");
    const ok = v.length === cfg.EMBEDDING_DIM;
    record("query embedding", ok, `${v.length}-dim`);
    if (!ok) hardFail = true;
  } catch (err) {
    record("query embedding", false, err.message);
    hardFail = true;
  }

  // 4. hybrid retrieval (needs DB + embeddings)
  let candidates = [];
  if (!hardFail) {
    try {
      const r = await hybridRetrieve(SAMPLE);
      candidates = r.candidates;
      record("hybrid retrieval", candidates.length > 0, `${candidates.length} candidates (vector ${r.vectorCount}, keyword ${r.keywordCount})`);
      if (!candidates.length) hardFail = true;
    } catch (err) {
      record("hybrid retrieval", false, err.message);
      hardFail = true;
    }
  }

  // 5. reranking
  if (candidates.length) {
    try {
      const top = await rerank(SAMPLE, candidates);
      record("reranking", top.length > 0, `kept ${top.length}, best score ${top[0]?.rerank?.toFixed(3)}`);
      if (!top.length) hardFail = true;
    } catch (err) {
      record("reranking", false, err.message);
      hardFail = true;
    }
  }

  // 6. LLM reachability (soft)
  const llmUp = await ping();
  record(
    `LLM reachable (${cfg.LLM_PROVIDER}/${cfg.LLM_MODEL})`,
    llmUp ? true : "warn",
    llmUp ? undefined : "not reachable — retrieval works; start Ollama (`ollama serve`) for full answers"
  );

  // 7. full end-to-end (soft — only if LLM available)
  if (llmUp && !hardFail) {
    try {
      const res = await answerQuestion(SAMPLE);
      const ok = res.ok !== false && !!res.answer;
      record("end-to-end answer", ok ? true : "warn", `${res.grounded ? "grounded" : "ungrounded"}, ${res.citations?.length || 0} citations`);
    } catch (err) {
      record("end-to-end answer", "warn", err.message);
    }
  }

  finish(hardFail);
}

async function finish(hardFail) {
  const passed = results.filter((r) => r.ok === true).length;
  const warned = results.filter((r) => r.ok === "warn").length;
  const failed = results.filter((r) => r.ok === false).length;
  console.log("\n" + "=".repeat(52));
  console.log(`Result: ${passed} passed · ${warned} warn · ${failed} failed`);
  console.log(failed ? "SMOKE TEST FAILED" : "SMOKE TEST OK");
  try { await close(); } catch {}
  process.exit(failed ? 1 : 0);
}

main().catch(async (err) => {
  console.error(err);
  try { await close(); } catch {}
  process.exit(1);
});
