/**
 * Meta / identity intents.
 *
 * Questions about the assistant itself ("who are you?", "what can you do?",
 * "help") aren't in the piano knowledge base, so retrieval + the answerability
 * gate would (correctly) refuse them — but a flat "I couldn't find that in the
 * knowledge base" to an identity question reads as broken. Answer these with a
 * fixed, honest description instead: no fabricated citations, no KB claim, no
 * refusal. Handled before retrieval so it's instant and free.
 *
 * Patterns are anchored to the whole question so they stay high-precision — e.g.
 * "who are you?" matches, but "what can you do about a weak 4th finger?" does not.
 */
const META_PATTERNS = [
  /^who\s+(are|r)\s+(you|u)[?!.]*$/i,
  /^what\s+(are|r)\s+(you|u)[?!.]*$/i,
  /^what('?s| is)\s+this(\s+(bot|app|tool|assistant|site|thing))?[?!.]*$/i,
  /^what\s+(can|do)\s+(you|u)\s+do[?!.]*$/i,
  /^what\s+can\s+(you|u)\s+help\s+(me\s+)?with[?!.]*$/i,
  /^what\s+do\s+(you|u)\s+know([\s\w]{0,15})?[?!.]*$/i,
  /^what('?s| is)\s+your\s+(purpose|name)[?!.]*$/i,
  /^are\s+you\s+(an?\s+)?(ai|a\s+bot|a\s+robot|human|real)[?!.]*$/i,
  /^how\s+(do|does)\s+(you|this|it)\s+work[?!.]*$/i,
  /^help[?!.]*$/i,
];

const META_ANSWER =
  "I'm a retrieval-augmented (RAG) assistant for a piano-learning knowledge base. " +
  "I answer questions about piano practice and technique from two sources — Chuan C. Chang's " +
  "*Fundamentals of Piano Practice* and Hanon's *The Virtuoso Pianist* — and I cite the exact " +
  "book and page for every claim, or tell you when the answer isn't in those books.\n\n" +
  "Try asking about finger independence, practicing a difficult passage, memorizing a piece, " +
  "playing faster while staying relaxed, or the Hanon exercises.";

// Returns the fixed meta answer for an identity/capability question, else null.
function matchMeta(question) {
  const q = (question || "").trim();
  if (!q) return null;
  return META_PATTERNS.some((re) => re.test(q)) ? META_ANSWER : null;
}

module.exports = { matchMeta, META_ANSWER, META_PATTERNS };
