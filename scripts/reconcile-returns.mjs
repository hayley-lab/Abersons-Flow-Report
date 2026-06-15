#!/usr/bin/env node
/*
 * Three-way vendor-returns reconciliation: RMH (truth) vs Lightspeed vs the
 * report's stored override (Vercel KV).
 *
 * WHY: after backfilling RMH vendor returns into the durable override
 * (scripts/backfill-rmh-returns.mjs), we need to prove the report now reflects
 * them AND quantify what is intentionally excluded (RMH returns whose SKU does
 * not fold into an active season). This is the "is everything showing?" check.
 *
 * Sources (all read-only):
 *   - RMH:    PurchaseOrder.POType = 3 grouped by SKU (qty, cost, retail) via tsql.
 *   - LS:     2.0/consignments?type=SUPPLIER_RETURN count via the API.
 *   - Report: scan:override:{season}:v:rmhret__* records in KV (what the
 *             request-time rollup reads). LS has no vendor returns, so the
 *             report's Returned column for these seasons is sourced entirely
 *             from this override.
 *
 * RUNS LOCALLY ON THE LAN ONLY (RMH 172.16.2.4 is not reachable from Vercel).
 *
 * REQUIREMENTS:
 *   - FreeTDS `tsql` on PATH.
 *   - .env.rmh   with HOST, USER, PASS, DATABASE, PORT.
 *   - .env.local with LS_DOMAIN_PREFIX + LS_ACCESS_TOKEN (LS) and
 *                     KV_REST_API_URL + KV_REST_API_TOKEN (report KV).
 *
 * USAGE:
 *   node scripts/reconcile-returns.mjs
 *   node scripts/reconcile-returns.mjs --seasons spring26
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function loadEnv(file) {
  let text;
  try {
    text = readFileSync(path.join(ROOT, file), "utf8");
  } catch {
    return;
  }
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env.local");
loadEnv(".env");
loadEnv(".env.rmh");

const argv = process.argv.slice(2);
const seasonsArg = (() => {
  const i = argv.indexOf("--seasons");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()) : null;
})();
const ACTIVE_SEASONS = seasonsArg || ["spring25", "fall25", "spring26", "fall26"];

// Mirrors lib/flow-math.js seasonSkuCodes for 2025/26 (rs/ps fold into spring,
// pf folds into fall; no separate pre-seasons). Returns the season or a
// "dropped" reason describing why a return is not in any active season.
function classify(sku) {
  if (!sku.includes("/")) return { dropped: "no-slash" };
  const seg = sku.split("/")[1].toLowerCase();
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return { season: "spring26" };
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return { season: "fall26" };
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return { season: "spring25" };
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return { season: "fall25" };
  const code = (seg.match(/^(rs|ps|pf|s|f)?\d{2}/) || [seg.slice(0, 4)])[0] || seg.slice(0, 4);
  return { dropped: `other-season:${code}` };
}

const TAB = String.fromCharCode(9);
const RMH_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  I.ItemLookupCode,
  CAST(SUM(POE.QuantityOrdered) AS varchar(20)),
  CAST(SUM(POE.QuantityOrdered * I.Cost) AS varchar(20)),
  CAST(SUM(POE.QuantityOrdered * I.Price) AS varchar(20)))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
WHERE PO.POType = 3 AND POE.QuantityOrdered > 0
GROUP BY I.ItemLookupCode;
go
quit
`;

function queryRmh() {
  const { HOST, USER, PASS, DATABASE, PORT } = process.env;
  if (!HOST || !USER || !PASS || !DATABASE) {
    throw new Error("RMH connection env missing (need HOST, USER, PASS, DATABASE in .env.rmh)");
  }
  const out = execFileSync(
    "tsql",
    ["-H", HOST, "-p", PORT || "1433", "-U", USER, "-P", PASS, "-D", DATABASE],
    { input: RMH_SQL, encoding: "utf8", timeout: 60_000, maxBuffer: 64 * 1024 * 1024 }
  );
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 4) continue;
    if (!f[0].includes("/") && !/[a-z]/i.test(f[0])) continue;
    const qty = parseInt(f[1], 10) || 0;
    if (qty <= 0) continue;
    rows.push({
      sku: f[0].trim().toLowerCase(),
      qty,
      cost: parseFloat(f[2]) || 0,
      retail: parseFloat(f[3]) || 0,
    });
  }
  return rows;
}

function zero() {
  return { units: 0, cost: 0, retail: 0, skus: 0 };
}
function add(acc, r) {
  acc.units += r.qty;
  acc.cost += r.cost;
  acc.retail += r.retail;
  acc.skus += 1;
}

async function lsReturnCount() {
  const base = `https://${process.env.LS_DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0/consignments`;
  const tok = process.env.LS_ACCESS_TOKEN;
  if (!process.env.LS_DOMAIN_PREFIX || !tok) return null;
  let after = 0;
  let total = 0;
  let guard = 0;
  while (guard++ < 200) {
    const res = await fetch(`${base}?type=SUPPLIER_RETURN&page_size=300&after=${after}`, {
      headers: { Authorization: `Bearer ${tok}` },
    });
    if (!res.ok) throw new Error(`LS consignments HTTP ${res.status}`);
    const d = await res.json();
    const data = d.data || [];
    if (!data.length) break;
    total += data.length;
    const nxt = d.version && d.version.max;
    if (nxt == null || nxt === after) break;
    after = nxt;
  }
  return total;
}

async function overrideStored(season) {
  const { kv } = await import("@vercel/kv");
  const idxRaw = await kv.get(`scan:override:${season}:vendorIndex`);
  const idx = idxRaw ? (typeof idxRaw === "string" ? JSON.parse(idxRaw) : idxRaw) : [];
  const keys = (Array.isArray(idx) ? idx : []).filter((k) => String(k).startsWith("rmhret__"));
  const acc = zero();
  for (const key of keys) {
    const recRaw = await kv.get(`scan:override:${season}:v:${key}`);
    const rec = recRaw ? (typeof recRaw === "string" ? JSON.parse(recRaw) : recRaw) : null;
    for (const p of (rec && rec.products) || []) {
      const q = Number(p.qtyReturned) || 0;
      if (q <= 0) continue;
      acc.units += q;
      acc.cost += q * (Number(p.cost) || 0);
      acc.retail += q * (Number(p.price) || 0);
      acc.skus += 1;
    }
  }
  return acc;
}

function fmt(a) {
  return `${String(a.units).padStart(6)}u  $${a.cost.toFixed(0).padStart(9)} cost  $${a.retail
    .toFixed(0)
    .padStart(10)} retail  (${a.skus} skus)`;
}

async function main() {
  const rmhRows = queryRmh();
  const rmhBySeason = {};
  const dropped = {};
  for (const s of ACTIVE_SEASONS) rmhBySeason[s] = zero();
  for (const r of rmhRows) {
    const c = classify(r.sku);
    if (c.season && ACTIVE_SEASONS.includes(c.season)) {
      add(rmhBySeason[c.season], r);
    } else {
      const reason = c.dropped || `inactive:${c.season}`;
      if (!dropped[reason]) dropped[reason] = zero();
      add(dropped[reason], r);
    }
  }

  const lsReturns = await lsReturnCount();

  console.warn("\n=== Vendor-returns reconciliation: RMH vs LS vs report (KV) ===\n");
  console.warn(`LS SUPPLIER_RETURN consignments: ${lsReturns}` + (lsReturns === 0 ? "  (returns are RMH-only — no LS collision)" : "  (LS now has returns — check the LS-wins guard)"));
  console.warn("");

  let okAll = true;
  for (const season of ACTIVE_SEASONS) {
    const rmh = rmhBySeason[season];
    const stored = await overrideStored(season);
    const unitDelta = rmh.units - stored.units;
    const ok = unitDelta === 0;
    okAll = okAll && ok;
    console.warn(`[${season}]`);
    console.warn(`  RMH POType=3 (this season): ${fmt(rmh)}`);
    console.warn(`  Report override stored:     ${fmt(stored)}`);
    console.warn(`  unit delta (RMH - stored):  ${unitDelta}  ${ok ? "OK" : "<-- MISMATCH"}`);
    console.warn("");
  }

  const droppedTotal = zero();
  const droppedSorted = Object.entries(dropped).sort((x, y) => y[1].units - x[1].units);
  for (const [, a] of droppedSorted) {
    droppedTotal.units += a.units;
    droppedTotal.cost += a.cost;
    droppedTotal.retail += a.retail;
    droppedTotal.skus += a.skus;
  }
  console.warn("=== RMH returns NOT in any active season (excluded by design) ===");
  console.warn("    (seasons before the app's 2025-2027 coverage window, or non-season SKUs)");
  const TOP = 15;
  const rest = zero();
  droppedSorted.forEach(([reason, a], i) => {
    if (i < TOP) {
      console.warn(`  ${reason.padEnd(22)} ${fmt(a)}`);
    } else {
      rest.units += a.units;
      rest.cost += a.cost;
      rest.retail += a.retail;
      rest.skus += a.skus;
    }
  });
  if (droppedSorted.length > TOP) {
    console.warn(`  ${`(+${droppedSorted.length - TOP} more codes)`.padEnd(22)} ${fmt(rest)}`);
  }
  console.warn(`  ${"TOTAL excluded".padEnd(22)} ${fmt(droppedTotal)}`);
  console.warn("");
  console.warn(
    okAll
      ? "RESULT: report override matches RMH for every active season."
      : "RESULT: at least one season MISMATCHES — re-run the backfill (--write) for it."
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
