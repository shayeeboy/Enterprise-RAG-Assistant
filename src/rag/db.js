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

async function query(text, params) {
  return pool.query(text, params);
}

async function close() {
  await pool.end();
}

module.exports = { pool, query, close };
