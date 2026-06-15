#!/usr/bin/env node
/* Diagnostic: where do a season's vendor-return units come from? Buckets the
 * override records by source (rmhret__ backfill vs original datatailor import)
 * and reports LS SUPPLIER_RETURN presence, to explain a report-vs-RMH returns gap. */
import { readFileSync } from "node:fs";
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
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
      v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(".env.local");

const seasons = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const SEASONS = seasons.length ? seasons : ["spring26", "fall26"];

function parse(v) {
  if (!v) return null;
  return typeof v === "string" ? JSON.parse(v) : v;
}

async function main() {
  const { kv } = await import("@vercel/kv");
  for (const season of SEASONS) {
    const idx = parse(await kv.get(`scan:override:${season}:vendorIndex`)) || [];
    const buckets = {};
    let totalUnits = 0;
    const raws = await Promise.all(
      idx.map((k) => kv.get(`scan:override:${season}:v:${k}`))
    );
    idx.forEach((key, i) => {
      const rec = parse(raws[i]);
      let u = 0;
      for (const p of (rec && rec.products) || []) u += Number(p.qtyReturned) || 0;
      if (u <= 0) return;
      const src = key.startsWith("rmhret__")
        ? "rmhret__ (RMH backfill)"
        : key.startsWith("rmhcost__")
          ? "rmhcost__ (cost-only — should be 0!)"
          : `datatailor import (${(rec && rec.source) || "?"})`;
      buckets[src] = (buckets[src] || 0) + u;
      totalUnits += u;
    });
    console.warn(`\n[${season}] override return units by source (raw, pre-dedup):`);
    for (const [src, u] of Object.entries(buckets).sort((a, b) => b[1] - a[1])) {
      console.warn(`  ${String(u).padStart(6)}u  ${src}`);
    }
    console.warn(`  ${String(totalUnits).padStart(6)}u  TOTAL override return units (raw sum)`);

    // Authoritative dedup: MAX qtyReturned per SKU across ALL override records.
    const bySku = {};
    idx.forEach((key, i) => {
      const rec = parse(raws[i]);
      for (const p of (rec && rec.products) || []) {
        const q = Number(p.qtyReturned) || 0;
        if (q <= 0) continue;
        const sku = (p.style || "").trim().toLowerCase();
        if (!sku) continue;
        bySku[sku] = Math.max(bySku[sku] || 0, q);
      }
    });
    const dedupUnits = Object.values(bySku).reduce((a, b) => a + b, 0);
    console.warn(
      `  ${String(dedupUnits).padStart(6)}u  per-SKU MAX dedup (${Object.keys(bySku).length} skus) <- target report value`
    );
  }
}
main().catch((e) => {
  console.error(e.message || e);
  process.exit(1);
});
