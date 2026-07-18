/**
 * Meta / conversational intents.
 *
 * Questions about the assistant, and social pleasantries (greetings, thanks,
 * goodbyes), aren't in the piano knowledge base — so retrieval + the
 * answerability gate would (correctly) refuse them, which reads as broken. These
 * get a fixed, honest reply instead: no fabricated citations, no KB claim, no
 * refusal, no LLM call. Handled before the input-length guard so short greetings
 * ("hi") work too.
 *
 * Every pattern is anchored to the whole question so it stays high-precision —
 * "who are you?" and "hi" match, but real KB questions ("what can you do about a
 * weak 4th finger?") do not.
 */
const IDENTITY_ANSWER =
  "I'm a retrieval-augmented (RAG) assistant for a piano-learning knowledge base. " +
  "I answer questions about piano practice and technique from two sources — Chuan C. Chang's " +
  "*Fundamentals of Piano Practice* and Hanon's *The Virtuoso Pianist* — and I cite the exact " +
  "book and page for every claim, or tell you when the answer isn't in those books.\n\n" +
  "Try asking about finger independence, practicing a difficult passage, memorizing a piece, " +
  "playing faster while staying relaxed, or the Hanon exercises.";

const GREETING_ANSWER =
  "Hi! I'm a piano-practice assistant grounded in Chang's *Fundamentals of Piano Practice* and " +
  "Hanon's *The Virtuoso Pianist*. Ask me anything about piano technique or practice — for " +
  "example, how to build finger independence, practice a difficult passage, or play faster " +
  "while staying relaxed.";

const THANKS_ANSWER =
  "You're welcome! Ask me anything else about piano practice or technique — every answer cites " +
  "the book and page it came from.";

const FAREWELL_ANSWER =
  "Happy practicing! 🎹 Come back anytime with a question about piano technique, " +
  "practice methods, or the Hanon exercises.";

// Ordered: first matching intent wins.
const INTENTS = [
  {
    kind: "identity",
    answer: IDENTITY_ANSWER,
    patterns: [
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
    ],
  },
  {
    kind: "greeting",
    answer: GREETING_ANSWER,
    patterns: [
      /^(hi|hey|hello|hiya|howdy|yo|sup|hi\s+there|hey\s+there|hello\s+there|greetings)[\s,!.]*$/i,
      /^good\s+(morning|afternoon|evening|day)[\s,!.]*$/i,
      /^how\s+are\s+(you|u|ya)([\s\w]{0,12})?[?!.]*$/i,
      /^how('?s| is)\s+it\s+going[\s?!.]*$/i,
    ],
  },
  {
    kind: "thanks",
    answer: THANKS_ANSWER,
    patterns: [
      /^(thanks|thank\s+(you|u)|thankyou|thx|tysm|ty|cheers|much\s+appreciated|appreciate\s+it)(\s+(a\s+lot|so\s+much|very\s+much|loads|heaps|again))?[\s!.,]*$/i,
    ],
  },
  {
    kind: "farewell",
    answer: FAREWELL_ANSWER,
    patterns: [
      /^(bye|byebye|goodbye|good\s+bye|see\s+(you|ya)(\s+(later|soon))?|later|cya|good\s*night|gtg|take\s+care)[\s!.]*$/i,
    ],
  },
];

// Returns { kind, answer } for a recognized conversational intent, else null.
function matchMeta(question) {
  const q = (question || "").trim();
  if (!q) return null;
  for (const intent of INTENTS) {
    if (intent.patterns.some((re) => re.test(q))) return { kind: intent.kind, answer: intent.answer };
  }
  return null;
}

module.exports = { matchMeta, INTENTS, IDENTITY_ANSWER, GREETING_ANSWER, THANKS_ANSWER, FAREWELL_ANSWER };
