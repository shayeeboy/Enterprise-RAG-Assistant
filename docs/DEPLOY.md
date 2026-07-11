# Deployment — free, off-localhost

Two pieces: a **static frontend** on GitHub Pages and a **backend API** on a
free container host. The LLM is Groq's free tier (Phase 3), so the backend only
runs the API plus the local embedding/rerank models.

```
Browser → GitHub Pages (frontend) → Backend host (Express) → Neon + local models + Groq
```

## 1. Frontend — GitHub Pages (automated)

`.github/workflows/pages.yml` publishes `public/` to Pages on every push to
`main`. Enable it once: **Settings → Pages → Build and deployment → Source:
GitHub Actions** (or it's set via the API during setup).

Live URL: `https://shayeeboy.github.io/Enterprise-RAG-Assistant/`

The page takes the backend URL as a query param, so nothing to rebuild when the
backend moves:

```
https://shayeeboy.github.io/Enterprise-RAG-Assistant/?api=https://YOUR-BACKEND
# with an access code:
https://shayeeboy.github.io/Enterprise-RAG-Assistant/?api=https://YOUR-BACKEND&code=YOURCODE
```

## 2. Backend — pick a free host

The backend loads the embedding + reranker models in memory (~1 GB peak), so
**RAM is the deciding factor**.

### Recommended: Hugging Face Spaces (Docker) — 16 GB RAM free

A thin Space that pulls the app from GitHub keeps one source of truth. The two
files to put in the Space are ready in [`deploy/huggingface/`](../deploy/huggingface/).

1. Create a **new Space** → SDK: **Docker** → **Blank** → CPU basic (free).
2. Add the two files from `deploy/huggingface/` to the Space repo:
   - `README.md` (has the required `sdk: docker` / `app_port: 8080` frontmatter)
   - `Dockerfile` (clones this GitHub repo and runs `server.js`)
3. **Settings → Variables and secrets** → add:
   - `DATABASE_URL` = your Neon string *(secret)*
   - `LLM_API_KEY` = your Groq key *(secret)*
   - `LLM_PROVIDER=openai-compatible`, `LLM_BASE_URL=https://api.groq.com/openai/v1`, `LLM_MODEL=llama-3.3-70b-versatile`
   - `ALLOWED_ORIGINS=https://shayeeboy.github.io`
   - *(optional)* `ACCESS_CODE=<something>` *(secret)*
4. The Space builds and serves at `https://<user>-<space>.hf.space`. Use that as
   the `?api=` value. Rebuild against latest code via **Factory rebuild**.

### Alternative: Render — simplest, but 512 MB free RAM is tight

Works the same way (Docker or Node), but the models may OOM on the 512 MB free
tier. Mitigate by re-embedding the KB with a smaller model (e.g.
`bge-small-en-v1.5`, 384-dim → change `sql/schema.sql` to `vector(384)` and
re-run `npm run build`), or use a paid instance. Env vars are identical to
above; set `ALLOWED_ORIGINS` and the Groq vars in the dashboard.

### Alternative: Oracle Cloud Always Free VM

A free ARM VM (up to 24 GB RAM) can run the backend (and even a local LLM via
Ollama, no API at all). More ops; see [`docs/PHASE-3.md`](PHASE-3.md) Path A.

## 3. Wire them together

1. Deploy the backend; note its URL.
2. Set `ALLOWED_ORIGINS=https://shayeeboy.github.io` on the backend (CORS).
3. Open `https://shayeeboy.github.io/Enterprise-RAG-Assistant/?api=<backend-url>`.
4. Health check: `GET <backend-url>/health` → `{ db: "connected", llm: "reachable" }`.

## Notes

- **Secrets** live only in the host's env/secret store — never in the repo.
  Rotate the Neon password and Groq key if they're ever exposed.
- **Cold starts**: free hosts may sleep; the first request wakes them.
- **Cost**: $0 across Pages + Neon free + Groq free + a free container host.
