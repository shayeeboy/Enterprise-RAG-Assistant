/**
 * Guardrails (workflow steps: Guardrails around input and output).
 * - Input:   reject empty / oversized / non-question input before spending compute.
 * - Retrieval: if nothing clears the relevance threshold, refuse instead of
 *              letting the LLM hallucinate (handled in pipeline via REFUSAL).
 * - Output:  keep only citations that point to real sources, and flag answers
 *            that cite nothing (possible ungrounded generation).
 */
const REFUSAL =
  "I couldn't find an answer to that in the piano-learning knowledge base " +
  "(Fundamentals of Piano Practice; The Virtuoso Pianist, Part I). " +
  "Try rephrasing, or ask about piano technique, practice methods, or the Hanon exercises.";

function validateInput(q) {
  if (typeof q !== "string") return { ok: false, message: "Question must be text." };
  const t = q.trim();
  if (t.length < 3) return { ok: false, message: "Please ask a fuller question (at least a few words)." };
  if (t.length > 2000) return { ok: false, message: "Question is too long (max 2000 characters)." };
  return { ok: true, value: t };
}

// Pull [n] markers out of the answer, dropping any that don't map to a real chunk.
function extractCitations(answer, chunks) {
  const nums = new Set();
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(answer))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= chunks.length) nums.add(n);
  }
  return [...nums]
    .sort((a, b) => a - b)
    .map((n) => {
      const c = chunks[n - 1];
      return {
        n,
        title: c.title,
        author: c.author,
        page_start: c.page_start,
        page_end: c.page_end,
        content_type: c.content_type,
      };
    });
}

function groundingGuard(answer, chunks) {
  const citations = extractCitations(answer, chunks);
  return { grounded: citations.length > 0, citations };
}

// Does this text contain at least one citation that maps to a real chunk?
function hasValidCitation(text, chunks) {
  const re = /\[(\d+)\]/g;
  let m;
  while ((m = re.exec(text))) {
    const n = Number(m[1]);
    if (n >= 1 && n <= chunks.length) return true;
  }
  return false;
}

/**
 * Faithfulness trim (Phase 4 roadmap): drop substantive answer sentences that
 * carry no valid citation — a claim with no source is exactly what the judge
 * flags as a hallucination. Conservative on purpose:
 *   - keeps short lead-ins / labels and lines ending in a colon (list intros),
 *   - keeps blank lines so list/paragraph structure survives,
 *   - never trims an answer down to (near) nothing — a refusal or an all-uncited
 *     answer is returned unchanged, and the grounding guard handles it downstream.
 * Pure function; unit-tested offline in scripts/check.js.
 */
function enforceCitations(answer, chunks, { minClaimLen = 45 } = {}) {
  if (!answer || !chunks || !chunks.length) return { text: answer, dropped: 0 };
  let dropped = 0;
  const outLines = answer.split(/\n/).map((line) => {
    if (!line.trim()) return line; // preserve blank lines (structure)
    const sentences = line.split(/(?<=[.!?])\s+/);
    const kept = sentences.filter((s) => {
      const t = s.trim();
      if (!t) return false;
      if (hasValidCitation(s, chunks)) return true; // cited claim — keep
      const bare = t.replace(/^[-*•\d.\)\s]+/, ""); // strip list markers
      if (bare.length < minClaimLen) return true; // short lead-in / label
      if (/[:：]$/.test(t)) return true; // list intro ("Rules:", "Do this:")
      dropped++;
      return false; // substantive claim with no source — drop
    });
    return kept.join(" ");
  });
  const text = outLines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  // Safety net: don't gut the answer. If trimming removed almost everything,
  // return the original (e.g. a refusal, or a wholly uncited answer).
  if (!text || text.length < Math.min(40, answer.trim().length * 0.4)) {
    return { text: answer, dropped: 0 };
  }
  return { text, dropped };
}

module.exports = { REFUSAL, validateInput, extractCitations, groundingGuard, enforceCitations };
