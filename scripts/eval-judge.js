/**
 * Phase 4 — LLM-as-Judge evaluation harness (`npm run eval:judge`).
 *
 * For each answerable question it runs the REAL pipeline (hybrid search + RRF +
 * rerank + LLM) to get the system answer and the exact top-K context, then has
 * a deterministic LLM-judge (temp 0, cross-model) score three things the old
 * keyword eval could not:
 *   - hallucination_detected (faithfulness: answer strictly ⊂ retrieved context)
 *   - answer_correctness_score (0..5 vs human-validated ground truth)
 *   - hit5_retrieval_pass (semantic retrieval recall, binary)
 * Out-of-scope questions are checked for correct refusal (deterministic grounding
 * guard), reported separately.
 *
 * Needs DATABASE_URL + a reachable LLM (same free tier as generation → $0).
 * Writes eval/judge-results.json. Exit 0 iff all acceptance targets are met.
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { answerQuestion } = require("../src/rag/pipeline");
const { judgeCase, judgeSettings, formatJudgeInput, JUDGE_SYSTEM_PROMPT } = require("../src/rag/judge");
const cfg = require("../src/rag/config");
const { close } = require("../src/rag/db");
const quota = require("./lib/quota-guard");

// --- Checkpoint/resume across the Groq daily-token-cap (TPD) ---
// One full 22-question run costs more tokens than the free-tier daily cap, so
// a run that gets rate-limited partway through saves progress here and the
// next scheduled run (once the cap resets) picks up the remaining questions
// instead of restarting from zero. Cleared once a full cycle completes.
const CHECKPOINT_PATH = path.join(__dirname, "..", "eval", ".judge-checkpoint.json");
function loadCheckpoint() {
  try {
    return JSON.parse(fs.readFileSync(CHECKPOINT_PATH, "utf8"));
  } catch {
    return { results: [], refusedAnswerable: [], refusalRows: [], usageTotal: { prompt: 0, completion: 0, total: 0 }, startedAt: new Date().toISOString() };
  }
}
function saveCheckpoint(state) {
  fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify(state, null, 2));
}
function clearCheckpoint() {
  try { fs.unlinkSync(CHECKPOINT_PATH); } catch {}
}

// --- Near-term roadmap goals (reported; the next milestone we're driving to) ---
// See the "Improvement roadmap" table in the README for the actions behind each
// and the stretch targets beyond these.
const GOAL_HALLUCINATION_MAX = 0.15; // faithfulness ≥ 85%
const GOAL_CORRECTNESS_MIN = 3.6; // mean correctness (0..5)
const GOAL_HIT5_MIN = 0.9; // ≥ 90% semantic Hit@5
const GOAL_REFUSAL_MIN = 1.0; // 100% refusal on out-of-scope

// --- CI regression floors (gate the exit code) ---
// Set below the measured baseline so the build stays green at current quality
// and only a genuine regression fails it. Refusal has no slack — fabricating on
// out-of-scope is the one thing this system must never regress on. Tune via env.
const FLOOR_HALLUCINATION_MAX = Number(process.env.FLOOR_HALLUCINATION_MAX || 0.34);
const FLOOR_CORRECTNESS_MIN = Number(process.env.FLOOR_CORRECTNESS_MIN || 2.7);
const FLOOR_HIT5_MIN = Number(process.env.FLOOR_HIT5_MIN || 0.75);
const FLOOR_REFUSAL_MIN = 1.0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Generation can fail non-fatally inside the pipeline (it returns ok:false with
// an error message instead of throwing). If we fed that error string to the
// judge it would score a real answer as 0 — silent garbage. Surface it as a
// throw so withRetry can back off (e.g. a rate limit), and if it persists the
// whole run aborts loudly rather than reporting bogus metrics.
async function generate(question) {
  const r = await answerQuestion(question);
  if (r.ok === false && r.meta && r.meta.error) throw new Error(r.meta.error);
  return r;
}

// --- Token-aware sliding-window rate limiter for the judge model ---
// Free tiers cap tokens-per-minute (Groq gpt-oss-120b = 8000 TPM), and a
// reasoning judge spends ~2.5k tokens/call, so we pace calls to stay under a
// safe budget in the trailing 60s rather than truncate context (which would
// bias the faithfulness check). JUDGE_TPM overrides the budget for other tiers.
const JUDGE_TPM_BUDGET = Number(process.env.JUDGE_TPM || 7200);
const judgeCalls = []; // { t, tokens }
function tokensUsedLast60s() {
  const cut = Date.now() - 60000;
  while (judgeCalls.length && judgeCalls[0].t < cut) judgeCalls.shift();
  return judgeCalls.reduce((s, c) => s + c.tokens, 0);
}
// Over-estimate a call's token cost from input length + reasoning/output headroom.
function estimateJudgeTokens(caseObj) {
  const chars = JUDGE_SYSTEM_PROMPT.length + formatJudgeInput(caseObj).length;
  return Math.ceil(chars / 4) + 1200;
}
async function reserveBudget(estimate) {
  for (;;) {
    const used = tokensUsedLast60s();
    if (used + estimate <= JUDGE_TPM_BUDGET || !judgeCalls.length) return;
    const wait = Math.max(500, judgeCalls[0].t + 60000 - Date.now() + 300);
    console.log(`    (throttle: ${used} judge tok/60s + ~${estimate} > ${JUDGE_TPM_BUDGET} — waiting ${Math.round(wait / 1000)}s)`);
    await sleep(Math.min(wait, 61000));
  }
}

// --- Same pacer, separate pool, for the generator model ---
// generate() (below) makes up to 3 calls (rewrite, gate, generation) against
// cfg.LLM_MODEL (gpt-oss-120b), which Groq rate-limits independently from the
// judge model (gpt-oss-20b) above — so it needs its own budget tracker, not a
// share of JUDGE_TPM_BUDGET. Without this, generate() only found out about a
// TPM cap reactively via withRetry's 429 catch (the same gap bench.js had
// before this pacer was added there — see scripts/bench.js).
const GEN_TPM_BUDGET = Number(process.env.GEN_TPM || 7200);
const genCalls = []; // { t, tokens }
function tokensUsedLast60sGen() {
  const cut = Date.now() - 60000;
  while (genCalls.length && genCalls[0].t < cut) genCalls.shift();
  return genCalls.reduce((s, c) => s + c.tokens, 0);
}
let lastGenEstimate = 2500; // conservative guess before we've seen a real call
async function reserveGenBudget() {
  for (;;) {
    const used = tokensUsedLast60sGen();
    if (used + lastGenEstimate <= GEN_TPM_BUDGET || !genCalls.length) return;
    const wait = Math.max(500, genCalls[0].t + 60000 - Date.now() + 300);
    console.log(`    (throttle: ${used} gen tok/60s + ~${lastGenEstimate} > ${GEN_TPM_BUDGET} — waiting ${Math.round(wait / 1000)}s)`);
    await sleep(Math.min(wait, 61000));
  }
}
function recordGenUsage(tokens) {
  if (!tokens) return;
  genCalls.push({ t: Date.now(), tokens });
  lastGenEstimate = tokens;
}

// Retry transient failures (429 rate-limit / 5xx) with backoff. For 429 the
// per-minute window needs real time to slide, so wait long, not milliseconds.
async function withRetry(fn, label, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e.message || String(e);
      const is429 = /429|rate.?limit/i.test(msg);
      // The small judge model intermittently returns empty or malformed output
      // under throttling (empty, non-JSON, missing/out-of-range fields). Any of
      // these is a per-call hiccup, so retry with backoff rather than aborting
      // the whole checkpointed, quota-scarce run on one flaky response.
      const judgeFlaky = /empty judge output|no JSON object|judge output missing|must be (?:0\|1|int)/i.test(msg);
      // Transient network faults from the hosted LLM (undici surfaces most as a
      // bare "fetch failed") should retry, not abort the whole checkpointed run.
      const network = /timeout|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|network|502|503|504/i.test(msg);
      const transient = is429 || judgeFlaky || network;
      if (attempt === retries || !transient) throw e;
      const wait = is429 ? 20000 : 2000 * attempt;
      console.log(`    (${label}: ${msg.slice(0, 70)} — retry ${attempt}/${retries} in ${Math.round(wait / 1000)}s)`);
      await sleep(wait);
    }
  }
}

const pct = (x) => `${(x * 100).toFixed(0)}%`;

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const gt = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "eval", "ground_truth.json"), "utf8"));
  const answerable = gt.filter((q) => q.answerable);
  const unanswerable = gt.filter((q) => !q.answerable);
  const settings = judgeSettings();

  console.log("Phase 4 — LLM-as-Judge evaluation");
  console.log(`  generator: ${cfg.LLM_PROVIDER} / ${cfg.LLM_MODEL}`);
  console.log(`  judge:     ${cfg.LLM_PROVIDER} / ${settings.model} @ temp ${settings.temperature}` +
    (settings.model !== cfg.LLM_MODEL ? "  (cross-judge)" : "  (self-judge)"));
  console.log("");

  const alreadyExhausted = quota.isExhausted();
  if (alreadyExhausted) {
    console.log(
      `Groq daily token cap (tokens per day) still recovering — tripped by ${alreadyExhausted.by} at ${alreadyExhausted.at}, ` +
      `won't clear until ~${alreadyExhausted.retryAt}. Skipping this run to avoid wasting retries; progress is checkpointed ` +
      `and will resume automatically once the cap clears.`
    );
    await close();
    process.exit(1);
  }

  const checkpoint = loadCheckpoint();
  const results = checkpoint.results.slice();
  const refusedAnswerable = checkpoint.refusedAnswerable.slice();
  const refusalRows = checkpoint.refusalRows.slice();
  let usageTotal = { ...checkpoint.usageTotal };
  const persist = () => saveCheckpoint({ results, refusedAnswerable, refusalRows, usageTotal, startedAt: checkpoint.startedAt });

  const doneAnswerableIds = new Set([...results.map((r) => r.id), ...refusedAnswerable.map((r) => r.id)]);
  const doneOutOfScopeIds = new Set(refusalRows.map((r) => r.id));
  if (doneAnswerableIds.size || doneOutOfScopeIds.size) {
    console.log(
      `Resuming from checkpoint: ${doneAnswerableIds.size}/${answerable.length} answerable graded, ` +
      `${doneOutOfScopeIds.size}/${unanswerable.length} out-of-scope checked.\n`
    );
  }

  // --- Answerable: judge faithfulness / correctness / semantic Hit@5 ---
  // If the pipeline REFUSES an answerable question (grounded=false — e.g. the
  // answerability gate declines a thin-coverage topic), there's no answer to
  // grade. Grading the refusal text against the retrieved chunks would wrongly
  // score it as a hallucination + correctness 0 — double-penalising a correct
  // "I don't know". So we record refusals separately as a COVERAGE figure and
  // do NOT feed them to the answer-quality judge.
  const remainingAnswerable = answerable.filter((q) => !doneAnswerableIds.has(q.id));
  for (const q of remainingAnswerable) {
    await reserveGenBudget();
    const res = await withRetry(() => generate(q.question), `answer:${q.id}`);
    recordGenUsage(res && res.meta && res.meta.tokens && res.meta.tokens.total);
    if (res.grounded === false) {
      refusedAnswerable.push({ id: q.id, question: q.question });
      console.log(`  REFUSED (coverage miss, not graded)  — ${q.question}`);
      persist();
      await sleep(300);
      continue;
    }
    const judgeInput = {
      question: q.question,
      groundTruth: q.ground_truth,
      contexts: res.contexts || [],
      systemAnswer: res.answer,
    };
    const estimate = estimateJudgeTokens(judgeInput);
    await reserveBudget(estimate);
    const verdict = await withRetry(() => judgeCase(judgeInput), `judge:${q.id}`);
    judgeCalls.push({ t: Date.now(), tokens: (verdict.usage && verdict.usage.total) || estimate });
    if (verdict.usage) {
      usageTotal.prompt += verdict.usage.prompt || 0;
      usageTotal.completion += verdict.usage.completion || 0;
      usageTotal.total += verdict.usage.total || 0;
    }
    const m = verdict.metrics;
    results.push({ id: q.id, question: q.question, grounded: res.grounded, metrics: m, reasoning: verdict.reasoning });
    console.log(
      `  ${m.hallucination_detected ? "HALLU" : "faith"} | correct ${m.answer_correctness_score}/5 | ` +
      `hit@5 ${m.hit5_retrieval_pass ? "PASS" : "FAIL"}  — ${q.question}`
    );
    persist();
    await sleep(500); // gentle pacing for the free tier
  }

  // --- Out-of-scope: deterministic refusal check ---
  console.log("");
  const remainingUnanswerable = unanswerable.filter((q) => !doneOutOfScopeIds.has(q.id));
  for (const q of remainingUnanswerable) {
    // Same token-aware pacing as the answerable loop: each generate() fires up
    // to 3 Groq calls against the generator model, so pace against GEN_TPM and
    // record real usage — otherwise this trailing burst can trip TPM even though
    // the answerable loop above was paced.
    await reserveGenBudget();
    const res = await withRetry(() => generate(q.question), `answer:${q.id}`);
    recordGenUsage(res && res.meta && res.meta.tokens && res.meta.tokens.total);
    const ok = res.grounded === false;
    refusalRows.push({ id: q.id, question: q.question, refused: ok });
    console.log(`  ${ok ? "REFUSED " : "ANSWERED"}  — ${q.question}`);
    persist();
    await sleep(500);
  }
  const refused = refusalRows.filter((r) => r.refused).length;

  // Both loops ran to completion (no throw) — the full cycle is covered, so
  // the checkpoint is no longer needed. A future run starts a fresh cycle.
  clearCheckpoint();

  // --- Aggregate (answer-quality metrics are over ANSWERED questions only;
  //     refused answerable questions are reported separately as coverage) ---
  const n = results.length; // answered
  const answeredRate = answerable.length ? n / answerable.length : 0;
  const halluRate = n ? results.reduce((s, r) => s + r.metrics.hallucination_detected, 0) / n : 0;
  const meanCorrect = n ? results.reduce((s, r) => s + r.metrics.answer_correctness_score, 0) / n : 0;
  const hit5Rate = n ? results.reduce((s, r) => s + r.metrics.hit5_retrieval_pass, 0) / n : 0;
  const refusalRate = unanswerable.length ? refused / unanswerable.length : null;

  const summary = {
    timestamp: new Date().toISOString(),
    generator: { provider: cfg.LLM_PROVIDER, model: cfg.LLM_MODEL },
    judge: { provider: cfg.LLM_PROVIDER, model: settings.model, temperature: settings.temperature, mode: settings.model !== cfg.LLM_MODEL ? "cross-judge" : "self-judge" },
    counts: { answerable: answerable.length, answered: n, refused_answerable: refusedAnswerable.length, out_of_scope: unanswerable.length },
    metrics: {
      hallucination_rate: Number(halluRate.toFixed(3)),
      faithfulness_rate: Number((1 - halluRate).toFixed(3)),
      mean_answer_correctness: Number(meanCorrect.toFixed(2)),
      semantic_hit5: Number(hit5Rate.toFixed(3)),
      answered_rate: Number(answeredRate.toFixed(3)),
      out_of_scope_refusal: refusalRate == null ? null : Number(refusalRate.toFixed(3)),
    },
    note: "faithfulness / correctness / Hit@5 are over ANSWERED questions; refused answerable questions are counted as coverage (answered_rate), not graded as hallucinations.",
    judge_tokens: usageTotal,
    cost_usd: 0,
    per_question: results,
    refused_answerable: refusedAnswerable,
    refusals: refusalRows,
  };

  const outPath = path.join(__dirname, "..", "eval", "judge-results.json");
  fs.writeFileSync(outPath, JSON.stringify(summary, null, 2));

  const goalMet = (ok) => (ok ? "✓ goal" : "· below goal");
  console.log("\n=== Results (answer-quality over answered questions; vs aspirational goals) ===");
  console.log(`Answered (of answerable):        ${n}/${answerable.length}` +
    (refusedAnswerable.length ? `   (${refusedAnswerable.length} refused as thin-coverage: ${refusedAnswerable.map((x) => x.id).join(", ")})` : ""));
  console.log(`Faithfulness (no hallucination): ${pct(1 - halluRate)}   (hallucination ${pct(halluRate)}, goal ≤ ${pct(GOAL_HALLUCINATION_MAX)})  ${goalMet(halluRate <= GOAL_HALLUCINATION_MAX)}`);
  console.log(`Mean answer correctness:         ${meanCorrect.toFixed(2)} / 5   (goal ≥ ${GOAL_CORRECTNESS_MIN})  ${goalMet(meanCorrect >= GOAL_CORRECTNESS_MIN)}`);
  console.log(`Semantic Hit@5:                  ${pct(hit5Rate)}   (${results.filter((r) => r.metrics.hit5_retrieval_pass).length}/${n}, goal ≥ ${pct(GOAL_HIT5_MIN)})  ${goalMet(hit5Rate >= GOAL_HIT5_MIN)}`);
  console.log(`Out-of-scope refusal:            ${refusalRate == null ? "n/a" : pct(refusalRate)}   (${refused}/${unanswerable.length}, goal = 100%)  ${goalMet(refusalRate == null || refusalRate >= GOAL_REFUSAL_MIN)}`);
  console.log(`Judge tokens: ${usageTotal.total} | cost: $0 (free tier) | results → eval/judge-results.json`);

  // Exit code gates on regression FLOORS (not the aspirational goals), so CI
  // stays green at current quality and only a real regression fails the build.
  const pass =
    halluRate <= FLOOR_HALLUCINATION_MAX &&
    meanCorrect >= FLOOR_CORRECTNESS_MIN &&
    hit5Rate >= FLOOR_HIT5_MIN &&
    (refusalRate == null || refusalRate >= FLOOR_REFUSAL_MIN);

  console.log(
    `\n${pass ? "PASS" : "FAIL"}  (CI regression floors: hallucination ≤ ${pct(FLOOR_HALLUCINATION_MAX)}, ` +
    `correctness ≥ ${FLOOR_CORRECTNESS_MIN}, Hit@5 ≥ ${pct(FLOOR_HIT5_MIN)}, refusal = 100%)`
  );
  await close();
  process.exit(pass ? 0 : 1);
})().catch(async (e) => {
  console.error("\neval:judge failed:", e.message);
  if (quota.isDailyCapError(e.message)) quota.markExhausted("eval:judge", e.message);
  try { await close(); } catch {}
  process.exit(1);
});
