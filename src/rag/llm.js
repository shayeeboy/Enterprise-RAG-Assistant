/**
 * LLM reasoning (workflow step: LLM Reasoning).
 * Default provider is Ollama — a free, local, open-source model runner — so the
 * whole assistant runs with zero API billing. Any OpenAI-compatible endpoint
 * can be swapped in via LLM_PROVIDER=openai-compatible + LLM_BASE_URL, without
 * touching the rest of the pipeline.
 */
const cfg = require("./config");

async function chatOllama(messages) {
  const res = await fetch(`${cfg.OLLAMA_HOST}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.LLM_MODEL,
      messages,
      stream: false,
      options: { temperature: cfg.LLM_TEMPERATURE },
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama error ${res.status}: ${body || res.statusText}`);
  }
  const data = await res.json();
  const prompt = data.prompt_eval_count || 0;
  const completion = data.eval_count || 0;
  return {
    content: (data.message?.content || "").trim(),
    usage: { prompt, completion, total: prompt + completion },
  };
}

async function chatOpenAICompatible(messages) {
  const base = cfg.LLM_BASE_URL.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cfg.LLM_API_KEY ? { Authorization: `Bearer ${cfg.LLM_API_KEY}` } : {}),
    },
    body: JSON.stringify({ model: cfg.LLM_MODEL, messages, temperature: cfg.LLM_TEMPERATURE }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`LLM error ${res.status}: ${body || res.statusText}`);
  }
  const data = await res.json();
  const u = data.usage || {};
  const prompt = u.prompt_tokens || 0;
  const completion = u.completion_tokens || 0;
  return {
    content: (data.choices?.[0]?.message?.content || "").trim(),
    usage: { prompt, completion, total: u.total_tokens || prompt + completion },
  };
}

async function chat(messages) {
  switch (cfg.LLM_PROVIDER) {
    case "ollama":
      return chatOllama(messages);
    case "openai":
    case "openai-compatible":
      if (!cfg.LLM_BASE_URL) throw new Error("LLM_BASE_URL is required for an openai-compatible provider.");
      return chatOpenAICompatible(messages);
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${cfg.LLM_PROVIDER}`);
  }
}

// Lightweight availability check for /health and friendly CLI errors.
async function ping() {
  try {
    if (cfg.LLM_PROVIDER === "ollama") {
      const r = await fetch(`${cfg.OLLAMA_HOST}/api/tags`);
      return r.ok;
    }
    return Boolean(cfg.LLM_BASE_URL);
  } catch {
    return false;
  }
}

module.exports = { chat, ping };
