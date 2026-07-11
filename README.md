# AI-Native Piano Learning Assistant — RAG Pipeline

A retrieval-augmented generation (RAG) assistant over a piano-learning
knowledge base, in two phases: an **offline ingestion pipeline** (Phase 1) that
turns source PDFs into a queryable vector database, and a **query-time
assistant** (Phase 2) that answers questions from that database with citations
and guardrails. Every stage runs on free, local, open-source models — no paid
API anywhere. Built as part of
[My AI Portfolio](https://github.com/shayeeboy) alongside the
[AI-Native Team Diagnostic](https://github.com/shayeeboy/ai-native-diagnostic).

**Knowledge base (this build):**
| Document | Author | Pages | Type |
|---|---|---|---|
| *Fundamentals of Piano Practice* | Chuan C. Chang | 202 | Method book (technique, practice methods, theory) |
| *The Virtuoso Pianist, Part I* | C. L. Hanon | 21 | Exercise book (20 numbered finger exercises) |

**Result of this run:** 985 chunks (940 + 45) indexed with metadata, ready for embedding and vector search.

---

## Pipeline

```
Knowledge Base → Document Parsing → Chunking → Chunk Overlap → Embeddings → Metadata → Indexing → Vector Database
```

Each stage is an isolated script in `scripts/`, so any stage can be swapped
(a different embedding model, a different vector DB) without touching the
others. Every stage but the last runs fully offline on this repo's contents —
including embeddings, which use a local model with no API key. Only the final
indexing stage needs network access, for the Neon Postgres database (a
`DATABASE_URL`); no third-party API credentials are required at any stage.

### 1. Knowledge Base

Two source PDFs: `fundamentals-of-piano-practice-readthedocs-io-en-latest.PDF`
and `virtuoso-pianist-pt1-a4.PDF`, placed in `data/uploads/`.

### 2. Document Parsing — `scripts/01_parse.js`

- Extracts text with `pdftotext -layout` (preserves reading order for
  single/multi-column pages).
- Splits on the form-feed character pdftotext inserts between pages, so
  every page keeps its page number — this becomes citation metadata later
  ("Fundamentals of Piano Practice, p.42").
- Cleans line-break hyphenation artifacts (`tech-\nnique` → `technique`)
  and collapses stray whitespace, without destroying paragraph breaks.
- Drops near-empty pages (running headers, blank separators).
- Output: `data/parsed/<doc>.json` — `{ doc_id, title, author, pages: [{ page, text }] }`.

**Result:** 202 usable pages from *Fundamentals*, 21 from *Hanon* (the Hanon
score is mostly musical notation glyphs, which `pdftotext` renders as
unrecognizable symbols — only the surrounding prose per exercise, e.g.
"Nº 3. (2-3-4) Before beginning to practise Nº 3…", is meaningfully
retrievable as text. This is a known limitation for scanned/notation-heavy
PDFs — see *Design decisions* below.)

### 3. Chunking — `scripts/02_chunk.js`

- Sentence-aware chunking: text is split into sentences first, then packed
  greedily into ~1,400-character (~350-token) chunks — never splitting a
  sentence in half.
- Chunk size was chosen to be large enough to keep a full technique
  explanation or exercise instruction intact, small enough for precise
  retrieval and to stay well under typical embedding model input limits.
- Chunks can span a page boundary; `page_start`/`page_end` are tracked so a
  chunk that starts on page 41 and ends on page 42 is still citable.

### 4. Chunk Overlap — (part of `scripts/02_chunk.js`)

- ~200 characters (~15% of chunk size) from the end of each chunk are
  carried into the start of the next.
- Purpose: prevents a technique instruction that lands right at a chunk
  boundary from losing its context — e.g. a sentence like "the thumb should
  pass under smoothly" shouldn't be split from the sentence before it that
  explains *when* to do it.
- Verified on real output: chunk 5 ends "…the most important factor for
  learning to play the piano is the practice methods." and chunk 6 opens
  with that same sentence before continuing — confirming overlap works as
  designed.

### 5. Embeddings — `scripts/04_embed.js`

- Runs a **local embedding model** — `mixedbread-ai/mxbai-embed-large-v1`
  (a BGE-large finetune) — via **Transformers.js** (`@xenova/transformers`).
  No API key, no per-call billing, and no network at inference time after
  the one-time model download. Chunks are embedded in batches of 16 with
  CLS pooling and L2 normalization.
- **Asymmetric retrieval** is preserved: documents are embedded as-is here,
  while queries should be prefixed at retrieval time with the model's
  instruction (`RETRIEVAL_QUERY_PREFIX`, exported from `04_embed.js`) —
  the same document-vs-query asymmetry that improves recall.
- 1,024-dimensional output — a reasonable balance of retrieval quality vs.
  storage/index size for a knowledge base this size (985 chunks), and it
  keeps the `vector(1024)` schema and HNSW index unchanged.
- **Swap-in note:** the model is pluggable via `EMBED_MODEL=...`, and because
  each stage is isolated you can drop in a hosted provider (Voyage AI's
  `voyage-3.5`, OpenAI `text-embedding-3-*`, etc.) by editing only this file
  — adjust `EMBEDDING_DIM` + `sql/schema.sql` if the dimension differs.

### 6. Metadata — `scripts/03_metadata.js`

Runs offline, right after chunking, so metadata is available before the
embedding call (order in the code differs slightly from the diagram for
this reason — see *Design decisions*). Adds per chunk:

- `source_type`: `method-book` vs `exercise-book`
- `content_type`: `exercise` / `technique` / `practice-method` / `theory` /
  `narrative` — keyword-classified
- `skill_level`: `beginner` / `advanced` / `unspecified`
- `finger_numbers`: e.g. `["3-4-5"]`, extracted from Hanon-style notation
  like "(3-4-5)" so a query like "exercises for my weak 4th and 5th finger"
  can filter directly
- `keywords`: lightweight frequency-based keyword extraction for hybrid
  (BM25 + vector) search

**Result on this run:** 354 technique chunks, 243 exercise chunks, 170
practice-method chunks, 150 narrative, 68 theory.

### 7. Indexing — `scripts/05_index.js`

- Idempotent bulk upsert into Postgres: multi-row `INSERT … ON CONFLICT DO
  UPDATE`, batched 100 rows per statement.
- Re-running after a knowledge base update (e.g. adding a third method
  book) only touches changed rows.
- **Requires `DATABASE_URL` (Neon connection string)** — run alongside or
  after the embedding stage.

### 8. Vector Database — Neon Postgres + pgvector

Schema in `sql/schema.sql`:

- `documents` table (one row per source book) and `chunks` table (one row
  per chunk, `embedding vector(1024)` column).
- **HNSW index** on `embedding` with cosine distance — better recall/speed
  tradeoff than IVFFlat for a KB this size, and doesn't need a training
  step before it's usable (IVFFlat needs data present before building the
  index; HNSW builds incrementally).
- B-tree indexes on `doc_id`, `content_type`, `skill_level` for metadata
  pre-filtering (e.g. "only exercises, only Hanon") ahead of vector search.
- Generated `tsvector` column + GIN index for hybrid keyword+vector search.

---

## Design decisions

- **Neon over self-hosted Postgres**: serverless scale-to-zero fits a
  portfolio/demo project's usage pattern (mirrors the same reasoning
  used for `ai-native-diagnostic` v3's backend).
- **pgvector over a dedicated vector DB** (Pinecone, Weaviate): one
  database for both structured metadata and vectors means metadata
  filtering and vector search happen in a single SQL query — simpler
  ops for a KB this size, and Neon has first-class pgvector support.
- **Local embeddings over a paid API**: embeddings run on-device with
  `mixedbread-ai/mxbai-embed-large-v1` via Transformers.js — zero API cost,
  no keys, fully reproducible offline. It's a 1024-dim BGE-large finetune,
  so quality is competitive with hosted options while keeping the schema
  identical. The stage stays provider-agnostic: swapping in a hosted
  embedder (Voyage AI, OpenAI, etc.) touches only `04_embed.js`.
- **Metadata before embeddings in execution order**: the diagram lists
  Embeddings → Metadata, but running metadata extraction first means the
  (comparatively expensive) embedding pass only happens once the chunk
  boundaries and tags are finalized — avoids re-embedding if a metadata
  rule changes.
- **Known limitation — Hanon notation**: `Nº 1` through `Nº 20` are
  primarily musical staff notation, not text. `pdftotext` extracts the
  surrounding instructional prose (fingering guidance, tempo markings,
  practice notes) but not the notes themselves. A future version could
  rasterize each exercise page and use a vision-capable model to describe
  the notation, or link out to the MuseScore/Mutopia source files.

---

## The Assistant (query time — Phase 2)

Phase 1 loads the vector DB; Phase 2 answers questions from it. The assistant
runs the full retrieval-augmented workflow below, every stage on free/local
tooling — the same local embedding model as ingestion, a local cross-encoder
reranker, and a local LLM via Ollama. No stage calls a paid API.

```
User Question
   → Query Rewrite       local LLM expands/clarifies the query
   → Embedding           mxbai-embed-large-v1 (same model as ingestion)
   → Hybrid Search       pgvector cosine + Postgres full-text
   → Scoring             Reciprocal Rank Fusion of the two result sets
   → Threshold           drop low-similarity / non-matching candidates
   → Reranking           bge-reranker-base cross-encoder scores each pair
   → Top-K Chunks        keep the best K for the prompt
   → Prompt Augmentation numbered, citable context blocks
   → LLM Reasoning       local model answers from the context only
   → Generated Answer
   → Citations           map [n] markers back to title + page
   → Guardrails          input checks; refuse when unsupported; grounding check
   → Response
```

**Each step → its module** (`src/rag/`):

| Workflow step | Module | Free/local tool |
|---|---|---|
| Query Rewrite | `rewrite.js` | local LLM (Ollama) |
| Embedding | `embed.js` | Transformers.js · `mxbai-embed-large-v1` |
| Hybrid Search + Scoring + Threshold | `retrieve.js` | pgvector + Postgres FTS + RRF |
| Reranking + Top-K | `rerank.js` | Transformers.js · `bge-reranker-base` |
| Prompt Augmentation | `prompt.js` | — (string assembly) |
| LLM Reasoning | `llm.js` | Ollama (pluggable) |
| Citations + Guardrails | `guardrails.js` | rule-based |
| Orchestration | `pipeline.js` | — |

### Why these tools (all free, no billing)

- **Local cross-encoder reranking** (`Xenova/bge-reranker-base`): the
  first-stage bi-encoder is fast but coarse; a cross-encoder re-scores each
  (question, chunk) pair jointly for much better precision — on CPU, no API key.
- **Hybrid search via RRF**: dense vectors catch paraphrase, keyword search
  catches exact terms (finger numbers, "Hanon"); Reciprocal Rank Fusion merges
  the two rankings without calibrating their different score scales.
- **Local LLM via Ollama**: keeps the assistant zero-cost and offline. The
  provider is pluggable — set `LLM_PROVIDER=openai-compatible` + `LLM_BASE_URL`
  to point at any hosted endpoint instead, without touching the pipeline.
- **Guardrails**: if nothing clears the relevance threshold the assistant
  refuses rather than inventing an answer, and the generated answer is checked
  for real citations before it's returned.

### Setup & run

```bash
npm install
cp .env.example .env           # set DATABASE_URL; the LLM defaults are free/local

# one-time: install the local LLM runner (https://ollama.com), then pull a model
ollama pull llama3.2:3b        # small/fast default; llama3.1:8b for higher quality

# ask a question (CLI)
npm run query -- "How should I practice a difficult passage?"
VERBOSE=1 npm run query -- "exercises for weak 4th and 5th fingers"

# or run the local API + chat UI
npm run serve                  # http://localhost:8080  (POST /ask, GET /health)

# verify every layer is wired up and the DB is loaded (read-only)
npm run smoke                  # checks DB, embeddings, retrieval, rerank, LLM
```

The embedding and reranker models download once on first use (cached under
`node_modules`). Retrieval and reranking are fully local; only the final answer
needs the LLM. Tune `TOP_K`, `VECTOR_THRESHOLD`, `RERANK_THRESHOLD`, and
`ENABLE_QUERY_REWRITE` in `.env`.

### Tests & CI

- `npm run check` — offline wiring + logic checks (module imports, guardrails,
  rank fusion, prompt assembly). No DB, LLM, or model downloads.
- `npm run smoke` — full read-only health check against the live DB
  (connectivity, embeddings, hybrid retrieval, rerank) plus an end-to-end answer
  when the LLM is up.

GitHub Actions (`.github/workflows/ci.yml`) runs `npm run check` on every push.
Add a `DATABASE_URL` repository secret to also run the full `npm run smoke` in CI
(the LLM step warns rather than fails there, since Ollama isn't available in CI).

### Deploying off localhost (Phase 3)

`server.js` is deploy-ready and env-driven for hosting the assistant behind a URL
while keeping everything free — see [`docs/PHASE-3.md`](docs/PHASE-3.md) for the
full analysis and hosting options. The knobs (all optional, default to open local
dev): `ALLOWED_ORIGINS` (CORS), `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`,
`ACCESS_CODE`, and — for a separately hosted front end — `window.RAG_API_BASE`.
Because `llm.js` supports `LLM_PROVIDER=openai-compatible`, the LLM can move to a
free-tier hosted endpoint (e.g. Groq) or stay fully self-hosted via Ollama.

**Observability** is built in (no external SDK): every query returns a `meta`
block with `traceId`, per-stage `latencyMs`, `tokens`, and `costUsd` (0 for local).
The server logs one JSON line per request, the CLI prints a timing/token line, and
the chat UI shows it under each answer. See [`docs/PHASE-3.md`](docs/PHASE-3.md#observability-built-in).

---

## Repo structure

```
rag-pipeline/
├── README.md                  ← this file
├── package.json
├── data/
│   ├── raw/                   ← pdftotext output (gitignored — regenerate from PDFs)
│   ├── parsed/                ← stage 2 output
│   └── chunks/                ← stage 3/4/6 output (chunks, enriched, embedded)
├── scripts/
│   ├── 01_parse.js
│   ├── 02_chunk.js
│   ├── 03_metadata.js
│   ├── 04_embed.js            ← local embeddings (Transformers.js, no API key)
│   ├── 05_index.js            ← requires DATABASE_URL
│   └── 06_query.js            ← Phase 2: ask a question from the CLI
├── src/rag/                   ← Phase 2 query library (one module per stage)
│   ├── pipeline.js            ← orchestrates the full workflow
│   ├── rewrite.js  embed.js  retrieve.js  rerank.js
│   ├── prompt.js   llm.js     guardrails.js
│   ├── db.js                  ← pooled Neon connection
│   └── config.js              ← env-driven, free/local defaults
├── server.js                 ← local API + chat UI (POST /ask, GET /health)
├── public/index.html         ← minimal chat front end
├── .env.example
└── sql/
    └── schema.sql
```

## Running it

```bash
npm install

# offline stages — no network/API keys needed
npm run offline    # parse → chunk (+overlap) → metadata

# embeddings — local model, no API key (first run downloads the model)
npm run embed      # optional: EMBED_MODEL=... to swap the model

# indexing — needs a Postgres (Neon) connection string
DATABASE_URL=postgres://... npm run index
```

Phase 2 (querying the loaded DB) is covered in
[The Assistant](#the-assistant-query-time--phase-2) above — `npm run query` for
the CLI or `npm run serve` for the local API + chat UI.

## Tools & services

| Layer | Tool/Service | Why |
|---|---|---|
| Runtime | Node.js | Matches existing portfolio stack |
| PDF text extraction | `poppler-utils` (`pdftotext`) | Fast, preserves page breaks & layout, no API cost |
| Chunking / metadata | Plain JS (no framework) | Small, auditable, no black-box chunking library |
| Embeddings | **Transformers.js** + `mxbai-embed-large-v1` (local, 1024-dim) | Free, no API key, reproducible offline; pluggable via `EMBED_MODEL` |
| Vector database | **Neon Postgres + pgvector** | Serverless Postgres with native vector search; one DB for metadata + vectors |
| DB indexing | HNSW (pgvector) | Better recall/speed for this KB size, incremental build |
| DB driver | `pg` (node-postgres) | Standard, well-supported Postgres client for Node |
| Hybrid search | pgvector cosine + Postgres full-text, fused with RRF | Combines semantic + keyword recall, no extra service |
| Reranking (Phase 2) | **Transformers.js** + `bge-reranker-base` (local cross-encoder) | Free, no API key; big precision gain over first-stage retrieval |
| LLM reasoning (Phase 2) | **Ollama** (local, default `llama3.2:3b`; `llama3.1:8b` for higher quality), provider-pluggable | Zero-cost, offline; swap to any OpenAI-compatible endpoint via env |
| Query API + UI (Phase 2) | Express + static chat page (`server.js`, `public/`) | Runs locally since the LLM is local; same Node stack as the rest |
