// pages/index.js
import { useState, useEffect, useCallback } from "react";

const fmt = (n) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(n || 0);

const pctColor = (pct, zero) => {
  if (zero || pct === 0) return { bg: "#f0ede6", color: "#9e9892" };
  if (pct >= 80) return { bg: "#e8f5ee", color: "#2d6a4f" };
  if (pct >= 50) return { bg: "#fef3e2", color: "#92600a" };
  return { bg: "#fdeaea", color: "#8b2020" };
};

const PctBadge = ({ pct, zero }) => {
  const { bg, color } = pctColor(pct, zero);
  return (
    <span style={{ background: bg, color, borderRadius: 20, padding: "2px 8px", fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
      {zero ? "0.0%" : `${pct.toFixed(1)}%`}
    </span>
  );
};

const Bar = ({ pct }) => (
  <div style={{ background: "#f0ede6", borderRadius: 3, height: 8, width: 72, overflow: "hidden" }}>
    <div style={{ width: `${Math.min(pct, 100).toFixed(1)}%`, height: "100%", background: "#2d6a4f", borderRadius: 3, transition: "width 0.4s ease" }} />
  </div>
);

const Spinner = ({ label = "Loading…" }) => (
  <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 14, padding: "3rem", color: "#9e9892" }}>
    <div style={{ width: 28, height: 28, border: "2px solid #e2ddd5", borderTopColor: "#3a5a8c", borderRadius: "50%", animation: "spin 0.7s linear infinite" }} />
    <div style={{ fontSize: 14 }}>{label}</div>
  </div>
);

const ErrBox = ({ msg }) => (
  <div style={{ background: "#fdeaea", border: "1px solid #f0b8b8", borderRadius: 10, padding: "1rem 1.25rem", color: "#8b2020", fontSize: 13, lineHeight: 1.6, marginBottom: "1rem" }}>
    <strong>Error: </strong>{msg}
  </div>
);

const KpiRow = ({ items }) => (
  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12, marginBottom: "1.5rem" }}>
    {items.map(({ label, value, sub }) => (
      <div key={label} style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 10, padding: "0.9rem 1.1rem", boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <div style={{ fontSize: 11, fontWeight: 600, letterSpacing: "0.07em", textTransform: "uppercase", color: "#9e9892", marginBottom: 4 }}>{label}</div>
        <div style={{ fontSize: 22, fontWeight: 600, color: "#1a1816", letterSpacing: -0.5 }}>{value}</div>
        {sub && <div style={{ fontSize: 12, color: "#6b6560", marginTop: 3 }}>{sub}</div>}
      </div>
    ))}
  </div>
);

const TableWrap = ({ title, right, children }) => (
  <div style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 10, boxShadow: "0 1px 3px rgba(0,0,0,0.06)", overflow: "hidden" }}>
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.9rem 1.1rem 0.7rem", borderBottom: "1px solid #e2ddd5", flexWrap: "wrap", gap: 8 }}>
      <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 17 }}>{title}</div>
      {right}
    </div>
    {children}
  </div>
);

const TH = ({ children, right }) => (
  <th style={{ padding: "8px 12px", textAlign: right ? "right" : "left", fontSize: 11, fontWeight: 600, letterSpacing: "0.06em", textTransform: "uppercase", color: "#6b6560", whiteSpace: "nowrap", background: "#f0ede6", borderBottom: "1px solid #e2ddd5" }}>
    {children}
  </th>
);

const TD = ({ children, right, mono }) => (
  <td style={{ padding: "9px 12px", textAlign: right ? "right" : "left", fontVariantNumeric: right ? "tabular-nums" : "normal", fontFamily: mono ? "monospace" : "inherit", fontSize: mono ? 12 : 13, color: mono ? "#6b6560" : "#1a1816", verticalAlign: "middle" }}>
    {children}
  </td>
);

const SEASONS = [
  { id: "prespring27", name: "Pre-Spring 2027" },
  { id: "fall26",      name: "Fall 2026" },
  { id: "prefall26",   name: "Pre-Fall 2026" },
  { id: "spring26",    name: "Spring 2026" },
  { id: "prespring26", name: "Pre-Spring 2026" },
  { id: "fall25",      name: "Fall 2025" },
  { id: "prefall25",   name: "Pre-Fall 2025" },
  { id: "spring25",    name: "Spring 2025" },
  { id: "prespring25", name: "Pre-Spring 2025" },
  { id: "fall24",      name: "Fall 2024" },
  { id: "prefall24",   name: "Pre-Fall 2024" },
  { id: "spring24",    name: "Spring 2024" },
  { id: "prespring24", name: "Pre-Spring 2024" },
  { id: "fall23",      name: "Fall 2023" },
  { id: "spring23",    name: "Spring 2023" },
];

// Returns the list of SKU suffix codes that identify a product as belonging to
// this season.  Prespring has TWO codes: older products use /rs, newer ones use /ps.
// Examples: prefall26 → ["/pf26"], prespring26 → ["/rs26", "/ps26"]
function seasonSkuCodes(seasonId) {
  var m = seasonId.match(/^(prefall|fall|spring|prespring)(\d+)$/);
  if (!m) return [];
  var year = m[2].slice(-2);
  if (m[1] === "prespring") return ["/rs" + year, "/ps" + year];
  var map = { prefall: "pf", fall: "f", spring: "s" };
  return ["/" + map[m[1]] + year];
}

