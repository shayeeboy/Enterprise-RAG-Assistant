/**
 * Hybrid retrieval: dense (pgvector cosine) + sparse (Postgres full-text),
 * fused with Reciprocal Rank Fusion (RRF), then scored and thresholded.
 *
 * Covers workflow steps: Embedding → Hybrid Search → Scoring → Threshold.
 * RRF is used instead of raw score-mixing because the two signals live on
 * different scales (cosine similarity vs. ts_rank_cd); rank fusion needs no
 * calibration and is a well-established, dependency-free approach.
 */
const { query } = require("./db");
const { embedQuery, toVectorLiteral } = require("./embed");
const cfg = require("./config");

function buildFilterSql(filters, startIdx) {
  const clauses = [];
  const params = [];
  let i = startIdx;
  if (filters?.content_type) { clauses.push(`content_type = $${i++}`); params.push(filters.content_type); }
  if (filters?.skill_level) { clauses.push(`skill_level = $${i++}`); params.push(filters.skill_level); }
  if (filters?.doc_id) { clauses.push(`doc_id = $${i++}`); params.push(filters.doc_id); }
  return { where: clauses.length ? " AND " + clauses.join(" AND ") : "", params };
}

async function vectorSearch(vecLiteral, filters) {
  const f = buildFilterSql(filters, 3);
  const sql = `
    SELECT chunk_id, 1 - (embedding <=> $1::vector) AS vscore
    FROM chunks
    WHERE embedding IS NOT NULL${f.where}
    ORDER BY embedding <=> $1::vector
    LIMIT $2`;
  const { rows } = await query(sql, [vecLiteral, cfg.HYBRID_CANDIDATES, ...f.params]);
  return rows; // best-first
}

async function keywordSearch(qtext, filters) {
  const f = buildFilterSql(filters, 3);
  const sql = `
    SELECT chunk_id, ts_rank_cd(text_tsv, plainto_tsquery('english', $1)) AS kscore
    FROM chunks
    WHERE text_tsv @@ plainto_tsquery('english', $1)${f.where}
    ORDER BY kscore DESC
    LIMIT $2`;
  const { rows } = await query(sql, [qtext, cfg.HYBRID_CANDIDATES, ...f.params]);
  return rows; // best-first
}

// Reciprocal Rank Fusion: score = Σ 1 / (k + rank) across the lists a doc appears in.
function reciprocalRankFusion(vectorRows, keywordRows, k) {
  const acc = new Map();
  const bump = (chunk_id, rank, patch) => {
    const s = acc.get(chunk_id) || { chunk_id, rrf: 0, vscore: null, kscore: null };
    s.rrf += 1 / (k + rank + 1);
    Object.assign(s, patch);
    acc.set(chunk_id, s);
  };
  vectorRows.forEach((r, i) => bump(r.chunk_id, i, { vscore: Number(r.vscore) }));
  keywordRows.forEach((r, i) => bump(r.chunk_id, i, { kscore: Number(r.kscore) }));
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}

async function hybridRetrieve(searchQuery, filters = {}) {
  const vecLiteral = toVectorLiteral(await embedQuery(searchQuery));

  const [vectorRows, keywordRows] = await Promise.all([
    vectorSearch(vecLiteral, filters),
    keywordSearch(searchQuery, filters),
  ]);

  const fused = reciprocalRankFusion(vectorRows, keywordRows, cfg.RRF_K);

  // Scoring + Threshold: keep a candidate if it clears the vector-similarity
  // floor OR it was a genuine keyword match. Everything else is dropped so the
  // reranker and LLM never see off-topic noise.
  const kept = fused.filter(
    (c) =>
      (c.vscore != null && c.vscore >= cfg.VECTOR_THRESHOLD) ||
      (c.kscore != null && c.kscore > 0)
  );

  const shortlist = kept.slice(0, cfg.RERANK_INPUT);
  if (!shortlist.length) {
    return { candidates: [], vectorCount: vectorRows.length, keywordCount: keywordRows.length };
  }

  // Hydrate full rows + document metadata (title/author for citations).
  const ids = shortlist.map((c) => c.chunk_id);
  const { rows } = await query(
    `SELECT c.chunk_id, c.text, c.page_start, c.page_end, c.content_type, c.skill_level,
            d.title, d.author
     FROM chunks c JOIN documents d ON d.doc_id = c.doc_id
     WHERE c.chunk_id = ANY($1)`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  const candidates = shortlist
    .map((c) => (byId.has(c.chunk_id) ? { ...byId.get(c.chunk_id), vscore: c.vscore, kscore: c.kscore, rrf: c.rrf } : null))
    .filter(Boolean);

  return { candidates, vectorCount: vectorRows.length, keywordCount: keywordRows.length };
}

module.exports = { hybridRetrieve, reciprocalRankFusion };
