---
title: Enterprise RAG Assistant API
emoji: 🎹
colorFrom: yellow
colorTo: gray
sdk: docker
app_port: 8080
pinned: false
---

# Enterprise RAG Assistant — backend API

Docker Space that runs the Express API (`server.js`) from
<https://github.com/shayeeboy/Enterprise-RAG-Assistant>.

The `Dockerfile` here clones that repo and starts the API, so this Space stays a
thin wrapper (single source of truth on GitHub). To rebuild against the latest
code, use the Space's **Factory rebuild**.

## Required secrets / variables (Settings → Variables and secrets)

| Key | Value | Kind |
|---|---|---|
| `DATABASE_URL` | your Neon connection string | secret |
| `LLM_PROVIDER` | `openai-compatible` | variable |
| `LLM_BASE_URL` | `https://api.groq.com/openai/v1` | variable |
| `LLM_API_KEY` | your Groq key | secret |
| `LLM_MODEL` | `llama-3.3-70b-versatile` | variable |
| `ALLOWED_ORIGINS` | `https://shayeeboy.github.io` | variable |
| `ACCESS_CODE` | *(optional)* a shared code to gate `/ask` | secret |

## Endpoints

- `GET /health` → `{ db, llm }` reachability
- `POST /ask` → `{ question }` returns the answer + citations + observability meta

Frontend: <https://shayeeboy.github.io/Enterprise-RAG-Assistant/?api=THIS_SPACE_URL>
