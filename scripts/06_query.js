/**
 * STAGE 8: The Assistant (query-time RAG) — CLI
 * ---------------------------------------------
 * Runs the full workflow:
 *   User Question → Query Rewrite → Embedding → Hybrid Search → Scoring →
 *   Threshold → Reranking → Top-K → Prompt Augmentation → LLM Reasoning →
 *   Answer → Citations → Guardrails → Response
 *
 * Usage:
 *     node scripts/06_query.js "how should I practice a difficult passage?"
 *     VERBOSE=1 node scripts/06_query.js "..."      # print per-stage telemetry
 *
 * Requires DATABASE_URL (Neon) and a local LLM (Ollama by default). Retrieval
 * and reranking run fully locally; only the final answer needs the LLM.
 */
require("dotenv").config();
const { answerQuestion } = require("../src/rag/pipeline");
const { close } = require("../src/rag/db");

async function main() {
  const question = process.argv.slice(2).join(" ").trim();
  if (!question) {
    console.error('Usage: node scripts/06_query.js "your question"');
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (Neon connection string). Aborting.");
    process.exit(1);
  }

  const verbose = process.env.VERBOSE === "1";
  const res = await answerQuestion(question, {
    onStage: verbose ? (n, d) => console.error(`· ${n}:`, JSON.stringify(d)) : undefined,
  });

  console.log("\n" + "=".repeat(64));
  console.log(res.answer);
  console.log("=".repeat(64));

  if (res.citations && res.citations.length) {
    console.log("\nCitations:");
    res.citations.forEach((c) => {
      const pages = c.page_start === c.page_end ? `p.${c.page_start}` : `pp.${c.page_start}-${c.page_end}`;
      console.log(`  [${c.n}] ${c.title} — ${pages} (${c.content_type || "general"})`);
    });
  }
  if (res.meta) console.error("\nmeta:", JSON.stringify(res.meta));

  await close();
}

main().catch(async (err) => {
  console.error(err);
  try { await close(); } catch {}
  process.exit(1);
});
