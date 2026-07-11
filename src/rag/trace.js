/**
 * Lightweight, dependency-free observability for the query pipeline.
 * Produces a per-request trace: a short id, per-stage latency, token counts,
 * an estimated cost, and any stage error. Surfaced in the API response `meta`,
 * logged as one JSON line server-side, and printed by the CLI.
 *
 * Deliberately no OpenTelemetry/vendor SDK — keeps Phase 3 free and portable.
 * The shape is OTel-friendly, so it can be exported later if desired.
 */
const { randomUUID } = require("crypto");

function newTrace(meta = {}) {
  return {
    traceId: randomUUID().slice(0, 8),
    provider: meta.provider,
    model: meta.model,
    stages: {}, // name -> ms
    tokens: { prompt: 0, completion: 0, total: 0 },
    error: null,
    _start: Date.now(),
  };
}

// Time an async stage, recording its duration even if it throws.
async function span(trace, name, fn) {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    trace.stages[name] = Date.now() - t0;
  }
}

function addTokens(trace, usage) {
  if (!usage) return;
  trace.tokens.prompt += usage.prompt || 0;
  trace.tokens.completion += usage.completion || 0;
  trace.tokens.total += usage.total || 0;
}

function finalize(trace, { costPer1kPrompt = 0, costPer1kCompletion = 0 } = {}) {
  trace.totalMs = Date.now() - trace._start;
  trace.costUsd = +(
    (trace.tokens.prompt / 1000) * costPer1kPrompt +
    (trace.tokens.completion / 1000) * costPer1kCompletion
  ).toFixed(6);
  delete trace._start;
  return trace;
}

module.exports = { newTrace, span, addTokens, finalize };
