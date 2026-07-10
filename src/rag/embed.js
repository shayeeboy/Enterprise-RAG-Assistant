/**
 * Query-time embedding — the retrieval half of the asymmetric pair.
 * Uses the SAME local model as ingestion (mxbai-embed-large-v1 via
 * Transformers.js), so query and document vectors live in the same space.
 * Queries get the model's instruction prefix; documents did not (see 04_embed.js).
 */
const { EMBED_MODEL, EMBEDDING_DIM } = require("./config");

// Must match the prefix used at ingestion time for correct asymmetric retrieval.
const RETRIEVAL_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

let _extractor = null;
async function getExtractor() {
  if (_extractor) return _extractor;
  const { pipeline } = await import("@xenova/transformers"); // ESM-only
  _extractor = await pipeline("feature-extraction", EMBED_MODEL, { quantized: true });
  return _extractor;
}

async function embedQuery(text) {
  const extractor = await getExtractor();
  const output = await extractor(RETRIEVAL_QUERY_PREFIX + text, {
    pooling: "cls",
    normalize: true,
  });
  const vec = Array.from(output.data);
  if (vec.length !== EMBEDDING_DIM) {
    throw new Error(
      `Query embedding is ${vec.length}-dim but the index is ${EMBEDDING_DIM}-dim. ` +
        `Set EMBED_MODEL to the same model used for ingestion.`
    );
  }
  return vec;
}

// pgvector accepts a '[a,b,c]' text literal cast to ::vector.
function toVectorLiteral(vec) {
  return `[${vec.join(",")}]`;
}

module.exports = { embedQuery, toVectorLiteral, RETRIEVAL_QUERY_PREFIX };
