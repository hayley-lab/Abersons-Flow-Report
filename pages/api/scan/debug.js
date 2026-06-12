import { kv } from "@vercel/kv";
import { getIronSession } from "iron-session";
import { sessionOptions } from "../../../lib/session";
import { getLsToken, lsBase } from "../../../lib/ls-auth";
import {
  CATALOG_META_KEY,
  loadCatalogProducts,
  loadSeasonBucket,
} from "../../../lib/catalog-store";
import { loadInventoryCache } from "../../../lib/inventory-ledger";
import { loadScanBig, loadScanData } from "../../../lib/scan-data-store";

export default async function handler(req, res) {
  const session = await getIronSession(req, res, sessionOptions);
  if (!session.authed) return res.status(401).json({ error: "Not authenticated" });

  const { action, season, consignmentId, productId, supplierId } = req.query;

  // ── Read-only peek at the shared catalog cache (no sync, no LS calls) ────────
  // Safe to poll during a rebuild — unlike POST/GET /api/scan/catalog, this never
  // advances the build, so it can't race or regress buildOffset.
  if (action === "catalog") {
    const meta = await kv.get(CATALOG_META_KEY);
    const seasons = String(req.query.seasons || "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const buckets = {};
    for (const s of seasons) {
      const b = await loadSeasonBucket(kv, s);
      buckets[s] = b && Array.isArray(b.seasonPids) ? b.seasonPids.length : 0;
    }
    let cachedProducts = null;
    if (req.query.count === "1" && meta) {
      const products = await loadCatalogProducts(kv, meta.shardCount);
      cachedProducts = Object.keys(products).length;
    }
    return res.json({
      meta: meta || null,
      cachedProducts,
      buckets,
    });
  }

  // ── Peek scan job + inventory cache state (read-only, no stepping) ──────────
  if (action === "job") {
    if (!season) return res.status(400).json({ error: "season required" });
    const [job, big, inv] = await Promise.all([
      kv.get(`scan:job:${season}`),
      loadScanBig(kv, season),
      loadInventoryCache(kv, season),
    ]);
    return res.json({
      job: job || null,
      catalog: big
        ? {
            catalogMode: big._catalogMode,
            catalogOffset: big._catalogOffset,
            catalogDone: big._catalogDone,
            catalogMatched: big._catalogMatched,
            seedHandles: Array.isArray(big._seedHandles) ? big._seedHandles.length : undefined,
            seasonPids: Array.isArray(big.seasonPids) ? big.seasonPids.length : undefined,
            callCounts: big.callCounts || null,
          }
        : null,
      inventoryStore: inv
        ? { version: inv.version, products: Object.keys(inv.onHand || {}).length }
        : null,
    });
  }

  // ── Raw LS fetch helper ─────────────────────────────────────────────────────
  if (action === "ls") {
    // Fetch any LS API path and return raw JSON
    // e.g. /api/scan/debug?action=ls&path=2.0/consignments/xxx/products
    const { path } = req.query;
    if (!path) return res.status(400).json({ error: "path required" });
    const token = await getLsToken();
    const r = await fetch(`${lsBase()}/${path}?page_size=200`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const data = await r.json();
    return res.json(data);
  }

  // ── Fetch a consignment's products and show raw fields ──────────────────────
  if (action === "consignment") {
    if (!consignmentId) return res.status(400).json({ error: "consignmentId required" });
    const token = await getLsToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const base = lsBase();

    // Fetch consignment header
    const hdr = await fetch(`${base}/2.0/consignments/${consignmentId}`, { headers }).then((r) =>
      r.json()
    );

    // Fetch all products in this consignment
    const items = [];
    let after = null;
    for (let p = 0; p < 50; p++) {
      const url = `${base}/2.0/consignments/${consignmentId}/products?page_size=200${after ? "&after=" + after : ""}`;
      const data = await fetch(url, { headers }).then((r) => r.json());
      const batch = data.data || [];
      items.push(...batch);
      if (batch.length < 200) break;
      const v = data.version && typeof data.version === "object" ? data.version.max : null;
      const vi = batch.reduce((mx, i) => Math.max(mx, i.version || 0), 0);
      after = v || vi || null;
      if (!after) break;
    }

    // Show full field set of first item + summary of all
    return res.json({
      consignment: hdr.data || hdr,
      itemCount: items.length,
      firstItemRaw: items[0] || null,
      allItemsSummary: items.slice(0, 20).map((i) => ({
        product_id: i.product_id,
        count: i.count,
        received: i.received,
        cost: i.cost,
        price: i.price,
        unit_price: i.unit_price,
        retail_price: i.retail_price,
        price_excluding_tax: i.price_excluding_tax,
        tax: i.tax,
      })),
    });
  }

  // ── Fetch a single product and show its price fields ────────────────────────
  if (action === "product") {
    if (!productId) return res.status(400).json({ error: "productId required" });
    const token = await getLsToken();
    const r = await fetch(`${lsBase()}/2.0/products/${productId}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    const data = await r.json();
    const p = data.data || data;
    return res.json({
      id: p.id,
      name: p.name,
      sku: p.sku,
      handle: p.handle,
      price: p.price,
      price_excluding_tax: p.price_excluding_tax,
      price_including_tax: p.price_including_tax,
      retail_price: p.retail_price,
      cost: p.cost,
      supplier: p.supplier,
      product_type_id: p.product_type_id,
      variant_parent_id: p.variant_parent_id,
      allFields: Object.keys(p),
    });
  }

  // ── List RETURN consignments (optionally filter by supplier) ────────────────
  if (action === "returns") {
    const token = await getLsToken();
    const headers = { Authorization: `Bearer ${token}`, Accept: "application/json" };
    const url = `${lsBase()}/2.0/consignments?type=RETURN&page_size=200${supplierId ? "&supplier_id=" + supplierId : ""}`;
    const data = await fetch(url, { headers }).then((r) => r.json());
    const items = (data.data || []).map((c) => ({
      id: c.id,
      status: c.status,
      type: c.type,
      supplier: c.supplier,
      supplier_id: c.supplier_id,
      name: c.name,
      reference: c.reference,
      created_at: c.created_at,
    }));
    return res.json({ count: items.length, items });
  }

  // ── Show override KV data for a season (vendor names + first product styles) ─
  if (action === "override") {
    if (!season) return res.status(400).json({ error: "season required" });
    const indexRaw = await kv.get(`scan:override:${season}:vendorIndex`);
    const vendorIndex = indexRaw
      ? typeof indexRaw === "string"
        ? JSON.parse(indexRaw)
        : indexRaw
      : [];
    const vendorRaws = await Promise.all(
      vendorIndex.map((k) => kv.get(`scan:override:${season}:v:${k}`))
    );
    const vendors = vendorIndex.map((key, i) => {
      const v = vendorRaws[i]
        ? typeof vendorRaws[i] === "string"
          ? JSON.parse(vendorRaws[i])
          : vendorRaws[i]
        : null;
      if (!v) return { key, error: "null" };
      const prods = v.products || [];
      return {
        key,
        vendorName: v.vendorName,
        deptName: v.deptName,
        productCount: prods.length,
        sampleStyles: prods
          .slice(0, 5)
          .map((p) => ({ style: p.style, description: p.description })),
      };
    });
    return res.json({ vendorCount: vendors.length, vendors });
  }

  // ── Show skuToPid entries matching a style prefix ───────────────────────────
  if (action === "skumatch") {
    if (!season) return res.status(400).json({ error: "season required" });
    const { style } = req.query;
    const data = await loadScanData(kv, season);
    if (!data) return res.json({ error: "No scan data" });
    const skuToPid = data.skuToPid || {};
    if (style) {
      const matches = Object.entries(skuToPid).filter(([sku]) =>
        sku.startsWith(style.toLowerCase())
      );
      return res.json({ style, matches: matches.slice(0, 20) });
    }
    const sample = Object.entries(skuToPid)
      .slice(0, 20)
      .map(([sku, pid]) => ({ sku, pid }));
    return res.json({ total: Object.keys(skuToPid).length, sample });
  }

  // ── Original KV scan data debug ─────────────────────────────────────────────
  if (!season) return res.status(400).json({ error: "season or action required" });

  const data = await loadScanData(kv, season);
  if (!data) return res.json({ error: "No scan data in KV for this season" });

  const { pidToSupplier, pidToType, seasonPids, deptVendors, summaryRows } = data;

  const deptNames = {};
  (summaryRows || []).forEach((r) => {
    deptNames[r.id] = r.name;
  });

  const allVendors = [];
  for (const [deptId, vendors] of Object.entries(deptVendors || {})) {
    for (const v of vendors) {
      allVendors.push({
        deptId,
        deptName: deptNames[deptId] || deptId,
        vendorId: v.id,
        vendorName: v.name,
        ordered: v.ordered,
      });
    }
  }

  const vendorProductCounts = allVendors
    .map(({ deptId, deptName, vendorId, vendorName, ordered }) => {
      const matches = (seasonPids || []).filter((id) => {
        const sup = pidToSupplier && pidToSupplier[id];
        const typ = pidToType && pidToType[id];
        return sup && (sup.i || sup.id) === vendorId && (typ === deptId || typ === "__none__");
      });
      return { deptName, vendorName, vendorId, deptId, ordered, matchingSkus: matches.length };
    })
    .sort((a, b) => b.ordered - a.ordered);

  return res.json({
    ts: data.ts,
    totalSkus: (seasonPids || []).length,
    vendorProductCounts: vendorProductCounts.slice(0, 30),
  });
}
