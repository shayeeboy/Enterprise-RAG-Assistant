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
const mods = ["config", "db", "embed", "retrieve", "rerank", "prompt", "llm", "rewrite", "guardrails", "pipeline", "trace", "logstore", "judge", "nli", "gate", "meta"];
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
// citation deep-links to source_url#page=N (clickable PDF citations)
const citedUrl = extractCitations("see [1]", [{ title: "A", page_start: 42, page_end: 42, source_url: "https://host/doc.pdf" }]);
assert.strictEqual(citedUrl[0].url, "https://host/doc.pdf#page=42", "citation deep-links to source_url#page=N");
const citedNoUrl = extractCitations("see [1]", [{ title: "A", page_start: 42, page_end: 42 }]);
assert.strictEqual(citedNoUrl[0].url, null, "citation url is null when the document has no source_url");
pass("citation extraction + grounding + PDF deep-link");

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
assert.ok(Array.isArray(gt) && gt.length >= 20, "ground-truth set should have >= 20 cases");
const answerable = gt.filter((q) => q.answerable);
assert.ok(answerable.length >= 15, "expected >= 15 answerable cases");
assert.ok(gt.filter((q) => !q.answerable).length >= 4, "expected >= 4 out-of-scope cases");
assert.ok(answerable.every((q) => typeof q.ground_truth === "string" && q.ground_truth.length > 40), "every answerable case needs a substantive golden answer");
assert.ok(gt.some((q) => !q.answerable), "must include out-of-scope cases");
assert.ok(new Set(gt.map((q) => q.id)).size === gt.length, "case ids must be unique");
pass(`ground-truth dataset integrity (${answerable.length} answerable + ${gt.length - answerable.length} out-of-scope)`);

// 8. Faithfulness trim (enforceCitations) — drop uncited claims, keep the rest
const { enforceCitations } = require("../src/rag/guardrails");
const fchunks = [{ title: "A", page_start: 1, text: "x" }, { title: "B", page_start: 2, text: "y" }];
const r1 = enforceCitations(
  "Practice hands separately to build speed and control over time [1]. This other sentence makes a substantive claim with no citation whatsoever.",
  fchunks
);
assert.ok(r1.text.includes("[1]"), "cited sentence is kept");
assert.ok(!/other sentence/.test(r1.text), "uncited substantive claim is dropped");
assert.strictEqual(r1.dropped, 1, "exactly one sentence dropped");
const r2 = enforceCitations("Do this:\n- Keep the fingers close to the keys [1].", fchunks);
assert.ok(/Do this:/.test(r2.text) && /\[1\]/.test(r2.text), "colon lead-in and cited list item kept");
const refusalish = "I could not find an answer to that in the piano knowledge base, sorry.";
assert.strictEqual(enforceCitations(refusalish, fchunks).text, refusalish, "all-uncited answer preserved (never gutted)");
pass("faithfulness trim: enforceCitations");

// 9. NLI faithfulness filter — pure logic (isClaim + trimByScore, no model)
const { isClaim, trimByScore } = require("../src/rag/nli");
assert.ok(isClaim("This is a substantive claim about piano technique and finger independence."), "long sentence is a claim");
assert.ok(!isClaim("Do this:"), "colon lead-in is not a claim");
assert.ok(!isClaim("- Keep going"), "short list item is not a claim");
const nliAns = "Practice hands separately to build speed and control over the whole passage [1]. Some entirely unsupported claim that the context never states at all.";
const nliScores = new Map([
  ["Practice hands separately to build speed and control over the whole passage [1].", 0.9],
  ["Some entirely unsupported claim that the context never states at all.", 0.05],
]);
const nliTrim = trimByScore(nliAns, (s) => (nliScores.has(s) ? nliScores.get(s) : null), { threshold: 0.4 });
assert.ok(nliTrim.text.includes("[1]"), "entailed claim kept");
assert.ok(!/unsupported claim/.test(nliTrim.text), "un-entailed claim dropped");
assert.strictEqual(nliTrim.dropped, 1, "one un-entailed sentence dropped");
assert.strictEqual(trimByScore(nliAns, () => null, { threshold: 0.4 }).dropped, 0, "unscored sentences are kept (safe default)");
pass("NLI faithfulness filter: isClaim + trimByScore");

// 10. Answerability gate — reply parsing (fail-open)
const { parseGate } = require("../src/rag/gate");
assert.strictEqual(parseGate("NO"), false, "NO → not answerable");
assert.strictEqual(parseGate("no."), false, "lowercase no → not answerable");
assert.strictEqual(parseGate("NO — different topic"), false, "NO with reason → not answerable");
assert.strictEqual(parseGate("YES"), true, "YES → answerable");
assert.strictEqual(parseGate("Yes, the sources cover this"), true, "YES with text → answerable");
assert.strictEqual(parseGate(""), true, "empty reply → fail-open (answerable)");
pass("answerability gate: parseGate (fail-open)");

// 11. Observability benchmark question bank
const { buildBank } = require("../eval/bench-questions");
const bank = buildBank();
assert.ok(Array.isArray(bank) && bank.length >= 100, "benchmark bank should have >= 100 questions");
assert.strictEqual(new Set(bank).size, bank.length, "benchmark questions must be unique");
assert.ok(bank.every((q) => typeof q === "string" && q.trim().endsWith("?")), "every benchmark item is a question");
pass(`observability benchmark bank (${bank.length} questions)`);

// 12. Meta / identity intent — answers "who are you?" instead of refusing,
// without catching real KB questions.
const { matchMeta } = require("../src/rag/meta");
assert.ok(matchMeta("who are you?"), "identity question → meta answer");
assert.ok(matchMeta("What can you do?"), "capability question → meta answer");
assert.ok(matchMeta("help"), "help → meta answer");
assert.strictEqual(matchMeta("How do I practice scales?"), null, "real KB question → not meta");
assert.strictEqual(matchMeta("What can you do about a weak 4th finger?"), null, "KB question containing 'you' → not meta");
pass("meta / identity intent handler");

console.log("\nAll wiring + logic checks passed.");
