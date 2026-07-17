/**
 * Answerability gate (Phase 4 roadmap — near-miss refusal).
 *
 * The rerank relevance floor refuses questions where nothing piano-related is
 * retrieved. It cannot refuse "near-miss" questions — piano/music-adjacent but
 * uncovered topics (piano history, self-tuning, jazz improvisation) — because
 * their retrieved chunks are topically piano-related and score HIGH on the
 * reranker (0.97–1.0), as high as valid questions. The only reliable signal is
 * whether the chunks actually ANSWER the specific question, so this is a small,
 * focused LLM call that returns a strict YES/NO — deliberately separate from the
 * generation step, which is biased toward producing a helpful answer.
 *
 * Fail-open: on any error or unparseable reply it returns answerable=true, so
 * the gate only ever adds refusals, never breaks a working answer path.
 */
const cfg = require("./config");
const { chat } = require("./llm");

const GATE_SYSTEM =
  "You are a strict retrieval gatekeeper for a piano-practice knowledge base. " +
  "Decide whether the sources actually ANSWER the user's question — not merely " +
  "mention its topic. Reply with exactly one word: YES or NO.\n" +
  "- Answer YES if the sources address the question's subject and contain relevant, " +
  "usable information that helps answer it, even if the coverage is partial.\n" +
  "- Answer NO if the sources are about a genuinely different subject (for example " +
  "piano history, tuning or repair, jazz or improvisation, reading sheet-music " +
  "notation, or another instrument), OR if they only mention the question's topic " +
  "in passing without explaining how to do or understand what is asked — even if " +
  "they mention the piano.\n" +
  "Do not explain.";

function buildGateMessages(question, chunks) {
  const src = chunks
    .map((c, i) => `[${i + 1}] ${c.title} — ${(c.text || "").replace(/\s+/g, " ").trim().slice(0, 400)}`)
    .join("\n");
  return [
    { role: "system", content: GATE_SYSTEM },
    {
      role: "user",
      content: `SOURCES:\n${src}\n\nQUESTION: ${question}\n\nDo the SOURCES contain information that directly answers the QUESTION? Answer YES or NO.`,
    },
  ];
}

function gateSettings() {
  return { model: cfg.GATE_MODEL || cfg.LLM_MODEL, temperature: 0 };
}

// Parse the model's reply into a boolean. Exported for offline testing.
function parseGate(reply) {
  const t = (reply || "").trim().toUpperCase();
  if (/\bNO\b/.test(t) && !/\bYES\b/.test(t)) return false;
  return true; // YES, ambiguous, or empty → fail-open (answerable)
}

// True if the chunks plausibly answer the question. Fail-open on error.
async function isAnswerable(question, chunks) {
  if (!chunks || !chunks.length) return false;
  try {
    const res = await chat(buildGateMessages(question, chunks), gateSettings());
    return parseGate(res.content);
  } catch {
    return true;
  }
}

module.exports = { isAnswerable, parseGate, buildGateMessages, gateSettings, GATE_SYSTEM };
