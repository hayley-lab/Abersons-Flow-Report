#!/usr/bin/env node
/*
 * Dry-run-first Lightspeed cleanup for register performance.
 *
 * Finds active, inventory-tracked products with no stock and no recent/open
 * activity, then optionally deactivates them with active=false. Never deletes.
 *
 * USAGE:
 *   node scripts/disable-stale-products.mjs --smoke-test
 *   node scripts/disable-stale-products.mjs
 *   node scripts/disable-stale-products.mjs --write
 *   node scripts/disable-stale-products.mjs --measure
 *   node scripts/disable-stale-products.mjs --revert scripts/out/<changes>.csv
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import {
  candidateReasonFromProduct as candidateReason,
  isActiveProduct,
  isConsignmentSku,
  isDeleted,
  isInventoryTracked,
  isSaleWithinWindow,
  recencyCutoffMs,
} from "../lib/stale-products.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_OUT_DIR = path.join(ROOT, "scripts", "out");
const SEARCH_PAGE_SIZE = 1000;
const SALES_PAGE_SIZE = 500;
const INVENTORY_PAGE_SIZE = 500;
const CONSIGNMENT_PAGE_SIZE = 200;
const CONSIGNMENT_LINE_PAGE_SIZE = 200;
const DEFAULT_RETRIES = 5;
const DEFAULT_WRITE_DELAY_MS = 250;
const DEFAULT_SEASONS = generateSeasons().map((s) => s.id);
const INVENTORY_CACHE_KEY = "scan:inv:store";
const INVENTORY_META_KEY = "scan:inv:store:meta";
const SALES_META_KEY = "scan:sales:store:meta";
const DEFAULT_SHARD_COUNT = 16;
const STALE_SALES_CACHE_MS = 36 * 60 * 60 * 1000;

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
    let val = match[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnv(".env.local");
loadEnv(".env");

function parseArgs(argv) {
  const args = {
    dryRun: true,
    measure: false,
    outDir: DEFAULT_OUT_DIR,
    seasons: DEFAULT_SEASONS,
    since: daysAgoIso(365),
    consignmentSince: daysAgoIso(182),
    splitConsignment: false,
    consignmentOnly: false,
    smokeTest: false,
    smokeId: null,
    write: false,
    writeDelayMs: DEFAULT_WRITE_DELAY_MS,
    limit: Infinity,
    freshInventory: false,
    freshSales: false,
    noSeasonGuard: false,
    revertFile: null,
    revertKvDate: null,
    checkpointFile: path.join(DEFAULT_OUT_DIR, "disable-stale-products.processed.txt"),
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--smoke-test") args.smokeTest = true;
    else if (arg === "--fresh-inventory") args.freshInventory = true;
    else if (arg === "--fresh-sales") args.freshSales = true;
    else if (arg === "--no-season-guard") args.noSeasonGuard = true;
    else if (arg === "--write") {
      args.write = true;
      args.dryRun = false;
    } else if (arg === "--measure") args.measure = true;
    else if (arg === "--consignment-only") args.consignmentOnly = true;
    else if (arg === "--split-consignment") args.splitConsignment = true;
    else if (arg === "--since") args.since = requiredValue(argv, ++i, "--since");
    else if (arg === "--consignment-since") {
      args.consignmentSince = requiredValue(argv, ++i, "--consignment-since");
      args.splitConsignment = true;
    } else if (arg === "--seasons") {
      args.seasons = requiredValue(argv, ++i, "--seasons")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (arg === "--out-dir") {
      args.outDir = path.resolve(ROOT, requiredValue(argv, ++i, "--out-dir"));
      args.checkpointFile = path.join(args.outDir, "disable-stale-products.processed.txt");
    } else if (arg === "--checkpoint") {
      args.checkpointFile = path.resolve(ROOT, requiredValue(argv, ++i, "--checkpoint"));
    } else if (arg === "--smoke-id") args.smokeId = requiredValue(argv, ++i, "--smoke-id");
    else if (arg === "--write-delay-ms") {
      args.writeDelayMs = parsePositiveInt(requiredValue(argv, ++i, "--write-delay-ms"), arg);
    } else if (arg === "--limit")
      args.limit = parsePositiveInt(requiredValue(argv, ++i, "--limit"), arg);
    else if (arg === "--revert") {
      args.revertFile = path.resolve(ROOT, requiredValue(argv, ++i, "--revert"));
      args.dryRun = false;
    } else if (arg === "--revert-kv") {
      args.revertKvDate = requiredValue(argv, ++i, "--revert-kv");
      args.dryRun = false;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return args;
}

function requiredValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function parsePositiveInt(value, flag) {
  const number = parseInt(value, 10);
  if (!Number.isFinite(number) || number <= 0)
    throw new Error(`${flag} must be a positive integer`);
  return number;
}

function printUsage() {
  console.warn(`Usage:
  node scripts/disable-stale-products.mjs --smoke-test
  node scripts/disable-stale-products.mjs [--since YYYY-MM-DD] [--seasons a,b,c]
  node scripts/disable-stale-products.mjs --consignment-only --since YYYY-MM-DD
  node scripts/disable-stale-products.mjs --split-consignment [--consignment-since YYYY-MM-DD]
  node scripts/disable-stale-products.mjs --no-season-guard --since YYYY-MM-DD
  node scripts/disable-stale-products.mjs --fresh-inventory --fresh-sales
  node scripts/disable-stale-products.mjs --write [--write-delay-ms 250]
  node scripts/disable-stale-products.mjs --measure
  node scripts/disable-stale-products.mjs --revert scripts/out/<changes>.csv
  node scripts/disable-stale-products.mjs --revert-kv YYYY-MM-DD

Notes:
  --consignment-only restricts candidates to consignment SKUs (item code starting with
  "c"/"C"); all other products are left untouched. Pair it with --since for the
  recency window (e.g. 6 months). By default recency reads cached lastSoldAt from KV;
  --fresh-sales pages LS live sales instead.

  --split-consignment applies --consignment-since (default 6 months) to SKUs starting
  with "C" and --since (default 12 months) to all other products. By default it reads
  cached lastSoldAt from KV; --fresh-sales pages LS live sales instead.

  --no-season-guard disables the report-season pid protection. Use only after
  confirming stale in-report products should be deactivated too.`);
}

function daysAgoIso(days) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function generateSeasons() {
  const year = new Date().getFullYear();
  const seasons = [];
  for (let y = year + 1; y >= 2025; y--) {
    const yy = String(y).slice(-2);
    if (y <= 2026) {
      seasons.push({ id: `fall${yy}` });
      seasons.push({ id: `spring${yy}` });
    } else {
      seasons.push({ id: `fall${yy}` });
      seasons.push({ id: `prefall${yy}` });
      seasons.push({ id: `spring${yy}` });
      seasons.push({ id: `prespring${yy}` });
    }
  }
  return seasons;
}

function seasonSkuCodes(seasonId) {
  const match = String(seasonId || "").match(/^(prefall|fall|spring|prespring)(\d+)$/);
  if (!match) return [];
  const yy = match[2].slice(-2);
  if (match[1] === "prespring") return ["/rs" + yy, "/ps" + yy];
  if (match[1] === "prefall") return ["/pf" + yy];
  if (match[1] === "fall") {
    const hasPreFall = DEFAULT_SEASONS.includes(`prefall${yy}`);
    return hasPreFall ? ["/f" + yy] : ["/f" + yy, "/pf" + yy];
  }
  if (match[1] === "spring") {
    const hasPreSpring = DEFAULT_SEASONS.includes(`prespring${yy}`);
    return hasPreSpring ? ["/s" + yy] : ["/s" + yy, "/rs" + yy, "/ps" + yy];
  }
  return [];
}

function skuMatchesSeason(sku, seasonId) {
  const normalized = String(sku || "")
    .toLowerCase()
    .trim();
  const segment = normalized.includes("/") ? normalized.split("/")[1] : "";
  if (!segment) return false;
  return seasonSkuCodes(seasonId).some((code) => segment.startsWith(code.slice(1)));
}

function skuMatchesAnySeason(sku, seasons) {
  return seasons.some((season) => skuMatchesSeason(sku, season));
}

function requireLsEnv() {
  const { LS_DOMAIN_PREFIX, LS_ACCESS_TOKEN } = process.env;
  if (!LS_DOMAIN_PREFIX || !LS_ACCESS_TOKEN) {
    throw new Error("LS env missing (need LS_DOMAIN_PREFIX + LS_ACCESS_TOKEN in .env.local)");
  }
  return {
    base: `https://${LS_DOMAIN_PREFIX}.retail.lightspeed.app/api`,
    token: LS_ACCESS_TOKEN,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryWaitMs(response, attempt) {
  const retryAfter = response.headers.get("retry-after");
  if (retryAfter) {
    const seconds = parseFloat(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
  }
  return Math.min(2000 * 2 ** attempt, 60_000);
}

async function lsRequest(pathname, { method = "GET", body, retries = DEFAULT_RETRIES } = {}) {
  const { base, token } = requireLsEnv();
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  for (let attempt = 0; attempt <= retries; attempt++) {
    let response;
    try {
      response = await fetch(`${base}/${pathname}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      if (attempt < retries) {
        await sleep(Math.min(2000 * 2 ** attempt, 60_000));
        continue;
      }
      throw error;
    }

    if ((response.status === 429 || response.status === 503) && attempt < retries) {
      await sleep(retryWaitMs(response, attempt));
      continue;
    }

    const text = await response.text();
    if (!response.ok) {
      const error = new Error(
        `LS ${method} ${pathname} HTTP ${response.status}: ${text.slice(0, 300)}`
      );
      error.status = response.status;
      error.body = text;
      throw error;
    }

    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  throw new Error(`LS ${method} ${pathname} exhausted retries`);
}

function cursorFrom(data, items) {
  const responseVersion =
    data?.version && typeof data.version === "object" ? data.version.max : null;
  const itemVersion = (items || []).reduce(
    (max, item) => Math.max(max, Number(item?.version || 0)),
    0
  );
  return responseVersion ?? (itemVersion || null);
}

function amountOf(row) {
  return numberValue(
    row?.current_amount ??
      row?.count ??
      row?.quantity ??
      row?.qty ??
      row?.on_hand ??
      row?.available ??
      row?.amount
  );
}

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) ? n : 0;
}

function productName(product) {
  const description = product?.description
    ? String(product.description)
        .replace(/<[^>]*>/g, "")
        .trim()
    : "";
  return description || product?.name || product?.variant_name || "";
}

async function fetchInventoryOnHand() {
  const onHand = new Map();
  let after = null;
  let rowsSeen = 0;
  let page = 0;

  process.stderr.write("Fetching inventory");
  for (;;) {
    const pathSuffix = after ? `&after=${encodeURIComponent(after)}` : "";
    const data = await lsRequest(
      `2.0/inventory?size=${INVENTORY_PAGE_SIZE}&sort_direction=asc${pathSuffix}`
    );
    const rows = data?.data || [];
    for (const row of rows) {
      const pid = row?.product_id;
      if (!pid) continue;
      onHand.set(pid, (onHand.get(pid) || 0) + amountOf(row));
      rowsSeen++;
    }
    page++;
    if (page % 25 === 0) process.stderr.write(".");

    const nextCursor = cursorFrom(data, rows);
    if (!rows.length || !nextCursor || nextCursor === after) break;
    after = nextCursor;
  }
  process.stderr.write(` ${rowsSeen} inventory rows, ${onHand.size} products\n`);
  return onHand;
}

async function loadCachedInventoryOnHand() {
  const kv = await loadKvClient();
  if (!kv) {
    throw new Error(
      "KV env missing; cannot read cached inventory. Use --fresh-inventory to page LS."
    );
  }
  const meta = await kv.get(INVENTORY_META_KEY);
  if (!meta?.complete) {
    throw new Error("Cached inventory is not marked complete. Use --fresh-inventory to page LS.");
  }
  const stored = await getShardedObjectByPid(kv, INVENTORY_CACHE_KEY);
  const onHandObject = stored?.onHand || {};
  const onHand = new Map();
  for (const [pid, amount] of Object.entries(onHandObject)) {
    onHand.set(String(pid), Number(amount) || 0);
  }
  if (!onHand.size) {
    throw new Error("Cached inventory has no on-hand rows. Use --fresh-inventory to page LS.");
  }
  console.error(
    `Loaded cached inventory: ${onHand.size} products (meta ts=${meta.ts || "unknown"}, version=${
      meta.version || "unknown"
    })`
  );
  return onHand;
}

async function loadInventoryOnHand(args) {
  if (args.freshInventory) return fetchInventoryOnHand();
  return loadCachedInventoryOnHand();
}

async function fetchLiveOnHand(productId) {
  const data = await lsRequest(`2.0/products/${encodeURIComponent(productId)}/inventory`);
  const rows = data?.data || data;
  if (Array.isArray(rows)) {
    return rows.reduce((sum, row) => sum + amountOf(row), 0);
  }
  return amountOf(rows || {});
}

async function fetchRecentSaleProductIds(since) {
  const sold = new Set();
  let after = null;
  let salesSeen = 0;
  let page = 0;

  process.stderr.write(`Fetching sales since ${since}`);
  for (;;) {
    const afterParam = after ? `&after=${encodeURIComponent(after)}` : "";
    const data = await lsRequest(
      `2.0/sales?page_size=${SALES_PAGE_SIZE}&date_from=${encodeURIComponent(since)}${afterParam}`
    );
    const sales = data?.data || [];
    for (const sale of sales) {
      salesSeen++;
      if (isVoidedOrDeletedSale(sale)) continue;
      for (const productId of saleProductIds(sale)) sold.add(productId);
    }
    page++;
    if (page % 25 === 0) process.stderr.write(".");

    const nextCursor = cursorFrom(data, sales);
    if (!sales.length || !nextCursor || nextCursor === after) break;
    after = nextCursor;
  }
  process.stderr.write(` ${salesSeen} sales, ${sold.size} products\n`);
  return sold;
}

function saleTimestampMs(sale) {
  const raw = sale?.sale_date || sale?.created_at || sale?.updated_at;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// Returns a Map<productId, latestSaleMs> for split-window mode (cannot come from the
// "ever sold" KV cache, so this always pages LS). `since` should be the longer lookback.
async function fetchSaleDatesByPid(since) {
  const lastSale = new Map();
  let after = null;
  let salesSeen = 0;
  let page = 0;

  process.stderr.write(`Fetching dated sales since ${since}`);
  for (;;) {
    const afterParam = after ? `&after=${encodeURIComponent(after)}` : "";
    const data = await lsRequest(
      `2.0/sales?page_size=${SALES_PAGE_SIZE}&date_from=${encodeURIComponent(since)}${afterParam}`
    );
    const sales = data?.data || [];
    for (const sale of sales) {
      salesSeen++;
      if (isVoidedOrDeletedSale(sale)) continue;
      const ms = saleTimestampMs(sale);
      if (ms == null) continue;
      for (const productId of saleProductIds(sale)) {
        const prev = lastSale.get(productId);
        if (prev == null || ms > prev) lastSale.set(productId, ms);
      }
    }
    page++;
    if (page % 25 === 0) process.stderr.write(".");

    const nextCursor = cursorFrom(data, sales);
    if (!sales.length || !nextCursor || nextCursor === after) break;
    after = nextCursor;
  }
  process.stderr.write(` ${salesSeen} sales, ${lastSale.size} products\n`);
  return lastSale;
}

async function loadCachedSaleProductIds() {
  const { meta, shards } = await loadCachedSalesShards();
  const sold = new Set();
  for (const shard of shards) {
    for (const [pid, totals] of Object.entries(shard || {})) {
      if (hasSaleActivity(totals)) sold.add(String(pid));
    }
  }
  console.error(
    `Loaded cached sales guard: ${sold.size} products (meta ts=${meta.ts || "unknown"}, version=${
      meta.version || "unknown"
    })`
  );
  return sold;
}

async function loadCachedSalesShards() {
  const kv = await loadKvClient();
  if (!kv) {
    throw new Error("KV env missing; cannot read cached sales. Use --fresh-sales to page LS.");
  }
  const meta = await kv.get(SALES_META_KEY);
  if (!meta?.complete) {
    throw new Error("Cached sales aggregate is not marked complete. Use --fresh-sales to page LS.");
  }
  const shardCount = meta.shardCount || DEFAULT_SHARD_COUNT;
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, index) =>
      kv.get(`scan:sales:store:agg:${index}`).catch(() => null)
    )
  );
  return { meta, shards };
}

function warnIfSalesCacheStale(meta) {
  const ts = Number(meta?.ts || 0);
  if (!ts) return;
  const ageMs = Date.now() - ts;
  if (ageMs > STALE_SALES_CACHE_MS) {
    console.warn(
      `Cached sales aggregate is ${Math.round(ageMs / 3600000)}h old; consider running sales-cache before cleanup.`
    );
  }
}

async function loadCachedLastSoldByPid() {
  const { meta, shards } = await loadCachedSalesShards();
  warnIfSalesCacheStale(meta);

  const lastSoldByPid = new Map();
  let rowsWithSales = 0;
  for (const shard of shards) {
    for (const [pid, totals] of Object.entries(shard || {})) {
      if (hasSaleActivity(totals)) rowsWithSales++;
      const lastSoldAt = Number(totals?.lastSoldAt || 0);
      if (lastSoldAt > 0) lastSoldByPid.set(String(pid), lastSoldAt);
    }
  }
  if (rowsWithSales > 0 && lastSoldByPid.size === 0) {
    throw new Error(
      "Cached sales aggregate has no lastSoldAt values. Rebuild /api/scan/sales-cache?sales=1 or use --fresh-sales."
    );
  }
  console.error(
    `Loaded cached last-sold guard: ${lastSoldByPid.size} products (meta ts=${
      meta.ts || "unknown"
    }, version=${meta.version || "unknown"})`
  );
  return lastSoldByPid;
}

function hasSaleActivity(totals) {
  return (
    Math.abs(Number(totals?.sold || 0)) > 0 ||
    Math.abs(Number(totals?.onSale || 0)) > 0 ||
    Math.abs(Number(totals?.saleAmt || 0)) > 0 ||
    Math.abs(Number(totals?.soldAmt || 0)) > 0 ||
    Math.abs(Number(totals?.returned || 0)) > 0
  );
}

async function loadSaleProductIds(args) {
  if (args.freshSales) return fetchRecentSaleProductIds(args.since);
  return loadCachedSaleProductIds();
}

function isVoidedOrDeletedSale(sale) {
  const status = normalizedStatus(sale?.status);
  return status === "VOIDED" || !!sale?.deleted_at;
}

function saleProductIds(sale) {
  const ids = new Set();
  const saleStatus = normalizedStatus(sale?.status);
  if (["OPEN", "PARKED", "LAYBY", "LAYAWAY"].includes(saleStatus)) return ids;
  for (const line of sale?.line_items || []) {
    if (!line?.product_id || normalizedStatus(line?.status) === "VOIDED") continue;
    const qty = parseInt(line.quantity == null ? 1 : line.quantity, 10);
    if (!qty) continue;
    ids.add(String(line.product_id));
  }
  return ids;
}

async function fetchOpenConsignmentProductIds() {
  const blocked = new Set();
  const types = ["SUPPLIER", "RETURN", "SUPPLIER_RETURN"];

  process.stderr.write("Fetching open consignments");
  for (const type of types) {
    let after = null;
    for (;;) {
      const afterParam = after ? `&after=${encodeURIComponent(after)}` : "";
      const data = await lsRequest(
        `2.0/consignments?type=${encodeURIComponent(type)}&page_size=${CONSIGNMENT_PAGE_SIZE}${afterParam}`
      );
      const headers = data?.data || [];
      for (const header of headers) {
        if (!headerLooksOpen(header)) continue;
        const items = await fetchConsignmentLineItems(header.id);
        for (const pid of openConsignmentProductIds(type, header, items)) blocked.add(pid);
      }
      process.stderr.write(".");

      const nextCursor = cursorFrom(data, headers);
      if (!headers.length || !nextCursor || nextCursor === after) break;
      after = nextCursor;
    }
  }
  process.stderr.write(` ${blocked.size} products\n`);
  return blocked;
}

async function fetchConsignmentLineItems(id) {
  if (!id) return [];
  const results = [];
  let after = null;
  for (;;) {
    const afterParam = after ? `&after=${encodeURIComponent(after)}` : "";
    const data = await lsRequest(
      `2.0/consignments/${id}/products?page_size=${CONSIGNMENT_LINE_PAGE_SIZE}${afterParam}`
    );
    const items = data?.data || [];
    results.push(...items);
    const nextCursor = cursorFrom(data, items);
    if (!items.length || !nextCursor || nextCursor === after) break;
    after = nextCursor;
  }
  return results;
}

function normalizedStatus(status) {
  return String(status || "")
    .toUpperCase()
    .replace(/[\s,_-]/g, "");
}

function headerLooksOpen(header) {
  if (!header || header.deleted_at) return false;
  const status = normalizedStatus(header.status);
  if (["VOIDED", "CANCELLED", "CANCELED"].includes(status)) return false;
  if (["RECEIVED", "COMPLETE", "COMPLETED", "CLOSED"].includes(status)) return false;
  return true;
}

function openConsignmentProductIds(type, header, items) {
  const ids = new Set();
  const normalizedType = normalizedStatus(type || header?.type);
  for (const item of items || []) {
    const pid = item?.product_id;
    if (!pid) continue;
    const count = Math.abs(Number(item.count || 0));
    if (!count) continue;
    if (normalizedType === "SUPPLIER") {
      const received = Math.max(0, Number(item.received || 0));
      if (Math.max(0, Number(item.count || 0)) > received) ids.add(String(pid));
    } else {
      ids.add(String(pid));
    }
  }
  return ids;
}

async function fetchActiveSeasonProductIds(seasons) {
  const guard = new Set();
  const kv = await loadKvClient();
  if (!kv) {
    console.warn("KV env missing; active-season guard is empty");
    return guard;
  }

  process.stderr.write("Fetching active-season KV guard");
  for (const season of seasons) {
    for (const baseKey of [`scan:pids:${season}`, `scan:data:${season}`]) {
      const value = await getShardedObjectByPid(kv, baseKey);
      addKnownPids(guard, value);
    }
    process.stderr.write(".");
  }
  process.stderr.write(` ${guard.size} products\n`);
  return guard;
}

async function loadKvClient() {
  if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) return null;
  const mod = await import("@vercel/kv");
  return mod.kv;
}

function addKnownPids(target, value) {
  if (!value) return;
  for (const pid of value.seasonPids || []) target.add(String(pid));
  for (const field of [
    "productStats",
    "pidToType",
    "pidToSupplier",
    "pidToPrice",
    "pidToSku",
    "pidToQtyOrdered",
    "pidToQtyReceived",
    "pidToQtyReturned",
  ]) {
    for (const pid of Object.keys(value[field] || {})) target.add(String(pid));
  }
}

function isShardedKvObject(value) {
  return !!(
    value &&
    typeof value === "object" &&
    value.sharded === true &&
    Number(value.version || 0) === 1
  );
}

function shardedKvShardKey(baseKey, index) {
  return `${baseKey}:shard:${index}`;
}

async function getShardedObjectByPid(kv, baseKey) {
  const marker = await kv.get(baseKey).catch(() => null);
  if (!marker) return null;
  if (!isShardedKvObject(marker)) return marker;

  const shardCount = marker.shardCount || 16;
  const shards = await Promise.all(
    Array.from({ length: shardCount }, (_, index) =>
      kv.get(shardedKvShardKey(baseKey, index)).catch(() => null)
    )
  );
  const result = { ...(marker.scalar || {}) };
  for (const field of marker.pidFields || []) {
    if (!result[field]) result[field] = {};
  }
  for (const field of marker.skuToPidFields || []) {
    if (!result[field]) result[field] = {};
  }
  for (const shard of shards) {
    for (const [pid, record] of Object.entries(shard?.records || {})) {
      for (const [field, fieldValue] of Object.entries(record || {})) {
        if ((marker.skuToPidFields || []).includes(field)) {
          result[field] = { ...(result[field] || {}), ...(fieldValue || {}) };
        } else {
          if (!result[field]) result[field] = {};
          result[field][pid] = fieldValue;
        }
      }
    }
  }
  return result;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function ensureOutDir(outDir) {
  mkdirSync(outDir, { recursive: true });
}

function csvEscape(value) {
  const str = value == null ? "" : String(value);
  if (!/[",\n\r]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function writeCsvRow(stream, columns, row) {
  stream.write(columns.map((column) => csvEscape(row[column])).join(",") + "\n");
}

function createCsvWriter(filePath, columns) {
  const stream = createWriteStream(filePath, { encoding: "utf8" });
  stream.write(columns.join(",") + "\n");
  return {
    filePath,
    write: (row) => writeCsvRow(stream, columns, row),
    close: () =>
      new Promise((resolve, reject) => {
        stream.end((err) => (err ? reject(err) : resolve()));
      }),
  };
}

function skipStats() {
  return {
    totalProducts: 0,
    inactive: 0,
    deleted: 0,
    nonInventory: 0,
    inStock: 0,
    recentSale: 0,
    openConsignment: 0,
    activeSeasonGuard: 0,
    nonConsignment: 0,
    candidate: 0,
    candidateConsignment: 0,
    candidateRegular: 0,
  };
}

function tallyCandidateClass(stats, product) {
  if (isConsignmentSku(product.sku)) stats.candidateConsignment++;
  else stats.candidateRegular++;
}

function candidateRow(product, onHand) {
  return {
    id: product.id,
    sku: product.sku || "",
    name: productName(product),
    on_hand: onHand,
    active: product.active,
    is_active: product.is_active,
    has_inventory: product.has_inventory,
    deleted_at: product.deleted_at || "",
    version: product.version || "",
    updated_at: product.updated_at || "",
  };
}

function earlierIsoDate(a, b) {
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

async function gatherContext(args) {
  const onHand = await loadInventoryOnHand(args);
  const base = { onHand, consignmentOnly: args.consignmentOnly };

  if (args.splitConsignment) {
    const lookback = earlierIsoDate(args.since, args.consignmentSince);
    base.lastSaleByPid = args.freshSales
      ? await fetchSaleDatesByPid(lookback)
      : await loadCachedLastSoldByPid();
    base.regularCutoffMs = Date.parse(args.since);
    base.consignmentCutoffMs = Date.parse(args.consignmentSince);
  } else if (args.freshSales) {
    base.recentSalePids = await loadSaleProductIds(args);
  } else {
    base.lastSaleByPid = await loadCachedLastSoldByPid();
    base.regularCutoffMs = Date.parse(args.since);
    base.consignmentCutoffMs = Date.parse(args.since);
  }

  base.openConsignmentPids = await fetchOpenConsignmentProductIds();
  base.activeSeasonPids = args.noSeasonGuard
    ? new Set()
    : await fetchActiveSeasonProductIds(args.seasons);
  return base;
}

async function scanCandidateProducts(context, { outDir, limit = Infinity } = {}) {
  ensureOutDir(outDir);
  const candidates = [];
  const stats = skipStats();
  const columns = [
    "id",
    "sku",
    "name",
    "on_hand",
    "active",
    "is_active",
    "has_inventory",
    "deleted_at",
    "version",
    "updated_at",
  ];
  const writer = createCsvWriter(
    path.join(outDir, `stale-product-candidates-${timestamp()}.csv`),
    columns
  );

  try {
    let offset = 0;
    process.stderr.write("Scanning products via search");
    for (;;) {
      const data = await lsRequest(
        `2.0/search?type=products&page_size=${SEARCH_PAGE_SIZE}&offset=${offset}`
      );
      const products = data?.data || [];
      for (const product of products) {
        if (!product?.id) continue;
        stats.totalProducts++;
        const reason = candidateReason(product, context);
        stats[reason]++;
        if (reason !== "candidate") continue;
        tallyCandidateClass(stats, product);

        const row = candidateRow(product, context.onHand.get(product.id) || 0);
        writer.write(row);
        candidates.push(product);
        if (candidates.length >= limit) break;
      }
      process.stderr.write(".");
      if (products.length < SEARCH_PAGE_SIZE || candidates.length >= limit) break;
      offset += SEARCH_PAGE_SIZE;
    }
  } finally {
    await writer.close();
  }

  process.stderr.write(` ${stats.totalProducts} products scanned\n`);
  return { candidates, stats, csv: writer.filePath };
}

async function scanAndWriteCandidates(context, args) {
  ensureOutDir(args.outDir);
  const processed = await readProcessedIds(args.checkpointFile);
  const stats = skipStats();
  const candidateColumns = [
    "id",
    "sku",
    "name",
    "on_hand",
    "active",
    "is_active",
    "has_inventory",
    "deleted_at",
    "version",
    "updated_at",
  ];
  const changeColumns = [
    "ts",
    "id",
    "sku",
    "name",
    "on_hand",
    "previous_active",
    "previous_is_active",
    "action",
    "status",
    "error",
  ];
  const candidatesWriter = createCsvWriter(
    path.join(args.outDir, `stale-product-candidates-${timestamp()}.csv`),
    candidateColumns
  );
  const changesWriter = createCsvWriter(
    path.join(args.outDir, `stale-product-changes-${timestamp()}.csv`),
    changeColumns
  );

  let changed = 0;
  let skippedCheckpoint = 0;
  let failed = 0;
  let offset = 0;

  try {
    process.stderr.write("Scanning products and writing candidates");
    for (;;) {
      const data = await lsRequest(
        `2.0/search?type=products&page_size=${SEARCH_PAGE_SIZE}&offset=${offset}`
      );
      const products = data?.data || [];
      for (const product of products) {
        if (!product?.id) continue;
        stats.totalProducts++;
        const reason = candidateReason(product, context);
        stats[reason]++;
        if (reason !== "candidate") continue;
        tallyCandidateClass(stats, product);

        const baseRow = candidateRow(product, context.onHand.get(product.id) || 0);
        candidatesWriter.write(baseRow);

        if (processed.has(product.id)) {
          skippedCheckpoint++;
          continue;
        }

        const changeRow = {
          ts: new Date().toISOString(),
          ...baseRow,
          previous_active: product.active,
          previous_is_active: product.is_active,
          action: "deactivate",
          status: "pending",
          error: "",
        };
        try {
          await setProductActive(product, false);
          changeRow.status = "ok";
          changed++;
          await appendProcessedId(args.checkpointFile, product.id);
          processed.add(product.id);
        } catch (error) {
          changeRow.status = "error";
          changeRow.error = error.message || String(error);
          failed++;
        }
        changesWriter.write(changeRow);

        if ((changed + failed) % 100 === 0) {
          console.error(
            `write progress: changed=${changed} failed=${failed} checkpoint-skipped=${skippedCheckpoint}`
          );
        }
        if (changed + failed >= args.limit) break;
        await sleep(args.writeDelayMs);
      }

      process.stderr.write(".");
      if (products.length < SEARCH_PAGE_SIZE || changed + failed >= args.limit) break;
      offset += SEARCH_PAGE_SIZE;
    }
  } finally {
    await candidatesWriter.close();
    await changesWriter.close();
  }

  printCandidateSummary(stats, candidatesWriter.filePath);
  console.warn("\n=== Write complete ===");
  console.warn(`changed: ${changed}`);
  console.warn(`skipped from checkpoint: ${skippedCheckpoint}`);
  console.warn(`failed: ${failed}`);
  console.warn(`change CSV: ${changesWriter.filePath}`);
  console.warn(`checkpoint: ${args.checkpointFile}`);
}

async function measureCatalog(args) {
  const onHand = await loadInventoryOnHand(args);
  const stats = {
    totalProducts: 0,
    active: 0,
    inactive: 0,
    deleted: 0,
    activeWithStock: 0,
    activeWithoutStock: 0,
    inventoryTracked: 0,
  };

  let offset = 0;
  process.stderr.write("Measuring products via search");
  for (;;) {
    const data = await lsRequest(
      `2.0/search?type=products&page_size=${SEARCH_PAGE_SIZE}&offset=${offset}`
    );
    const products = data?.data || [];
    for (const product of products) {
      if (!product?.id) continue;
      stats.totalProducts++;
      if (isDeleted(product)) stats.deleted++;
      if (isInventoryTracked(product)) stats.inventoryTracked++;
      if (isActiveProduct(product)) {
        stats.active++;
        if ((onHand.get(product.id) || 0) > 0) stats.activeWithStock++;
        else stats.activeWithoutStock++;
      } else {
        stats.inactive++;
      }
    }
    process.stderr.write(".");
    if (products.length < SEARCH_PAGE_SIZE) break;
    offset += SEARCH_PAGE_SIZE;
  }
  process.stderr.write(` ${stats.totalProducts} products scanned\n`);
  printMeasure(stats);
}

function printMeasure(stats) {
  console.warn("\n=== Catalog measurement ===");
  console.warn(`total products: ${stats.totalProducts}`);
  console.warn(
    `active: ${stats.active} | inactive: ${stats.inactive} | deleted_at set: ${stats.deleted}`
  );
  console.warn(`has_inventory=true: ${stats.inventoryTracked}`);
  console.warn(`active w/ onHand>0: ${stats.activeWithStock}`);
  console.warn(`active w/ onHand<=0: ${stats.activeWithoutStock}`);
}

function printCandidateSummary(stats, csv) {
  console.warn("\n=== Stale product dry-run ===");
  console.warn(`products scanned: ${stats.totalProducts}`);
  console.warn(`candidates: ${stats.candidate}`);
  console.warn(
    `  consignment (SKU "C…"): ${stats.candidateConsignment} | regular: ${stats.candidateRegular}`
  );
  console.warn("");
  console.warn("Skipped:");
  console.warn(`  inactive: ${stats.inactive}`);
  console.warn(`  deleted: ${stats.deleted}`);
  console.warn(`  non-inventory: ${stats.nonInventory}`);
  console.warn(`  still in stock: ${stats.inStock}`);
  console.warn(`  recent sale: ${stats.recentSale}`);
  console.warn(`  open consignment: ${stats.openConsignment}`);
  console.warn(`  active-season report guard: ${stats.activeSeasonGuard}`);
  if (stats.nonConsignment) console.warn(`  non-consignment (skipped): ${stats.nonConsignment}`);
  console.warn("");
  console.warn(`candidate CSV: ${csv}`);
}

async function fetchProduct(id) {
  const data = await lsRequest(`2.0/products/${encodeURIComponent(id)}`);
  return data?.data || data;
}

async function setProductActive(productOrId, active) {
  const id = typeof productOrId === "string" ? productOrId : productOrId?.id;
  if (!id) throw new Error("setProductActive requires a product id");
  return lsRequest(`2026-04/products/${encodeURIComponent(id)}`, {
    method: "PUT",
    body: { details: { is_active: active } },
  });
}

async function findSmokeProduct(args) {
  if (args.smokeId) return fetchProduct(args.smokeId);
  let offset = 0;
  process.stderr.write("Finding smoke-test product");
  for (;;) {
    const data = await lsRequest(
      `2.0/search?type=products&page_size=${SEARCH_PAGE_SIZE}&offset=${offset}`
    );
    const products = data?.data || [];
    for (const product of products) {
      if (!product?.id) continue;
      if (!isActiveProduct(product) || isDeleted(product) || !isInventoryTracked(product)) continue;
      if (skuMatchesAnySeason(product.sku || "", args.seasons)) continue;
      const onHand = await fetchLiveOnHand(product.id);
      if (onHand <= 0) return product;
    }
    process.stderr.write(".");
    if (products.length < SEARCH_PAGE_SIZE) break;
    offset += SEARCH_PAGE_SIZE;
  }
  process.stderr.write("\n");
  throw new Error("No active, non-season, zero-stock product found for smoke test");
}

async function runSmokeTest(args) {
  const product = await findSmokeProduct(args);
  const before = await fetchProduct(product.id);
  const beforeActive = before.active;
  const beforeIsActive = before.is_active;
  console.warn(`Smoke product: ${before.id} ${before.sku || ""} ${productName(before)}`);
  console.warn(`Before: active=${beforeActive} is_active=${beforeIsActive}`);

  await setProductActive(before, false);
  const disabled = await fetchProduct(before.id);
  console.warn(`Disabled: active=${disabled.active} is_active=${disabled.is_active}`);

  await setProductActive(before, beforeActive !== false && beforeIsActive !== false);
  const restored = await fetchProduct(before.id);
  console.warn(`Restored: active=${restored.active} is_active=${restored.is_active}`);

  if (!isActiveProduct(restored)) {
    throw new Error("Smoke test did not restore product to active state");
  }
  console.warn("Smoke test passed: write scope works and product was restored.");
}

async function readProcessedIds(checkpointFile) {
  const ids = new Set();
  if (!existsSync(checkpointFile)) return ids;
  const rl = createInterface({
    input: createReadStream(checkpointFile, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const id = line.trim();
    if (id) ids.add(id);
  }
  return ids;
}

async function appendProcessedId(checkpointFile, id) {
  await new Promise((resolve, reject) => {
    const stream = createWriteStream(checkpointFile, { flags: "a", encoding: "utf8" });
    stream.end(`${id}\n`, (err) => (err ? reject(err) : resolve()));
  });
}

function parseCsvLine(line) {
  const fields = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quoted) {
      if (char === '"' && line[i + 1] === '"') {
        current += '"';
        i++;
      } else if (char === '"') {
        quoted = false;
      } else {
        current += char;
      }
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else if (char === '"') {
      quoted = true;
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

async function readCsvRows(filePath) {
  const rows = [];
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  let headers = null;
  for await (const line of rl) {
    if (!headers) {
      headers = parseCsvLine(line);
      continue;
    }
    if (!line.trim()) continue;
    const values = parseCsvLine(line);
    rows.push(Object.fromEntries(headers.map((header, index) => [header, values[index] || ""])));
  }
  return rows;
}

async function revertFromCsv(filePath, args) {
  ensureOutDir(args.outDir);
  const rows = await readCsvRows(filePath);
  const ids = rows
    .filter((row) => !row.status || row.status === "ok")
    .map((row) => row.id || row.product_id)
    .filter(Boolean);
  const uniqueIds = [...new Set(ids)];
  const columns = ["ts", "id", "action", "status", "error"];
  const writer = createCsvWriter(
    path.join(args.outDir, `stale-product-revert-${timestamp()}.csv`),
    columns
  );
  let reverted = 0;
  let failed = 0;

  try {
    for (const id of uniqueIds) {
      const row = {
        ts: new Date().toISOString(),
        id,
        action: "reactivate",
        status: "pending",
        error: "",
      };
      try {
        await setProductActive(id, true);
        row.status = "ok";
        reverted++;
      } catch (error) {
        row.status = "error";
        row.error = error.message || String(error);
        failed++;
      }
      writer.write(row);
      if ((reverted + failed) % 100 === 0) {
        console.error(`revert progress: reverted=${reverted} failed=${failed}`);
      }
      await sleep(args.writeDelayMs);
    }
  } finally {
    await writer.close();
  }

  console.warn("\n=== Revert complete ===");
  console.warn(`reverted: ${reverted}`);
  console.warn(`failed: ${failed}`);
  console.warn(`revert CSV: ${writer.filePath}`);
}

function cleanupLogKey(date) {
  return `scan:cleanup:log:${date}`;
}

function validateCleanupDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ""))) {
    throw new Error("--revert-kv requires a YYYY-MM-DD date");
  }
}

async function revertFromKvDate(date, args) {
  validateCleanupDate(date);
  ensureOutDir(args.outDir);
  const kv = await loadKvClient();
  if (!kv) throw new Error("KV env missing; cannot read nightly cleanup audit log.");

  const rows = (await kv.get(cleanupLogKey(date))) || [];
  const ids = rows
    .filter((row) => !row.status || row.status === "ok")
    .map((row) => row.id)
    .filter(Boolean);
  const uniqueIds = [...new Set(ids.map(String))];
  if (!uniqueIds.length) throw new Error(`No cleanup audit rows found for ${date}`);

  const columns = ["ts", "id", "sku", "action", "status", "error"];
  const byId = new Map(rows.map((row) => [String(row.id), row]));
  const writer = createCsvWriter(
    path.join(args.outDir, `stale-product-revert-kv-${date}-${timestamp()}.csv`),
    columns
  );
  let reverted = 0;
  let failed = 0;

  try {
    for (const id of uniqueIds) {
      const source = byId.get(id) || {};
      const row = {
        ts: new Date().toISOString(),
        id,
        sku: source.sku || "",
        action: "reactivate",
        status: "pending",
        error: "",
      };
      try {
        await setProductActive(id, true);
        row.status = "ok";
        reverted++;
      } catch (error) {
        row.status = "error";
        row.error = error.message || String(error);
        failed++;
      }
      writer.write(row);
      if ((reverted + failed) % 100 === 0) {
        console.error(`kv revert progress: reverted=${reverted} failed=${failed}`);
      }
      await sleep(args.writeDelayMs);
    }
  } finally {
    await writer.close();
  }

  console.warn("\n=== KV Revert complete ===");
  console.warn(`date: ${date}`);
  console.warn(`reverted: ${reverted}`);
  console.warn(`failed: ${failed}`);
  console.warn(`revert CSV: ${writer.filePath}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.revertFile) {
    await revertFromCsv(args.revertFile, args);
    return;
  }
  if (args.revertKvDate) {
    await revertFromKvDate(args.revertKvDate, args);
    return;
  }
  if (args.smokeTest) {
    await runSmokeTest(args);
    return;
  }
  if (args.measure) {
    await measureCatalog(args);
    return;
  }

  const context = await gatherContext(args);
  if (args.write) {
    await scanAndWriteCandidates(context, args);
  } else {
    const { stats, csv } = await scanCandidateProducts(context, args);
    printCandidateSummary(stats, csv);
    console.warn("\nDry-run only. Re-run with --write to deactivate the candidates.");
  }
}

const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().catch((error) => {
    console.error(error.message || error);
    process.exit(1);
  });
}

export {
  isConsignmentSku,
  recencyCutoffMs,
  isSaleWithinWindow,
  candidateReason,
  skuMatchesSeason,
  earlierIsoDate,
  parseArgs,
};
