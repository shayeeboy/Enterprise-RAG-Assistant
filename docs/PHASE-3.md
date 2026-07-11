# Phase 3 — Hosting the assistant off localhost (free, no API cost)

Phase 1 (ingestion) and Phase 2 (query-time assistant) both run locally today.
Phase 3 is about making the assistant reachable from a URL instead of
`localhost`, **without introducing paid services**.

## The one hard part: the LLM

Everything except the LLM has an easy free home:

| Component | Free hosting | Notes |
|---|---|---|
| Frontend (`public/`) | GitHub Pages / Netlify / Vercel | static; already how `ai-native-diagnostic` is hosted |
| Database | **Neon** (already cloud) | no change needed |
| Backend API (`server.js`) | Render / Fly.io / Oracle free | loads embed + rerank models → **RAM matters** |
| **LLM reasoning** | the blocker | real compute; most free tiers can't run an 8B model locally |

The code is already provider-agnostic: `src/rag/llm.js` supports
`LLM_PROVIDER=openai-compatible` + `LLM_BASE_URL`, so the LLM can move to a
hosted endpoint **with no code change**.

## Three paths

### Path A — Fully self-hosted, zero third-party API
Run everything on an **Oracle Cloud Always Free** ARM VM (up to 4 vCPU / 24 GB
RAM, free forever): Ollama (`llama3.1:8b`) + the Express backend + Transformers.js
models on one box. Neon for the DB, GitHub Pages for the frontend, free TLS via
Cloudflare Tunnel or Caddy + a free domain.
- ✅ Truly free, no API, no rate limits, full control.
- ⚠️ Ops burden (VM, systemd/pm2, TLS, keeping Ollama up); Oracle signup needs a
  card for verification (no charge); ARM capacity can be intermittent.

### Path B — Managed free tiers + free-tier LLM API (least effort)
Backend on Fly.io/Render free; LLM via a **free-tier OpenAI-compatible endpoint**
— **Groq** (fast, generous free tier) or **Cloudflare Workers AI** — plugged into
the existing `openai-compatible` provider.
- ✅ Minimal ops, near-zero maintenance, no billing.
- ⚠️ "Free" = free-*tier* API (rate limits, may change); still an external API.
  Render free sleeps (cold starts).
- ⚠️ **RAM:** the backend loads mxbai-large (1024-dim) + bge-reranker in memory —
  likely OOMs on a 512 MB free dyno. Options: (a) a host with ≥1–2 GB, or
  (b) re-embed the KB with a smaller model (e.g. `bge-small-en-v1.5`, 384-dim),
  which means changing `sql/schema.sql` to `vector(384)` and re-running
  `npm run build`. Query and document vectors **must** use the same model.

### Path C — Browser-side LLM (WebGPU)
LLM runs in the visitor's browser via WebLLM/WebGPU; the backend only does
retrieval + rerank.
- ✅ LLM cost is literally $0 (runs on the visitor's device).
- ⚠️ Multi-GB model download per visitor; needs WebGPU. Neat flex, rough UX.

## Recommendation
- **Truly no API + always-on demo →** Path A (Oracle Always Free).
- **Least effort, OK with a free-tier API →** Path B with Groq (code already
  supports it), plus a smaller-model re-embed if the host is RAM-constrained.

## Shared prep (done — deploy-ready regardless of path)
Implemented in `server.js` and `public/index.html`, all env-driven:

- **CORS allowlist** — `ALLOWED_ORIGINS` (empty = allow all for local dev; set to
  the frontend origin in production).
- **Rate limiting** — per-IP fixed window, `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS`.
- **Optional access code** — `ACCESS_CODE` gates `/ask`; the frontend sends it via
  `window.RAG_ACCESS_CODE` → `x-access-code` header.
- **Configurable API base** — `window.RAG_API_BASE` lets the static frontend call a
  backend on a different origin (empty = same origin, i.e. `npm run serve`).
- **Proxy-aware IPs** — `trust proxy` so rate limiting works behind a host's proxy.

## Remaining per-path work (when a path is chosen)
- **Path A:** provision the VM; install Node + Ollama; pull the model; run the
  backend as a service; TLS via Cloudflare Tunnel; set `ALLOWED_ORIGINS`.
- **Path B:** set `LLM_PROVIDER=openai-compatible` + Groq/CF creds; deploy backend;
  if host RAM < ~1 GB, re-embed with a smaller model (schema + `npm run build`);
  set `ALLOWED_ORIGINS` and (recommended) `ACCESS_CODE`.
- **Both:** deploy the frontend to GitHub Pages with `window.RAG_API_BASE` pointing
  at the backend; add a keep-alive ping if the host sleeps.
