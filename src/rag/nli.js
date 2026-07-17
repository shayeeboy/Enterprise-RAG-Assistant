/**
 * NLI faithfulness filter (Phase 4 roadmap).
 * A local cross-encoder scores whether the retrieved context ENTAILS each answer
 * sentence, and drops sentences it doesn't. This catches claims that carry a
 * citation but whose source doesn't actually support them — the one thing the
 * citation trim (guardrails.enforceCitations) can't see. Local via
 * Transformers.js, no API key. Opt-in via ENFORCE_ENTAILMENT.
 *
 * The pure pieces (sentence splitting + score-based trimming) are separated from
 * the model call so they can be unit-tested offline in scripts/check.js without
 * downloading a model. Each answer sentence is scored against every retrieved
 * chunk separately (each pair fits the model's 512-token window) and kept if ANY
 * chunk entails it — "grounded if some source supports it".
 */
const cfg = require("./config");

const DEFAULTS = { threshold: cfg.ENTAILMENT_THRESHOLD, minClaimLen: 45 };

// --- pure helpers (unit-tested) -------------------------------------------

// A sentence is a "claim" worth checking if it's substantive (long enough) and
// not a list intro ending in a colon. Short lead-ins/labels are never checked.
function isClaim(sentence, minClaimLen = DEFAULTS.minClaimLen) {
  const t = sentence.trim();
  if (!t) return false;
  const bare = t.replace(/^[-*•\d.\)\s]+/, "");
  if (bare.length < minClaimLen) return false;
  if (/[:：]$/.test(t)) return false;
  return true;
}

// Split preserving line structure; returns the raw split sentences per line.
function splitSentences(answer) {
  return answer.split(/\n/).map((line) => (line.trim() ? line.split(/(?<=[.!?])\s+/) : [line]));
}

// Collect the claim sentences (raw strings) that should be scored.
function claimSentences(answer, minClaimLen = DEFAULTS.minClaimLen) {
  const out = [];
  for (const line of splitSentences(answer)) {
    for (const s of line) if (isClaim(s, minClaimLen)) out.push(s);
  }
  return out;
}

/**
 * Rebuild the answer, dropping claim sentences whose score is below threshold.
 * `scoreOf(sentence)` returns a number or null/undefined (unscored → kept).
 * Pure. Never guts the answer: if trimming removes almost everything, the
 * original is returned unchanged.
 */
function trimByScore(answer, scoreOf, { threshold = DEFAULTS.threshold, minClaimLen = DEFAULTS.minClaimLen } = {}) {
  if (!answer) return { text: answer, dropped: 0 };
  let dropped = 0;
  const outLines = splitSentences(answer).map((line) => {
    if (line.length === 1 && !line[0].trim()) return line[0]; // preserve blank line
    const kept = line.filter((s) => {
      if (!s.trim()) return false;
      if (!isClaim(s, minClaimLen)) return true; // lead-in / label / short — keep
      const score = scoreOf(s);
      if (score == null) return true; // unscored — keep (safe default)
      if (score >= threshold) return true; // entailed — keep
      dropped++;
      return false; // not entailed — drop
    });
    return kept.join(" ");
  });
  const text = outLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  if (!text || text.length < Math.min(40, answer.trim().length * 0.4)) {
    return { text: answer, dropped: 0 };
  }
  return { text, dropped };
}

// --- model-backed scoring --------------------------------------------------

let _tok = null;
let _model = null;
let _entailIdx = null;
async function getModel() {
  if (_model) return { tok: _tok, model: _model, entailIdx: _entailIdx };
  const { AutoTokenizer, AutoModelForSequenceClassification } = await import("@xenova/transformers");
  _tok = await AutoTokenizer.from_pretrained(cfg.NLI_MODEL);
  _model = await AutoModelForSequenceClassification.from_pretrained(cfg.NLI_MODEL, { quantized: true });
  // Resolve the "entailment" logit index from the model's own label map so we
  // don't hard-code an order that varies between NLI checkpoints.
  const id2label = (_model.config && _model.config.id2label) || {};
  const key = Object.keys(id2label).find((k) => /entail/i.test(String(id2label[k])));
  _entailIdx = key != null ? Number(key) : 1;
  return { tok: _tok, model: _model, entailIdx: _entailIdx };
}

function softmaxRow(row) {
  const m = Math.max(...row);
  const ex = row.map((x) => Math.exp(x - m));
  const s = ex.reduce((a, b) => a + b, 0);
  return ex.map((e) => e / s);
}

// P(entailment) for each aligned (premise[i], hypothesis[i]) pair, batched.
async function entailmentBatch(premises, hypotheses, batchSize = 12) {
  const { tok, model, entailIdx } = await getModel();
  const out = [];
  for (let i = 0; i < premises.length; i += batchSize) {
    const p = premises.slice(i, i + batchSize);
    const h = hypotheses.slice(i, i + batchSize);
    const inputs = await tok(p, { text_pair: h, padding: true, truncation: true });
    const { logits } = await model(inputs);
    for (const row of logits.tolist()) out.push(softmaxRow(row)[entailIdx]);
  }
  return out;
}

/**
 * Drop answer sentences the retrieved chunks don't entail. `chunks` is the list
 * the answer was generated from (each with `.text`). Returns { text, dropped,
 * scores }. Async (loads the NLI model on first use).
 */
async function enforceEntailment(answer, chunks, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  if (!answer || !chunks || !chunks.length) return { text: answer, dropped: 0, scores: [] };
  const claims = claimSentences(answer, o.minClaimLen);
  if (!claims.length) return { text: answer, dropped: 0, scores: [] };

  // Score every (chunk, claim) pair; a claim is kept if ANY chunk entails it.
  // Strip citation markers ("[1]") from the hypothesis — they're noise to the
  // NLI model and shouldn't affect the entailment judgement.
  const clean = (s) => s.trim().replace(/\[\d+\]/g, "").replace(/\s{2,}/g, " ").trim();
  const premises = [];
  const hypotheses = [];
  for (const claim of claims) {
    for (const c of chunks) {
      premises.push(c.text || "");
      hypotheses.push(clean(claim));
    }
  }
  const flat = await entailmentBatch(premises, hypotheses);
  const maxByClaim = new Map();
  claims.forEach((claim, ci) => {
    let best = 0;
    for (let j = 0; j < chunks.length; j++) best = Math.max(best, flat[ci * chunks.length + j]);
    maxByClaim.set(claim, best);
  });

  const { text, dropped } = trimByScore(answer, (s) => (maxByClaim.has(s) ? maxByClaim.get(s) : null), o);
  return { text, dropped, scores: [...maxByClaim.values()] };
}

module.exports = { isClaim, splitSentences, claimSentences, trimByScore, entailmentBatch, enforceEntailment, getModel };
