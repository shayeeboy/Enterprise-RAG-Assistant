/**
 * STAGE 2 + 3: Chunking + Chunk Overlap
 * --------------------------------------
 * Input:  data/parsed/<doc>.json
 * Output: data/chunks/<doc>.chunks.json
 *
 * Strategy: recursive/sentence-aware chunking.
 *  - Target chunk size: ~350 tokens (~1400 chars) — small enough for precise
 *    retrieval, large enough to keep a Hanon exercise's instructions or a
 *    FPP technique explanation intact.
 *  - Overlap: ~15% of chunk size (~50 tokens / ~200 chars), taken from the
 *    END of the previous chunk and prepended to the next one. This prevents
 *    a technique explanation that straddles a chunk boundary from losing
 *    context (e.g. "the thumb should..." cut off right before the key
 *    instruction on the next page).
 *  - We split on sentence boundaries first, then greedily pack sentences
 *    into a chunk until the size budget is hit — never split mid-sentence.
 *  - Page number is preserved per chunk (majority page if a chunk spans two
 *    pages) for citation metadata downstream.
 */

const fs = require("fs");
const path = require("path");

const PARSED_DIR = path.join(__dirname, "..", "data", "parsed");
const OUT_DIR = path.join(__dirname, "..", "data", "chunks");

const CHUNK_SIZE_CHARS = 1400; // ~350 tokens at ~4 chars/token
const OVERLAP_CHARS = 200; // ~50 tokens

// crude sentence splitter tuned for prose (keeps abbreviations like "e.g." intact often enough for this use case)
function splitSentences(text) {
  return text
    .replace(/([.?!])\s+(?=[A-Z0-9])/g, "$1|SPLIT|")
    .split("|SPLIT|")
    .map((s) => s.trim())
    .filter(Boolean);
}

function chunkPages(pages) {
  // Flatten to a stream of {sentence, page} so chunks can span page boundaries
  const stream = [];
  for (const p of pages) {
    for (const sentence of splitSentences(p.text)) {
      stream.push({ sentence, page: p.page });
    }
  }

  const chunks = [];
  let current = [];
  let currentLen = 0;

  function flush() {
    if (current.length === 0) return;
    const text = current.map((s) => s.sentence).join(" ");
    const pages = [...new Set(current.map((s) => s.page))];
    chunks.push({ text, pages });

    // build overlap tail for the next chunk: walk backwards from the end
    // of `current` until we've collected ~OVERLAP_CHARS
    let tail = [];
    let tailLen = 0;
    for (let i = current.length - 1; i >= 0; i--) {
      tail.unshift(current[i]);
      tailLen += current[i].sentence.length + 1;
      if (tailLen >= OVERLAP_CHARS) break;
    }
    current = tail;
    currentLen = tailLen;
  }

  for (const item of stream) {
    if (currentLen + item.sentence.length > CHUNK_SIZE_CHARS && current.length > 0) {
      flush();
    }
    current.push(item);
    currentLen += item.sentence.length + 1;
  }
  flush(); // final chunk

  return chunks;
}

function processDoc(file) {
  const parsed = JSON.parse(fs.readFileSync(path.join(PARSED_DIR, file), "utf-8"));
  const rawChunks = chunkPages(parsed.pages);

  const chunks = rawChunks.map((c, i) => ({
    chunk_id: `${parsed.doc_id}::chunk-${String(i).padStart(4, "0")}`,
    doc_id: parsed.doc_id,
    title: parsed.title,
    author: parsed.author,
    chunk_index: i,
    page_start: c.pages[0],
    page_end: c.pages[c.pages.length - 1],
    char_count: c.text.length,
    text: c.text,
  }));

  const outPath = path.join(OUT_DIR, file.replace(".json", ".chunks.json"));
  fs.writeFileSync(outPath, JSON.stringify(chunks, null, 2));
  console.log(`${parsed.title}: ${chunks.length} chunks -> ${outPath}`);
  return chunks;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const files = fs.readdirSync(PARSED_DIR).filter((f) => f.endsWith(".json"));
let all = [];
for (const f of files) all = all.concat(processDoc(f));

fs.writeFileSync(
  path.join(OUT_DIR, "all_chunks.json"),
  JSON.stringify(all, null, 2)
);
console.log(`\nTotal chunks across knowledge base: ${all.length}`);
