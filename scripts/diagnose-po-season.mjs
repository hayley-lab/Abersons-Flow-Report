#!/usr/bin/env node
/*
 * Read-only answer to "why isn't this PO showing in the flow report?".
 *
 * For a Lightspeed consignment (PO), prints every line item with:
 *   - its LIVE LS SKU (the season the PO should land in),
 *   - the SKU held in the shared catalog cache (what the report currently sees),
 *   - which season's scan:data actually contains the pid.
 *
 * A "live ps27 / cached f26" split means the SKU season code was corrected in LS
 * after the last catalog refresh, so the report still has the PO under the old
 * season until the next sync re-buckets it.
 *
 * REQUIREMENTS: .env.local with LS_DOMAIN_PREFIX, LS_ACCESS_TOKEN, KV_REST_API_*.
 *
 * USAGE:
 *   node scripts/diagnose-po-season.mjs 85626                       # find PO by number
 *   node scripts/diagnose-po-season.mjs <consignmentId> --items     # per-item detail
 *   node scripts/diagnose-po-season.mjs 85626 --seasons prespring27,fall26
 */
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
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}
loadEnv(".env.local");

const argv = process.argv.slice(2);
const NEEDLE = argv[0];
const SHOW_ITEMS = argv.includes("--items");
const SEASONS = (() => {
  const i = argv.indexOf("--seasons");
  return i >= 0 && argv[i + 1]
    ? argv[i + 1].split(",").map((s) => s.trim())
    : ["prespring27", "spring27", "prefall27", "fall27", "spring26", "fall26"];
})();

if (!NEEDLE) {
  console.error("usage: node scripts/diagnose-po-season.mjs <poNumberOrConsignmentId> [--items]");
  process.exit(1);
}

const PREFIX = process.env.LS_DOMAIN_PREFIX;
const TOK = process.env.LS_ACCESS_TOKEN;

async function ls(p) {
  const res = await fetch(`https://${PREFIX}.retail.lightspeed.app/api/${p}`, {
    headers: { Authorization: `Bearer ${TOK}` },
  });
  if (!res.ok) throw new Error(`GET ${p} HTTP ${res.status}`);
  return res.json();
}

const { kv } = await import("@vercel/kv");

function shardForPid(pid, shardCount = 16) {
  const str = String(pid == null ? "" : pid);
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % shardCount;
}

// Minimal reader for lib/kv-sharded.js sharded objects (scan:data, scan:pids).
async function getSharded(baseKey) {
  const marker = await kv.get(baseKey);
  if (!marker) return null;
  if (!(marker.sharded === true && marker.version === 1)) return marker;
  const shardCount = marker.shardCount || 16;
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, i) => kv.get(`${baseKey}:shard:${i}`))
  );
  const result = { ...(marker.scalar || {}) };
  for (const shard of shards) {
    for (const [pid, record] of Object.entries(shard?.records || {})) {
      for (const [field, value] of Object.entries(record || {})) {
        if ((marker.skuToPidFields || []).includes(field)) {
          result[field] = { ...(result[field] || {}), ...(value || {}) };
        } else {
          if (!result[field]) result[field] = {};
          result[field][pid] = value;
        }
      }
    }
  }
  return result;
}

async function findConsignment(needle) {
  if (/^[0-9a-f]{8}-/i.test(needle)) return (await ls(`2.0/consignments/${needle}`))?.data;
  let after = null;
  for (let page = 0; page < 100; page++) {
    const data = await ls(`2.0/consignments?page_size=200${after ? `&after=${after}` : ""}`);
    const items = data?.data || [];
    const hit = items.find((c) => JSON.stringify(c).includes(needle));
    if (hit) return hit;
    const next = data?.version?.max;
    if (!next || items.length < 200) return null;
    after = next;
  }
  return null;
}

const po = await findConsignment(NEEDLE);
if (!po) {
  console.error(`no consignment matched "${NEEDLE}"`);
  process.exit(2);
}

const items = (await ls(`2.0/consignments/${po.id}/products?page_size=500`))?.data || [];
const pids = [...new Set(items.map((i) => i.product_id).filter(Boolean))];
console.warn(
  `PO ${po.id}\n  type=${po.type} status=${po.status} supplier=${po.supplier_id}` +
    `\n  due=${po.due_at} created=${po.created_at} line items=${items.length} pids=${pids.length}`
);

const catMeta = await kv.get("scan:catalog:meta");
console.warn(
  `catalog cache: complete=${catMeta?.complete} cursor=${catMeta?.version} last refresh=${catMeta?.ts && new Date(catMeta.ts).toISOString()}`
);
const shardMap = {};
await Promise.all(
  [...new Set(pids.map((p) => shardForPid(p, catMeta?.shardCount || 16)))].map(async (i) => {
    shardMap[i] = (await kv.get(`scan:catalog:shard:${i}`)) || {};
  })
);

const seasonPidSets = {};
for (const s of SEASONS) {
  const data = await getSharded(`scan:data:${s}`);
  if (data) seasonPidSets[s] = new Set((data.seasonPids || []).map(String));
}

const seasonCode = (sku) => {
  const seg = String(sku || "")
    .toLowerCase()
    .split("/")[1];
  return seg ? seg.replace(/[0-9]*$/, "") + (seg.match(/\d\d/) || [""])[0] : "?";
};

const transitions = {};
for (const pid of pids) {
  const cached = shardMap[shardForPid(pid, catMeta?.shardCount || 16)][pid];
  const live = (await ls(`2.0/products/${pid}`))?.data;
  const inSeasons = Object.keys(seasonPidSets).filter((s) => seasonPidSets[s].has(pid));
  const key = `live ${seasonCode(live?.sku)} | cached ${seasonCode(cached?.sku)} | report: ${inSeasons.join(",") || "NONE"}`;
  transitions[key] = (transitions[key] || 0) + 1;
  if (SHOW_ITEMS) {
    console.warn(
      `  ${String(live?.sku || "?").padEnd(26)} cached=${String(cached?.sku || "(not in catalog)").padEnd(26)} report=${inSeasons.join(",") || "NONE"}`
    );
  }
}

console.warn(`\n--- line items grouped by season attribution ---`);
for (const [k, v] of Object.entries(transitions).sort((a, b) => b[1] - a[1])) {
  console.warn(`  ${String(v).padStart(4)}x  ${k}`);
}
