/**
 * Same-day Groq daily-token-cap (TPD) coordination between eval:judge and
 * bench — both scripts share one Groq key, so whichever hits the daily cap
 * first records it here and the other skips immediately instead of burning
 * retries on calls that will just 429. State is gitignored and self-resets
 * because it's only honored when its `date` matches today.
 */
const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "..", "eval", ".groq-quota-state.json");
const today = () => new Date().toISOString().slice(0, 10);

function isExhaustedToday() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
  return s.date === today() && s.exhausted ? s : null;
}

function markExhausted(by, reason) {
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    date: today(),
    exhausted: true,
    by,
    reason: String(reason).slice(0, 200),
    at: new Date().toISOString(),
  }, null, 2));
}

// The daily cap (TPD) is distinct from the per-minute limit (TPM): only TPD
// is unrecoverable within the run, so only it should trip the shared marker.
const isDailyCapError = (msg) => /tokens per day|TPD/i.test(String(msg));

module.exports = { isExhaustedToday, markExhausted, isDailyCapError };
