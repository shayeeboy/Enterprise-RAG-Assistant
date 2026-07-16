/**
 * Offline wiring + logic check — no DB, no LLM, no network, no model downloads.
 * Runs in CI on every push to catch broken imports and regressions in the
 * pure-logic pieces (guardrails, rank fusion, prompt assembly).
 *
 * For the full DB + model + LLM check, see scripts/smoke.js (`npm run smoke`).
 *
 * Usage:  npm run check      (exit 0 on success, 1 on failure)
 */
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const pass = (name) => console.log("[PASS] " + name);

// 1. every module imports cleanly (catches syntax / bad require paths)
const mods = ["config", "db", "embed", "retrieve", "rerank", "prompt", "llm", "rewrite", "guardrails", "pipeline", "trace", "logstore", "judge"];
mods.forEach((m) => require("../src/rag/" + m));
pass(`all modules import (${mods.length})`);

// 2. input guardrails
const { validateInput, extractCitations, groundingGuard } = require("../src/rag/guardrails");
assert.strictEqual(validateInput("  ").ok, false, "empty input must be rejected");
assert.strictEqual(validateInput("how to practice scales").ok, true, "valid input must pass");
pass("input validation");

// 3. citation extraction + grounding
const chunks = [
  { title: "A", author: "x", page_start: 1, page_end: 2, content_type: "technique", text: "practice slowly" },
  { title: "B", author: "y", page_start: 5, page_end: 5, content_type: "exercise", text: "hands separately" },
];
assert.strictEqual(extractCitations("see [1] and [2] and [9]", chunks).length, 2, "invalid citation [9] must be dropped");
assert.strictEqual(groundingGuard("no citations here", chunks).grounded, false, "answer with no citations is ungrounded");
assert.strictEqual(groundingGuard("grounded [1]", chunks).grounded, true, "answer citing a real source is grounded");
pass("citation extraction + grounding");

// 4. reciprocal rank fusion — a doc appearing in both lists should win
const { reciprocalRankFusion } = require("../src/rag/retrieve");
const fused = reciprocalRankFusion(
  [{ chunk_id: "a", vscore: 0.9 }, { chunk_id: "b", vscore: 0.5 }],
  [{ chunk_id: "b", kscore: 0.3 }, { chunk_id: "c", kscore: 0.1 }],
  60
);
assert.strictEqual(fused[0].chunk_id, "b", "doc present in both result sets must rank first");
pass("reciprocal rank fusion");

// 5. prompt augmentation — numbered, citable context
const { buildMessages } = require("../src/rag/prompt");
const msgs = buildMessages("q?", chunks);
assert.strictEqual(msgs.length, 2, "expected system + user messages");
assert.ok(msgs[1].content.includes("[1]") && msgs[1].content.includes("[2]"), "context blocks must be numbered");
pass("prompt augmentation");

// 6. LLM-Judge (Phase 4) — pure input formatting, output parsing, schema validation
const { formatJudgeInput, parseJudgeOutput, validateJudge } = require("../src/rag/judge");
const jxml = formatJudgeInput({
  question: "how do I build finger independence?",
  groundTruth: "keep other fingers down; use parallel sets",
  contexts: [{ title: "Fundamentals", page_start: 103, text: "play each finger three to five times" }],
  systemAnswer: "Keep the other fingers depressed [1].",
});
assert.ok(
  /<user_query>/.test(jxml) && /<ground_truth>/.test(jxml) && /<retrieved_context_top_5>/.test(jxml) && /<system_answer>/.test(jxml),
  "judge input must contain all four XML sections"
);
assert.ok(jxml.includes("play each finger three to five times"), "retrieved context text must be embedded");
// clean JSON parses
const jgood = parseJudgeOutput('{"reasoning":{},"metrics":{"hallucination_detected":0,"answer_correctness_score":5,"hit5_retrieval_pass":1}}');
assert.strictEqual(jgood.metrics.answer_correctness_score, 5, "correctness parsed");
// tolerates code fences + surrounding prose (rubric forbids them, but be defensive)
const jfenced = parseJudgeOutput('```json\n{"metrics":{"hallucination_detected":1,"answer_correctness_score":2,"hit5_retrieval_pass":0}}\n```');
assert.strictEqual(jfenced.metrics.hallucination_detected, 1, "fenced JSON still parses");
// out-of-range / wrong-type metrics are rejected
assert.throws(() => validateJudge({ metrics: { hallucination_detected: 2, answer_correctness_score: 5, hit5_retrieval_pass: 1 } }), /hallucination_detected/);
assert.throws(() => validateJudge({ metrics: { hallucination_detected: 0, answer_correctness_score: 7, hit5_retrieval_pass: 1 } }), /correctness/);
assert.throws(() => parseJudgeOutput("not json at all"), /JSON/);
pass("LLM-judge: xml formatting + json parsing + schema validation");

// 7. ground-truth dataset integrity
const gt = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "eval", "ground_truth.json"), "utf8"));
assert.ok(Array.isArray(gt) && gt.length >= 12, "ground-truth set should have >= 12 cases");
const answerable = gt.filter((q) => q.answerable);
assert.ok(answerable.length >= 10, "expected >= 10 answerable cases");
assert.ok(answerable.every((q) => typeof q.ground_truth === "string" && q.ground_truth.length > 40), "every answerable case needs a substantive golden answer");
assert.ok(gt.some((q) => !q.answerable), "must include out-of-scope cases");
assert.ok(new Set(gt.map((q) => q.id)).size === gt.length, "case ids must be unique");
pass(`ground-truth dataset integrity (${answerable.length} answerable + ${gt.length - answerable.length} out-of-scope)`);

console.log("\nAll wiring + logic checks passed.");
