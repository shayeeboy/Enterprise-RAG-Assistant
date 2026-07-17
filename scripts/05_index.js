/**
 * STAGE 6 + 7: Indexing + Vector Database Load
 * ----------------------------------------------
 * Input:  data/chunks/all_chunks.embedded.json
 * Target: Neon Postgres (pgvector) — schema in sql/schema.sql
 *
 * Run:
 *     DATABASE_URL=postgres://... node scripts/05_index.js
 *
 * Idempotent: uses ON CONFLICT DO UPDATE so re-running after a KB update
 * (e.g. adding a third method book) only touches changed rows.
 */

const fs = require("fs");
const path = require("path");
const { Client } = require("pg"); // npm install pg

const CHUNKS_DIR = path.join(__dirname, "..", "data", "chunks");
const BATCH_SIZE = 100;

// Public base for the self-hosted PDFs (served from the GitHub Pages site's
// public/pdfs/). Citations deep-link as `${source_url}#page=N`. Override with
// PDF_BASE_URL to host the PDFs elsewhere.
const PDF_BASE = (process.env.PDF_BASE_URL || "https://shayeeboy.github.io/Enterprise-RAG-Assistant/pdfs").replace(/\/$/, "");

const DOC_META = {
  "fundamentals-of-piano-practice": {
    title: "Fundamentals of Piano Practice",
    author: "Chuan C. Chang",
    source_type: "method-book",
    source_url: `${PDF_BASE}/fundamentals-of-piano-practice.pdf`,
  },
  "hanon-virtuoso-pianist-pt1": {
    title: "The Virtuoso Pianist, Part I",
    author: "C. L. Hanon",
    source_type: "exercise-book",
    source_url: `${PDF_BASE}/hanon-virtuoso-pianist-pt1.pdf`,
  },
};

async function upsertDocuments(client, chunks) {
  const docIds = [...new Set(chunks.map((c) => c.doc_id))];
  for (const docId of docIds) {
    const meta = DOC_META[docId];
    const pageCount = Math.max(...chunks.filter((c) => c.doc_id === docId).map((c) => c.page_end));
    await client.query(
      `INSERT INTO documents (doc_id, title, author, source_type, page_count, source_url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (doc_id) DO UPDATE SET
         title = EXCLUDED.title, author = EXCLUDED.author,
         source_type = EXCLUDED.source_type, page_count = EXCLUDED.page_count,
         source_url = EXCLUDED.source_url`,
      [docId, meta.title, meta.author, meta.source_type, pageCount, meta.source_url || null]
    );
  }
  console.log(`Upserted ${docIds.length} document records.`);
}

async function upsertChunkBatch(client, batch) {
  // build a single multi-row upsert per batch for throughput
  const values = [];
  const params = [];
  batch.forEach((c, i) => {
    const base = i * 11;
    values.push(
      `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11})`
    );
    params.push(
      c.chunk_id,
      c.doc_id,
      c.chunk_index,
      c.page_start,
      c.page_end,
      c.char_count,
      c.text,
      c.content_type,
      c.skill_level,
      c.finger_numbers,
      `[${c.embedding.join(",")}]` // pgvector literal format
    );
  });

  const sql = `
    INSERT INTO chunks
      (chunk_id, doc_id, chunk_index, page_start, page_end, char_count, text,
       content_type, skill_level, finger_numbers, embedding)
    VALUES ${values.join(",")}
    ON CONFLICT (chunk_id) DO UPDATE SET
      text = EXCLUDED.text,
      content_type = EXCLUDED.content_type,
      skill_level = EXCLUDED.skill_level,
      finger_numbers = EXCLUDED.finger_numbers,
      embedding = EXCLUDED.embedding
  `;
  await client.query(sql, params);
}

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set (Neon connection string). Aborting.");
    process.exit(1);
  }

  const embeddedPath = path.join(CHUNKS_DIR, "all_chunks.embedded.json");
  if (!fs.existsSync(embeddedPath)) {
    console.error(
      `Missing ${embeddedPath}. Run scripts/04_embed.js first (local embeddings, no API key).`
    );
    process.exit(1);
  }

  const chunks = JSON.parse(fs.readFileSync(embeddedPath, "utf-8"));
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await upsertDocuments(client, chunks);

  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    await upsertChunkBatch(client, batch);
    console.log(`Indexed ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }

  await client.end();
  console.log("Indexing complete. Vector database ready for retrieval.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
