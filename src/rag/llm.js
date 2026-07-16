/**
 * LLM reasoning (workflow step: LLM Reasoning).
 * Default provider is Ollama — a free, local, open-source model runner — so the
 * whole assistant runs with zero API billing. Any OpenAI-compatible endpoint
 * can be swapped in via LLM_PROVIDER=openai-compatible + LLM_BASE_URL, without
 * touching the rest of the pipeline.
 *
 * `chat(messages, opts)` accepts an optional per-call override so callers like
 * the Phase 4 LLM-Judge can use a different model / endpoint / temperature on
 * the same provider (e.g. cross-judging on a second free-tier model) without
 * affecting the production generation path, which calls `chat(messages)` plainly.
 */
const cfg = require("./config");

async function chatOllama(messages, o) {
  const res = await fetch(`${o.ollamaHost}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: o.model,
      messages,
      stream: false,
      options: { temperature: o.temperature },
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

async function chatOpenAICompatible(messages, o) {
  const base = o.baseUrl.replace(/\/$/, "");
  const res = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(o.apiKey ? { Authorization: `Bearer ${o.apiKey}` } : {}),
    },
    body: JSON.stringify({ model: o.model, messages, temperature: o.temperature }),
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

// Resolve effective call settings from config, applying any per-call overrides.
function resolve(opts = {}) {
  return {
    provider: (opts.provider || cfg.LLM_PROVIDER).toLowerCase(),
    model: opts.model || cfg.LLM_MODEL,
    temperature: opts.temperature != null ? opts.temperature : cfg.LLM_TEMPERATURE,
    ollamaHost: opts.ollamaHost || cfg.OLLAMA_HOST,
    baseUrl: opts.baseUrl || cfg.LLM_BASE_URL,
    apiKey: opts.apiKey || cfg.LLM_API_KEY,
  };
}

async function chat(messages, opts = {}) {
  const o = resolve(opts);
  switch (o.provider) {
    case "ollama":
      return chatOllama(messages, o);
    case "openai":
    case "openai-compatible":
      if (!o.baseUrl) throw new Error("LLM_BASE_URL is required for an openai-compatible provider.");
      return chatOpenAICompatible(messages, o);
    default:
      throw new Error(`Unknown LLM_PROVIDER: ${o.provider}`);
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
