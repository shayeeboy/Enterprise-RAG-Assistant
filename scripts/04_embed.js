/**
 * STAGE 5: Embeddings  (LOCAL / FREE)
 * -----------------------------------
 * Input:  data/chunks/all_chunks.enriched.json
 * Output: data/chunks/all_chunks.embedded.json  (adds `embedding: number[]` to each chunk)
 *
 * Runs a local embedding model via Transformers.js (@xenova/transformers) —
 * no API key, no per-call billing, no network at inference time after the
 * one-time model download. This replaces the paid Voyage AI call while
 * keeping every other stage (chunking, metadata, indexing) untouched — that
 * modularity is the whole point of the pipeline.
 *
 *     node scripts/04_embed.js
 *
 * Model: mixedbread-ai/mxbai-embed-large-v1 — a BGE-large finetune that
 * outputs 1024-dim vectors, so the SQL schema (`vector(1024)`) and the HNSW
 * index are unchanged. Like Voyage, it's asymmetric: documents are embedded
 * as-is here; at retrieval time queries should be prefixed with the model's
 * query instruction (see RETRIEVAL_QUERY_PREFIX below).
 *
 * Override the model with EMBED_MODEL=... (must be a Transformers.js-compatible
 * feature-extraction model; adjust EMBEDDING_DIM + sql/schema.sql if its
 * dimension differs from 1024).
 */

const fs = require("fs");
const path = require("path");

const CHUNKS_DIR = path.join(__dirname, "..", "data", "chunks");
const MODEL = process.env.EMBED_MODEL || "mixedbread-ai/mxbai-embed-large-v1";
const BATCH_SIZE = 16; // local CPU inference — smaller batches keep memory flat
const EMBEDDING_DIM = 1024;

// mxbai/BGE use CLS pooling; documents need no prefix, queries do. Kept here
// so the retrieval side of the app can import the exact same string.
const RETRIEVAL_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

async function main() {
  // @xenova/transformers is ESM-only; load it via dynamic import from CommonJS.
  const { pipeline } = await import("@xenova/transformers");

  console.log(`Loading local embedding model: ${MODEL}`);
  console.log("(first run downloads the model to ./node_modules/@xenova cache — this can take a few minutes)");

  let lastPct = -1;
  const extractor = await pipeline("feature-extraction", MODEL, {
    quantized: true, // ~4x smaller download, negligible quality loss for retrieval
    progress_callback: (p) => {
      if (p.status === "progress" && typeof p.progress === "number") {
        const pct = Math.floor(p.progress / 10) * 10;
        if (pct !== lastPct) {
          lastPct = pct;
          process.stdout.write(`  downloading ${p.file || ""}: ${pct}%\r`);
        }
      }
    },
  });
  console.log("\nModel loaded. Embedding chunks...");

  const chunks = JSON.parse(
    fs.readFileSync(path.join(CHUNKS_DIR, "all_chunks.enriched.json"), "utf-8")
  );

  const embedded = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const output = await extractor(
      batch.map((c) => c.text),
      { pooling: "cls", normalize: true }
    );
    const vectors = output.tolist(); // [batch][EMBEDDING_DIM]

    batch.forEach((c, j) => {
      const vec = vectors[j];
      if (vec.length !== EMBEDDING_DIM) {
        throw new Error(
          `Expected ${EMBEDDING_DIM}-dim embedding but got ${vec.length}. ` +
            `Update EMBEDDING_DIM and sql/schema.sql to match the model.`
        );
      }
      embedded.push({ ...c, embedding: vec });
    });

    console.log(`Embedded ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }

  fs.writeFileSync(
    path.join(CHUNKS_DIR, "all_chunks.embedded.json"),
    JSON.stringify(embedded, null, 2)
  );
  console.log(
    `Done. ${embedded.length} chunks embedded at ${EMBEDDING_DIM} dimensions with ${MODEL} (local, no API cost).`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

module.exports = { RETRIEVAL_QUERY_PREFIX };
