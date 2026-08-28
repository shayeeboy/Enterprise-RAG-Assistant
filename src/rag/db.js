/**
 * Shared Postgres (Neon) connection pool for the query side.
 * Mirrors the ingestion scripts' use of `pg`, but pooled for a long-lived
 * server process and with SSL negotiated for Neon.
 */
const { Pool } = require("pg");
const { DATABASE_URL } = require("./config");

// Neon requires TLS; local Postgres usually doesn't. Disable via PGSSL=disable.
const isLocal = DATABASE_URL && /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const needsSsl = DATABASE_URL && !isLocal && process.env.PGSSL !== "disable";

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: needsSsl ? { rejectUnauthorized: false } : false,
  max: 4,
});

// CRITICAL: Neon (serverless) drops idle pooled connections when its compute
// suspends. pg emits 'error' on the idle client; with NO listener attached,
// Node treats it as an uncaught exception and CRASHES the process — which on
// Cloud Run shows up as a 503 + restart loop the moment a dropped connection
// coincides with a request. Log and swallow: the pool transparently opens a
// fresh connection on the next query, so a dead idle client must never take
// down the server.
pool.on("error", (err) => {
  console.error("pg pool idle-client error (ignored; pool reconnects on next query):", err.message);
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (e) {
    // A connection Neon dropped while idle can surface on the first query after
    // wake. The pool has already discarded the dead client, so one retry gets a
    // fresh connection instead of failing the request.
    if (/Connection terminated|ECONNRESET|server closed the connection|termina/i.test(e.message || "")) {
      return pool.query(text, params);
    }
    throw e;
  }
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, close };
