/**
 * Groq daily-token-cap (TPD) coordination between eval:judge and bench —
 * both scripts share one Groq key, so whichever hits the cap first records
 * here exactly when Groq said it would recover, and the other (or a later
 * retry of the same script) skips immediately until that moment instead of
 * burning retries on calls that will just 429. State is gitignored.
 *
 * Groq's TPD limit behaves as a rolling window, not a fixed daily reset —
 * its 429 body gives a short, specific "try again in Xm Ys" countdown that
 * can be far sooner than the next UTC midnight. We parse and honor that
 * countdown (falling back to a conservative default if it can't be parsed)
 * instead of blocking retries for the rest of the calendar day.
 */
const fs = require("fs");
const path = require("path");

const STATE_PATH = path.join(__dirname, "..", "..", "eval", ".groq-quota-state.json");

// Conservative fallback when the error message doesn't carry a parseable
// countdown — better to under-retry briefly than hammer a 429 in a loop.
const DEFAULT_RETRY_MS = 30 * 60 * 1000;

// Parses Groq's "Please try again in 24m32.255999999s." (any combination of
// h/m/s components) into milliseconds. Returns null if nothing matched.
function parseRetryAfterMs(msg) {
  const m = String(msg).match(/try again in\s+((?:\d+h)?(?:\d+m)?(?:[\d.]+s)?)/i);
  if (!m || !m[1]) return null;
  const dur = m[1];
  const h = /(\d+)h/.exec(dur);
  const min = /(\d+)m/.exec(dur);
  const s = /([\d.]+)s/.exec(dur);
  const ms = (h ? Number(h[1]) * 3600000 : 0) + (min ? Number(min[1]) * 60000 : 0) + (s ? Number(s[1]) * 1000 : 0);
  return ms > 0 ? ms : null;
}

// Returns the stored state while still within its retry window, else null
// (the window having passed is treated as "no longer exhausted" — self-reset).
function isExhausted() {
  let s;
  try {
    s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  } catch {
    return null;
  }
  if (!s.exhausted || !s.retryAt) return null;
  return Date.now() < new Date(s.retryAt).getTime() ? s : null;
}

function markExhausted(by, reason) {
  const reasonStr = String(reason);
  const retryMs = parseRetryAfterMs(reasonStr) || DEFAULT_RETRY_MS;
  const now = Date.now();
  fs.writeFileSync(STATE_PATH, JSON.stringify({
    exhausted: true,
    by,
    reason: reasonStr.slice(0, 200),
    at: new Date(now).toISOString(),
    retryAt: new Date(now + retryMs).toISOString(),
  }, null, 2));
}

// The daily cap (TPD) is distinct from the per-minute limit (TPM): only TPD
// is unrecoverable within the run, so only it should trip the shared marker.
const isDailyCapError = (msg) => /tokens per day|TPD/i.test(String(msg));

module.exports = { isExhausted, markExhausted, isDailyCapError, parseRetryAfterMs };
