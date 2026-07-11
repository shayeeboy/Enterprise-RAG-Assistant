# Backend container for the RAG assistant API (server.js).
# Works on any container host (Render, Fly.io, Hugging Face Spaces, a VM).
# The LLM is Groq (free tier) by env, so the container only runs the API +
# local embedding/rerank models — budget ~1 GB RAM for the models.
FROM node:20-slim

# poppler-utils is only needed for ingestion (pdftotext); omit for a leaner
# query-only image. Uncomment if you also run `npm run build` in the container.
# RUN apt-get update && apt-get install -y --no-install-recommends poppler-utils && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package*.json ./
RUN npm ci --omit=dev

# App source.
COPY . .

# Hosts inject PORT (HF Spaces uses 7860). server.js reads process.env.PORT.
ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "server.js"]
