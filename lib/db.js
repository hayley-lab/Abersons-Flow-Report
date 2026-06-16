import { neon } from "@neondatabase/serverless";

let sqlClient = null;

export function databaseUrl() {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || "";
}

export function hasSqlDatabase() {
  return !!databaseUrl();
}

export function getSql() {
  const url = databaseUrl();
  if (!url) return null;
  if (!sqlClient) {
    // Neon serverless uses HTTP/WebSocket rather than a per-Lambda direct TCP
    // connection, avoiding the usual Vercel/Postgres connection exhaustion risk.
    sqlClient = neon(url);
  }
  return sqlClient;
}

export function sqlReadsEnabled() {
  return process.env.REPORT_SQL_READ === "1" || process.env.REPORT_SQL_READ === "true";
}

export function sqlWritesEnabled() {
  return (
    process.env.REPORT_SQL_WRITE === "1" ||
    process.env.REPORT_SQL_WRITE === "true" ||
    sqlReadsEnabled()
  );
}