const DEMO_SUMMARY = [
  { id: "acc",   name: "Accessories",       ordered: 101823,  received: 98413,  sold: 55410,  cost: 40610  },
  { id: "alley", name: "Alley",             ordered: 922276,  received: 904549, sold: 604999, cost: 361475 },
  { id: "alt",   name: "Alterations",       ordered: 0,       received: 0,      sold: 0,      cost: 0      },
  { id: "denim", name: "Denim",             ordered: 69531,   received: 68231,  sold: 45600,  cost: 27290  },
  { id: "des",   name: "Designer",          ordered: 306105,  received: 282960, sold: 149860, cost: 113184 },
  { id: "gc",    name: "Gift Certificates", ordered: 0,       received: 0,      sold: 0,      cost: 0      },
  { id: "hg",    name: "Home Gifts",        ordered: 0,       received: 0,      sold: 0,      cost: 0      },
  { id: "mens",  name: "Mens",              ordered: 472591,  received: 428733, sold: 240091, cost: 171493 },
  { id: "next",  name: "Next",              ordered: 617680,  received: 588475, sold: 452816, cost: 235390 },
  { id: "shoes", name: "Shoes",             ordered: 329474,  received: 293793, sold: 164143, cost: 117517 },
];

const DEMO_VENDORS = {
  acc: [
    { id: "dk",   name: "Dana Kellin",  ordered: 31048, received: 31048, sold: 17854, cost: 12419 },
    { id: "jp",   name: "Judi Powers",  ordered: 30280, received: 30280, sold: 15100, cost: 12112 },
    { id: "re",   name: "Rene Escobar", ordered: 40305, received: 36895, sold: 19866, cost: 14758 },
    { id: "vale", name: "Vale",         ordered: 1830,  received: 1830,  sold: 1830,  cost: 732   },
  ],
  alley: [
    { id: "rag",   name: "Rag & Bone",    ordered: 210500, received: 207800, sold: 145000, cost: 83200  },
    { id: "vince", name: "Vince",         ordered: 189600, received: 185000, sold: 122300, cost: 74000  },
    { id: "tb",    name: "Theory",        ordered: 145000, received: 142000, sold: 99800,  cost: 56800  },
    { id: "eis",   name: "Eileen Fisher", ordered: 377176, received: 369749, sold: 237899, cost: 147900 },
  ],
  denim: [
    { id: "ag",  name: "AG Jeans",  ordered: 35000, received: 34500, sold: 23400, cost: 13800 },
    { id: "dl",  name: "DL1961",    ordered: 20531, received: 20231, sold: 14200, cost: 8090  },
    { id: "mih", name: "MiH Jeans", ordered: 14000, received: 13500, sold: 8000,  cost: 5400  },
  ],
  des: [
    { id: "akris", name: "Akris",      ordered: 89000,  received: 82000,  sold: 41000, cost: 32800 },
    { id: "staud", name: "Staud",      ordered: 72105,  received: 67960,  sold: 38860, cost: 27184 },
    { id: "nili",  name: "Nili Lotan", ordered: 145000, received: 133000, sold: 70000, cost: 53200 },
  ],
  mens: [
    { id: "polo", name: "Ralph Lauren",  ordered: 155000, received: 140000, sold: 78000, cost: 56000 },
    { id: "boss", name: "Hugo Boss",     ordered: 120000, received: 110000, sold: 62000, cost: 44000 },
    { id: "pt01", name: "PT01 Trousers", ordered: 95000,  received: 86000,  sold: 48000, cost: 34400 },
    { id: "sco",  name: "Scott Barber",  ordered: 102591, received: 92733,  sold: 52091, cost: 37093 },
  ],
  next: [
    { id: "vero", name: "Veronica Beard", ordered: 198000, received: 189000, sold: 152000, cost: 75600 },
    { id: "mm",   name: "M.M. LaFleur",   ordered: 165000, received: 159000, sold: 124000, cost: 63600 },
    { id: "wit",  name: "Witchery",       ordered: 254680, received: 240475, sold: 176816, cost: 96190 },
  ],
  shoes: [
    { id: "cl",  name: "Christian Louboutin",   ordered: 98000, received: 87000, sold: 48000, cost: 34800 },
    { id: "hw",  name: "Hogl",                  ordered: 82000, received: 73000, sold: 42000, cost: 29200 },
    { id: "laz", name: "Lavorazione Artigiana", ordered: 72000, received: 65000, sold: 37000, cost: 26000 },
    { id: "sas", name: "SAS Shoes",             ordered: 77474, received: 68793, sold: 37143, cost: 27517 },
  ],
};

const DEMO_PRODUCTS = {
  dk: [
    { name: "dia 14k dia/14k",        sku: "adc2726/pf2501",  variant: "dia/14k",      cost: 825,  price: 2063, onHand: 0, sold: 1 },
    { name: "dia sil 14k",            sku: "adc2806s/pf2501", variant: "dia/sil/14k",  cost: 350,  price: 875,  onHand: 1, sold: 0 },
    { name: "ear kyanite 14k",        sku: "ade2939/f2501",   variant: "14k/kyanite",  cost: 1075, price: 2688, onHand: 1, sold: 0 },
    { name: "ear tahitian pearl 14k", sku: "ade2058/f2501",   variant: "14k",          cost: 526,  price: 1315, onHand: 1, sold: 0 },
    { name: "neck 14k",               sku: "adc266/f2501",    variant: "14k",          cost: 476,  price: 1190, onHand: 1, sold: 0 },
    { name: "neck sunstone 14k",      sku: "adc2953/f2501",   variant: "14k/sunstone", cost: 1475, price: 3688, onHand: 1, sold: 0 },
  ],
};

// ── API helpers ───────────────────────────────────────────────────────────────

