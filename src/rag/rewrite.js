/**
 * Query rewrite (workflow step: Query Rewrite).
 * Rewrites a raw user question into a single, self-contained search query
 * that retrieves better (resolves pronouns, drops chit-chat, keeps key terms).
 * Uses the local LLM; if it's unavailable or rewriting fails, we fall back to
 * the original question so retrieval still runs.
 */
const { chat } = require("./llm");
const cfg = require("./config");

const SYSTEM = `Rewrite the user's question into a single, self-contained search query optimized for keyword + semantic retrieval over a piano-practice knowledge base.
Keep the important domain terms. Do not answer the question.
Output ONLY the rewritten query as plain text — no quotes, no preamble, one line.`;

async function rewriteQuery(question) {
  if (!cfg.ENABLE_QUERY_REWRITE) return { query: question, rewritten: false };
  try {
    const { content, usage } = await chat([
      { role: "system", content: SYSTEM },
      { role: "user", content: question },
    ]);
    const q = (content || "").split("\n")[0].replace(/^["']|["']$/g, "").trim();
    if (!q || q.length < 3) return { query: question, rewritten: false, usage };
    return { query: q, rewritten: q.toLowerCase() !== question.toLowerCase(), usage };
  } catch (e) {
    // Non-fatal: retrieval proceeds with the original question.
    return { query: question, rewritten: false, error: e.message };
  }
}

module.exports = { rewriteQuery };
