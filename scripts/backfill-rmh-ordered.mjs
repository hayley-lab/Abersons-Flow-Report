#!/usr/bin/env node
/*
 * LOCAL correction of the spring25 (default) Ordered column from authoritative
 * RMH POType=0 (placed) purchase orders.
 *
 * WHY: the one-time datatailor scrape stored UNDERCOUNTED vendor-total `ordered`
 * dollars (e.g. spring25 $3.14M vs RMH truth $4.74M — a 34% gap). Every RMH SKU
 * is already present in the override (diagnostic: 0 missing), so the fix is NOT
 * to add records (that double-counts, since the rollup sums override records per
 * vendor) — it is to RECOMPUTE each existing vendor record's top-level `ordered`
 * from RMH's per-SKU placed-order dollars, SKU-anchored, each SKU counted once.
 *
 * Only the top-level `ordered` field changes. received / sold / returns / the
 * per-product arrays (and thus the cost/price fallback) are left untouched. The
 * rollup already reads the top-level `ordered` for a no-LS season, so NO code
 * change is required.
 *
 * SAFETY / REVERSIBILITY:
 *   - --write first dumps the FULL current override (vendorIndex + every v:*) to
 *     scripts/out/override-backup-<season>-<ts>.json (gitignored).
 *   - Each corrected record keeps its original value in `orderedScraped` (set
 *     once) so the change is self-documenting and idempotent (ordered is always
 *     recomputed from RMH, never from the already-corrected value).
 *   - --revert <backup.json> restores every record + the vendorIndex verbatim.
 *   - RMH SKUs not found in any ORIGINAL datatailor record (keys not starting
 *     with "rmh") are written as new rmhord__{dept}__{supplier} records so their
 *     ordered still counts (typically negligible; reported in the dry run).
 *
 * RUNS LOCALLY ON THE LAN ONLY (RMH 172.16.2.4 is unreachable from Vercel).
 * REQUIREMENTS: FreeTDS `tsql`; .env.rmh (HOST/USER/PASS/DATABASE/PORT);
 *   .env.local (KV_REST_API_URL + KV_REST_API_TOKEN).
 *
 * USAGE:
 *   node scripts/backfill-rmh-ordered.mjs                       # dry run (spring25)
 *   node scripts/backfill-rmh-ordered.mjs --write
 *   node scripts/backfill-rmh-ordered.mjs --seasons spring25 --write
 *   node scripts/backfill-rmh-ordered.mjs --seasons spring26 --crossover
 *   node scripts/backfill-rmh-ordered.mjs --seasons spring26 --crossover --write
 *   node scripts/backfill-rmh-ordered.mjs --revert scripts/out/override-backup-spring25-<ts>.json
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "scripts", "out");

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
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnv(".env.local");
loadEnv(".env");
loadEnv(".env.rmh");

const argv = process.argv.slice(2);
const WRITE = argv.includes("--write");
const CROSSOVER = argv.includes("--crossover");
const revertIdx = argv.indexOf("--revert");
const REVERT_FILE = revertIdx >= 0 ? argv[revertIdx + 1] : null;
const seasonsArg = (() => {
  const i = argv.indexOf("--seasons");
  return i >= 0 && argv[i + 1] ? argv[i + 1].split(",").map((s) => s.trim()) : null;
})();
const SEASONS = seasonsArg || ["spring25"];

const TAB = String.fromCharCode(9);

function seasonForSku(sku) {
  const seg = sku.includes("/") ? sku.split("/")[1].toLowerCase() : "";
  if (/^rs26/.test(seg) || /^ps26/.test(seg) || /^s26/.test(seg)) return "spring26";
  if (/^pf26/.test(seg) || /^f26/.test(seg)) return "fall26";
  if (/^rs25/.test(seg) || /^ps25/.test(seg) || /^s25/.test(seg)) return "spring25";
  if (/^pf25/.test(seg) || /^f25/.test(seg)) return "fall25";
  return null;
}

const RMH_SQL = `SET NOCOUNT ON;
SELECT CONCAT_WS(CHAR(9),
  I.ItemLookupCode,
  CAST(SUM(CASE WHEN PO.IsPlaced = 1 THEN POE.QuantityOrdered ELSE 0 END) AS varchar(20)),
  CAST(MAX(I.Price) AS varchar(20)),
  CAST(MAX(I.Cost) AS varchar(20)),
  ISNULL(CAST(I.SupplierID AS varchar(20)),''),
  ISNULL(REPLACE(S.SupplierName, CHAR(9), ' '),''),
  ISNULL(CAST(I.DepartmentID AS varchar(20)),''),
  ISNULL(REPLACE(D.Name, CHAR(9), ' '),''))
FROM PurchaseOrderEntry POE
JOIN PurchaseOrder PO ON PO.ID = POE.PurchaseOrderID
JOIN Item I ON I.ID = POE.ItemID
LEFT JOIN Supplier S ON S.ID = I.SupplierID
LEFT JOIN Department D ON D.ID = I.DepartmentID
WHERE PO.POType = 0 AND CHARINDEX('/', I.ItemLookupCode) > 0
GROUP BY I.ItemLookupCode, I.SupplierID, S.SupplierName, I.DepartmentID, D.Name;
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
    { input: RMH_SQL, encoding: "utf8", timeout: 120_000, maxBuffer: 256 * 1024 * 1024 }
  );
  const rows = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.includes(TAB)) continue;
    const f = line.split(TAB);
    if (f.length < 8) continue;
    if (!f[0].includes("/")) continue;
    const qtyPlaced = parseInt(f[1], 10) || 0;
    if (qtyPlaced <= 0) continue;
    rows.push({
      sku: f[0].trim().toLowerCase(),
      qtyPlaced,
      price: parseFloat(f[2]) || 0,
      cost: parseFloat(f[3]) || 0,
      supplierId: f[4].trim() || "0",
      supplierName: f[5].trim() || "Unknown",
      deptId: f[6].trim() || "0",
      deptName: f[7].trim() || "",
    });
  }
  return rows;
}

function money(n) {
  return "$" + Math.round(n).toLocaleString();
}

const parse = (v) => (v ? (typeof v === "string" ? JSON.parse(v) : v) : null);
const isBackfillKey = (k) => /^rmh(cost|ret|ord|sold)__/.test(k);

async function loadOverride(kv, season) {
  const index = parse(await kv.get(`scan:override:${season}:vendorIndex`)) || [];
  const records = {};
  for (const key of index) {
    records[key] = parse(await kv.get(`scan:override:${season}:v:${key}`));
  }
  return { index, records };
}

async function revert(file) {
  const { kv } = await import("@vercel/kv");
  const backup = JSON.parse(readFileSync(file, "utf8"));
  const { season, vendorIndex, records } = backup;
  for (const [key, rec] of Object.entries(records)) {
    await kv.set(`scan:override:${season}:v:${key}`, JSON.stringify(rec));
  }
  await kv.set(`scan:override:${season}:vendorIndex`, JSON.stringify(vendorIndex));
  console.warn(
    `Reverted ${season}: restored ${Object.keys(records).length} records + vendorIndex from ${file}`
  );
}

// Plan the correction for one season: recompute each ORIGINAL datatailor
// record's top-level `ordered` from RMH per-SKU placed dollars (each SKU counted
// once, assigned to the first original record that lists it). RMH SKUs not in
// any original record become new rmhord__ records.
function plan(season, rmhAll, override, { crossover = false } = {}) {
  const rmh = rmhAll.filter((r) => seasonForSku(r.sku) === season);
  const rmhBySku = new Map();
  for (const r of rmh) rmhBySku.set(r.sku, r); // one row per (sku,supplier); pick last

  const originalKeys = override.index.filter((k) => !isBackfillKey(k) && override.records[k]);

  // sku -> first original record key that lists it
  const skuToKey = new Map();
  for (const key of originalKeys) {
    for (const p of override.records[key].products || []) {
      const sku = String(p.style || "")
        .toLowerCase()
        .trim();
      if (sku && !skuToKey.has(sku)) skuToKey.set(sku, key);
    }
  }

  const newOrderedByKey = new Map(); // key -> recomputed top-level ordered $
  for (const key of originalKeys) newOrderedByKey.set(key, 0);
  const productUpdatesByKey = new Map(); // key -> sku -> RMH row (crossover mode)
  const residualBySupplier = new Map(); // rmhord key -> {meta, retail, products}
  let assignedRetail = 0;
  let residualRetail = 0;
  let productUpdates = 0;

  for (const r of rmh) {
    const retail = r.qtyPlaced * r.price;
    const key = skuToKey.get(r.sku);
    if (key) {
      newOrderedByKey.set(key, newOrderedByKey.get(key) + retail);
      if (crossover) {
        if (!productUpdatesByKey.has(key)) productUpdatesByKey.set(key, new Map());
        productUpdatesByKey.get(key).set(r.sku, r);
        productUpdates += 1;
      }
      assignedRetail += retail;
    } else {
      const rk = `rmhord__${r.deptId}__${r.supplierId}`;
      if (!residualBySupplier.has(rk)) {
        residualBySupplier.set(rk, {
          vendorId: r.supplierId,
          vendorName: r.supplierName,
          deptId: r.deptId,
          deptName: r.deptName,
          ordered: 0,
          received: 0,
          sold: 0,
          source: crossover ? "rmh-ordered-crossover-backfill" : "rmh-ordered-backfill",
          products: [],
        });
      }
      const rec = residualBySupplier.get(rk);
      rec.ordered += retail;
      rec.products.push({
        style: r.sku,
        description: "",
        cost: r.cost,
        price: r.price,
        orderedRetail: Math.round(retail * 100) / 100,
        qtyOrdered: r.qtyPlaced,
        qtyStock: 0,
        qtySold: 0,
        qtySale: 0,
        qtyReturned: 0,
      });
      residualRetail += retail;
    }
  }

  const beforeTotal = originalKeys.reduce(
    (s, k) => s + (Number(override.records[k].ordered) || 0),
    0
  );
  const afterTotal = assignedRetail + residualRetail;

  return {
    season,
    originalKeys,
    newOrderedByKey,
    productUpdatesByKey,
    productUpdates,
    crossover,
    residualBySupplier,
    assignedRetail,
    residualRetail,
    beforeTotal,
    afterTotal,
    rmhTotal: rmh.reduce((s, r) => s + r.qtyPlaced * r.price, 0),
  };
}

function summarize(p, override) {
  console.warn(`================ ${p.season} ================`);
  if (p.crossover) console.warn(`Mode: crossover (top-level ordered + per-product RMH ordered)`);
  console.warn(`Original datatailor records:        ${p.originalKeys.length}`);
  console.warn(`Before — override ordered total:    ${money(p.beforeTotal)}`);
  console.warn(`After  — RMH-authoritative total:   ${money(p.afterTotal)}`);
  console.warn(`  ...assigned to existing vendors:  ${money(p.assignedRetail)}`);
  console.warn(
    `  ...residual (new rmhord records): ${money(p.residualRetail)} (${p.residualBySupplier.size} records)`
  );
  if (p.crossover) {
    console.warn(`  ...per-product RMH refreshes:     ${p.productUpdates}`);
  }
  console.warn(`RMH placed truth (sanity check):    ${money(p.rmhTotal)}`);
  // Top 12 biggest per-vendor changes.
  const deltas = p.originalKeys
    .map((k) => ({
      k,
      name: override.records[k].vendorName || k,
      before: Number(override.records[k].ordered) || 0,
      after: p.newOrderedByKey.get(k) || 0,
    }))
    .map((d) => ({ ...d, delta: d.after - d.before }))
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
    .slice(0, 12);
  console.warn(`\nLargest per-vendor changes:`);
  for (const d of deltas) {
    console.warn(
      `  ${d.name.slice(0, 34).padEnd(34)} ${money(d.before).padStart(12)} -> ${money(d.after).padStart(12)}  (${d.delta >= 0 ? "+" : ""}${money(d.delta)})`
    );
  }
  console.warn("");
}

async function applyPlan(kv, p, override) {
  mkdirSync(OUT_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = path.join(OUT_DIR, `override-backup-${p.season}-${stamp}.json`);
  writeFileSync(
    backupPath,
    JSON.stringify(
      { season: p.season, vendorIndex: override.index, records: override.records },
      null,
      2
    )
  );
  console.warn(`[${p.season}] backup written: ${backupPath}`);

  // Correct each original record's top-level ordered (preserve original once).
  for (const key of p.originalKeys) {
    const rec = override.records[key];
    if (rec.orderedScraped === undefined) rec.orderedScraped = Number(rec.ordered) || 0;
    rec.ordered = Math.round((p.newOrderedByKey.get(key) || 0) * 100) / 100;
    if (p.crossover) {
      const updates = p.productUpdatesByKey.get(key);
      if (updates) {
        for (const product of rec.products || []) {
          const sku = String(product.style || "")
            .toLowerCase()
            .trim();
          const rmh = updates.get(sku);
          if (!rmh) continue;
          const retail = rmh.qtyPlaced * rmh.price;
          if (product.qtyOrderedScraped === undefined) {
            product.qtyOrderedScraped = Number(product.qtyOrdered) || 0;
          }
          if (product.orderedRetailScraped === undefined) {
            product.orderedRetailScraped =
              Number(
                product.orderedRetail ??
                  product.orderedValue ??
                  product.orderedAmount ??
                  product.ordered ??
                  product.orderValue
              ) || 0;
          }
          product.qtyOrdered = rmh.qtyPlaced;
          product.price = rmh.price;
          product.orderedRetail = Math.round(retail * 100) / 100;
        }
      }
    }
    await kv.set(`scan:override:${p.season}:v:${key}`, JSON.stringify(rec));
  }

  // Write residual rmhord records + extend the vendorIndex.
  const newKeys = [];
  for (const [rk, rec] of p.residualBySupplier) {
    await kv.set(`scan:override:${p.season}:v:${rk}`, JSON.stringify(rec));
    newKeys.push(rk);
  }
  if (newKeys.length) {
    const merged = Array.from(new Set([...override.index, ...newKeys]));
    await kv.set(`scan:override:${p.season}:vendorIndex`, JSON.stringify(merged));
  }
  console.warn(
    `[${p.season}] corrected ${p.originalKeys.length} records, wrote ${newKeys.length} residual record(s).`
  );
}

async function main() {
  if (REVERT_FILE) {
    await revert(REVERT_FILE);
    return;
  }

  const rmhAll = queryRmh();
  console.warn(`RMH POType=0 placed SKU rows (all seasons): ${rmhAll.length}\n`);

  const { kv } = await import("@vercel/kv");
  for (const season of SEASONS) {
    const override = await loadOverride(kv, season);
    const p = plan(season, rmhAll, override, { crossover: CROSSOVER });
    summarize(p, override);
    if (WRITE) {
      if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
        throw new Error("KV write env missing (need KV_REST_API_URL + KV_REST_API_TOKEN)");
      }
      await applyPlan(kv, p, override);
    }
  }

  if (!WRITE) {
    console.warn("DRY RUN — no KV writes. Re-run with --write to apply (a backup is taken first).");
  } else {
    console.warn(
      "\nDone. Ordered now reflects RMH placed-PO truth for the requested season(s). Re-run a scan or wait for the nightly to refresh derived caches; the request-time rollup reads the override immediately."
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
