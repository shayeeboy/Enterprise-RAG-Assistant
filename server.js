/**
 * Local / deployable HTTP API + minimal chat UI for the RAG assistant.
 *
 *   POST /ask     { question }        → full pipeline result (answer + citations)
 *   GET  /health                      → DB + LLM reachability
 *   GET  /                            → static chat UI (public/index.html)
 *
 * Deployment hardening (all opt-in via env — see .env.example and docs/PHASE-3.md):
 *   - CORS allowlist (ALLOWED_ORIGINS); open when unset for local dev.
 *   - Per-IP rate limiting (RATE_LIMIT_MAX / RATE_LIMIT_WINDOW_MS).
 *   - Optional shared access code (ACCESS_CODE) to gate /ask.
 *
 * Start with:  npm run serve
 */
require("dotenv").config();
const express = require("express");
const cors = require("cors");
const path = require("path");
const { answerQuestion } = require("./src/rag/pipeline");
const { ping } = require("./src/rag/llm");
const { pool } = require("./src/rag/db");
const logstore = require("./src/rag/logstore");
const cfg = require("./src/rag/config");

const app = express();
app.set("trust proxy", true); // so req.ip reflects X-Forwarded-For behind a host's proxy
app.use(express.json({ limit: "64kb" }));

// --- CORS: open in local dev (no allowlist), restricted in production ---
app.use(
  cors({
    origin(origin, cb) {
      if (!cfg.ALLOWED_ORIGINS.length) return cb(null, true); // dev: allow all
      if (!origin || cfg.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`Origin ${origin} not allowed by CORS`));
    },
  })
);

app.use(express.static(path.join(__dirname, "public")));

// --- Simple in-memory per-IP rate limiter (fixed window; fine for one instance) ---
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  let e = hits.get(ip);
  if (!e || now > e.reset) {
    e = { count: 0, reset: now + cfg.RATE_LIMIT_WINDOW_MS };
    hits.set(ip, e);
  }
  e.count++;
  if (e.count > cfg.RATE_LIMIT_MAX) {
    const retry = Math.ceil((e.reset - now) / 1000);
    res.set("Retry-After", String(retry));
    return res.status(429).json({ ok: false, answer: `Rate limit exceeded — try again in ${retry}s.` });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of hits) if (now > v.reset) hits.delete(k);
}, 60000).unref();

// --- Optional shared access code (protects a public LLM endpoint from abuse) ---
function accessGate(req, res, next) {
  if (!cfg.ACCESS_CODE) return next();
  const code = req.get("x-access-code") || (req.body && req.body.accessCode);
  if (code === cfg.ACCESS_CODE) return next();
  return res.status(401).json({ ok: false, answer: "Access code required or incorrect." });
}

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

// Aggregated observability over all logged user attempts.
app.get("/stats", async (_req, res) => {
  try {
    res.json(await logstore.getStats());
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/ask", rateLimit, accessGate, async (req, res) => {
  const question = (req.body && req.body.question) || "";
  try {
    const result = await answerQuestion(question);
    // Structured observability line — one JSON object per request.
    const m = result.meta || {};
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        traceId: m.traceId,
        ms: m.latencyMs?.total,
        stages: m.latencyMs,
        tokens: m.tokens?.total,
        costUsd: m.costUsd,
        grounded: result.grounded,
        model: m.model,
        error: m.error || null,
      })
    );
    // Persist the trace for searchable/aggregated observability (best-effort;
    // awaited so it completes before a Cloud Run instance can freeze).
    await logstore.logQuery(question, result);
    res.json(result);
  } catch (e) {
    console.error("ask failed:", e.message);
    res.status(500).json({ ok: false, answer: "Internal error handling the question.", error: e.message });
  }
});

// Ensure the observability table exists (non-fatal if the DB is unreachable).
logstore.ensureSchema().catch((e) => console.warn("query_logs ensureSchema failed:", e.message));

app.listen(cfg.PORT, () => {
  const cors = cfg.ALLOWED_ORIGINS.length ? cfg.ALLOWED_ORIGINS.join(", ") : "(open — dev)";
  console.log(`RAG assistant on http://localhost:${cfg.PORT}  (LLM: ${cfg.LLM_PROVIDER}/${cfg.LLM_MODEL})`);
  console.log(`CORS: ${cors} · rate limit: ${cfg.RATE_LIMIT_MAX}/${Math.round(cfg.RATE_LIMIT_WINDOW_MS / 1000)}s · access code: ${cfg.ACCESS_CODE ? "on" : "off"}`);
});
