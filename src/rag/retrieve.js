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

// General Reciprocal Rank Fusion over any number of ranked lists. Each list is
// best-first and names the per-row score field to carry through ("vscore" /
// "kscore"); a chunk's fused score sums 1 / (k + rank + 1) over every list it
// appears in, and the strongest score seen per field is retained so downstream
// thresholding still sees the best signal across all queries.
function fuseRankLists(lists, k) {
  const acc = new Map();
  for (const { rows, field } of lists) {
    rows.forEach((r, rank) => {
      const s = acc.get(r.chunk_id) || { chunk_id: r.chunk_id, rrf: 0, vscore: null, kscore: null };
      s.rrf += 1 / (k + rank + 1);
      const v = Number(r[field]);
      if (Number.isFinite(v)) s[field] = s[field] == null ? v : Math.max(s[field], v);
      acc.set(r.chunk_id, s);
    });
  }
  return [...acc.values()].sort((a, b) => b.rrf - a.rrf);
}

// Reciprocal Rank Fusion: a doc appearing in both lists wins. Two-list special
// case, kept for external callers and the unit test.
function reciprocalRankFusion(vectorRows, keywordRows, k) {
  return fuseRankLists(
    [{ rows: vectorRows, field: "vscore" }, { rows: keywordRows, field: "kscore" }],
    k
  );
}

async function hybridRetrieve(searchQuery, filters = {}) {
  // Accept one query or several (e.g. the raw question AND its rewrite, or a
  // multi-query fan-out). Union the retrieval pools across all of them so a
  // single drifting rewrite can never DROP a chunk the original would have found.
  const seen = new Set();
  const queries = (Array.isArray(searchQuery) ? searchQuery : [searchQuery])
    // Strip NUL / C0 control bytes: Postgres text (and plainto_tsquery) reject a
    // 0x00 byte outright ("invalid byte sequence for encoding UTF8"), and an LLM
    // rewrite occasionally emits one — sanitize here, the shared DB boundary.
    .map((q) => String(q || "").replace(/[\x00-\x1F\x7F]/g, " ").replace(/\s+/g, " ").trim())
    .filter((q) => q.length >= 3 && !seen.has(q.toLowerCase()) && seen.add(q.toLowerCase()));
  if (!queries.length) return { candidates: [], vectorCount: 0, keywordCount: 0 };

  // Run dense + sparse search for every query in parallel.
  const perQuery = await Promise.all(
    queries.map(async (q) => {
      const vecLiteral = toVectorLiteral(await embedQuery(q));
      const [vectorRows, keywordRows] = await Promise.all([
        vectorSearch(vecLiteral, filters),
        keywordSearch(q, filters),
      ]);
      return { vectorRows, keywordRows };
    })
  );

  const lists = [];
  let vectorCount = 0;
  let keywordCount = 0;
  for (const { vectorRows, keywordRows } of perQuery) {
    lists.push({ rows: vectorRows, field: "vscore" }, { rows: keywordRows, field: "kscore" });
    vectorCount += vectorRows.length;
    keywordCount += keywordRows.length;
  }
  const fused = fuseRankLists(lists, cfg.RRF_K);

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
    return { candidates: [], vectorCount, keywordCount };
  }

  // Hydrate full rows + document metadata (title/author for citations).
  const ids = shortlist.map((c) => c.chunk_id);
  const { rows } = await query(
    `SELECT c.chunk_id, c.doc_id, c.text, c.page_start, c.page_end, c.content_type, c.skill_level,
            d.title, d.author, d.source_url
     FROM chunks c JOIN documents d ON d.doc_id = c.doc_id
     WHERE c.chunk_id = ANY($1)`,
    [ids]
  );
  const byId = new Map(rows.map((r) => [r.chunk_id, r]));
  const candidates = shortlist
    .map((c) => (byId.has(c.chunk_id) ? { ...byId.get(c.chunk_id), vscore: c.vscore, kscore: c.kscore, rrf: c.rrf } : null))
    .filter(Boolean);

  return { candidates, vectorCount, keywordCount };
}

module.exports = { hybridRetrieve, reciprocalRankFusion };
