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

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const bank = buildBank();
  // Sample with replacement across the bank so repeated nightly runs vary.
  const batch = shuffle(bank).slice(0, Math.min(COUNT, bank.length));
  console.log(`Observability benchmark — ${batch.length} of ${bank.length} questions (source=benchmark)\n`);

  let logged = 0;
  let grounded = 0;
  for (let i = 0; i < batch.length; i++) {
    const q = batch[i];
    let res;
    try {
      res = await answerQuestion(q);
    } catch (e) {
      console.log(`  [${i + 1}] ERROR ${e.message.slice(0, 80)} — aborting`);
      break;
    }
    // A rate-limited generation returns ok:false with the 429 in meta.error.
    const err = res && res.meta && res.meta.error;
    if (err && /429|rate.?limit|tokens per day|TPD/i.test(err)) {
      console.log(`  [${i + 1}] rate-limited (daily quota spent) — stopping, ${logged} logged so far`);
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
  try { await close(); } catch {}
  process.exit(1);
});
