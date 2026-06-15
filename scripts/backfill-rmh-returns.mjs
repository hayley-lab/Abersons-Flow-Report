#!/usr/bin/env node
/*
 * One-off / periodic LOCAL backfill of RMH vendor returns into the durable
 * datatail override baseline.
 *
 * WHY: vendor returns done in the old RMH POS never made it into Lightspeed, so
 * the LS-based flow report shows those items as still in stock ("not showing out
 * of the new report" — Steve, Jun 2026). This pulls RMH vendor returns
 * (PurchaseOrder.POType = 3) per active season and writes them as override
 * records so flow-rollup surfaces them in the Returned column (see
 * lib/flow-rollup.js overrideReturnsByPid + the LS-wins guard).
 *
 * RUNS LOCALLY ON THE LAN ONLY. The RMH SQL Server (172.16.2.4) is a LAN host
 * that Vercel cannot reach, so this is NOT a production endpoint.
 *
 * REQUIREMENTS:
 *   - FreeTDS `tsql` on PATH (brew install freetds).
 *   - .env.rmh   with HOST, USER, PASS, DATABASE, PORT (read-only SQL access).
 *   - .env.local with KV_REST_API_URL + KV_REST_API_TOKEN (Vercel KV write).
 *
 * USAGE:
 *   node scripts/backfill-rmh-returns.mjs            # dry run (no writes)
 *   node scripts/backfill-rmh-returns.mjs --write    # persist override records
 *   node scripts/backfill-rmh-returns.mjs --seasons spring26,fall26 --write
 *
 * IDEMPOTENT: writes a stable key per (season, dept, supplier) and re-running
 * overwrites in place. flow-rollup takes MAX(qtyReturned) per pid, so this can
 * coexist with the datatailor hard pull without double-counting.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// --- tiny .env loader (avoids adding a dependency) -------------------------
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

// --- args ------------------------------------------------------------------
const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const seasonsArg = (() => {
  const i = argv.indexOf("--seasons");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()) : null;
})();
const ACTIVE_SEASONS = seasonsArg || ["spring25", "fall25", "spring26", "fall26"];

// Season classification for a SKU's post-slash segment. Mirrors
// lib/flow-math.js seasonSkuCodes for 2025/26 (no separate pre-seasons:
// rs/ps fold into spring, pf folds into fall).
function seasonForSku(sku) {
  const seg = (sku.includes("/") ? sku.split("/")[1] : "").toLowerCase();
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return "spring26";
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return "fall26";
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return "spring25";
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return "fall25";
  return null;
}

// --- RMH query via tsql ----------------------------------------------------
const TAB = String.fromCharCode(9);
const RMH_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  I.ItemLookupCode,
  ISNULL(CAST(I.SupplierID AS varchar(20)),''),
  ISNULL(S.SupplierName,''),
  ISNULL(CAST(I.DepartmentID AS varchar(20)),''),
  ISNULL(D.Name,''),
  ISNULL(CAST(I.Cost AS varchar(20)),'0'),
  ISNULL(CAST(I.Price AS varchar(20)),'0'),
  CAST(SUM(POE.QuantityOrdered) AS varchar(20)),
  ISNULL(REPLACE(REPLACE(I.Description, CHAR(9), ' '), CHAR(10), ' '),''))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
LEFT JOIN Supplier S ON S.ID = I.SupplierID
LEFT JOIN Department D ON D.ID = I.DepartmentID
WHERE PO.POType = 3 AND CHARINDEX('/', I.ItemLookupCode) > 0
GROUP BY I.ItemLookupCode, I.SupplierID, S.SupplierName, I.DepartmentID, D.Name, I.Cost, I.Price, I.Description;
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
    if (!line.includes(TAB)) continue; // skip locale/prompt/rows-affected noise
    const f = line.split(TAB);
    if (f.length < 9) continue;
    if (!f[0].includes("/")) continue; // data rows lead with the SKU
    const qty = parseInt(f[7], 10) || 0;
    if (qty <= 0) continue;
    rows.push({
      sku: f[0].trim(),
      supplierId: f[1].trim() || "0",
      supplierName: f[2].trim() || "Unknown",
      deptId: f[3].trim() || "0",
      deptName: f[4].trim() || "",
      cost: parseFloat(f[5]) || 0,
      price: parseFloat(f[6]) || 0,
      qtyReturned: qty,
      description: f[8].trim(),
    });
  }
  return rows;
}

// --- build override records per season -------------------------------------
function buildOverridesBySeason(rows) {
  const bySeason = {}; // season -> { vendorKey -> vendorRecord }
  for (const r of rows) {
    const season = seasonForSku(r.sku);
    if (!season || !ACTIVE_SEASONS.includes(season)) continue;
    if (!bySeason[season]) bySeason[season] = {};
    const key = `rmhret__${r.deptId}__${r.supplierId}`;
    if (!bySeason[season][key]) {
      bySeason[season][key] = {
        vendorId: r.supplierId,
        vendorName: r.supplierName,
        deptId: r.deptId,
        deptName: r.deptName,
        ordered: 0,
        received: 0,
        sold: 0,
        source: "rmh-returns-backfill",
        products: [],
      };
    }
    bySeason[season][key].products.push({
      style: r.sku,
      description: r.description,
      cost: r.cost,
      price: r.price,
      qtyOrdered: 0,
      qtyStock: 0,
      qtySold: 0,
      qtySale: 0,
      qtyReturned: r.qtyReturned,
    });
  }
  return bySeason;
}

function summarize(bySeason) {
  for (const season of ACTIVE_SEASONS) {
    const vendors = bySeason[season] || {};
    let units = 0;
    let cost = 0;
    let skus = 0;
    for (const v of Object.values(vendors)) {
      for (const p of v.products) {
        units += p.qtyReturned;
        cost += p.qtyReturned * p.cost;
        skus += 1;
      }
    }
    console.warn(
      `[${season}] vendors=${Object.keys(vendors).length} skus=${skus} units=${units} cost=$${cost.toFixed(2)}`
    );
  }
}

async function writeOverrides(bySeason) {
  const { kv } = await import("@vercel/kv");
  for (const season of ACTIVE_SEASONS) {
    const vendors = bySeason[season];
    if (!vendors || Object.keys(vendors).length === 0) continue;
    const indexRaw = await kv.get(`scan:override:${season}:vendorIndex`);
    const existing = indexRaw ? (typeof indexRaw === "string" ? JSON.parse(indexRaw) : indexRaw) : [];
    const keys = Object.keys(vendors);
    for (const key of keys) {
      // No TTL — permanent baseline (matches pages/api/import/save.js).
      await kv.set(`scan:override:${season}:v:${key}`, JSON.stringify(vendors[key]));
    }
    const merged = Array.from(new Set([...existing, ...keys]));
    await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(merged));
    console.warn(`[${season}] wrote ${keys.length} override vendor record(s)`);
  }
}

async function main() {
  const rows = queryRmh();
  console.warn(`RMH returns rows (POType=3, SKU'd): ${rows.length}`);
  const bySeason = buildOverridesBySeason(rows);
  summarize(bySeason);
  if (!WRITE) {
    console.warn("\nDRY RUN — no KV writes. Re-run with --write to persist.");
    return;
  }
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
    throw new Error("KV write env missing (need KV_REST_API_URL + KV_REST_API_TOKEN in .env.local)");
  }
  await writeOverrides(bySeason);
  console.warn("\nDone. Returns are written to the durable override baseline.");
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
