# Hugging Face Space (Docker) — thin backend container.
# Pulls the app code from GitHub at build time so there's a single source of
# truth; only this Dockerfile + README.md live in the Space repo.
FROM node:20-slim

RUN apt-get update && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Build arg lets you pin a fork/branch; defaults to the main repo.
ARG REPO=https://github.com/shayeeboy/Enterprise-RAG-Assistant
RUN git clone --depth 1 "$REPO" .

RUN npm ci --omit=dev

# HF routes to app_port (set to 8080 in README frontmatter); server.js reads PORT.
ENV NODE_ENV=production PORT=8080
EXPOSE 8080

CMD ["node", "server.js"]
