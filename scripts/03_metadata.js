/**
 * STAGE 4: Metadata Enrichment
 * -----------------------------
 * Input:  data/chunks/all_chunks.json
 * Output: data/chunks/all_chunks.enriched.json
 *
 * Adds metadata that the retrieval layer can filter/boost on *before* or
 * *after* the vector similarity search — this is what makes a RAG system
 * feel like a domain expert rather than a generic text search:
 *
 *  - source_type   : "method-book" | "exercise-book"
 *  - content_type  : "exercise" | "technique" | "theory" | "practice-method"
 *                     | "narrative"  (heuristic keyword classification)
 *  - skill_level    : "beginner" | "intermediate" | "advanced" | "unspecified"
 *  - finger_numbers : which piano fingers (1-5) are explicitly referenced,
 *                     useful for Hanon content ("exercise for 3-4-5")
 *  - keywords       : lightweight keyword extraction for hybrid (BM25 + vector) search
 */

const fs = require("fs");
const path = require("path");

const CHUNKS_DIR = path.join(__dirname, "..", "data", "chunks");

const SOURCE_TYPE_BY_DOC = {
  "fundamentals-of-piano-practice": "method-book",
  "hanon-virtuoso-pianist-pt1": "exercise-book",
};

const CONTENT_TYPE_RULES = [
  { type: "exercise", pattern: /\b(exercise|Nº ?\d+|scale|arpeggio|trill|stretch)\b/i },
  { type: "technique", pattern: /\b(technique|finger(ing)?|wrist|relax|posture|hand position)\b/i },
  { type: "practice-method", pattern: /\b(practice|repetition|metronome|memoriz|sight[- ]?read)\b/i },
  { type: "theory", pattern: /\b(chord|scale degree|key signature|temperament|tuning|interval)\b/i },
];

const SKILL_LEVEL_RULES = [
  { level: "beginner", pattern: /\b(beginner|beginning student|first lesson|new student)\b/i },
  { level: "advanced", pattern: /\b(advanced|virtuoso|concert pianist|professional)\b/i },
];

const STOPWORDS = new Set(
  "the a an of to in and is are was were be been being for on with as by at from this that it its it's you your yourself we our practice piano".split(" ")
);

function classifyContentType(text) {
  for (const rule of CONTENT_TYPE_RULES) {
    if (rule.pattern.test(text)) return rule.type;
  }
  return "narrative";
}

function classifySkillLevel(text) {
  for (const rule of SKILL_LEVEL_RULES) {
    if (rule.pattern.test(text)) return rule.level;
  }
  return "unspecified";
}

function extractFingerNumbers(text) {
  // Hanon-style notation like "3-4-5" or "(3-4)" referencing piano fingers 1-5
  const matches = text.match(/\b[1-5](?:-[1-5]){1,4}\b/g) || [];
  return [...new Set(matches)];
}

function extractKeywords(text, n = 8) {
  const freq = {};
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));

  for (const w of words) freq[w] = (freq[w] || 0) + 1;

  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([w]) => w);
}

function enrich(chunk) {
  return {
    ...chunk,
    source_type: SOURCE_TYPE_BY_DOC[chunk.doc_id] || "unknown",
    content_type: classifyContentType(chunk.text),
    skill_level: classifySkillLevel(chunk.text),
    finger_numbers: extractFingerNumbers(chunk.text),
    keywords: extractKeywords(chunk.text),
  };
}

const all = JSON.parse(fs.readFileSync(path.join(CHUNKS_DIR, "all_chunks.json"), "utf-8"));
const enriched = all.map(enrich);

fs.writeFileSync(
  path.join(CHUNKS_DIR, "all_chunks.enriched.json"),
  JSON.stringify(enriched, null, 2)
);

// quick distribution report
const dist = {};
for (const c of enriched) dist[c.content_type] = (dist[c.content_type] || 0) + 1;
console.log(`Enriched ${enriched.length} chunks.`);
console.log("content_type distribution:", dist);
