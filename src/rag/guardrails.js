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

module.exports = { REFUSAL, validateInput, extractCitations, groundingGuard };
