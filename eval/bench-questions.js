/**
 * Benchmark question bank for observability load.
 *
 * A deterministic set of realistic piano-practice questions covering the corpus,
 * generated from topic phrases × phrasings. scripts/bench.js drives these through
 * the real pipeline to produce automated test traffic, so the system-health
 * metrics (latency, grounded rate, cost) become statistically meaningful.
 *
 * These are TEST queries, tagged `source='benchmark'` in query_logs and reported
 * separately from organic `live` traffic — never presented as real usage.
 */
const TOPICS = [
  "build finger independence",
  "strengthen a weak 4th finger",
  "strengthen a weak 5th finger",
  "practice a difficult passage",
  "memorize a piece of music",
  "practice scales effectively",
  "practice arpeggios",
  "play faster without tensing up",
  "stay relaxed while playing",
  "avoid fatigue and injury at the piano",
  "start practicing as a complete beginner",
  "use parallel sets",
  "practice hands separately",
  "move from hands-separate to hands-together practice",
  "use a metronome while practicing",
  "count rhythm accurately",
  "use mental play",
  "improve my memorization",
  "get past a speed wall",
  "use slow practice without wasting time",
  "warm up before playing",
  "deal with cold, stiff fingers",
  "get real value from Hanon exercises",
  "improve my thumb technique",
  "use forearm rotation",
  "practice trills",
  "play octaves comfortably",
  "prepare for a performance",
  "manage nerves before performing",
  "practice efficiently when short on time",
  "break a hard piece into short segments",
  "learn a new piece quickly",
  "choose between a grand and an upright piano",
  "improve my tone quality",
  "control dynamics while playing",
  "reduce stress in my hands and arms",
  "keep my hands quiet and efficient",
  "practice musically rather than mechanically",
  "develop real playing speed",
  "cycle a passage to build technique",
];

const TEMPLATES = [
  (t) => `How do I ${t}?`,
  (t) => `What's the best way to ${t}?`,
  (t) => `I'm struggling to ${t} — any advice?`,
];

// Deterministic, deduped bank.
function buildBank() {
  const out = [];
  for (const t of TOPICS) for (const tpl of TEMPLATES) out.push(tpl(t));
  return [...new Set(out)];
}

module.exports = { buildBank, TOPICS, TEMPLATES };