// Fetch with exponential-backoff retry on 429 rate-limit responses
// and on network-level failures ("Failed to fetch").
async function apiFetch(path, attempt) {
  if (!attempt) attempt = 0;
  var res;
  try {
    res = await fetch("/api/ls/" + path);
  } catch (netErr) {
    // Network error (connection reset, "Failed to fetch", etc.) — retry up to 4 times
    if (attempt < 4) {
      await new Promise(function(r) { setTimeout(r, 1500 * (attempt + 1)); });
      return apiFetch(path, attempt + 1);
    }
    throw netErr;
  }
  if (res.status === 429 && attempt < 4) {
    await new Promise(function(r) { setTimeout(r, 1000 * (attempt + 1)); });
    return apiFetch(path, attempt + 1);
  }
  if (!res.ok) {
    var err = await res.json().catch(function() { return {}; });
    throw new Error(err.message || err.error || "HTTP " + res.status);
  }
  return res.json();
}

async function apiFetchAll(path, key) {
  var results = [];
  var after = null;
  var pages = 0;
  while (pages < 200) {
    pages++;
    var sep = path.includes("?") ? "&" : "?";
    var fullPath = path + sep + "page_size=200" + (after ? "&after=" + after : "");
    var data = await apiFetch(fullPath);
    var items = data[key] || data.data || [];
    results = results.concat(items);
    if (items.length === 0) break;
    if (items.length < 200) break;
    var vfr = (data.version && typeof data.version === "object") ? data.version.max : null;
    var vfi = items.reduce(function(mx, i) { return Math.max(mx, i.version || 0); }, 0);
    var cursor = (vfr !== null ? vfr : vfi) || null;
    if (!cursor) break;
    after = cursor;
  }
  return results;
}

