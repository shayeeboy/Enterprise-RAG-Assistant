/**
 * STAGE 1: Document Parsing
 * -------------------------
 * Input:  raw text extracted from PDFs via `pdftotext -layout` (data/raw/*.txt)
 * Output: data/parsed/<doc>.json — an array of { page, text } objects
 *
 * pdftotext preserves a form-feed (\f) character between pages, which we use
 * to recover page numbers. This matters later: page number becomes chunk
 * metadata, which lets the assistant cite "Fundamentals of Piano Practice, p.42"
 * instead of an opaque chunk id.
 */

const fs = require("fs");
const path = require("path");

const RAW_DIR = path.join(__dirname, "..", "data", "raw");
const OUT_DIR = path.join(__dirname, "..", "data", "parsed");

const DOCS = [
  {
    id: "fundamentals-of-piano-practice",
    title: "Fundamentals of Piano Practice",
    author: "Chuan C. Chang",
    file: "fundamentals.txt",
  },
  {
    id: "hanon-virtuoso-pianist-pt1",
    title: "The Virtuoso Pianist, Part I",
    author: "C. L. Hanon",
    file: "hanon.txt",
  },
];

function cleanText(raw) {
  return raw
    .replace(/\r/g, "")
    // de-hyphenate words split across a line break: "tech-\nnique" -> "technique"
    .replace(/(\w)-\n(\w)/g, "$1$2")
    // collapse remaining single newlines inside a paragraph into spaces,
    // but keep blank lines (paragraph breaks)
    .replace(/([^\n])\n(?!\n)/g, "$1 ")
    // collapse repeated whitespace
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function parseDoc(doc) {
  const rawPath = path.join(RAW_DIR, doc.file);
  const raw = fs.readFileSync(rawPath, "utf-8");
  const pages = raw.split("\f");

  const parsedPages = pages
    .map((pageText, i) => ({
      page: i + 1,
      text: cleanText(pageText),
    }))
    // drop essentially-empty pages (blank separators, running headers only)
    .filter((p) => p.text.length > 20);

  const outPath = path.join(OUT_DIR, `${doc.id}.json`);
  fs.writeFileSync(
    outPath,
    JSON.stringify(
      {
        doc_id: doc.id,
        title: doc.title,
        author: doc.author,
        page_count: parsedPages.length,
        pages: parsedPages,
      },
      null,
      2
    )
  );
  console.log(`Parsed ${doc.title}: ${parsedPages.length} non-empty pages -> ${outPath}`);
}

fs.mkdirSync(OUT_DIR, { recursive: true });
DOCS.forEach(parseDoc);
