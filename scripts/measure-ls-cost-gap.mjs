#!/usr/bin/env node
/*
 * READ-ONLY measurement of the LS supply_price gap that RMH can fill.
 *
 * WHY: before injecting authoritative RMH costs into Lightspeed
 * (supply_price), we need to know exactly how many products are actually
 * missing a cost in LS, and how many of those we can fill from RMH. This
 * right-sizes the injection and proves we never overwrite a real LS cost.
 *
 * Sources (both read-only):
 *   - LS:  2.0/products paged — sku -> { id, supply_price, name, active }.
 *   - RMH: PurchaseOrder.POType = 0 (real purchases) grouped by SKU with a
 *          positive Item.Cost via tsql. This is the SAME gate the LS
 *          injection will use (a genuine purchase, never consignment).
 *
 * The "fillable" set = LS products whose supply_price is 0/empty AND a season
 * SKU (active season) AND we have a positive RMH POType=0 cost. That is the
 * exact set the injection will touch (fill-only, consignment-gated).
 *
 * RUNS LOCALLY ON THE LAN ONLY (RMH 172.16.2.4 is unreachable from Vercel).
 *
 * REQUIREMENTS:
 *   - FreeTDS `tsql` on PATH.
 *   - .env.rmh   with HOST, USER, PASS, DATABASE, PORT.
 *   - .env.local with LS_DOMAIN_PREFIX + LS_ACCESS_TOKEN.
 *
 * USAGE:
 *   node scripts/measure-ls-cost-gap.mjs
 *   node scripts/measure-ls-cost-gap.mjs --seasons spring26
 *   node scripts/measure-ls-cost-gap.mjs --samples 20
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
const SAMPLES = (() => {
  const i = argv.indexOf("--samples");
  return i >= 0 && argv[i + 1] ? parseInt(argv[i + 1], 10) || 10 : 10;
})();
const ACTIVE_SEASONS = seasonsArg || ["spring25", "fall25", "spring26", "fall26"];

function seasonForSku(sku) {
  if (!sku || !sku.includes("/")) return null;
  const seg = sku.split("/")[1].toLowerCase();
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return "spring26";
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return "fall26";
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return "spring25";
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return "fall25";
  return null;
}

function isZeroCost(v) {
  const n = Number(v);
  return !Number.isFinite(n) || n <= 0;
}

const TAB = String.fromCharCode(9);
// Authoritative RMH cost for SKUs with a real POType=0 order and cost > 0.
const RMH_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  I.ItemLookupCode,
  CAST(MAX(I.Cost) AS varchar(20)),
  CAST(MAX(I.Price) AS varchar(20)))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
WHERE PO.POType = 0 AND CHARINDEX('/', I.ItemLookupCode) > 0 AND I.Cost > 0
GROUP BY I.ItemLookupCode;
go
quit
`;

function queryRmhCosts() {
  const { HOST, USER, PASS, DATABASE, PORT } = process.env;
  if (!HOST || !USER || !PASS || !DATABASE) {
    throw new Error("RMH connection env missing (need HOST, USER, PASS, DATABASE in .env.rmh)");
  }
  const out = execFileSync(
    "tsql",
    ["-H", HOST, "-p", PORT || "1433", "-U", USER, "-P", PASS, "-D", DATABASE],
    { input: RMH_SQL, encoding: "utf8", timeout: 120_000, maxBuffer: 128 * 1024 * 1024 }
  );
  const bySku = new Map();
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 3) continue;
    if (!f[0].includes("/")) continue;
    const cost = parseFloat(f[1]) || 0;
    if (cost <= 0) continue;
    bySku.set(f[0].trim().toLowerCase(), { cost, price: parseFloat(f[2]) || 0 });
  }
  return bySku;
}

async function fetchAllLsProducts() {
  const base = `https://${process.env.LS_DOMAIN_PREFIX}.retail.lightspeed.app/api/2.0/products`;
  const tok = process.env.LS_ACCESS_TOKEN;
  if (!process.env.LS_DOMAIN_PREFIX || !tok) {
    throw new Error("LS env missing (need LS_DOMAIN_PREFIX + LS_ACCESS_TOKEN in .env.local)");
  }
  const products = [];
  let after = 0;
  let guard = 0;
  process.stderr.write("Fetching LS products");
  while (guard++ < 2000) {
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetch(`${base}?page_size=300&after=${after}`, {
        headers: { Authorization: `Bearer ${tok}` },
      });
      if (res.status !== 429 && res.status !== 503) break;
      if (attempt >= 4) break;
      await new Promise((r) => setTimeout(r, 2000 * 2 ** attempt));
    }
    if (!res.ok) throw new Error(`LS products HTTP ${res.status}`);
    const d = await res.json();
    const data = d.data || [];
    if (!data.length) break;
    for (const p of data) {
      products.push({
        id: p.id,
        sku: (p.sku || "").trim().toLowerCase(),
        supply_price: p.supply_price,
        name: p.name || p.variant_name || "",
        active: p.active !== false && p.is_active !== false,
      });
    }
    process.stderr.write(".");
    const nxt = d.version && d.version.max;
    if (nxt == null || nxt === after) break;
    after = nxt;
  }
  process.stderr.write(` ${products.length} products\n`);
  return products;
}

function blank() {
  return { skus: 0, costSum: 0, samples: [] };
}

async function main() {
  const rmhCosts = queryRmhCosts();
  console.warn(`RMH POType=0 SKUs with cost>0: ${rmhCosts.size}`);
  const products = await fetchAllLsProducts();

  const stats = {
    seasonProducts: 0,
    hasCost: 0,
    zeroCostNoRmh: 0,
  };
  const fillable = {};
  for (const s of ACTIVE_SEASONS) fillable[s] = blank();

  for (const p of products) {
    const season = seasonForSku(p.sku);
    if (!season || !ACTIVE_SEASONS.includes(season)) continue;
    stats.seasonProducts += 1;
    if (!isZeroCost(p.supply_price)) {
      stats.hasCost += 1;
      continue;
    }
    const rmh = rmhCosts.get(p.sku);
    if (!rmh) {
      stats.zeroCostNoRmh += 1;
      continue;
    }
    const bucket = fillable[season];
    bucket.skus += 1;
    bucket.costSum += rmh.cost;
    if (bucket.samples.length < SAMPLES) {
      bucket.samples.push({ sku: p.sku, id: p.id, rmhCost: rmh.cost, name: p.name.slice(0, 32) });
    }
  }

  console.warn("\n=== LS supply_price gap (active seasons) ===\n");
  console.warn(`Active-season LS products:            ${stats.seasonProducts}`);
  console.warn(`  already have LS cost (untouched):   ${stats.hasCost}`);
  console.warn(`  $0 cost, NO RMH cost (can't fill):  ${stats.zeroCostNoRmh}`);
  let fillTotal = 0;
  let costTotal = 0;
  for (const s of ACTIVE_SEASONS) fillTotal += fillable[s].skus;
  for (const s of ACTIVE_SEASONS) costTotal += fillable[s].costSum;
  console.warn(`  $0 cost, FILLABLE from RMH:         ${fillTotal}  (avg RMH cost $${(fillTotal ? costTotal / fillTotal : 0).toFixed(0)})`);

  console.warn("\n=== Fillable set per season (the exact injection target) ===");
  for (const season of ACTIVE_SEASONS) {
    const b = fillable[season];
    console.warn(
      `\n[${season}] fillable=${b.skus}  avg_rmh_cost=$${(b.skus ? b.costSum / b.skus : 0).toFixed(0)}`
    );
    for (const s of b.samples) {
      console.warn(`    ${s.sku.padEnd(24)} $${String(s.rmhCost).padStart(7)}  ${s.id}  ${s.name}`);
    }
  }
  console.warn(
    "\nNOTE: fill-only — every product above currently has supply_price=0 in LS, so" +
      "\nwriting the RMH cost never overwrites a real LS cost. Consignment goods have" +
      "\nno POType=0 RMH order and are therefore absent from this set."
  );
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
