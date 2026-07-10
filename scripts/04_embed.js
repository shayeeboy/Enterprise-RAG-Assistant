/**
 * STAGE 5: Embeddings
 * --------------------
 * Input:  data/chunks/all_chunks.enriched.json
 * Output: data/chunks/all_chunks.embedded.json  (adds `embedding: number[]` to each chunk)
 *
 * IMPORTANT: This script makes real network calls to an embeddings API and
 * requires a live API key — it is NOT run inside the offline build sandbox
 * that produced this repo. Run it locally / in CI where network + secrets
 * are available:
 *
 *     VOYAGE_API_KEY=xxxx node scripts/04_embed.js
 *
 * Why Voyage AI: Anthropic does not serve an embeddings endpoint itself and
 * recommends Voyage AI as its embeddings partner. `voyage-3.5` (1024-dim,
 * or configurable via `output_dimension`) works well for domain-specific
 * technical/instructional text like this knowledge base. Swap the fetch
 * call below for OpenAI's `text-embedding-3-small` or any other provider
 * without touching any other stage — that's the point of keeping this as
 * an isolated pipeline step.
 */

const fs = require("fs");
const path = require("path");

const CHUNKS_DIR = path.join(__dirname, "..", "data", "chunks");
const MODEL = "voyage-3.5";
const BATCH_SIZE = 32; // Voyage's batch embedding endpoint accepts arrays of input text
const EMBEDDING_DIM = 1024;

async function embedBatch(texts) {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: MODEL,
      input_type: "document", // vs "query" at retrieval time — asymmetric embeddings improve recall
      output_dimension: EMBEDDING_DIM,
    }),
  });

  if (!res.ok) {
    throw new Error(`Voyage API error ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.data.map((d) => d.embedding);
}

async function withRetry(fn, retries = 3, delayMs = 1500) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === retries) throw err;
      console.warn(`  retry ${attempt}/${retries} after error: ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs * attempt));
    }
  }
}

async function main() {
  if (!process.env.VOYAGE_API_KEY) {
    console.error(
      "VOYAGE_API_KEY is not set. This stage requires network access and a live " +
        "API key, so it's meant to run outside this offline build sandbox.\n" +
        "Example: VOYAGE_API_KEY=xxxx node scripts/04_embed.js"
    );
    process.exit(1);
  }

  const chunks = JSON.parse(
    fs.readFileSync(path.join(CHUNKS_DIR, "all_chunks.enriched.json"), "utf-8")
  );

  const embedded = [];
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);
    const embeddings = await withRetry(() => embedBatch(batch.map((c) => c.text)));
    batch.forEach((c, j) => embedded.push({ ...c, embedding: embeddings[j] }));
    console.log(`Embedded ${Math.min(i + BATCH_SIZE, chunks.length)}/${chunks.length}`);
  }

  fs.writeFileSync(
    path.join(CHUNKS_DIR, "all_chunks.embedded.json"),
    JSON.stringify(embedded, null, 2)
  );
  console.log(`Done. ${embedded.length} chunks embedded at ${EMBEDDING_DIM} dimensions.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
