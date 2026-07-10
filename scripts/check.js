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
const pass = (name) => console.log("[PASS] " + name);

// 1. every module imports cleanly (catches syntax / bad require paths)
const mods = ["config", "db", "embed", "retrieve", "rerank", "prompt", "llm", "rewrite", "guardrails", "pipeline"];
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

console.log("\nAll wiring + logic checks passed.");