// Run async tasks with a bounded concurrency limit (avoids flooding the LS API).
async function withConcurrency(tasks, limit) {
  var results = new Array(tasks.length).fill(null);
  var nextIdx = 0;
  async function worker() {
    while (true) {
      var i = nextIdx++;
      if (i >= tasks.length) break;
      results[i] = await tasks[i]();
    }
  }
  var workers = [];
  for (var w = 0; w < Math.min(limit, tasks.length); w++) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ── main component ────────────────────────────────────────────────────────────

export default function FlowReport() {
  const [authed, setAuthed] = useState(null);
  const [demo, setDemo] = useState(false);
  const [screen, setScreen] = useState("summary");
  const [season, setSeason] = useState("prefall26");

  const [summaryRows, setSummaryRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [loadingStep, setLoadingStep] = useState("");
  const [error, setError] = useState(null);

  const [seasonPids, setSeasonPids] = useState(new Set());
  const [pidToType, setPidToType] = useState({});
  const [pidToSupplier, setPidToSupplier] = useState({});
  const [pidToPrice, setPidToPrice] = useState({});
  const [pidToCost, setPidToCost] = useState({});
  const [allConsigItems, setAllConsigItems] = useState([]);
  const [allSaleLineItems, setAllSaleLineItems] = useState([]);

  const [currentDept, setCurrentDept] = useState(null);
  const [vendorRows, setVendorRows] = useState([]);
  const [vendorLoading, setVendorLoading] = useState(false);
  const [vendorError, setVendorError] = useState(null);

  const [currentVendor, setCurrentVendor] = useState(null);
  const [productRows, setProductRows] = useState([]);
  const [productLoading, setProductLoading] = useState(false);
  const [productError, setProductError] = useState(null);

  // ── load summary ──────────────────────────────────────────────────────────

  const loadSummary = useCallback(async () => {
    setLoading(true);
    setLoadingStep("Preparing…");
    setError(null);
    setSummaryRows([]);
    setAllConsigItems([]);
    setAllSaleLineItems([]);
    setSeasonPids(new Set());

    if (demo) { setSummaryRows(DEMO_SUMMARY); setLoading(false); return; }

    try {
      // Determine which SKU suffix codes identify this season.
      // The LS API tag filter (?tag_ids[]=UUID) is silently ignored, so we
      // identify season products by their SKU suffix instead.
      var skuCodes = seasonSkuCodes(season);
      if (skuCodes.length === 0) throw new Error("Unrecognized season format: " + season);

      // 1. Load departments + consignment headers in parallel
      setLoadingStep("Loading departments & purchase orders…");
      var parallelResult = await Promise.all([
        apiFetchAll("2.0/product_types", "data"),
        apiFetchAll("2.0/consignments?type=SUPPLIER", "data"),
      ]);
      var cats         = parallelResult[0];
      var consignments = parallelResult[1];
      console.log("[FlowReport] Departments:", cats.length, "Consignments:", consignments.length, "SKU codes:", skuCodes);

      // 2. Scan ALL products sequentially, identifying season PARENT products by SKU.
      //    LS 2.0/products returns parent products only — variants are separate records
      //    fetched via ?variant_parent_id=. Consignment items reference variant IDs,
      //    so we must also fetch variants for every season parent we find (step 2b).
      var newPidToType     = {};
      var newPidToSupplier = {};
      var newPidToPrice    = {};
      var newPidToCost     = {};
      var seasonPidSet     = new Set();
      var seasonParentIds  = []; // parent IDs confirmed as season products
      var parentStore      = {}; // pid → {typeId,suppId,suppName,price,cost} for variant inheritance

      var prodAfter    = null;
      var prodPages    = 0;
      var totalScanned = 0;

      while (prodPages < 500) {
        prodPages++;
        // Small delay after the first page to avoid rapid-fire requests to LS
        if (prodPages > 1) await new Promise(function(r) { setTimeout(r, 120); });
        var prodPath = "2.0/products?page_size=200" + (prodAfter ? "&after=" + prodAfter : "");
        setLoadingStep("Scanning products… (" + totalScanned.toLocaleString() + " scanned)");
        var prodData = await apiFetch(prodPath);
        var prods    = prodData.data || [];
        totalScanned += prods.length;

        for (var pi = 0; pi < prods.length; pi++) {
          var p   = prods[pi];
          var sku = (p.sku || "").toLowerCase();

          var isSeason = false;
          for (var ci = 0; ci < skuCodes.length; ci++) {
            if (sku.includes(skuCodes[ci])) { isSeason = true; break; }
          }

          var typeId   = p.product_type_id || "__none__";
          var suppId   = (p.supplier && p.supplier.id)   || p.supplier_id   || "__none__";
          var suppName = (p.supplier && p.supplier.name) || "Unknown";
          var price    = parseFloat(p.price_excluding_tax || 0);
          var cost     = parseFloat(p.supply_price        || 0);

          // Always store parent data so variants can inherit it in step 2b
          if (!p.variant_parent_id) {
            parentStore[p.id] = { typeId: typeId, suppId: suppId, suppName: suppName, price: price, cost: cost };
          }

          if (isSeason) {
            seasonPidSet.add(p.id);
            newPidToType[p.id]     = typeId;
            newPidToSupplier[p.id] = { id: suppId, name: suppName };
            newPidToPrice[p.id]    = price;
            newPidToCost[p.id]     = cost;
            // Queue parent products for variant fetching in step 2b
            if (!p.variant_parent_id) seasonParentIds.push(p.id);
          }
        }

        if (prods.length === 0) break;
        var vfrP = (prodData.version && typeof prodData.version === "object") ? prodData.version.max : null;
        var vfiP = prods.reduce(function(mx, pp) { return Math.max(mx, pp.version || 0); }, 0);
        var cursorP = (vfrP !== null ? vfrP : vfiP) || null;
        if (!cursorP) break;
        prodAfter = cursorP;
      }

      console.log("[FlowReport] Season parents from SKU scan:", seasonParentIds.length, "/ total scanned:", totalScanned);

      // Diagnostic: if 0 parents found, the SKU pattern probably doesn't match.
      if (seasonParentIds.length === 0) {
        throw new Error(
          "No products found matching season code(s) " + skuCodes.join(", ") +
          " (checked " + totalScanned.toLocaleString() + " products). " +
          "Verify the SKU suffix format in Lightspeed, e.g. open a known Pre-Fall 2026 product and check its SKU."
        );
      }

      // 2b. Fetch variants for each season parent.
      //     PO/consignment line items reference VARIANT product IDs, not parent IDs.
      //     We only fetch variants for the N season parents (not all 40k products),
      //     so this is fast and won't hit rate limits.
      setLoadingStep("Fetching variants for " + seasonParentIds.length + " season product(s)…");
      await withConcurrency(
        seasonParentIds.map(function(pid) {
          return async function() {
            var variants = await apiFetchAll("2.0/products?variant_parent_id=" + pid, "data");
            var par      = parentStore[pid];
            for (var vvi = 0; vvi < variants.length; vvi++) {
              var vp = variants[vvi];
              if (seasonPidSet.has(vp.id)) continue; // already added
              seasonPidSet.add(vp.id);
              // Prefer variant's own values; fall back to parent
              newPidToType[vp.id]     = vp.product_type_id || (par && par.typeId) || "__none__";
              newPidToSupplier[vp.id] = {
                id:   (vp.supplier && vp.supplier.id)   || vp.supplier_id   || (par && par.suppId)   || "__none__",
                name: (vp.supplier && vp.supplier.name) || (par && par.suppName) || "Unknown",
              };
              newPidToPrice[vp.id] = parseFloat(vp.price_excluding_tax || 0) || (par ? par.price : 0);
              newPidToCost[vp.id]  = parseFloat(vp.supply_price        || 0) || (par ? par.cost  : 0);
            }
          };
        }),
        5
      );

      console.log("[FlowReport] Season PID set size (parents + variants):", seasonPidSet.size);
      setPidToType(newPidToType);
      setPidToSupplier(newPidToSupplier);
      setPidToPrice(newPidToPrice);
      setPidToCost(newPidToCost);
      setSeasonPids(new Set(seasonPidSet));

      // 3. Fetch consignment line items with bounded concurrency (3 at a time).
      var newConsigItems = [];
      var posDone = 0;
      await withConcurrency(
        consignments.map(function(c) {
          return async function() {
            var items = await apiFetchAll("2.0/consignments/" + c.id + "/products", "data");
            posDone++;
            setLoadingStep("Checking POs… (" + posDone + " of " + consignments.length + ")");
            for (var ii = 0; ii < items.length; ii++) {
              if (seasonPidSet.has(items[ii].product_id)) newConsigItems.push(items[ii]);
            }
          };
        }),
        3
      );
      console.log("[FlowReport] Season consig line items:", newConsigItems.length);
      setAllConsigItems(newConsigItems);

      // 4. Build department summary from consignment line items
      var map = {};
      for (var ki = 0; ki < cats.length; ki++) {
        var cat = cats[ki];
        map[cat.id] = { id: cat.id, name: cat.name, ordered: 0, received: 0, sold: 0 };
      }
      for (var ni = 0; ni < newConsigItems.length; ni++) {
        var item    = newConsigItems[ni];
        var cid     = newPidToType[item.product_id] || "__none__";
        if (!map[cid]) map[cid] = { id: cid, name: "Other", ordered: 0, received: 0, sold: 0 };
        var iPrice  = newPidToPrice[item.product_id] || 0;
        map[cid].ordered  += iPrice * (item.count    || 0);
        map[cid].received += iPrice * (item.received || 0);
      }

      // 5. Fetch all sales (sequential pages) and tally sold amounts
      var newSaleLineItems = [];
      var salesError       = null;
      try {
        var salesResults = [];
        var saleAfter    = null;
        var salePages    = 0;
        while (salePages < 200) {
          salePages++;
          var salePath = "2.0/sales?page_size=200" + (saleAfter ? "&after=" + saleAfter : "");
          setLoadingStep("Loading sales… (page " + salePages + ", " + salesResults.length + " loaded)");
          var saleData  = await apiFetch(salePath);
          var saleItems = saleData.data || [];
          salesResults  = salesResults.concat(saleItems);
          if (saleItems.length === 0) break;
          if (saleItems.length < 200) break;
          var svp = (saleData.version && typeof saleData.version === "object") ? saleData.version.max : null;
          var svi = saleItems.reduce(function(mx, i) { return Math.max(mx, i.version || 0); }, 0);
          var saleCursor = (svp !== null ? svp : svi) || null;
          if (!saleCursor) break;
          saleAfter = saleCursor;
        }
        for (var si = 0; si < salesResults.length; si++) {
          var sale = salesResults[si];
          if (sale.status === "VOIDED") continue;
          var lis = sale.line_items || [];
          for (var li = 0; li < lis.length; li++) {
            if (lis[li].product_id && lis[li].status !== "VOIDED") newSaleLineItems.push(lis[li]);
          }
        }
        setAllSaleLineItems(newSaleLineItems);
        console.log("[FlowReport] Total sale line items:", newSaleLineItems.length);
      } catch (e) {
        salesError = e.message;
      }

      // Tally sold amounts (returns subtracted)
      for (var sli = 0; sli < newSaleLineItems.length; sli++) {
        var lineItem = newSaleLineItems[sli];
        if (!seasonPidSet.has(lineItem.product_id)) continue;
        var lcid = newPidToType[lineItem.product_id] || "__none__";
        if (!map[lcid]) continue;
        var amount = parseFloat(lineItem.total_price || lineItem.price || 0);
        if (lineItem.is_return) { map[lcid].sold -= amount; } else { map[lcid].sold += amount; }
      }

      setSummaryRows(Object.values(map).sort(function(a, b) { return b.ordered - a.ordered; }));
      if (salesError) setError("Sales data may be incomplete: " + salesError);
    } catch (e) {
      if (e.message.includes("401") || e.message.toLowerCase().includes("not authenticated")) {
        setAuthed(false);
      } else {
        setError(e.message);
      }
    }
    setLoading(false);
  }, [demo, season]);

  // ── auth check ────────────────────────────────────────────────────────────

  useEffect(() => {
    fetch("/api/auth/session")
      .then(function(r) { return r.json(); })
      .then(function(d) { setAuthed(d.authenticated === true); })
      .catch(function() { setAuthed(false); });
  }, []);

  useEffect(function() { if (authed === true) loadSummary(); }, [authed, loadSummary]);

  // ── department drilldown ──────────────────────────────────────────────────

  const openDept = useCallback(function(dept) {
    setCurrentDept(dept);
    setVendorRows([]);
    setVendorError(null);
    setVendorLoading(true);
    setScreen("vendors");

    if (demo) { setVendorRows(DEMO_VENDORS[dept.id] || []); setVendorLoading(false); return; }

    try {
      var vm = {};
      for (var i = 0; i < allConsigItems.length; i++) {
        var item = allConsigItems[i];
        if (!seasonPids.has(item.product_id)) continue;
        if (pidToType[item.product_id] !== dept.id) continue;
        var supplier = pidToSupplier[item.product_id];
        if (!supplier || supplier.id === "__none__") continue;
        if (!vm[supplier.id]) vm[supplier.id] = { id: supplier.id, name: supplier.name, ordered: 0, received: 0, sold: 0, cost: 0 };
        var retailPrice = pidToPrice[item.product_id] || 0;
        vm[supplier.id].ordered  += retailPrice * (item.count    || 0);
        vm[supplier.id].received += retailPrice * (item.received || 0);
        vm[supplier.id].cost     += parseFloat(item.cost || 0) * (item.received || 0);
      }
      for (var j = 0; j < allSaleLineItems.length; j++) {
        var li = allSaleLineItems[j];
        if (!seasonPids.has(li.product_id)) continue;
        if (pidToType[li.product_id] !== dept.id) continue;
        var sup = pidToSupplier[li.product_id];
        if (!sup || !vm[sup.id]) continue;
        var saleAmt = parseFloat(li.total_price || li.price || 0);
        if (li.is_return) { vm[sup.id].sold -= saleAmt; } else { vm[sup.id].sold += saleAmt; }
      }
      setVendorRows(Object.values(vm).sort(function(a, b) { return b.ordered - a.ordered; }));
    } catch (e) { setVendorError(e.message); }
    setVendorLoading(false);
  }, [demo, allConsigItems, allSaleLineItems, pidToType, pidToSupplier, pidToPrice, seasonPids]);

  // ── vendor drilldown ──────────────────────────────────────────────────────

  const openVendor = useCallback(async function(vendor) {
    setCurrentVendor(vendor);
    setProductRows([]);
    setProductLoading(true);
    setProductError(null);
    setScreen("products");

    if (demo) { setProductRows(DEMO_PRODUCTS[vendor.id] || []); setProductLoading(false); return; }

    try {
      var allProducts = await apiFetchAll("2.0/products?supplier_id=" + vendor.id, "data");
      var products    = allProducts.filter(function(p) {
        return seasonPids.has(p.id) && pidToType[p.id] === currentDept.id;
      });

      var pidSet    = new Set(products.map(function(p) { return p.id; }));
      var soldMap   = {};
      var returnMap = {};
      for (var i = 0; i < allSaleLineItems.length; i++) {
        var li = allSaleLineItems[i];
        if (!pidSet.has(li.product_id)) continue;
        var qty = parseInt(li.quantity || 0);
        if (li.is_return) {
          returnMap[li.product_id] = (returnMap[li.product_id] || 0) + qty;
        } else {
          soldMap[li.product_id] = (soldMap[li.product_id] || 0) + qty;
        }
      }

      setProductRows(products.map(function(p) {
        return {
          name:     p.name,
          sku:      p.sku || "",
          variant:  p.variant_option_one_value || p.variant_name || "",
          cost:     parseFloat(p.supply_price        || 0),
          price:    parseFloat(p.price_excluding_tax || 0),
          onHand:   (p.inventory && p.inventory.count != null) ? p.inventory.count : (p.inventory_count || 0),
          sold:     soldMap[p.id]   || 0,
          returned: returnMap[p.id] || 0,
        };
      }));
    } catch (e) { setProductError(e.message); }
    setProductLoading(false);
  }, [demo, currentDept, seasonPids, pidToType, allSaleLineItems]);

  // ── computed totals ───────────────────────────────────────────────────────

  const totalOrdered  = summaryRows.reduce(function(a, r) { return a + r.ordered;  }, 0);
  const totalReceived = summaryRows.reduce(function(a, r) { return a + r.received; }, 0);
  const totalSold     = summaryRows.reduce(function(a, r) { return a + r.sold;     }, 0);
  const totalRecPct   = totalOrdered  > 0 ? (totalReceived / totalOrdered)  * 100 : 0;
  const totalSoldPct  = totalReceived > 0 ? (totalSold     / totalReceived) * 100 : 0;
  const vTotalOrdered  = vendorRows.reduce(function(a, r) { return a + r.ordered;  }, 0);
  const vTotalReceived = vendorRows.reduce(function(a, r) { return a + r.received; }, 0);
  const vTotalSold     = vendorRows.reduce(function(a, r) { return a + r.sold;     }, 0);
  const vTotalCost     = vendorRows.reduce(function(a, r) { return a + (r.cost || 0); }, 0);
  var seasonLabel = "";
  for (var sIdx = 0; sIdx < SEASONS.length; sIdx++) { if (SEASONS[sIdx].id === season) { seasonLabel = SEASONS[sIdx].name; break; } }
  if (!seasonLabel) seasonLabel = season;

  // ── styles ────────────────────────────────────────────────────────────────

  const s = {
    app:        { fontFamily: "'DM Sans',sans-serif", background: "#f7f5f0", minHeight: "100vh", fontSize: 14 },
    header:     { background: "#fff", borderBottom: "1px solid #e2ddd5", padding: "0 1.5rem", display: "flex", alignItems: "center", justifyContent: "space-between", height: 56, position: "sticky", top: 0, zIndex: 100 },
    logo:       { fontFamily: "'DM Serif Display',serif", fontSize: 22, color: "#1a1816", letterSpacing: -0.5 },
    nav:        { display: "flex", gap: 4 },
    navBtn:     function(active) { return { background: active ? "#e8eef7" : "none", border: "none", padding: "6px 13px", borderRadius: 6, fontSize: 13, color: active ? "#3a5a8c" : "#6b6560", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontWeight: 500 }; },
    main:       { padding: "1.75rem 1.5rem", maxWidth: 1200, margin: "0 auto" },
    seasonPill: { display: "flex", alignItems: "center", gap: 6, background: "#f0ede6", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 10px", fontSize: 13, fontWeight: 500 },
    tableRow:   function(clickable, zero) { return { borderBottom: "1px solid #e2ddd5", cursor: clickable && !zero ? "pointer" : "default", opacity: zero ? 0.45 : 1, transition: "background 0.1s" }; },
    backBtn:    { background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, textDecoration: "underline", textUnderlineOffset: 2, padding: 0, marginBottom: "0.9rem" },
    demoBadge:  { background: "#fef3e2", color: "#92600a", border: "1px solid #f5d9a0", borderRadius: 20, fontSize: 11, fontWeight: 600, padding: "3px 10px", letterSpacing: "0.04em" },
    statusDot:  function(status) {
      var colors = { sold: "#4a7ab5", stock: "#e05a36", ordered: "#aaa", returned: "#9b59b6" };
      return { width: 10, height: 10, borderRadius: "50%", background: colors[status] || "#aaa", display: "inline-block" };
    },
  };

  const fontLink = "@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display&family=DM+Sans:wght@300;400;500;600&display=swap'); @keyframes spin{to{transform:rotate(360deg)}} tbody tr:hover{background:#f0f5fb!important}";

  // ── login screens ─────────────────────────────────────────────────────────

  if (authed === null) return (
    <div style={s.app}><style>{fontLink}</style>
      <header style={s.header}><div style={s.logo}>abersons</div></header>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 56px)" }}><Spinner label="Checking login…" /></div>
    </div>
  );

  if (authed === false) return (
    <div style={s.app}><style>{fontLink}</style>
      <header style={s.header}><div style={s.logo}>abersons</div></header>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "calc(100vh - 56px)", gap: 16 }}>
        <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 26, color: "#1a1816" }}>Flow Report</div>
        <div style={{ fontSize: 13, color: "#6b6560", marginBottom: 8 }}>Connect your Lightspeed account to continue.</div>
        <a href="/api/auth/lightspeed" style={{ background: "#3a5a8c", color: "#fff", padding: "10px 24px", borderRadius: 8, textDecoration: "none", fontFamily: "'DM Sans',sans-serif", fontSize: 14, fontWeight: 500 }}>Connect to Lightspeed</a>
      </div>
    </div>
  );

  // ── render ────────────────────────────────────────────────────────────────

  return (
    <div style={s.app}>
      <style>{fontLink}</style>

      <header style={s.header}>
        <div style={s.logo}>abersons</div>
        <nav style={s.nav}>
          <button style={s.navBtn(screen !== "detail")} onClick={function() { setScreen("summary"); }}>flow summary</button>
          <button style={s.navBtn(screen === "detail")} onClick={function() { setScreen("detail"); }}>flow detail</button>
        </nav>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {demo && <span style={s.demoBadge}>demo mode</span>}
          <div style={s.seasonPill}>
            <span style={{ color: "#9e9892", fontSize: 12 }}>▸</span>
            <select value={season} onChange={function(e) { setSeason(e.target.value); setScreen("summary"); }}
              style={{ background: "none", border: "none", fontFamily: "'DM Sans',sans-serif", fontSize: 13, fontWeight: 500, color: "#1a1816", cursor: "pointer", outline: "none" }}>
              {SEASONS.map(function(s2) { return <option key={s2.id} value={s2.id}>{s2.name}</option>; })}
            </select>
            <span style={{ color: "#9e9892", fontSize: 12 }}>◂</span>
          </div>
          <button onClick={function() { setDemo(!demo); setScreen("summary"); }}
            style={{ background: "none", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 11px", fontSize: 12, color: "#6b6560", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            {demo ? "Live data" : "Demo mode"}
          </button>
          <button onClick={function() { fetch("/api/auth/logout").then(function() { setAuthed(false); }); }}
            style={{ background: "none", border: "none", padding: "5px 8px", fontSize: 12, color: "#9e9892", cursor: "pointer", fontFamily: "'DM Sans',sans-serif" }}>
            logout
          </button>
        </div>
      </header>

      <div style={s.main}>

        {/* ── SUMMARY ── */}
        {screen === "summary" && (
          <>
            {loading && <Spinner label={loadingStep || ("Loading " + seasonLabel + " data…")} />}
            {error && <ErrBox msg={error} />}
            {!loading && (
              <>
                <KpiRow items={[
                  { label: "Total Ordered",  value: fmt(totalOrdered) },
                  { label: "Total Received", value: fmt(totalReceived), sub: totalRecPct.toFixed(1) + "% of ordered" },
                  { label: "Total Sold",     value: fmt(totalSold),     sub: totalSoldPct.toFixed(1) + "% of received" },
                  { label: "Departments",    value: summaryRows.filter(function(r) { return r.ordered > 0 || r.sold > 0; }).length },
                ]} />
                <TableWrap title={"Store Summary — " + seasonLabel}
                  right={<button onClick={loadSummary} style={{ background: "none", border: "1px solid #e2ddd5", borderRadius: 6, padding: "5px 11px", fontSize: 12, fontWeight: 500, color: "#6b6560", cursor: "pointer", display: "flex", alignItems: "center", gap: 5 }}>↺ Refresh</button>}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <TH>Sold %</TH><TH>Department</TH><TH right>Ordered</TH>
                        <TH right>Received</TH><TH right>Sold</TH>
                        <TH right>Received %</TH><TH right>Sold %</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {summaryRows.map(function(r) {
                        var recPct  = r.ordered  > 0 ? (r.received / r.ordered)  * 100 : 0;
                        var soldPct = r.received > 0 ? (r.sold     / r.received) * 100 : 0;
                        var zero    = r.ordered === 0 && r.sold === 0;
                        return (
                          <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={function() { if (!zero) openDept(r); }}>
                            <TD><Bar pct={soldPct} /></TD>
                            <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                            <TD right>{fmt(r.ordered)}</TD>
                            <TD right>{fmt(r.received)}</TD>
                            <TD right>{fmt(r.sold)}</TD>
                            <TD right><PctBadge pct={recPct}  zero={zero} /></TD>
                            <TD right><PctBadge pct={soldPct} zero={zero} /></TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              </>
            )}
          </>
        )}

        {/* ── VENDORS ── */}
        {screen === "vendors" && (
          <>
            <button style={s.backBtn} onClick={function() { setScreen("summary"); }}>← Store Summary</button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button onClick={function() { setScreen("summary"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>Store Summary</button>
              {" › "}<span style={{ color: "#1a1816", fontWeight: 500 }}>{currentDept ? currentDept.name : ""}</span>
            </div>
            {vendorLoading && <Spinner label="Loading vendors…" />}
            {vendorError && <ErrBox msg={vendorError} />}
            {!vendorLoading && (
              <>
                <KpiRow items={[
                  { label: "Ordered (retail)", value: fmt(vTotalOrdered) },
                  { label: "Cost (wholesale)", value: fmt(vTotalCost) },
                  { label: "Received", value: fmt(vTotalReceived), sub: vTotalOrdered > 0 ? ((vTotalReceived / vTotalOrdered) * 100).toFixed(1) + "%" : "—" },
                  { label: "Sold",     value: fmt(vTotalSold),     sub: vTotalReceived > 0 ? ((vTotalSold / vTotalReceived) * 100).toFixed(1) + "%" : "—" },
                  { label: "Vendors",  value: vendorRows.filter(function(r) { return r.ordered > 0 || r.sold > 0; }).length },
                ]} />
                <TableWrap title={(currentDept ? currentDept.name : "") + " — by Vendor"}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr>
                        <TH>Sold %</TH><TH>Vendor</TH><TH right>Ordered</TH><TH right>Cost</TH>
                        <TH right>Received</TH><TH right>Sold</TH>
                        <TH right>Received %</TH><TH right>Sold %</TH>
                      </tr>
                    </thead>
                    <tbody>
                      {vendorRows.map(function(r) {
                        var recPct  = r.ordered  > 0 ? (r.received / r.ordered)  * 100 : 0;
                        var soldPct = r.received > 0 ? (r.sold     / r.received) * 100 : 0;
                        var zero    = r.ordered === 0 && r.sold === 0;
                        return (
                          <tr key={r.id} style={s.tableRow(!zero, zero)} onClick={function() { if (!zero) openVendor(r); }}>
                            <TD><Bar pct={soldPct} /></TD>
                            <TD><span style={{ fontWeight: 500 }}>{r.name}</span></TD>
                            <TD right>{fmt(r.ordered)}</TD>
                            <TD right style={{ color: "#6b6560" }}>{r.cost > 0 ? fmt(r.cost) : "—"}</TD>
                            <TD right>{fmt(r.received)}</TD>
                            <TD right>{fmt(r.sold)}</TD>
                            <TD right><PctBadge pct={recPct}  zero={zero} /></TD>
                            <TD right><PctBadge pct={soldPct} zero={zero} /></TD>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </TableWrap>
              </>
            )}
          </>
        )}

        {/* ── PRODUCTS ── */}
        {screen === "products" && (
          <>
            <button style={s.backBtn} onClick={function() { setScreen("vendors"); }}>← {currentDept ? currentDept.name : ""}</button>
            <div style={{ color: "#9e9892", fontSize: 13, marginBottom: "1.25rem" }}>
              <button onClick={function() { setScreen("summary"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>Store Summary</button>
              {" › "}
              <button onClick={function() { setScreen("vendors"); }} style={{ background: "none", border: "none", color: "#3a5a8c", cursor: "pointer", fontFamily: "'DM Sans',sans-serif", fontSize: 13, textDecoration: "underline", textUnderlineOffset: 2, padding: 0 }}>{currentDept ? currentDept.name : ""}</button>
              {" › "}<span style={{ color: "#1a1816", fontWeight: 500 }}>{currentVendor ? currentVendor.name : ""}</span>
            </div>
            <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: "1.25rem" }}>
              {[
                { label: "Ordered (retail)", value: fmt(currentVendor ? currentVendor.ordered  : 0) },
                { label: "Cost (wholesale)", value: fmt(currentVendor ? currentVendor.cost     : 0) },
                { label: "Received",         value: fmt(currentVendor ? currentVendor.received : 0) },
                { label: "Sold",             value: fmt(currentVendor ? currentVendor.sold     : 0) },
                { label: "SKUs",             value: productRows.length },
              ].map(function(kv) {
                return (
                  <div key={kv.label} style={{ background: "#fff", border: "1px solid #e2ddd5", borderRadius: 6, padding: "7px 13px" }}>
                    <div style={{ fontSize: 11, textTransform: "uppercase", letterSpacing: "0.05em", color: "#9e9892", marginBottom: 2 }}>{kv.label}</div>
                    <div style={{ fontWeight: 600, color: "#1a1816" }}>{kv.value}</div>
                  </div>
                );
              })}
            </div>
            {productLoading && <Spinner label="Loading products…" />}
            {productError && <ErrBox msg={productError} />}
            {!productLoading && (
              <TableWrap title={(currentDept ? currentDept.name : "") + " — " + (currentVendor ? currentVendor.name : "")}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr>
                      <TH>Status</TH><TH>Description</TH><TH>SKU</TH><TH>Variant</TH>
                      <TH right>Cost</TH><TH right>Price</TH>
                      <TH right>On Hand</TH><TH right>Sold</TH><TH right>Returned</TH>
                    </tr>
                  </thead>
                  <tbody>
                    {productRows.length === 0 ? (
                      <tr><td colSpan={9} style={{ padding: "2.5rem", textAlign: "center", color: "#9e9892" }}>No products found for this vendor in the selected season.</td></tr>
                    ) : productRows.map(function(p, i) {
                      var status = p.returned > 0 && p.sold === 0 ? "returned" : p.sold > 0 ? "sold" : p.onHand > 0 ? "stock" : "ordered";
                      return (
                        <tr key={i} style={{ borderBottom: "1px solid #e2ddd5" }}>
                          <TD><span style={s.statusDot(status)} /></TD>
                          <TD>{p.name}</TD>
                          <TD mono>{p.sku}</TD>
                          <TD><span style={{ color: "#6b6560" }}>{p.variant}</span></TD>
                          <TD right>{p.cost  > 0 ? fmt(p.cost)  : "—"}</TD>
                          <TD right>{p.price > 0 ? fmt(p.price) : "—"}</TD>
                          <TD right>{p.onHand}</TD>
                          <TD right>{p.sold}</TD>
                          <TD right style={{ color: p.returned > 0 ? "#9b59b6" : "#9e9892" }}>{p.returned || 0}</TD>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "9px 12px", background: "#f0ede6", borderTop: "1px solid #e2ddd5", fontSize: 12 }}>
                  {[["sold","sold","#4a7ab5"],["stock","in stock","#e05a36"],["ordered","ordered","#aaa"],["returned","returned","#9b59b6"]].map(function(e) {
                    return (
                      <div key={e[0]} style={{ display: "flex", alignItems: "center", gap: 5, color: "#6b6560" }}>
                        <span style={{ width: 9, height: 9, borderRadius: "50%", background: e[2], display: "inline-block" }} />
                        {e[1]}
                      </div>
                    );
                  })}
                </div>
              </TableWrap>
            )}
          </>
        )}

        {/* ── DETAIL placeholder ── */}
        {screen === "detail" && (
          <div style={{ color: "#6b6560", marginTop: "1rem" }}>
            Select a department from the <strong>flow summary</strong> tab to drill into vendor and product detail.
          </div>
        )}

      </div>
    </div>
  );
}
