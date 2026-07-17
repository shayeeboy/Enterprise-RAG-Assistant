/**
 * Computes aggregated observability from `query_logs` and rewrites the section
 * of README.md between the <!-- STATS:START --> and <!-- STATS:END --> markers.
 * Run by `.github/workflows/stats.yml` on a schedule (and locally via npm run stats).
 */
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { getStats } = require("../src/rag/logstore");
const { close } = require("../src/rag/db");

const fmt = (n) => (n == null ? "—" : Number(n).toLocaleString("en-US"));

(async () => {
  const s = await getStats();
  const total = s.total || 0;
  const groundedPct = total ? Math.round((100 * s.grounded_count) / total) : 0;

  const block =
    total === 0
      ? "_No queries logged yet — be the first: **[try the live demo](#try-it-live)**, then this table auto-updates._"
      : [
          `_Auto-updated from **${fmt(total)}** logged queries` +
            (s.benchmark_count ? ` (${fmt(s.live_count)} live + ${fmt(s.benchmark_count)} automated benchmark)` : "") +
            (s.last_at ? ` · last refresh ${new Date(s.last_at).toISOString().slice(0, 10)}` : "") +
            "._",
          "",
          "| Metric | Value |",
          "|---|---|",
          `| Total queries | ${fmt(total)} |`,
          `| Grounded (cited) | ${groundedPct}% |`,
          `| Avg latency | ${fmt(s.avg_latency_ms)} ms |`,
          `| p50 / p95 latency | ${fmt(s.p50_latency_ms)} / ${fmt(s.p95_latency_ms)} ms |`,
          `| Avg stage split — rewrite · retrieve · rerank · llm | ${fmt(s.avg_rewrite_ms)} · ${fmt(s.avg_retrieve_ms)} · ${fmt(s.avg_rerank_ms)} · ${fmt(s.avg_llm_ms)} ms |`,
          `| Avg tokens / query | ${fmt(s.avg_tokens)} |`,
          `| Total tokens | ${fmt(s.total_tokens)} |`,
          `| Total LLM cost | $${s.total_cost_usd || 0} |`,
        ].join("\n");

  const readmePath = path.join(__dirname, "..", "README.md");
  let md = fs.readFileSync(readmePath, "utf8");
  const re = /<!-- STATS:START -->[\s\S]*?<!-- STATS:END -->/;
  if (!re.test(md)) {
    console.error("STATS markers not found in README.md");
    process.exit(1);
  }
  md = md.replace(re, `<!-- STATS:START -->\n${block}\n<!-- STATS:END -->`);
  fs.writeFileSync(readmePath, md);
  console.log(`README stats updated (${total} queries).`);
  await close();
})().catch(async (e) => {
  console.error(e);
  try { await close(); } catch {}
  process.exit(1);
});
