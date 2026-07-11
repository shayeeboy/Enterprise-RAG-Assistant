/**
 * Search / tail the observability log of user attempts.
 *
 *   npm run logs                 # 30 most recent attempts
 *   npm run logs -- "hanon"      # attempts whose question matches "hanon"
 */
require("dotenv").config();
const { search } = require("../src/rag/logstore");
const { close } = require("../src/rag/db");

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }
  const term = process.argv.slice(2).join(" ").trim();
  const rows = await search(term, 30);
  if (!rows.length) {
    console.log(term ? `No attempts matching "${term}".` : "No attempts logged yet.");
  }
  rows.forEach((r) => {
    const when = new Date(r.created_at).toISOString().slice(0, 19).replace("T", " ");
    console.log(
      `${when} · ${r.trace_id || "-"} · ${r.grounded ? "grounded" : "ungrounded"} · ` +
        `${r.latency_total_ms ?? "?"}ms · ${r.tokens_total ?? 0}tok · ${r.model || ""}`
    );
    console.log(`   ${r.question}`);
  });
  await close();
})().catch(async (e) => {
  console.error(e);
  try { await close(); } catch {}
  process.exit(1);
});
