/**
 * Observability benchmark (`npm run bench`).
 *
 * Drives a batch of realistic piano-practice questions through the REAL pipeline
 * and logs each to query_logs tagged `source='benchmark'`, so the system-health
 * metrics (latency p50/p95, grounded rate, cost) become statistically meaningful.
 * This is automated TEST traffic — reported separately from organic `live`
 * queries, never presented as real usage.
 *
 * Batch size = BENCH_COUNT (default 40, sized to fit a Groq free-tier daily
 * window). Paces between calls and ABORTS cleanly on a rate-limit / tokens-per-day
 * cap so partial progress is preserved and nothing bogus is logged. Run it a few
 * times (e.g. nightly) to accumulate a meaningful sample.
 */
require("dotenv").config();
const { buildBank } = require("../eval/bench-questions");
const { answerQuestion } = require("../src/rag/pipeline");
const { logQuery } = require("../src/rag/logstore");
const { close } = require("../src/rag/db");
const quota = require("./lib/quota-guard");

const COUNT = Number(process.env.BENCH_COUNT || 40);
const PACE_MS = Number(process.env.BENCH_PACE_MS || 800);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function shuffle(a) {
  const arr = a.slice();
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

const isRateLimited = (err) => /429|rate.?limit|tokens per day|TPD/i.test(String(err));

// --- Token-aware sliding-window pacer (mirrors eval-judge.js's reserveBudget) ---
// Groq's free tier caps tokens-per-minute (gpt-oss-120b = 8000 TPM — see
// eval-judge.js), and a single RAG answer can cost anywhere from ~200 to
// ~3000 tokens depending on how much context gets retrieved, so a flat delay
// between questions can't account for the swing: two "big" questions landing
// close together can blow the budget on their own. Track actual usage in the
// trailing 60s (from each call's real meta.tokens.total) and wait before a
// call that would likely exceed it, using the last real call as the estimate
// for the next one (nothing better to go on until it returns).
const BENCH_TPM_BUDGET = Number(process.env.BENCH_TPM || 7200);
const recentCalls = []; // { t, tokens }
function tokensUsedLast60s() {
  const cut = Date.now() - 60000;
  while (recentCalls.length && recentCalls[0].t < cut) recentCalls.shift();
  return recentCalls.reduce((s, c) => s + c.tokens, 0);
}
let lastTokenEstimate = 2500; // conservative guess before we've seen a real call
async function reserveBudget() {
  for (;;) {
    const used = tokensUsedLast60s();
    if (used + lastTokenEstimate <= BENCH_TPM_BUDGET || !recentCalls.length) return;
    const wait = Math.max(500, recentCalls[0].t + 60000 - Date.now() + 300);
    console.log(`    (throttle: ${used} tok/60s + ~${lastTokenEstimate} > ${BENCH_TPM_BUDGET} — waiting ${Math.round(wait / 1000)}s)`);
    await sleep(Math.min(wait, 61000));
  }
}
function recordUsage(tokens) {
  if (!tokens) return;
  recentCalls.push({ t: Date.now(), tokens });
  lastTokenEstimate = tokens;
}

// A single question can fire up to 3 Groq calls (rewrite, gate, generation),
// so a burst of questions can trip the per-minute (TPM) limit well before the
// daily cap (TPD). Only the generation call's failure surfaces into
// res.meta.error (rewrite is non-fatal, gate is fail-open — see pipeline.js),
// so that's what we retry here. Mirrors eval-judge.js's withRetry: a TPM 429
// needs the per-minute window to actually slide, so wait long, not ms.
async function answerWithRetry(q, retries = 4) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const res = await answerQuestion(q);
    const err = res && res.meta && res.meta.error;
    if (!err || !isRateLimited(err)) return res;
    // A confirmed daily-cap error won't clear on its own within this run —
    // bubble up immediately rather than burning retries against it.
    if (quota.isDailyCapError(err) || attempt === retries) return res;
    const wait = 20000;
    console.log(`    (${err.slice(0, 70)} — retry ${attempt}/${retries} in ${Math.round(wait / 1000)}s)`);
    await sleep(wait);
  }
}

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const alreadyExhausted = quota.isExhausted();
  if (alreadyExhausted) {
    console.log(
      `Groq daily token cap (tokens per day) still recovering — tripped by ${alreadyExhausted.by} at ${alreadyExhausted.at}, ` +
      `won't clear until ~${alreadyExhausted.retryAt}. Skipping this run.`
    );
    await close();
    process.exit(0);
  }

  const bank = buildBank();
  // Sample with replacement across the bank so repeated nightly runs vary.
  const batch = shuffle(bank).slice(0, Math.min(COUNT, bank.length));
  console.log(`Observability benchmark — ${batch.length} of ${bank.length} questions (source=benchmark)\n`);

  let logged = 0;
  let grounded = 0;
  for (let i = 0; i < batch.length; i++) {
    const q = batch[i];
    await reserveBudget();
    let res;
    try {
      res = await answerWithRetry(q);
    } catch (e) {
      console.log(`  [${i + 1}] ERROR ${e.message.slice(0, 80)} — aborting`);
      break;
    }
    recordUsage(res && res.meta && res.meta.tokens && res.meta.tokens.total);
    // A rate-limited generation returns ok:false with the 429 in meta.error.
    const err = res && res.meta && res.meta.error;
    if (err && isRateLimited(err)) {
      const dailyCap = quota.isDailyCapError(err);
      if (dailyCap) quota.markExhausted("bench", err);
      const why = dailyCap ? "daily quota spent" : "rate limit didn't clear after retries";
      console.log(`  [${i + 1}] rate-limited (${why}) — stopping, ${logged} logged so far`);
      break;
    }
    await logQuery(q, res, "benchmark");
    logged++;
    if (res && res.grounded) grounded++;
    const ms = res && res.meta && res.meta.latencyMs ? res.meta.latencyMs.total : "?";
    console.log(`  [${i + 1}] ${res && res.grounded ? "grounded" : "refused "} ${String(ms).padStart(6)}ms | ${q}`);
    await sleep(PACE_MS);
  }

  console.log(`\nLogged ${logged} benchmark queries (${logged ? Math.round((100 * grounded) / logged) : 0}% grounded).`);
  console.log("Run `npm run stats` to refresh the README observability block.");
  await close();
  process.exit(0);
})().catch(async (e) => {
  console.error("bench failed:", e.message);
  if (quota.isDailyCapError(e.message)) quota.markExhausted("bench", e.message);
  try { await close(); } catch {}
  process.exit(1);
});
