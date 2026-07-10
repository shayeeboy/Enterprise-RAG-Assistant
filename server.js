/**
 * Local HTTP API + minimal chat UI for the RAG assistant.
 *
 *   POST /ask     { question }        → full pipeline result (answer + citations)
 *   GET  /health                      → DB + LLM reachability
 *   GET  /                            → static chat UI (public/index.html)
 *
 * Runs locally because the LLM (Ollama) and the embedding/rerank models are
 * local and free. Start with:  npm run serve
 */
require("dotenv").config();
const express = require("express");
const path = require("path");
const { answerQuestion } = require("./src/rag/pipeline");
const { ping } = require("./src/rag/llm");
const { pool } = require("./src/rag/db");
const cfg = require("./src/rag/config");

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/health", async (_req, res) => {
  const out = { status: "ok", provider: cfg.LLM_PROVIDER, model: cfg.LLM_MODEL };
  try {
    await pool.query("SELECT 1");
    out.db = "connected";
  } catch {
    out.db = "unreachable";
    out.status = "degraded";
  }
  out.llm = (await ping()) ? "reachable" : "unreachable";
  res.json(out);
});

app.post("/ask", async (req, res) => {
  const question = (req.body && req.body.question) || "";
  try {
    const result = await answerQuestion(question);
    res.json(result);
  } catch (e) {
    console.error("ask failed:", e.message);
    res.status(500).json({ ok: false, answer: "Internal error handling the question.", error: e.message });
  }
});

app.listen(cfg.PORT, () => {
  console.log(`RAG assistant on http://localhost:${cfg.PORT}  (LLM: ${cfg.LLM_PROVIDER}/${cfg.LLM_MODEL})`);
});
