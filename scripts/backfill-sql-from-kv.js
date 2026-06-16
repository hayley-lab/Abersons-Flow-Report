#!/usr/bin/env node
// Populate the SQL reporting tables from the already-verified KV snapshots.
//
// Run with `npx tsx scripts/backfill-sql-from-kv.js` so local Next-style
// extensionless imports work under Node.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getSql, hasSqlDatabase } from "../lib/db";
import { loadOverride } from "../lib/override-store";
import { loadScanData } from "../lib/scan-data-store";
import { ensureSqlSchema, upsertSqlReport } from "../lib/sql-report-store";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(file) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!match) continue;
    const key = match[1];
    let value = match[2];
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined || process.env[key] === "") process.env[key] = value;
  }
}

loadEnv(".env.local");

function argValue(name) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  return hit ? hit.slice(prefix.length) : null;
}

function generateSeasons() {
  const year = new Date().getFullYear();
  const out = [];
  for (let y = year + 1; y >= 2025; y--) {
    const yy = String(y).slice(-2);
    if (y <= 2026) out.push(`fall${yy}`, `spring${yy}`);
    else out.push(`fall${yy}`, `prefall${yy}`, `spring${yy}`, `prespring${yy}`);
  }
  return out;
}

const dryRun = process.argv.includes("--dry-run");
const seasonArg = argValue("season");
const seasons = seasonArg
  ? seasonArg
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  : generateSeasons();

if (!hasSqlDatabase()) {
  console.error("DATABASE_URL or POSTGRES_URL is required");
  process.exit(1);
}

async function main() {
  const { kv } = await import("@vercel/kv");
  const sql = getSql();
  await ensureSqlSchema(sql);

  for (const season of seasons) {
    const [rawData, override] = await Promise.all([
      loadScanData(kv, season),
      loadOverride(kv, season),
    ]);
    if (!rawData && !override) {
      process.stdout.write(`${season}: no KV data/override found; skipped\n`);
      continue;
    }
    const rowCount = Object.keys(rawData?.productStats || {}).length;
    const overrideCount = Object.keys(override?.vendors || {}).length;
    if (dryRun) {
      process.stdout.write(
        `${season}: would backfill productStats=${rowCount} overrideVendors=${overrideCount}\n`
      );
      continue;
    }
    const result = await upsertSqlReport(sql, season, rawData, override);
    process.stdout.write(`${season}: upserted rows=${result.rows || 0} ts=${result.ts || "n/a"}\n`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
