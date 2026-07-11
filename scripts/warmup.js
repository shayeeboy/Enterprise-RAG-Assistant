/**
 * Build-time warm-up: pre-downloads the local embedding + reranker models into
 * the image's Transformers.js cache, so the running container does NOT fetch
 * them into Cloud Run's in-memory filesystem at runtime. This cuts cold-start
 * time and peak memory dramatically. Run from the Dockerfile: `node scripts/warmup.js`.
 */
(async () => {
  const { embedQuery } = require("../src/rag/embed");
  const { rerank } = require("../src/rag/rerank");
  console.log("warmup: loading embedding model…");
  await embedQuery("warmup");
  console.log("warmup: loading reranker model…");
  await rerank("warmup", [
    { text: "warmup passage", title: "t", page_start: 1, page_end: 1, content_type: "x" },
  ]);
  console.log("warmup complete: models cached in the image.");
})().catch((e) => {
  console.error("warmup failed:", e.message);
  process.exit(1);
});
